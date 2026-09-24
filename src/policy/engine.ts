/**
 * P1-T4: deterministic Policy Engine (LLM-free, no callers yet in T4).
 *
 * `evaluate` is a pure function of (evidence, abstention, context, risk,
 * policy ref, resolved thresholds): no I/O, no dates, no randomness in
 * this file (the only I/O in the module graph is threshold env resolution
 * at load time in loader.ts; tests bypass it by injecting thresholds).
 *
 * Evaluation order:
 *   1. Load the policy by name+version (structured error when unknown).
 *   2. SINGLE GLOBAL ABSTAIN RULE (see types.ts): abstained evidence
 *      short-circuits to ESCALATE + ["abstained_evidence"] before any
 *      policy logic runs. `context`/`risk` never rescue abstention.
 *   3. Otherwise delegate to the policy definition with the resolved
 *      shared thresholds.
 *
 * v1 `context`/`risk` handling: accepted and forwarded. `context` never
 * moves a cut (except find@1.0.0 reading `context.candidateCount` for the
 * 1/N weak-winner baseline). `risk` moves cuts ONLY where the policy
 * documents it (gate/screen numeric bands via thresholds.RISK_CUT_DELTA,
 * pii non-secret branch); every other v1 policy ignores it. Neither
 * `context` nor `risk` ever rescues abstention (rule above).
 */
import { getPolicy } from "./loader.js";
import type { PolicyThresholds } from "./thresholds.js";
import { ABSTAIN_REASON_CODE, type PolicyDecision, type PolicyInput } from "./types.js";

export interface EvaluateOptions {
  /** Injected thresholds (pure/test path). Defaults to the loader-resolved shared table. */
  thresholds?: PolicyThresholds;
}

export function evaluate(input: PolicyInput, opts?: EvaluateOptions): PolicyDecision {
  if (!input || typeof input !== "object") throw new Error("policy_engine: input must be an object");
  if (!input.policy || typeof input.policy.name !== "string" || typeof input.policy.version !== "string") {
    throw new Error("policy_engine: input.policy {name, version} is required");
  }
  if (!input.evidence || typeof input.evidence !== "object" || !Array.isArray(input.evidence.signals)) {
    throw new Error("policy_engine: input.evidence with a signals array is required");
  }
  const { definition, thresholds } = getPolicy(input.policy.name, input.policy.version, { thresholds: opts?.thresholds });
  if (input.abstention?.abstained === true) {
    return {
      decision: "ESCALATE",
      reason_codes: [ABSTAIN_REASON_CODE],
      policy: { name: definition.name, version: definition.version },
    };
  }
  return definition.evaluate(
    { evidence: input.evidence, abstention: input.abstention, context: input.context, risk: input.risk },
    thresholds,
  );
}
