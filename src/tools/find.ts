import type { LayaClient } from "../client.js";
import { findEvidence, winnerOf } from "../evidence.js";
import { LIMITS, assertCount } from "../limits.js";
import { evaluateForTool } from "../policy/mode.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, shadowSchema, envelopeMetadataProperties } from "../tool.js";

export const findTool: ToolDefinition = {
  name: "laya_find",
  description:
    "Pick the best candidate id for a query from a list, or report that none of them answers. " +
    "Cheaper than calling the main LLM for routing decisions over up to 250 candidates. " +
    "Lists above 250 are rejected with input_too_large (no silent truncation). " +
    "Returns the winner with its raw, uncalibrated distribution and winner_probability (never a " +
    "confidence) plus the deterministic ALLOW/ESCALATE `decision` from the versioned find@1.0.0 policy. " +
    "An ESCALATE decision is authoritative: do not act on the winner when the decision escalates. " +
    "A cheap deterministic pre-filter (lexical token-overlap ranking plus exact-duplicate removal, " +
    "no LLM) optionally narrows the pool to `top_k` before the judge (default 250 and min_score 0 " +
    "= legacy: every candidate reaches the judge, zero breaking). The response reports `pruned` " +
    "and `pruning:{kept, dropped, method}`; the 1/N weak-winner baseline always uses the real " +
    "pre-pruning candidate count.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Plain-language query the candidate should answer." },
      candidates: {
        type: "array",
        maxItems: LIMITS.maxFindCandidates,
        description: "Candidate list (max 250). Each entry needs `id` (returned verbatim) and `text` (the candidate's body).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
          },
          required: ["id", "text"],
        },
      },
      top_k: {
        type: "integer",
        minimum: 1,
        maximum: LIMITS.maxFindCandidates,
        description:
          "Max candidates sent to the judge (default 250 = legacy behaviour: no pruning). " +
          "When below the pool size the pool is ranked by query token-overlap (exact duplicates " +
          "removed first, ties keep input order) and only the top top_k reach the judge. " +
          "Above 250 is rejected with input_too_large.",
      },
      min_score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Minimum query token-overlap for a candidate to reach the judge (default 0 = no " +
          "filtering = legacy behaviour): |query tokens present in the candidate| / |query tokens| " +
          "after case/diacritic/punctuation-insensitive normalization. Candidates below the cut " +
          "are dropped before the top_k cap (counted in dropped, never silent). Must be in [0,1].",
      },
    },
    required: ["query", "candidates"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      ...envelopeMetadataProperties(),
      winner: { type: "string", description: "Winning candidate id, or 'none'." },
      exists: { type: "boolean" },
      distribution: { type: "object" },
      winner_probability: {
        type: ["number", "null"],
        description: "Top raw share (never a confidence); null when the dict came back empty.",
      },
      decision: decisionSchema(["ALLOW", "ESCALATE"]),
      shadow: shadowSchema(),
      latency_ms: { type: "number" },
      evidence: evidenceSchema("Find evidence bundle (choice + distribution signals)."),
      abstention: abstentionSchema(),
      pruned: { type: "boolean" },
      pruning: {
        type: "object",
        properties: {
          kept: { type: "integer" },
          dropped: { type: "integer" },
          method: { type: "string" },
        },
        required: ["kept", "dropped", "method"],
      },
    },
    required: [
      "winner",
      "exists",
      "distribution",
      "winner_probability",
      "decision",
      "latency_ms",
      "evidence",
      "abstention",
      "pruned",
      "pruning",
    ],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  buildQuestions: (args) => buildFindQuestionsWithInfo(args).questions,
};

/**
 * Fase-4 T4: cheap deterministic pre-filter for the find candidate pool.
 *
 * Method `token-overlap+exact-dedup` (no LLM, no embeddings):
 *   1. normalize query + candidates (lowercase, diacritics stripped,
 *      non-letters/digits -> space) and split into tokens;
 *   2. score each candidate by query-token coverage:
 *      |query tokens present in the candidate| / |query tokens|
 *      (0 when the query has no tokens);
 *   3. drop exact duplicates (identical normalized token sequences -- case,
 *      punctuation, whitespace and diacritic insensitive), first kept;
 *   4. drop candidates below min_score, stable-sort the rest by score desc
 *      (ties keep input order), keep the first top_k.
 *
 * The filter ONLY runs when it would do something (top_k < pool size or
 * min_score > 0); default calls take the legacy path verbatim (original
 * order, duplicates included -- zero breaking by default). `none` is never
 * filtered: it is always appended as a criterion, so a fully-pruned pool
 * still resolves through the existing none/empty abstention path (ESCALATE,
 * no policy change).
 */
export const FIND_PRUNE_METHOD = "token-overlap+exact-dedup";

/** Normalize text for lexical comparison: lowercase, no diacritics, token list. */
export function tokenizeForFind(text: string): string[] {
  const norm = String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return norm === "" ? [] : norm.split(/\s+/);
}

/**
 * Query-token coverage of a candidate: fraction of distinct query tokens
 * present among the candidate tokens. Pure; 0 when the query has no tokens
 * (an empty query ranks nothing above anything else -- ties keep order).
 */
export function overlapScore(queryTokens: readonly string[], candidateTokens: readonly string[]): number {
  const distinct = new Set(queryTokens);
  if (distinct.size === 0) return 0;
  const cand = new Set(candidateTokens);
  let hit = 0;
  for (const t of distinct) if (cand.has(t)) hit++;
  return hit / distinct.size;
}

/**
 * Fase-4 T4: optional pruning selection (mirrors the T3
 * `resolveExtractSelection` style).
 *
 *   - top_k: max candidates reaching the judge, default 250 (= legacy: the
 *     whole pool reaches the judge). Integer >= 1; above the 250 hard cap is
 *     rejected with input_too_large (same ceiling, same vocabulary).
 *   - min_score: minimum overlapScore, default 0 (= legacy: no filtering).
 *     Number in [0,1].
 */
export interface FindSelection {
  topK: number;
  minScore: number;
}

export function resolveFindSelection(args: Record<string, unknown>): FindSelection {
  const rawTopK = args.top_k ?? null;
  let topK: number = LIMITS.maxFindCandidates;
  if (rawTopK !== null && rawTopK !== undefined) {
    if (typeof rawTopK !== "number" || !Number.isInteger(rawTopK) || rawTopK < 1) {
      throw new Error(`laya_find top_k must be an integer >= 1 (got ${JSON.stringify(rawTopK)})`);
    }
    topK = rawTopK;
  }
  assertCount(
    topK,
    LIMITS.maxFindCandidates,
    "top_k",
    `laya_find top_k exceeds the ${LIMITS.maxFindCandidates}-candidate ceiling; split the list and merge winners`,
  );
  const rawScore = args.min_score ?? 0;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore) || rawScore < 0 || rawScore > 1) {
    throw new Error(`laya_find min_score must be a number in [0,1] (got ${JSON.stringify(rawScore)})`);
  }
  return { topK, minScore: rawScore };
}

export interface ScoredFindCandidate {
  id: string;
  text: string;
  /** Lexical pre-filter score (query-token coverage in [0,1]; 0 on the legacy path). */
  score: number;
}

export interface FindPruning {
  kept: number;
  dropped: number;
  method: string;
}

/**
 * Rank/filter/dedupe a valid-id candidate pool. Pure, so the builder and
 * tests share it. Inactive (topK >= pool size and minScore <= 0) returns the
 * pool verbatim in input order with score 0 -- the legacy path.
 */
export function selectFindCandidates(
  pool: Array<{ id: string; text: string }>,
  query: string,
  selection: FindSelection,
): { shown: ScoredFindCandidate[]; dropped: number; pruned: boolean } {
  const active = selection.topK < pool.length || selection.minScore > 0;
  if (!active) {
    return { shown: pool.map((c) => ({ id: c.id, text: c.text, score: 0 })), dropped: 0, pruned: false };
  }
  const queryTokens = tokenizeForFind(query);
  const seen = new Set<string>();
  const scored: Array<ScoredFindCandidate & { index: number }> = [];
  pool.forEach((c, index) => {
    const key = tokenizeForFind(c.text).join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    const score = overlapScore(queryTokens, tokenizeForFind(c.text));
    if (score >= selection.minScore) scored.push({ id: c.id, text: c.text, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const shown = scored.slice(0, selection.topK).map(({ id, text, score }) => ({ id, text, score }));
  const dropped = pool.length - shown.length;
  return { shown, dropped, pruned: dropped > 0 };
}

export function buildFindQuestionsWithInfo(args: Record<string, unknown>): {
  questions: Record<string, unknown>;
  shown: ScoredFindCandidate[];
  pruned: boolean;
  pruning: FindPruning;
} {
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  assertCount(
    candidates.length,
    LIMITS.maxFindCandidates,
    "candidates",
    `laya_find accepts at most ${LIMITS.maxFindCandidates} candidates per call; split the list and merge winners`,
  );
  const selection = resolveFindSelection(args);
  const pool: Array<{ id: string; text: string }> = [];
  for (const c of candidates) {
    if (c && typeof c.id === "string") pool.push({ id: c.id, text: String(c.text ?? "") });
  }
  const { shown, dropped, pruned } = selectFindCandidates(pool, String(args.query ?? ""), selection);
  const criteria: Record<string, string> = {};
  for (const c of shown) {
    criteria[c.id] = c.text.slice(0, 240);
  }
  criteria.none = "None of the candidates addresses the query.";
  return {
    questions: {
      exists: {
        type: "choice",
        instructions: `Pick the candidate that best answers the query: "${args.query ?? ""}". If none of them address it, choose 'none'.`,
        criteria,
      },
    },
    shown,
    pruned,
    pruning: { kept: shown.length, dropped, method: FIND_PRUNE_METHOD },
  };
}

/**
 * P1-T6 (breaking): `laya_find` routes the winner through the engine. The
 * legacy `probabilities` dict (uncalibrated shares labelled as a confidence
 * probability) is now `distribution` with the honest `winner_probability`
 * top share (null when the dict came back empty), and the output carries
 * the ALLOW-or-ESCALATE `decision` from find@1.0.0. The winner value itself
 * is unchanged (firm, unique, above-baseline winners still ALLOW); T3
 * abstention bands (none/empty/tie/weak) are now authoritative via the
 * engine ESCALATE exit -- consumers must not act on the winner when the
 * decision escalates. No threshold literal lives here: the 1/N weak-winner
 * baseline reads context.candidateCount inside the policy.
 *
 * Fase-4 T4 (additive, no policy change -- find stays 1.0.0): the candidate
 * pool optionally passes through the cheap token-overlap+exact-dedup
 * pre-filter (top_k/min_score, defaults = legacy: every candidate reaches
 * the judge). `none` is always sent, `candidateCount` is always the REAL
 * pre-pruning pool size (pruning changes counts, never the contract shape),
 * and the output appends the additive `pruned` + `pruning:{kept, dropped,
 * method}` report (plus a `pruning` mirror on evidence.metadata; signals
 * untouched). A fully-pruned pool sends criteria { none } only, which
 * resolves through the pre-existing none path to authoritative ESCALATE.
 */
export async function handleFind(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const built = buildFindQuestionsWithInfo(args);
  const result = await runTool(client, args, built.questions, (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const choice = a.exists?.choice ?? "none";
    const distribution = (a.exists?.probabilities as Record<string, number> | undefined) ?? null;
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const { evidence, abstention } = findEvidence(raw, {
      choice: typeof a.exists?.choice === "string" ? a.exists.choice : null,
      distribution,
      candidateCount: candidates.length,
    });
    // P1-T6: decision owned by the engine (shared table resolved for uniformity;
    // find@1.0.0 applies no numeric cut -- firmness is presence + uniqueness).
    const { thresholds } = getPolicy("find", "1.0.0");
    const { decision, shadow } = evaluateForTool(
      "laya_find",
      {
        evidence,
        abstention,
        context: { candidateCount: candidates.length, query_chars: String(args.query ?? "").length },
        risk: "normal",
        policy: { name: "find", version: "1.0.0" },
      },
      { thresholds },
    );
    // T4 additive pruning report on the evidence bundle (signals untouched).
    evidence.metadata = { ...(evidence.metadata ?? {}), pruning: { ...built.pruning } };
    return JSON.stringify(
      {
        winner: choice,
        exists: choice !== "none",
        distribution: distribution ?? {},
        winner_probability: winnerOf(distribution ?? null),
        decision,
        ...(shadow ? { shadow } : {}),
        latency_ms: raw.latencyMs,
        evidence,
        abstention,
        pruned: built.pruned,
        pruning: built.pruning,
      },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
