import type { LayaClient } from "../client.js";
import { LIMITS, assertCount, inputTooLarge } from "../limits.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const decideTool: ToolDefinition = {
  name: "laya_decide",
  description:
    "Pick one of 2-6 bounded options, with optional per-requirement checks evaluated independently in the same call. " +
    "Use when the choice space is small and the criteria are explicit. Fewer than 2 or more than 6 options, " +
    "or more than 32 requirements, are rejected with input_too_large. " +
    "Returns the winner and a confidence probability.",
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
        maxItems: LIMITS.maxDecideRequirements,
        items: { type: "string" },
        description: "Optional constraints (max 32). Each one is evaluated independently.",
      },
    },
    required: ["decision", "candidates"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const requirements = Array.isArray(args.requirements) ? args.requirements : [];
    // The schema declares minItems 2 / maxItems 6, but MCP hosts do not
    // always enforce schemas -- enforce here too so the bound is real.
    if (candidates.length < LIMITS.minDecideOptions) {
      throw inputTooLarge(
        "candidates",
        LIMITS.minDecideOptions,
        candidates.length,
        "laya_decide needs at least 2 options; with a single option there is nothing to decide",
      );
    }
    assertCount(
      candidates.length,
      LIMITS.maxDecideOptions,
      "candidates",
      "laya_decide accepts 2-6 options; use laya_find for larger candidate lists",
    );
    assertCount(
      requirements.length,
      LIMITS.maxDecideRequirements,
      "requirements",
      `at most ${LIMITS.maxDecideRequirements} requirements per call to stay within the ${LIMITS.maxQuestions}-question server budget`,
    );
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
