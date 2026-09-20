import type { LayaClient } from "../client.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const findTool: ToolDefinition = {
  name: "laya_find",
  description:
    "Pick the best candidate id for a query from a list, or report that none of them answers. " +
    "Cheaper than calling the main LLM for routing decisions over up to 250 candidates. " +
    "Returns a winner and a confidence probability.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Plain-language query the candidate should answer." },
      candidates: {
        type: "array",
        description: "Candidate list. Each entry needs `id` (returned verbatim) and `text` (the candidate's body).",
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
    return JSON.stringify(
      { winner: choice, exists: choice !== "none", probabilities: probs, latency_ms: raw.latencyMs },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
