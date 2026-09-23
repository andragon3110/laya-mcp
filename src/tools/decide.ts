import type { LayaClient } from "../client.js";
import { decideEvidence, winnerOf } from "../evidence.js";
import { LIMITS, assertCount, inputTooLarge } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const decideTool: ToolDefinition = {
  name: "laya_decide",
  description:
    "Pick one of 2-6 bounded options, with optional per-requirement checks evaluated independently in the same call. " +
    "Use when the choice space is small and the criteria are explicit. Fewer than 2 or more than 6 options, " +
    "or more than 32 requirements, are rejected with input_too_large. " +
    "Returns the winner with its raw, uncalibrated distribution and winner_probability (never a confidence) " +
    "plus the deterministic ALLOW/ESCALATE `decision` from the versioned decide@1.0.0 policy. " +
    "An ESCALATE decision is authoritative: do not act on the selection when the decision escalates.",
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

/**
 * P1-T6 (breaking): `laya_decide` routes the pick through the engine. The
 * legacy `confidence` dict (the raw choice distribution mislabelled as a
 * confidence probability) is now `distribution` with the honest
 * `winner_probability` top share (null when empty), and each requirement
 * entry is now `{signal, supported}` (raw, uncalibrated support signal or
 * null when missing; `supported` resolves from the shared requireSupport
 * cut and is display-only -- the policy owns the cut). The output carries
 * the ALLOW-or-ESCALATE `decision` from decide@1.0.0; T3 abstention (no
 * selection, empty/flat distribution, missing or unsupported requirements)
 * is now authoritative via the engine ESCALATE exit. No threshold literal
 * remains in this handler.
 */
export async function handleDecide(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const result = await runTool(client, args, decideTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number }>;
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const requirementKeys = Object.keys(a).filter((k) => k.startsWith("requirement_"));
    const { evidence, abstention } = decideEvidence(raw, {
      selected: typeof a.selected?.choice === "string" ? a.selected.choice : null,
      distribution: (a.selected?.probabilities as Record<string, number> | undefined) ?? null,
      optionCount: candidates.length,
      requirements: requirementKeys.map((k) => ({
        key: k,
        signal: typeof a[k]?.noul === "number" ? (a[k].noul as number) : null,
        missing: typeof a[k]?.noul !== "number",
      })),
    });
    // P1-T6: decision and display cuts resolve from the shared table.
    const { thresholds } = getPolicy("decide", "1.0.0");
    const decision = evaluate(
      {
        evidence,
        abstention,
        context: { option_count: candidates.length, requirement_count: requirementKeys.length },
        risk: "normal",
        policy: { name: "decide", version: "1.0.0" },
      },
      { thresholds },
    );
    const distribution = (a.selected?.probabilities as Record<string, number> | undefined) ?? {};
    const requirements: Record<string, { signal: number | null; supported: boolean | null }> = {};
    for (const [k, v] of Object.entries(a).filter(([k]) => k.startsWith("requirement_"))) {
      const signal = typeof (v as { noul?: unknown }).noul === "number" ? ((v as { noul: number }).noul) : null;
      requirements[k] = { signal, supported: signal === null ? null : signal >= thresholds.requireSupport };
    }
    return JSON.stringify(
      {
        selected: a.selected?.choice ?? null,
        distribution,
        winner_probability: winnerOf(distribution),
        requirements,
        decision,
        latency_ms: raw.latencyMs,
        evidence,
        abstention,
      },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
