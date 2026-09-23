import type { LayaClient, PredictResult } from "../client.js";
import { decideEvidence, winnerOf } from "../evidence.js";
import { LIMITS, assertCount, inputTooLarge } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { TOOL_TIMEOUT_MS, type ToolDefinition, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, envelopeMetadataProperties } from "../tool.js";

type DecideAnswers = Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number }>;

function validatedParts(args: Record<string, unknown>): {
  candidates: Array<{ id?: unknown; description?: unknown }>;
  requirements: string[];
} {
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
  return {
    candidates: candidates as Array<{ id?: unknown; description?: unknown }>,
    requirements: requirements as string[],
  };
}

function criteriaOf(candidates: Array<{ id?: unknown; description?: unknown }>): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const c of candidates) {
    if (c && typeof c.id === "string") criteria[c.id] = String(c.description ?? "").slice(0, 240);
  }
  return criteria;
}

function descriptionOf(
  candidates: Array<{ id?: unknown; description?: unknown }>,
  selected: string,
): string {
  const match = candidates.find((c) => c && c.id === selected);
  return String(match?.description ?? "").slice(0, 240);
}

/**
 * Fase-4 T6, stage 1: the selection question only (as before). The declared
 * `buildQuestions` of the tool stays the validation + stage-1 entry point,
 * so the builder-level caps (2-6 options, <= 32 requirements) keep throwing
 * `input_too_large` exactly where the old single-call builder threw.
 */
export function buildSelectionQuestions(args: Record<string, unknown>): Record<string, unknown> {
  const { candidates, requirements } = validatedParts(args);
  void requirements;
  const state = args.evidence ? `Evidence: ${String(args.evidence)}` : "";
  return {
    selected: {
      type: "choice",
      instructions: `Pick the best option for: ${args.decision ?? ""}. ${state}`,
      criteria: criteriaOf(candidates),
    },
  };
}

/**
 * Fase-4 T6, stage 2: one `noul` per requirement, each evaluated AGAINST the
 * resolved stage-1 winner. The selected option id (plus its description when
 * the id matches a known candidate) is injected into every instruction, so
 * the judge answers "is THIS requirement met by THIS option?" instead of the
 * old simultaneous "is it met by the selected option?" with no option in
 * scope. The `true`/`false` criteria are unchanged from the single-call era.
 */
export function buildRequirementQuestions(
  args: Record<string, unknown>,
  selected: string,
  selectedDescription?: string,
): Record<string, unknown> {
  const { candidates, requirements } = validatedParts(args);
  const desc = selectedDescription ?? descriptionOf(candidates, selected);
  const descPart = desc ? ` (described as: "${desc}")` : "";
  const out: Record<string, unknown> = {};
  requirements.forEach((req, i) => {
    out[`requirement_${i}`] = {
      type: "noul",
      instructions:
        `Is the following requirement met by the selected option "${selected}"${descPart}? ` +
        `Requirement: ${req}`,
      criteria: {
        true: "Requirement is supported by the evidence.",
        false: "Requirement is contradicted or unsupported.",
      },
    };
  });
  return out;
}

export const decideTool: ToolDefinition = {
  name: "laya_decide",
  description:
    "Pick one of 2-6 bounded options, then check each optional requirement against the resolved winner. " +
    "Stage 1 selects the best option; stage 2 evaluates every requirement against that selected option " +
    "(a second /predict call -- a single call when no requirements are given). " +
    "Fewer than 2 or more than 6 options, " +
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
        description:
          "Optional constraints (max 32). Each one is evaluated against the stage-1 winner in a second call.",
      },
    },
    required: ["decision", "candidates"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      ...envelopeMetadataProperties(),
      selected: {
        type: ["string", "null"],
        description: "Winning option id; null when the pick abstained.",
      },
      distribution: { type: "object" },
      winner_probability: {
        type: ["number", "null"],
        description: "Top raw share (never a confidence); null when empty.",
      },
      requirements: {
        type: "object",
        description: "Per requirement key {signal, supported}; signal null and supported null when unevaluated.",
      },
      decision: decisionSchema(["ALLOW", "ESCALATE"]),
      latency_ms: { type: "number", description: "Sum of both stages when requirements are present." },
      evidence: evidenceSchema("Decide evidence bundle (selection + requirement signals)."),
      abstention: abstentionSchema(),
    },
    required: [
      "selected",
      "distribution",
      "winner_probability",
      "requirements",
      "decision",
      "latency_ms",
      "evidence",
      "abstention",
    ],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  buildQuestions: buildSelectionQuestions,
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
 *
 * Fase-4 T6 (two-stage, output shape preserved): selection and requirement
 * checks no longer share one /predict call, because requirements asked
 * blind ("met by the selected option?" with no option in scope) cannot
 * distinguish "holds for B but not for A". Stage 1 asks the `selected`
 * choice alone; stage 2 asks each `requirement_{i}` against the resolved
 * winner with its id (+ description when known) injected in the
 * instructions. Cost/latency: exactly 2 /predict calls when requirements
 * are present (latency_ms is the SUM of both stages; each stage gets the
 * standard tool timeout), exactly 1 when requirements are empty (zero
 * extra cost). No second stage runs without a selection: a null/abstained
 * pick records every requirement as missing (signal null, supported null),
 * which abstains ("no option selected") and ESCALATEs via
 * decide_no_selection -- evaluating requirements with nothing selected
 * would be uninterpretable. A flat distribution still runs stage 2 (the
 * selection exists) and then abstains on the flat band as before.
 * Evidence model/revision come from the stage-1 (selection) call, which
 * owns the pick. Policy stays decide@1.0.0 on purpose: thresholds, reason
 * codes and the ALLOW/ESCALATE contract are untouched -- only the signal
 * sourcing changed -- so NO version bump.
 */
export async function handleDecide(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const selectionQuestions = decideTool.buildQuestions(args);
  const { candidates, requirements } = validatedParts(args);

  let raw1: PredictResult;
  try {
    raw1 = await client.predict(args, selectionQuestions, TOOL_TIMEOUT_MS);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const a1 = raw1.answers as DecideAnswers;
  const selected = typeof a1.selected?.choice === "string" ? a1.selected.choice : null;
  const distribution = (a1.selected?.probabilities as Record<string, number> | undefined) ?? null;

  // Stage 2 runs only when there is a winner to evaluate against. Empty
  // requirements -> single call, zero extra cost. Null selection -> no
  // second stage by design (see docblock); requirements stay missing.
  let reqAnswers: DecideAnswers = {};
  let raw2: PredictResult | null = null;
  if (requirements.length > 0 && selected !== null) {
    const reqQuestions = buildRequirementQuestions(args, selected);
    try {
      raw2 = await client.predict(args, reqQuestions, TOOL_TIMEOUT_MS);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    reqAnswers = raw2.answers as DecideAnswers;
  }

  const requirementKeys = requirements.map((_, i) => `requirement_${i}`);
  const { evidence, abstention } = decideEvidence(raw1, {
    selected,
    distribution,
    optionCount: candidates.length,
    requirements: requirementKeys.map((k) => ({
      key: k,
      signal: typeof reqAnswers[k]?.noul === "number" ? (reqAnswers[k].noul as number) : null,
      missing: typeof reqAnswers[k]?.noul !== "number",
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
  const outDistribution = (a1.selected?.probabilities as Record<string, number> | undefined) ?? {};
  const outRequirements: Record<string, { signal: number | null; supported: boolean | null }> = {};
  for (const k of requirementKeys) {
    const signal = typeof reqAnswers[k]?.noul === "number" ? (reqAnswers[k].noul as number) : null;
    outRequirements[k] = { signal, supported: signal === null ? null : signal >= thresholds.requireSupport };
  }
  return JSON.stringify(
    {
      selected,
      distribution: outDistribution,
      winner_probability: winnerOf(outDistribution),
      requirements: outRequirements,
      decision,
      latency_ms: raw1.latencyMs + (raw2?.latencyMs ?? 0),
      evidence,
      abstention,
    },
    null,
    2,
  );
}
