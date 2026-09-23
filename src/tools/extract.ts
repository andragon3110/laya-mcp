import type { LayaClient } from "../client.js";
import type { GlinerClient, GlinerSpan } from "../gliner.js";
import type { ToolContext } from "../index.js";
import { extractEvidence, winnerOf, type ExtractFieldEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const extractTool: ToolDefinition = {
  name: "laya_extract",
  description:
    "Pull structured field values from a document. Two candidate sources: `regex` (caller supplies a " +
    "pattern per field) or `entities` (GLiNER finds zero-shot spans, no pattern needed). With `auto` " +
    "(default) GLiNER is used when its sidecar is reachable, otherwise regex. Laya always picks among " +
    "the candidates, and the returned value is always a verbatim substring of the document " +
    "(never model-generated). Entity mode additionally returns character offsets for grounding. " +
    "Each field returns its raw, uncalibrated winner_probability (never a confidence) plus the deterministic " +
    "ALLOW/ESCALATE `decision` from the versioned extract@1.0.0 policy; an ESCALATE decision is authoritative. " +
    "At most 20 candidates per field reach the judge; the response reports truncated:true and " +
    "dropped:N when more were found (no silent truncation). Document at most 20,000 chars, at most " +
    "64 fields per call (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      document: { type: "string", maxLength: LIMITS.maxStateChars, description: "Source document (max 20,000 chars)." },
      fields: {
        type: "array",
        maxItems: LIMITS.maxExtractFields,
        description:
          "Fields to extract (max 64). Each needs `id` and `description`. Regex mode additionally needs " +
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
    return Array.from(document.matchAll(re), (m) => m[0]);
  } catch {
    return [];
  }
}

export interface ExtractTruncation {
  truncated: boolean;
  dropped: number;
}

function assertExtractBudget(args: Record<string, unknown>): { document: string; fields: FieldSpec[] } {
  const document = String(args.document ?? "");
  const fields = (Array.isArray(args.fields) ? args.fields : []) as FieldSpec[];
  // The whole document rides along as Laya state on every path, so the
  // server state cap applies here even for pure-regex calls (fail fast with
  // the same vocabulary instead of a /predict 413 round trip).
  assertLength(
    document,
    LIMITS.maxStateChars,
    "document",
    `laya_extract document exceeds ${LIMITS.maxStateChars} chars; shorten it or extract per section`,
  );
  assertCount(
    fields.length,
    LIMITS.maxExtractFields,
    "fields",
    `laya_extract accepts at most ${LIMITS.maxExtractFields} fields per call (one server question each); split into batches`,
  );
  return { document, fields };
}

export function buildRegexQuestionsWithInfo(
  args: Record<string, unknown>,
): { questions: Record<string, unknown> } & ExtractTruncation {
  const { document, fields } = assertExtractBudget(args);
  const out: Record<string, unknown> = {};
  let dropped = 0;
  fields.forEach((f: FieldSpec, i: number) => {
    if (!f || typeof f.id !== "string" || typeof f.pattern !== "string") return;
    const all = regexCandidates(document, f.pattern);
    if (all.length > LIMITS.maxExtractCandidates) dropped += all.length - LIMITS.maxExtractCandidates;
    const candidates = all.slice(0, LIMITS.maxExtractCandidates);
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
  return { questions: out, truncated: dropped > 0, dropped };
}

function buildRegexQuestions(args: Record<string, unknown>): Record<string, unknown> {
  return buildRegexQuestionsWithInfo(args).questions;
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
  const { document, fields } = assertExtractBudget(args);
  const source = args.source === "regex" || args.source === "entities" ? args.source : "auto";
  const glinerReady = ctx?.glinerReady() ?? false;

  const useEntities = source === "entities" || (source === "auto" && glinerReady);
  let fallbackNote: string | undefined;
  let spanIndex: Record<string, Record<string, SpanChoice>> = {};
  let truncation: ExtractTruncation = { truncated: false, dropped: 0 };

  let questions: Record<string, unknown>;
  if (useEntities && ctx) {
    try {
      const types = [...new Set(fields.flatMap((f) => (f?.id ? [f.entity_type ?? f.id, f.id] : [])))];
      const { spansByType, latencyMs } = await ctx.gliner.extractEntities(document, types);
      void latencyMs;
      const built = buildEntityQuestions(fields, spansByType);
      questions = built.questions;
      spanIndex = built.spanIndex;
      let dropped = 0;
      for (const f of fields) {
        if (!f || typeof f.id !== "string") continue;
        const spans = spansByType[f.entity_type ?? f.id] ?? spansByType[f.id] ?? [];
        if (spans.length > LIMITS.maxExtractCandidates) dropped += spans.length - LIMITS.maxExtractCandidates;
      }
      truncation = { truncated: dropped > 0, dropped };
    } catch (err) {
      if (source === "entities") throw err;
      fallbackNote = `GLiNER unavailable (${err instanceof Error ? err.message : String(err)}); fell back to regex.`;
      const built = buildRegexQuestionsWithInfo(args);
      questions = built.questions;
      truncation = { truncated: built.truncated, dropped: built.dropped };
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
    const built = buildRegexQuestionsWithInfo(args);
    questions = built.questions;
    truncation = { truncated: built.truncated, dropped: built.dropped };
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
    const fieldEvidence: ExtractFieldEvidence[] = [];
    const entitySource = useEntities && !fallbackNote;
    fields.forEach((f, i) => {
      if (!f || typeof f.id !== "string") return;
      const key = `extract_${i}_${f.id}`;
      const ans = a[key];
      const choice = ans?.choice ?? "none";
      // P1-T6: legacy decision, engine-owned (choice/value below). The
      // legacy `confidence` number is now the honest `winner_probability`
      // (null when the answer is missing or the dict came back empty).
      // P1-T3 bugfix preserved: Math.max(...[]) is -Infinity for an empty
      // dict; JSON already serialized -Infinity as null, so legacy
      // consumers reading null see no change, while consumers reading 0
      // for missing answers see the honest null (breaking, documented).
      const entry: Record<string, unknown> = {
        id: f.id,
        winner_probability: ans ? (winnerOf(ans.probabilities ?? {}) ?? null) : null,
      };
      let candidateCount = 0;
      let invalidPattern = false;
      let span: ExtractFieldEvidence["span"] = null;
      let detectorScore: number | null = null;
      let entityType: string | null = null;
      if (choice === "none") {
        entry.value = null;
        entry.status = "not_found";
        // Regex path with a firm "none": the judge may still have seen (and
        // rejected) candidates -- count them so abstention only fires when
        // there truly were zero candidates (or an invalid pattern).
        if (!entitySource && typeof f.pattern === "string") {
          try {
            candidateCount = regexCandidates(document, f.pattern).slice(0, LIMITS.maxExtractCandidates).length;
          } catch {
            invalidPattern = true;
          }
        }
      } else if (spanIndex[key]?.[choice]) {
        const s = spanIndex[key][choice].span;
        entry.value = s.text;
        entry.status = "extracted";
        entry.start = s.start;
        entry.end = s.end;
        entry.entity_type = s.type;
        entry.detector_score = s.confidence;
        span = { start: s.start, end: s.end };
        detectorScore = typeof s.confidence === "number" ? s.confidence : null;
        entityType = s.type;
      } else {
        // Regex path: the choice key (m{n}) is not the value; resolve it.
        // Recompute candidates deterministically to map key -> substring
        // (same 20-cap the judge saw, so m{n} always lines up).
        const cands = f.pattern
          ? regexCandidates(document, f.pattern).slice(0, LIMITS.maxExtractCandidates)
          : [];
        const m = /^m(\d+)$/.exec(choice);
        const idx = m ? Number(m[1]) : -1;
        entry.value = idx >= 0 && idx < cands.length ? cands[idx] : null;
        entry.status = entry.value === null ? "not_found" : "extracted";
        candidateCount = cands.length;
        if (typeof f.pattern === "string") {
          try {
            new RegExp(f.pattern, "g");
          } catch {
            invalidPattern = true;
          }
        }
      }
      if (entitySource) {
        // Entity path: the judge saw one criterion per GLiNER span (20-cap).
        candidateCount = Object.keys(spanIndex[key] ?? {}).length;
      }
      results.push(entry);
      fieldEvidence.push({
        fieldId: f.id,
        question: key,
        choice: typeof ans?.choice === "string" ? ans.choice : null,
        distribution: (ans?.probabilities as Record<string, number> | undefined) ?? null,
        candidateCount,
        invalidPattern,
        source: entitySource ? "gliner" : "regex",
        span,
        detectorScore,
        entityType: entityType ?? f.entity_type ?? f.id,
        value: entry.value,
        status: typeof entry.status === "string" ? entry.status : undefined,
      });
    });
    const out: Record<string, unknown> = {
      results,
      source: useEntities && !fallbackNote ? "entities" : "regex",
      truncated: truncation.truncated,
      dropped: truncation.dropped,
      latency_ms: raw.latencyMs,
    };
    if (fallbackNote) out.fallback = fallbackNote;
    if (raw.routing && Object.keys(raw.routing).length > 0) out.routing = raw.routing;
    const { evidence, abstention } = extractEvidence(raw, {
      fields: fieldEvidence,
      source: useEntities && !fallbackNote ? "entities" : "regex",
    });
    // P1-T6: decision owned by the engine. T3 abstention (zero-candidate /
    // invalid-pattern fields) is now authoritative via the ESCALATE exit --
    // consumers must not act on values when the decision escalates. No
    // threshold literal lives here: v1 firmness is candidates-existed and
    // pattern-parsed.
    const { thresholds } = getPolicy("extract", "1.0.0");
    const decision = evaluate(
      {
        evidence,
        abstention,
        context: {
          field_count: fieldEvidence.length,
          candidate_source: useEntities && !fallbackNote ? "entities" : "regex",
        },
        risk: "normal",
        policy: { name: "extract", version: "1.0.0" },
      },
      { thresholds },
    );
    out.decision = decision;
    out.evidence = evidence;
    out.abstention = abstention;
    return JSON.stringify(out, null, 2);
  }, judgeOpts);
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
