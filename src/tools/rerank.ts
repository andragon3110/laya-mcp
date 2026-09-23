import type { LayaClient } from "../client.js";
import { rerankEvidence } from "../evidence.js";
import { LIMITS, assertCount } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool } from "../tool.js";
import { overlapScore, tokenizeForFind } from "./find.js";

export interface RerankCandidate {
  id?: string;
  text?: string;
}

export interface RerankTruncation {
  candidates: RerankCandidate[];
  truncated: boolean;
  truncatedIds: string[];
}

/**
 * Apply the documented 2000-char per-candidate truncation for real (the
 * description always claimed it; no code did). Pure function so it is
 * testable without a server. State sent to /predict carries the truncated
 * texts; ids and ordering keys are untouched.
 */
export function truncateRerankCandidates(candidates: RerankCandidate[]): RerankTruncation {
  const truncatedIds: string[] = [];
  const out = candidates.map((c) => {
    const text = String(c?.text ?? "");
    if (text.length <= LIMITS.maxRerankCandidateChars) return c;
    if (typeof c?.id === "string") truncatedIds.push(c.id);
    return { ...c, text: text.slice(0, LIMITS.maxRerankCandidateChars) };
  });
  return { candidates: out, truncated: truncatedIds.length > 0, truncatedIds };
}

export const rerankTool: ToolDefinition = {
  name: "laya_rerank",
  description:
    "Score every candidate's relevance to a query and return them sorted. Each candidate gets its own raw, " +
    "uncalibrated relevance_score (the Router noul output: HIGHER means more relevant WITHIN this call only -- " +
    "it is NOT a probability or confidence, 0.9 does NOT mean 90%, scores are NOT comparable across calls or " +
    "checkpoints, and no cutoff on the score is meaningful; act only on the ALLOW/ESCALATE decision, never on " +
    "the number), " +
    "so the whole ordering survives. Use for retrieval reranking, near-duplicate triage, or ordering a feed. " +
    "The ordering is informational: the deterministic ALLOW/ESCALATE `decision` from the versioned rerank@1.0.0 " +
    "policy authorizes USE of the ordering, and an ESCALATE decision is authoritative (do not trust the order " +
    "when the decision escalates). " +
    "At most 64 candidates per call (larger pools are rejected with input_too_large, never silently cut); " +
    "each candidate text is truncated to 2,000 chars and the response sets " +
    "truncated:true (with truncated_ids) when any judged candidate was cut. " +
    "Optional top_k (default 64 = legacy: every candidate reaches the judge): when the pool is larger, a cheap " +
    "deterministic token-overlap pre-filter (no LLM, no dedupe) keeps the best K and Laya orders that top-K " +
    "shortlist -- the final order is the judge's, the pre-filter rank never leaks into relevance_score; the " +
    "response reports pruned:true with pruning:{kept, dropped, method}.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Query the candidates should be ranked against." },
      candidates: {
        type: "array",
        maxItems: LIMITS.maxRerankCandidates,
        description: "Candidate list (max 64). Each entry needs `id` and `text` (truncated to 2,000 chars internally).",
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["id", "text"],
        },
      },
      top_k: {
        type: "integer",
        minimum: 1,
        description:
          "Max candidates sent to the judge (default 64 = legacy behaviour: no pruning). " +
          "When below the pool size the pool is ranked by query token-overlap (ties keep input order, " +
          "exact duplicates are kept -- near-duplicate triage needs them visible) and only the top top_k " +
          "reach the judge, which decides the final order. Above 64 is rejected with input_too_large.",
      },
    },
    required: ["query", "candidates"],
    additionalProperties: false,
  },
  buildQuestions: (args) => buildRerankQuestionsWithInfo(args).questions,
};

/**
 * Fase-4 T5: optional count-based pre-selection (mirrors the T3/T4
 * `resolve*Selection` style).
 *
 *   - top_k: max candidates reaching the judge, default 64 (= legacy: the
 *     whole pool reaches the judge). Integer >= 1; above the 64 hard cap is
 *     rejected with input_too_large (same ceiling, same vocabulary).
 *
 * Why there is NO min_relevance param (deliberate, pinned by test): the
 * relevance_score is the raw, uncalibrated Router noul output with no
 * documented scale, so a caller-supplied cutoff would be uninterpretable
 * (0.9 is not 90%, scores do not transfer across calls or checkpoints) and
 * non-portable; rerank@1.0.0 authorizes USE of the ordering and never cuts
 * (v1 sorts only); and the cheap pre-filter cannot estimate noul without
 * the judge, so the only sound cut point is count-based (top_k) BEFORE the
 * judge. A score cut would need calibrated scores + a policy change -- both
 * out of scope (see task Constraints: no calibration).
 */
export interface RerankSelection {
  topK: number;
}

export function resolveRerankSelection(args: Record<string, unknown>): RerankSelection {
  const rawTopK = args.top_k ?? null;
  let topK: number = LIMITS.maxRerankCandidates;
  if (rawTopK !== null && rawTopK !== undefined) {
    if (typeof rawTopK !== "number" || !Number.isInteger(rawTopK) || rawTopK < 1) {
      throw new Error(`laya_rerank top_k must be an integer >= 1 (got ${JSON.stringify(rawTopK)})`);
    }
    topK = rawTopK;
  }
  assertCount(
    topK,
    LIMITS.maxRerankCandidates,
    "top_k",
    `laya_rerank top_k exceeds the ${LIMITS.maxRerankCandidates}-candidate ceiling; split the list and merge orderings`,
  );
  return { topK };
}

/**
 * Fase-4 T5: cheap deterministic pre-filter for the rerank candidate pool.
 *
 * Method `token-overlap` (no LLM, no embeddings; tokenizer + scorer shared
 * with the T4 find pre-filter): score each candidate by query-token coverage
 * (overlapScore over tokenizeForFind), stable-sort desc (ties keep input
 * order), keep the first top_k. Runs ONLY when top_k < pool size; default
 * calls take the legacy path verbatim (input order, zero breaking).
 *
 * Unlike find's `token-overlap+exact-dedup`, rerank does NOT dedupe: the
 * contract returns one rank per input candidate and near-duplicate triage
 * is an advertised use, so collapsing entries would silently drop
 * caller-requested rows. Equal texts tie on the pre-score and keep input
 * order; the judge still assigns each its own relevance_score.
 *
 * The pre-filter ONLY selects the shortlist: the final order is Laya's over
 * the top-K (pre-filter rank never leaks into relevance_score or `rank`).
 */
export const RERANK_PRUNE_METHOD = "token-overlap";

export interface ScoredRerankCandidate {
  id: string;
  text: string;
  /** Lexical pre-filter score (query-token coverage in [0,1]; 0 on the legacy path). */
  preScore: number;
  /** Position in the input pool (valid-id entries only); keys judge answers back to it. */
  inputIndex: number;
}

export interface RerankPruning {
  kept: number;
  dropped: number;
  method: string;
}

export function selectRerankCandidates(
  pool: Array<{ id: string; text: string }>,
  query: string,
  selection: RerankSelection,
): { shown: ScoredRerankCandidate[]; dropped: number; pruned: boolean } {
  if (selection.topK >= pool.length) {
    return {
      shown: pool.map((c, inputIndex) => ({ id: c.id, text: c.text, preScore: 0, inputIndex })),
      dropped: 0,
      pruned: false,
    };
  }
  const queryTokens = tokenizeForFind(query);
  const scored: Array<ScoredRerankCandidate & { order: number }> = pool.map((c, inputIndex) => ({
    id: c.id,
    text: c.text,
    preScore: overlapScore(queryTokens, tokenizeForFind(c.text)),
    inputIndex,
    order: inputIndex,
  }));
  scored.sort((a, b) => b.preScore - a.preScore || a.order - b.order);
  const shown = scored.slice(0, selection.topK).map(({ id, text, preScore, inputIndex }) => ({
    id,
    text,
    preScore,
    inputIndex,
  }));
  const dropped = pool.length - shown.length;
  return { shown, dropped, pruned: dropped > 0 };
}

export function buildRerankQuestionsWithInfo(args: Record<string, unknown>): {
  questions: Record<string, unknown>;
  shown: ScoredRerankCandidate[];
  pruned: boolean;
  pruning: RerankPruning;
} {
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  assertCount(
    candidates.length,
    LIMITS.maxRerankCandidates,
    "candidates",
    `laya_rerank accepts at most ${LIMITS.maxRerankCandidates} candidates per call (one question each); split the list`,
  );
  const selection = resolveRerankSelection(args);
  const pool: Array<{ id: string; text: string }> = [];
  for (const c of candidates) {
    if (c && typeof c.id === "string") pool.push({ id: c.id, text: String(c.text ?? "") });
  }
  const { shown, dropped, pruned } = selectRerankCandidates(pool, String(args.query ?? ""), selection);
  // Question keys index the SHOWN shortlist (0..kept-1), not the input pool:
  // with pruning active the judge never sees dropped positions, so input
  // indexing would leave gaps. Default (unpruned) calls keep legacy keys
  // verbatim (shown order == input order there).
  const out: Record<string, unknown> = {};
  shown.forEach((c, i) => {
    out[`relevance_${i}_${c.id}`] = {
      type: "noul",
      instructions: `How relevant is candidate "${c.id}" to the query: "${args.query ?? ""}"?`,
      criteria: {
        true: "Candidate directly addresses the query.",
        false: "Candidate does not address the query.",
      },
    };
  });
  return {
    questions: out,
    shown,
    pruned,
    pruning: { kept: shown.length, dropped, method: RERANK_PRUNE_METHOD },
  };
}

/**
 * P1-T6 (breaking): `laya_rerank` routes the ordering through the engine.
 * Each ranked entry's legacy `relevance` number (a raw Router noul output)
 * is now the honestly named `relevance_score` (null when the backend gave
 * no answer for that candidate -- the legacy `?? 0` default, which sorted
 * missing candidates as zeroes, is gone; missing scores sort last), and
 * the output carries the ALLOW-or-ESCALATE `decision` from rerank@1.0.0.
 * The sort itself is unchanged for firm signal sets; T3 abstention (empty
 * or missing candidates) is now authoritative via the engine ESCALATE
 * exit. No threshold literal lives here: v1 never cuts, it sorts.
 *
 * Fase-4 T5 (additive, no policy change -- rerank stays 1.0.0): the pool
 * optionally passes through the cheap token-overlap pre-filter (top_k,
 * default = legacy: every candidate reaches the judge). Questions, judge
 * state, evidence signals, and `truncated_ids` cover the judged shortlist
 * only; candidates dropped by the pre-filter are reported in the additive
 * `pruned` + `pruning:{kept, dropped, method}` report (plus a `pruning`
 * mirror on evidence.metadata; signals untouched), never as missing
 * signals. Entries without a string id keep their legacy null-score rows
 * (never judged, always missing). With pruning active, question keys index
 * the shortlist (relevance_<shown-i>_<id>); unpruned calls keep legacy keys.
 */
export async function handleRerank(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  const built = buildRerankQuestionsWithInfo(args);
  const keyByInputIndex = new Map<number, string>();
  built.shown.forEach((c, i) => keyByInputIndex.set(c.inputIndex, `relevance_${i}_${c.id}`));
  const shownPoolIdx = new Set(built.shown.map((c) => c.inputIndex));
  const { candidates: truncated, truncated: wasTruncated, truncatedIds } =
    truncateRerankCandidates(built.shown as RerankCandidate[]);
  // State sent to /predict carries the truncated SHORTLIST texts; scoring
  // keys below index the same shortlist so ranks line up.
  const state = { ...args, candidates: truncated };
  const result = await runTool(client, state, built.questions, (raw) => {
    const a = raw.answers as Record<string, { noul: number }>;
    const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    // Rows cover judged entries only: shown candidates (answered by
    // shortlist key) plus legacy null rows for entries without a string
    // id. Dropped-by-prefilter candidates contribute NO row and NO signal
    // (they were never asked) -- pruning is reported, not evidenced.
    let ordinal = -1;
    const rows: Array<{ id: unknown; relevance_score: number | null; orig: number; question: string; missing: boolean }> = [];
    candidates.forEach((c: { id?: string }, i: number) => {
      if (!c || typeof c.id !== "string") {
        rows.push({ id: c?.id, relevance_score: null, orig: i, question: `relevance_${i}_${c?.id}`, missing: true });
        return;
      }
      ordinal += 1;
      if (!shownPoolIdx.has(ordinal)) return;
      const key = keyByInputIndex.get(ordinal) as string;
      const v = a[key]?.noul;
      rows.push({
        id: c.id,
        relevance_score: numOrNull(v),
        orig: i,
        question: key,
        missing: typeof v !== "number",
      });
    });
    // Firm scores sort descending; missing (null) scores sort last and keep
    // input order among themselves (stable, no invented value).
    const scored = rows
      .map((entry) => ({ rank: 0, id: entry.id, relevance_score: entry.relevance_score, inputIndex: entry.orig }))
      .sort((x, y) => {
        if (x.relevance_score === null && y.relevance_score === null) return x.inputIndex - y.inputIndex;
        if (x.relevance_score === null) return 1;
        if (y.relevance_score === null) return -1;
        if (y.relevance_score !== x.relevance_score) return (y.relevance_score as number) - (x.relevance_score as number);
        return x.inputIndex - y.inputIndex;
      })
      .map((entry, idx) => ({ rank: idx + 1, id: entry.id, relevance_score: entry.relevance_score }));
    // Evidence covers judged rows only: shown candidates (by shortlist key)
    // plus legacy null rows for entries without a string id. Dropped-by-
    // prefilter candidates were never asked, so they contribute NO signal
    // (missing or otherwise) -- pruning is reported, not evidenced.
    const { evidence, abstention } = rerankEvidence(raw, {
      items: rows.map((r) => ({
        id: String(r.id),
        question: r.question,
        relevance: r.relevance_score,
        rank: scored.find((s) => s.id === r.id)?.rank ?? 0,
        missing: r.missing,
      })),
    });
    // P1-T6: decision owned by the engine (shared table resolved for uniformity;
    // rerank@1.0.0 applies no numeric cut -- it authorizes use of the ordering).
    const { thresholds } = getPolicy("rerank", "1.0.0");
    const decision = evaluate(
      {
        evidence,
        abstention,
        context: { candidate_count: candidates.length, query_chars: String(args.query ?? "").length },
        risk: "normal",
        policy: { name: "rerank", version: "1.0.0" },
      },
      { thresholds },
    );
    // T5 additive pruning report on the evidence bundle (signals untouched).
    evidence.metadata = { ...(evidence.metadata ?? {}), pruning: { ...built.pruning } };
    return JSON.stringify(
      {
        ranked: scored,
        truncated: wasTruncated,
        truncated_ids: truncatedIds,
        decision,
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
