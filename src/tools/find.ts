import type { LayaClient } from "../client.js";
import { findEvidence } from "../evidence.js";
import { LIMITS, assertCount } from "../limits.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const findTool: ToolDefinition = {
  name: "laya_find",
  description:
    "Pick the best candidate id for a query from a list, or report that none of them answers. " +
    "Cheaper than calling the main LLM for routing decisions over up to 250 candidates. " +
    "Lists above 250 are rejected with input_too_large (no silent truncation). " +
    "Returns a winner and a confidence probability.",
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
    },
    required: ["query", "candidates"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    assertCount(
      candidates.length,
      LIMITS.maxFindCandidates,
      "candidates",
      `laya_find accepts at most ${LIMITS.maxFindCandidates} candidates per call; split the list and merge winners`,
    );
    const criteria: Record<string, string> = {};
    for (const c of candidates) {
      if (c && typeof c.id === "string") criteria[c.id] = String(c.text ?? "").slice(0, 240);
    }
    criteria.none = "None of the candidates addresses the query.";
    return {
      exists: {
        type: "choice",
        instructions: `Pick the candidate that best answers the query: "${args.query ?? ""}". If none of them address it, choose 'none'.`,
        criteria,
      },
    };
  },
};

export async function handleFind(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const result = await runTool(client, args, findTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const choice = a.exists?.choice ?? "none";
    const probs = a.exists?.probabilities ?? {};
    // P1-T3: legacy decision, engine-owned from T5/T6 (winner/choice above).
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const { evidence, abstention } = findEvidence(raw, {
      choice: typeof a.exists?.choice === "string" ? a.exists.choice : null,
      distribution: (a.exists?.probabilities as Record<string, number> | undefined) ?? null,
      candidateCount: candidates.length,
    });
    return JSON.stringify(
      { winner: choice, exists: choice !== "none", probabilities: probs, latency_ms: raw.latencyMs, evidence, abstention },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
