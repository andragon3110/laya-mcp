/**
 * verify@1.0.0 — per-claim support aggregated to one decision.
 *
 * Evidence consumed: one Router `noul` signal per claim built by
 * `verifyEvidence` (evidence.ts), `metadata.question === "claim_<i>"`,
 * `signal_strength` = raw claim support (uncalibrated), `candidate` = claim
 * text, `metadata.verdict` = legacy per-claim label (informational only;
 * this policy recomputes from signals + the shared table, it never trusts
 * the label).
 *
 * Thresholds (origin: verify.ts legacy verdicts, behavior preserved, NOT
 * calibrated; SHARED with gate@1.0.0 via thresholds.ts — the pre-P1
 * duplication of the 0.8/0.4 literals in verify.ts and gate.ts is gone):
 * `claimVerified` (v1 0.8, `>=` verified), `claimContradicted` (v1 0.4,
 * `<` contradicted, `>=` unsupported). Edges: 0.8 -> verified, 0.4 ->
 * unsupported, just below 0.4 -> contradicted.
 *
 * Aggregation (v1 preserves the per-claim cut points; the aggregation is
 * new because legacy verify had no single action — T5 wires it):
 * all verified -> ALLOW; any contradicted -> DENY (a contradicted claim
 * must not be relied on); else (unsupported, no contradicted) -> REVIEW.
 * Differs from gate@1.0.0 on purpose: gate ESCALATEs on contradicted
 * (completion authority), verify DENYs (fact-check refusal).
 *
 * Reason codes (exhaustive):
 *   - "verify_all_verified"      (ALLOW)    every claim >= verified
 *   - "verify_unsupported_review"(REVIEW)   some unsupported, none contradicted
 *   - "verify_contradicted_deny" (DENY)     any claim < contradicted cut
 *   - "verify_no_claims"         (ESCALATE) zero claim signals
 *   - "verify_missing_signal"    (ESCALATE) any claim signal null/absent
 *   - "abstained_evidence"       (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains on empty/low/mid claim bands).
 */
import type { Signal } from "../../evidence.js";
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

function claimSignals(signals: Signal[]): Signal[] {
  return signals.filter(
    (s) => typeof (s.metadata as Record<string, unknown> | undefined)?.question === "string" &&
      String((s.metadata as Record<string, unknown>).question).startsWith("claim_"),
  );
}

export const verifyPolicy: PolicyDefinition = {
  name: "verify",
  version: "1.0.0",
  description: "Claim-support aggregation on the shared verify/gate 0.8/0.4 cut points.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "verify", version: "1.0.0" };
    const claims = claimSignals(ctx.evidence?.signals ?? []);
    if (claims.length === 0) {
      return { decision: "ESCALATE", reason_codes: ["verify_no_claims"], policy };
    }
    let unsupported = 0;
    for (const c of claims) {
      const v = c.signal_strength;
      if (typeof v !== "number") {
        return { decision: "ESCALATE", reason_codes: ["verify_missing_signal"], policy };
      }
      if (v < t.claimContradicted) {
        return { decision: "DENY", reason_codes: ["verify_contradicted_deny"], policy };
      }
      if (v < t.claimVerified) unsupported++;
    }
    if (unsupported > 0) {
      return { decision: "REVIEW", reason_codes: ["verify_unsupported_review"], policy };
    }
    return { decision: "ALLOW", reason_codes: ["verify_all_verified"], policy };
  },
};
