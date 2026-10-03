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
 *   3. GLOBAL DOUBT GATE (doubt-gate-es T3): when the caller passes the
 *      case confidence via `context.answer_confidence` (per-question map)
 *      or `context.min_confidence` (precomputed case-min scalar) and its
 *      minimum falls below `thresholds.minConfidence`, short-circuit to
 *      ESCALATE + ["low_confidence"] before any policy logic runs. The
 *      gate ESCALATES, never blocks and never invents certainty: a missing
 *      or non-finite confidence sleeps the gate (passthrough to the
 *      policy), and a non-finite cut disables it. The cut is
 *      UNCALIBRATED-CONSERVATIVE (see DOUBT_GATE_UNCALIBRATED in
 *      thresholds.ts) -- review-by-default until real labels exist.
 *   4. Otherwise delegate to the policy definition with the resolved
 *      shared thresholds.
 *
 * fut-b-semantica T3 (BREAKING precedence change, implemented in
 * evidence.ts, documented here because the engine owns the rule): the
 * global rule is UNCHANGED -- real abstention still precedes every band --
 * but what COUNTS as abstention narrowed. Band-position abstention is gone
 * (verify/gate claim bands, review/gate mid-band safe_to_apply): a present
 * signal in a REVIEW/DENY zone is firm evidence for that band, not
 * ambiguity, so REVIEW/DENY are reachable via the handlers. Evidence
 * abstains ONLY on missing/degraded input (null signals, empty claims).
 * Missing -> ESCALATE is preserved at both levels (global rule + the
 * policies' missing-signal exits).
 *
 * v1 `context`/`risk` handling: accepted and forwarded. `context` never
 * moves a cut (except find@1.0.0 reading `context.candidateCount` for the
 * 1/N weak-winner baseline). `risk` moves cuts ONLY where the policy
 * documents it (gate/screen numeric bands via thresholds.RISK_CUT_DELTA,
 * pii non-secret branch); every other v1 policy ignores it. Neither
 * `context` nor `risk` ever rescues abstention (rule above).
 *
 * doubt-gate-es T3 exception: the GLOBAL doubt gate (this file, step 3
 * above) reads `context.answer_confidence` / `context.min_confidence` as a
 * pure passthrough tripwire. It never moves a policy cut -- it
 * short-circuits to ESCALATE before any policy runs, and only on doubt.
 */
import { getPolicy } from "./loader.js";
import type { PolicyThresholds } from "./thresholds.js";
import {
  ABSTAIN_REASON_CODE,
  type PolicyContext,
  type PolicyDecision,
  type PolicyInput,
} from "./types.js";

export interface EvaluateOptions {
  /** Injected thresholds (pure/test path). Defaults to the loader-resolved shared table. */
  thresholds?: PolicyThresholds;
}

/**
 * doubt-gate-es T3: reason code for the global doubt gate. Escalate-only:
 * low declared confidence routes to human review, never to a block.
 */
export const LOW_CONFIDENCE_REASON_CODE = "low_confidence";

/**
 * doubt-gate-es T3: case min-confidence from the caller context. Accepts the
 * per-question `answer_confidence` map (min over finite values) or a
 * precomputed `min_confidence` scalar. Returns null when neither is usable --
 * the gate sleeps rather than inventing certainty.
 */
export function caseMinConfidence(context: PolicyContext | undefined): number | null {
  if (!context || typeof context !== "object") return null;
  const scalar = (context as Record<string, unknown>).min_confidence;
  if (typeof scalar === "number") return Number.isFinite(scalar) ? scalar : null;
  const table = (context as Record<string, unknown>).answer_confidence;
  if (typeof table !== "object" || table === null) return null;
  let min: number | null = null;
  for (const v of Object.values(table as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    min = min === null ? v : Math.min(min, v);
  }
  return min;
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
  const minConf = caseMinConfidence(input.context);
  if (
    minConf !== null &&
    Number.isFinite(thresholds.minConfidence) &&
    minConf < thresholds.minConfidence
  ) {
    return {
      decision: "ESCALATE",
      reason_codes: [LOW_CONFIDENCE_REASON_CODE],
      policy: { name: definition.name, version: definition.version },
    };
  }
  return definition.evaluate(
    { evidence: input.evidence, abstention: input.abstention, context: input.context, risk: input.risk },
    thresholds,
  );
}
