import type { LayaClient } from "../client.js";
import { rerankEvidence } from "../evidence.js";
import { LIMITS, assertCount } from "../limits.js";
import { type ToolDefinition, runTool } from "../tool.js";

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
    "Score every candidate's relevance to a query and return them sorted. Each candidate gets its own probability, " +
    "so the whole ordering survives. Use for retrieval reranking, near-duplicate triage, or ordering a feed. " +
    "At most 64 candidates per call; each candidate text is truncated to 2,000 chars and the response sets " +
    "truncated:true (with truncated_ids) when any candidate was cut.",
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
    },
    required: ["query", "candidates"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    assertCount(
      candidates.length,
      LIMITS.maxRerankCandidates,
      "candidates",
      `laya_rerank accepts at most ${LIMITS.maxRerankCandidates} candidates per call (one question each); split the list`,
    );
    const out: Record<string, unknown> = {};
    candidates.forEach((c: { id?: string }, i: number) => {
      if (!c || typeof c.id !== "string") return;
      out[`relevance_${i}_${c.id}`] = {
        type: "noul",
        instructions: `How relevant is candidate "${c.id}" to the query: "${args.query ?? ""}"?`,
        criteria: {
          true: "Candidate directly addresses the query.",
          false: "Candidate does not address the query.",
        },
      };
    });
    return out;
  },
};

export async function handleRerank(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  const { candidates: truncated, truncated: wasTruncated, truncatedIds } =
    truncateRerankCandidates(candidates as RerankCandidate[]);
  // State sent to /predict carries the truncated texts; scoring keys below
  // still use the original ids/order so ranks line up.
  const state = { ...args, candidates: truncated };
  const result = await runTool(client, state, rerankTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { noul: number }>;
    const scored = candidates
      .map((c: { id?: string }, i: number) => ({
        rank: 0,
        id: c.id,
        relevance: a[`relevance_${i}_${c.id}`]?.noul ?? 0,
      }))
      // P1-T3: legacy decision, engine-owned from T5/T6 (sort order below).
      .sort((a, b) => b.relevance - a.relevance)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
    const { evidence, abstention } = rerankEvidence(raw, {
      items: candidates.map((c: { id?: string }, i: number) => {
        const key = `relevance_${i}_${c.id}`;
        const v = a[key]?.noul;
        return {
          id: String(c.id),
          question: key,
          relevance: typeof v === "number" ? v : null,
          rank: scored.find((s) => s.id === c.id)?.rank ?? 0,
          missing: typeof v !== "number",
        };
      }),
    });
    return JSON.stringify(
      { ranked: scored, truncated: wasTruncated, truncated_ids: truncatedIds, latency_ms: raw.latencyMs, evidence, abstention },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
