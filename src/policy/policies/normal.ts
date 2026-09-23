/**
 * normal@1.0.0 — default profile for low-risk informational reads.
 *
 * Evidence consumed: ANY evidence bundle. The policy reads NO signal
 * values: low-risk informational output (rankings, labels, comparisons,
 * extractions) carries no authorization either way, so firm evidence
 * allows the step to proceed and only missing/ambiguous evidence stops
 * it (via the global abstain rule in engine.ts).
 *
 * Thresholds: NONE. This profile intentionally has no cut points; it is
 * the explicit "no numeric gate" baseline against which the thresholded
 * policies (screen/verify/review/gate/...) are the exception.
 *
 * Reason codes (exhaustive — only two):
 *   - "normal_allow_default" (ALLOW)    evidence not abstained
 *   - "abstained_evidence"   (ESCALATE) global rule in engine.ts.
 * v1 never returns REVIEW or DENY under this profile; callers needing a
 * gate must pin a thresholded policy (e.g. security@1.0.0).
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const normalPolicy: PolicyDefinition = {
  name: "normal",
  version: "1.0.0",
  description: "Default low-risk profile: firm evidence allows, abstention escalates, no numeric gate.",
  evaluate(ctx: PolicyEvalContext, _t: PolicyThresholds): PolicyDecision {
    const policy = { name: "normal", version: "1.0.0" };
    void _t;
    void ctx;
    return { decision: "ALLOW", reason_codes: ["normal_allow_default"], policy };
  },
};
