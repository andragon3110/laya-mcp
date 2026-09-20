import type { LayaClient } from "../client.js";
import type { GlinerClient, GlinerSpan } from "../gliner.js";
import type { ToolContext } from "../index.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const extractTool: ToolDefinition = {
  name: "laya_extract",
  description:
    "Pull structured field values from a document. Two candidate sources: `regex` (caller supplies a " +
    "pattern per field) or `entities` (GLiNER finds zero-shot spans, no pattern needed). With `auto` " +
    "(default) GLiNER is used when its sidecar is reachable, otherwise regex. Laya always picks among " +
    "the candidates, and the returned value is always a verbatim substring of the document " +
    "(never model-generated). Entity mode additionally returns character offsets for grounding.",
  inputSchema: {
    type: "object",
    properties: {
      document: { type: "string", description: "Source document." },
      fields: {
        type: "array",
        description:
          "Fields to extract. Each needs `id` and `description`. Regex mode additionally needs " +
          "`pattern` (ECMAScript regex, no flags). Entity mode optionally takes `entity_type` " +
          "(defaults to the field id).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            pattern: { type: "string", description: "ECMAScript regex (no flags). Required in regex mode." },
            description: { type: "string", description: "What the field means." },
            entity_type: {
              type: "string",
              description: "GLiNER entity type to look for. Defaults to the field id.",
            },
          },
          required: ["id", "description"],
        },
      },
      source: {
        type: "string",
        enum: ["regex", "entities", "auto"],
        description:
          "Candidate source. `regex` = classic patterns only. `entities` = GLiNER spans only " +
          "(fails clearly when the sidecar is down). `auto` (default) = GLiNER when reachable, " +
          "regex fallback otherwise.",
      },
    },
    required: ["document", "fields"],
    additionalProperties: false,
  },
  buildQuestions: (args) => buildRegexQuestions(args),
};

interface FieldSpec {
  id?: string;
  pattern?: string;
  description?: string;
  entity_type?: string;
}

function regexCandidates(document: string, pattern: string): string[] {
  try {
    const re = new RegExp(pattern, "g");
    return Array.from(document.matchAll(re), (m) => m[0]).slice(0, 20);
  } catch {
    return [];
  }
}

function buildRegexQuestions(args: Record<string, unknown>): Record<string, unknown> {
  const fields = Array.isArray(args.fields) ? args.fields : [];
  const out: Record<string, unknown> = {};
  fields.forEach((f: FieldSpec, i: number) => {
    if (!f || typeof f.id !== "string" || typeof f.pattern !== "string") return;
    const candidates = regexCandidates(String(args.document ?? ""), f.pattern);
    const criteria: Record<string, string> = {};
    candidates.forEach((c, idx) => {
      criteria[`m${idx}`] = c.slice(0, 240);
    });
    criteria.none = "None of the regex matches is the true value of the field.";
    out[`extract_${i}_${f.id}`] = {
      type: "choice",
      instructions:
        `Pick the substring candidate that is the real value of field "${f.id}". ` +
        `Field meaning: ${f.description ?? ""}.`,
      criteria,
    };
  });
  return out;
}

interface SpanChoice {
  key: string;
  span: GlinerSpan;
}

function buildEntityQuestions(
  fields: FieldSpec[],
  spansByType: Record<string, GlinerSpan[]>,
): { questions: Record<string, unknown>; spanIndex: Record<string, Record<string, SpanChoice>> } {
  const questions: Record<string, unknown> = {};
  const spanIndex: Record<string, Record<string, SpanChoice>> = {};
  fields.forEach((f, i) => {
    if (!f || typeof f.id !== "string") return;
    const etype = f.entity_type ?? f.id;
    const spans = spansByType[etype] ?? spansByType[f.id] ?? [];
    const criteria: Record<string, string> = {};
    const index: Record<string, SpanChoice> = {};
    spans.slice(0, 20).forEach((s, idx) => {
      const key = `g${idx}`;
      criteria[key] =
        `${s.text.slice(0, 200)} [${s.start}:${s.end}] (${s.type}, gliner_conf=${s.confidence.toFixed(2)})`;
      index[key] = { key, span: s };
    });
    criteria.none = "None of the extracted spans is the true value of the field.";
    questions[`extract_${i}_${f.id}`] = {
      type: "choice",
      instructions:
        `Pick the span that is the real value of field "${f.id}". ` +
        `Field meaning: ${f.description ?? ""}. Spans show [start:end] offsets into the document.`,
      criteria,
    };
    spanIndex[`extract_${i}_${f.id}`] = index;
  });
  return { questions, spanIndex };
}

export async function handleExtract(
  client: LayaClient,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const fields = (Array.isArray(args.fields) ? args.fields : []) as FieldSpec[];
  const document = String(args.document ?? "");
  const source = args.source === "regex" || args.source === "entities" ? args.source : "auto";
  const glinerReady = ctx?.glinerReady() ?? false;

  const useEntities = source === "entities" || (source === "auto" && glinerReady);
  let fallbackNote: string | undefined;
  let spanIndex: Record<string, Record<string, SpanChoice>> = {};

  let questions: Record<string, unknown>;
  if (useEntities && ctx) {
    try {
      const types = [...new Set(fields.flatMap((f) => (f?.id ? [f.entity_type ?? f.id, f.id] : [])))];
      const { spansByType, latencyMs } = await ctx.gliner.extractEntities(document, types);
      void latencyMs;
      const built = buildEntityQuestions(fields, spansByType);
      questions = built.questions;
      spanIndex = built.spanIndex;
    } catch (err) {
      if (source === "entities") throw err;
      fallbackNote = `GLiNER unavailable (${err instanceof Error ? err.message : String(err)}); fell back to regex.`;
      questions = buildRegexQuestions(args);
    }
  } else {
    if (source === "entities") {
      throw new Error(
        "laya_extract source=entities but the gliner-server sidecar is not reachable. " +
          "Start it with $HOME/laya-mcp/start_gliner.sh (installed via install.sh --with-gliner), " +
          "or use source=auto for regex fallback.",
      );
    }
    if (source === "auto") {
      fallbackNote = "GLiNER sidecar unreachable at call time; using regex candidates.";
    }
    questions = buildRegexQuestions(args);
  }

  // The entities path asks Laya to choose among pre-labeled spans -- a
  // meta-choice task the multilingual checkpoint fails zero-shot (picks
  // "none" at ~0.86; verified 2026-09-20). Force the fine-tuned
  // typed-decisions checkpoint as judge. The regex path keeps Router
  // default so existing behavior is untouched.
  const judgeOpts =
    useEntities && !fallbackNote ? { model: "typed-decisions" } : undefined;

  const result = await runTool(client, args, questions, (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const results: Array<Record<string, unknown>> = [];
    fields.forEach((f, i) => {
      if (!f || typeof f.id !== "string") return;
      const key = `extract_${i}_${f.id}`;
      const ans = a[key];
      const choice = ans?.choice ?? "none";
      const entry: Record<string, unknown> = {
        id: f.id,
        confidence: ans ? Math.max(...Object.values(ans.probabilities ?? {})) : 0,
      };
      if (choice === "none") {
        entry.value = null;
        entry.status = "not_found";
      } else if (spanIndex[key]?.[choice]) {
        const s = spanIndex[key][choice].span;
        entry.value = s.text;
        entry.status = "extracted";
        entry.start = s.start;
        entry.end = s.end;
        entry.entity_type = s.type;
        entry.gliner_confidence = s.confidence;
      } else {
        // Regex path: the choice key (m{n}) is not the value; resolve it.
        // Recompute candidates deterministically to map key -> substring.
        const cands = f.pattern ? regexCandidates(document, f.pattern) : [];
        const m = /^m(\d+)$/.exec(choice);
        const idx = m ? Number(m[1]) : -1;
        entry.value = idx >= 0 && idx < cands.length ? cands[idx] : null;
        entry.status = entry.value === null ? "not_found" : "extracted";
      }
      results.push(entry);
    });
    const out: Record<string, unknown> = {
      results,
      source: useEntities && !fallbackNote ? "entities" : "regex",
      latency_ms: raw.latencyMs,
    };
    if (fallbackNote) out.fallback = fallbackNote;
    if (raw.routing && Object.keys(raw.routing).length > 0) out.routing = raw.routing;
    return JSON.stringify(out, null, 2);
  }, judgeOpts);
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
