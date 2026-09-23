import type { LayaClient } from "../client.js";
import type { GlinerClient, GlinerSpan } from "../gliner.js";
import type { ToolContext } from "../index.js";
import { extractEvidence, winnerOf, type ExtractFieldEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength, extractLimitsFromEnv } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema } from "../tool.js";

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
    "At most max_candidates per field reach the judge (default 20 = legacy behaviour; top_k further " +
    "narrows the shown set, min_gliner_score drops low-confidence GLiNER spans before sorting by " +
    "detector_score); the response reports truncated:true and " +
    "dropped:N when more were proposed than shown (over-cap or below min_gliner_score -- never silent). " +
    "Every returned value is a verbatim substring of the document with character offsets " +
    "(regex results carry start/end since fase-4 T3; entity results already did); a judge choice " +
    "that does not map to an exact span resolves to null/not_found, never a synthesized string. " +
    "Document at most 20,000 chars, at most " +
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
      top_k: {
        type: "integer",
        minimum: 1,
        description:
          "Max candidates per field sent to the judge (default 20 = legacy behaviour). " +
          "The shown set is the first top_k of the proposed candidates " +
          "(regex: document order; entities: detector_score order after min_gliner_score " +
          "filtering), further narrowed by max_candidates. Above the " +
          "LAYA_LIMITS_MAX_EXTRACT_CANDIDATES ceiling (default 20) is rejected " +
          "with input_too_large.",
      },
      max_candidates: {
        type: "integer",
        minimum: 1,
        description:
          "Hard ceiling per field on candidates reaching the judge (default 20 = legacy " +
          "behaviour). Effective shown set is min(top_k, max_candidates). Above the " +
          "LAYA_LIMITS_MAX_EXTRACT_CANDIDATES ceiling (default 20) is rejected " +
          "with input_too_large.",
      },
      min_gliner_score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Minimum GLiNER confidence for entity candidates (default 0 = no filtering = " +
          "legacy behaviour; null = default). Applies to the entities path only; spans below the cut " +
          "are dropped before sorting (never reach the judge, counted in dropped). " +
          "Must be in [0,1].",
      },
    },
    required: ["document", "fields"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            value: {
              type: ["string", "null"],
              description: "Verbatim document substring, or null when not found (never synthesized).",
            },
            status: { type: "string", enum: ["extracted", "not_found"] },
            winner_probability: { type: ["number", "null"] },
            start: { type: "integer" },
            end: { type: "integer" },
            entity_type: { type: "string" },
            detector_score: { type: ["number", "null"] },
          },
          required: ["id", "value", "status", "winner_probability"],
        },
      },
      source: { type: "string", enum: ["regex", "entities"] },
      truncated: { type: "boolean" },
      dropped: { type: "integer" },
      fallback: { type: "string" },
      routing: { type: "object" },
      decision: decisionSchema(["ALLOW", "ESCALATE"]),
      latency_ms: { type: "number" },
      evidence: evidenceSchema("Extract evidence bundle (per-field choice signals)."),
      abstention: abstentionSchema(),
    },
    required: ["results", "source", "truncated", "dropped", "latency_ms", "decision", "evidence", "abstention"],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  buildQuestions: (args) => buildRegexQuestions(args),
};

interface FieldSpec {
  id?: string;
  pattern?: string;
  description?: string;
  entity_type?: string;
}

export interface RegexCandidate {
  text: string;
  start: number;
  end: number;
}

function regexCandidates(document: string, pattern: string): RegexCandidate[] {
  try {
    const re = new RegExp(pattern, "g");
    const out: RegexCandidate[] = [];
    for (const m of document.matchAll(re)) {
      const text = m[0];
      const start = m.index ?? 0;
      out.push({ text, start, end: start + text.length });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fase-4 T3: configurable candidate selection.
 *
 *   - top_k / max_candidates: per-field shown set is min(top_k,
 *     max_candidates); each defaults to 20 (legacy slice(0,20) behaviour,
 *     zero breaking by default). Each must be an integer >= 1; values above
 *     the LAYA_LIMITS_MAX_EXTRACT_CANDIDATES ceiling (default 20, read from
 *     the live env at call time) are rejected with input_too_large.
 *   - min_gliner_score: entities-path filter on GLiNER confidence, default 0
 *     (no filtering = legacy behaviour). Must be a number in [0,1].
 */
export interface ExtractSelection {
  topK: number;
  maxCandidates: number;
  minGlinerScore: number;
  /** Effective per-field shown set: min(topK, maxCandidates). */
  shown: number;
}

function parsePositiveIntParam(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`laya_extract ${name} must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function resolveExtractSelection(args: Record<string, unknown>): ExtractSelection {
  const ceiling = extractLimitsFromEnv().maxExtractCandidates;
  // Defaults follow a lowered operator ceiling so default callers never
  // throw; a raised ceiling keeps the legacy 20 default (zero breaking).
  const fallback = Math.min(LIMITS.maxExtractCandidates, ceiling);
  const topK = parsePositiveIntParam(args.top_k, "top_k") ?? fallback;
  const maxCandidates = parsePositiveIntParam(args.max_candidates, "max_candidates") ?? fallback;
  assertCount(topK, ceiling, "top_k", "laya_extract top_k exceeds the candidate ceiling; raise LAYA_LIMITS_MAX_EXTRACT_CANDIDATES or request fewer");
  assertCount(
    maxCandidates,
    ceiling,
    "max_candidates",
    "laya_extract max_candidates exceeds the candidate ceiling; raise LAYA_LIMITS_MAX_EXTRACT_CANDIDATES or request fewer",
  );
  const rawScore = args.min_gliner_score ?? 0;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore) || rawScore < 0 || rawScore > 1) {
    throw new Error(`laya_extract min_gliner_score must be a number in [0,1] (got ${JSON.stringify(rawScore)})`);
  }
  return { topK, maxCandidates, minGlinerScore: rawScore, shown: Math.min(topK, maxCandidates) };
}

/**
 * Entities pipeline: GLiNER proposes -> drop spans below minGlinerScore ->
 * sort by confidence descending (stable: ties keep sidecar order) -> top
 * `shown`. Pure, so builders and the judge-answer resolver share it and
 * g{n} keys always line up.
 */
export function selectEntitySpans(spans: GlinerSpan[], minGlinerScore: number, shown: number): GlinerSpan[] {
  return spans
    .filter((s) => typeof s.confidence === "number" && s.confidence >= minGlinerScore)
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, shown);
}

/**
 * Grounded-value invariant: a candidate only counts when its [start:end]
 * slice of the ORIGINAL document equals its text. Regex offsets come from
 * matchAll so they hold by construction; sidecar spans are re-checked
 * because a mismatched span must resolve to null/not_found, never to a
 * synthesized or shifted string.
 */
export function isGrounded(document: string, text: string, start: number, end: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= document.length &&
    start <= end &&
    document.slice(start, end) === text
  );
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
  const selection = resolveExtractSelection(args);
  const out: Record<string, unknown> = {};
  let dropped = 0;
  fields.forEach((f: FieldSpec, i: number) => {
    if (!f || typeof f.id !== "string" || typeof f.pattern !== "string") return;
    const all = regexCandidates(document, f.pattern);
    // Regex keeps document order: the judge sees the FIRST `shown` matches.
    const candidates = all.slice(0, selection.shown);
    if (all.length > candidates.length) dropped += all.length - candidates.length;
    const criteria: Record<string, string> = {};
    candidates.forEach((c, idx) => {
      criteria[`m${idx}`] = c.text.slice(0, 240);
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
  selection: ExtractSelection,
): { questions: Record<string, unknown>; spanIndex: Record<string, Record<string, SpanChoice>> } {
  const questions: Record<string, unknown> = {};
  const spanIndex: Record<string, Record<string, SpanChoice>> = {};
  fields.forEach((f, i) => {
    if (!f || typeof f.id !== "string") return;
    const etype = f.entity_type ?? f.id;
    const proposed = spansByType[etype] ?? spansByType[f.id] ?? [];
    const shown = selectEntitySpans(proposed, selection.minGlinerScore, selection.shown);
    const criteria: Record<string, string> = {};
    const index: Record<string, SpanChoice> = {};
    shown.forEach((s, idx) => {
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
  const selection = resolveExtractSelection(args);
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
      const built = buildEntityQuestions(fields, spansByType, selection);
      questions = built.questions;
      spanIndex = built.spanIndex;
      let dropped = 0;
      for (const f of fields) {
        if (!f || typeof f.id !== "string") continue;
        const proposed = spansByType[f.entity_type ?? f.id] ?? spansByType[f.id] ?? [];
        const shown = selectEntitySpans(proposed, selection.minGlinerScore, selection.shown);
        if (proposed.length > shown.length) dropped += proposed.length - shown.length;
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
            candidateCount = regexCandidates(document, f.pattern).slice(0, selection.shown).length;
          } catch {
            invalidPattern = true;
          }
        }
      } else if (spanIndex[key]?.[choice]) {
        const s = spanIndex[key][choice].span;
        // Grounded: the sidecar span only counts when its [start:end] slice
        // of the ORIGINAL document equals its text. A mismatched span (or a
        // forged choice key that somehow hit the index) resolves to
        // null/not_found -- never a synthesized or shifted string.
        if (isGrounded(document, s.text, s.start, s.end)) {
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
          entry.value = null;
          entry.status = "not_found";
        }
      } else {
        // Regex path: the choice key (m{n}) is not the value; resolve it.
        // Recompute candidates deterministically to map key -> substring
        // (same shown set the judge saw, so m{n} always lines up). A choice
        // outside the shown set (e.g. a hallucinated m99) resolves to
        // null/not_found -- never synthesized.
        const cands = f.pattern
          ? regexCandidates(document, f.pattern).slice(0, selection.shown)
          : [];
        const m = /^m(\d+)$/.exec(choice);
        const idx = m ? Number(m[1]) : -1;
        const cand = idx >= 0 && idx < cands.length ? cands[idx] : null;
        if (cand && isGrounded(document, cand.text, cand.start, cand.end)) {
          entry.value = cand.text;
          entry.status = "extracted";
          entry.start = cand.start;
          entry.end = cand.end;
        } else {
          entry.value = null;
          entry.status = "not_found";
        }
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
        // Entity path: the judge saw one criterion per shown GLiNER span
        // (post-filter, post-cap). A fully-filtered field reports 0, which
        // surfaces as ESCALATE via the engine abstained_evidence rule (the
        // policy-level extract_no_candidates documents the same condition).
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
