import type { LayaClient } from "../client.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const rerankTool: ToolDefinition = {
  name: "laya_rerank",
  description:
    "Score every candidate's relevance to a query and return them sorted. Each candidate gets its own probability, " +
    "so the whole ordering survives. Use for retrieval reranking, near-duplicate triage, or ordering a feed.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Query the candidates should be ranked against." },
      candidates: {
        type: "array",
        description: "Candidate list. Each entry needs `id` and `text` (truncated to 2,000 chars internally).",
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
  const result = await runTool(client, args, rerankTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { noul: number }>;
    const scored = candidates
      .map((c: { id?: string }, i: number) => ({
        rank: 0,
        id: c.id,
        relevance: a[`relevance_${i}_${c.id}`]?.noul ?? 0,
      }))
      .sort((a, b) => b.relevance - a.relevance)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
    return JSON.stringify({ ranked: scored, latency_ms: raw.latencyMs }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
