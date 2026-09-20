import type { LayaClient } from "../client.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const decideTool: ToolDefinition = {
  name: "laya_decide",
  description:
    "Pick one of 2-6 bounded options, with optional per-requirement checks evaluated independently in the same call. " +
    "Use when the choice space is small and the criteria are explicit. Returns the winner and a confidence probability.",
  inputSchema: {
    type: "object",
    properties: {
      decision: { type: "string", description: "What you are deciding (used as the prompt)." },
      evidence: { type: "string", description: "Evidence the model should base its decision on." },
      candidates: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        items: {
          type: "object",
          properties: { id: { type: "string" }, description: { type: "string" } },
          required: ["id"],
        },
      },
      requirements: {
        type: "array",
        items: { type: "string" },
        description: "Optional constraints. Each one is evaluated independently.",
      },
    },
    required: ["decision", "candidates"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const requirements = Array.isArray(args.requirements) ? args.requirements : [];
    const criteria: Record<string, string> = {};
    for (const c of candidates) {
      if (c && typeof c.id === "string") criteria[c.id] = String(c.description ?? "").slice(0, 240);
    }
    const state = args.evidence ? `Evidence: ${String(args.evidence)}` : "";
    const out: Record<string, unknown> = {
      selected: {
        type: "choice",
        instructions: `Pick the best option for: ${args.decision ?? ""}. ${state}`,
        criteria,
      },
    };
    requirements.forEach((req, i) => {
      out[`requirement_${i}`] = {
        type: "noul",
        instructions: `Is the following requirement met by the selected option? Requirement: ${req}`,
        criteria: {
          true: "Requirement is supported by the evidence.",
          false: "Requirement is contradicted or unsupported.",
        },
      };
    });
    return out;
  },
};

export async function handleDecide(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const result = await runTool(client, args, decideTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number }>;
    return JSON.stringify(
      {
        selected: a.selected?.choice ?? null,
        confidence: a.selected?.probabilities ?? {},
        requirements: Object.fromEntries(
          Object.entries(a).filter(([k]) => k.startsWith("requirement_")).map(([k, v]) => [k, v.noul]),
        ),
        latency_ms: raw.latencyMs,
      },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
