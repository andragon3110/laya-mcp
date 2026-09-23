/**
 * P1-T4: Policy Engine barrel (no handlers wired in T4; W3/W4 do the wiring).
 */
export { ABSTAIN_REASON_CODE } from "./types.js";
export type {
  PolicyContext,
  PolicyDecision,
  PolicyDecisionKind,
  PolicyDefinition,
  PolicyEvalContext,
  PolicyInput,
  PolicyRef,
  RiskTier,
} from "./types.js";
export { THRESHOLDS_V1, THRESHOLD_ENV_VARS, resolveThresholds, thresholdsFromEnv } from "./thresholds.js";
export type { PolicyThresholds } from "./thresholds.js";
export { PolicyNotFoundError, getPolicy, listPolicies } from "./loader.js";
export type { LoadedPolicy } from "./loader.js";
export { evaluate } from "./engine.js";
export type { EvaluateOptions } from "./engine.js";
