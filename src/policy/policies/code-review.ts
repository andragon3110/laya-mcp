/**
 * code-review@1.0.0 — diff safety for the code-review workflow.
 *
 * Evidence consumed: same shape as review@1.0.0 (`reviewEvidence`:
 * 0-2 rubric `score` signals for audit + one `noul`
 * `metadata.question === "safe_to_apply"` signal carrying the raw safety
 * output, uncalibrated).
 *
 * Thresholds (origin: review.ts legacy action, behavior preserved, NOT
 * calibrated; SHARED with review@1.0.0 and gate@1.0.0 via thresholds.ts):
 * `reviewAuto` (v1 0.85, strict `>`), `reviewReview` (v1 0.5, strict `>`).
 * Edges: 0.85 -> REVIEW, 0.5 -> ESCALATE. This policy is intentionally the
 * review-family logic under a workflow-facing name so API consumers pin
 * `code-review@1.0.0` while the cut points stay in the one shared table.
 *
 * Reason codes (exhaustive):
 *   - "code_review_auto_allow"    (ALLOW)    safe_to_apply > auto
 *   - "code_review_needs_review"  (REVIEW)   safe_to_apply > review
 *   - "code_review_escalate"      (ESCALATE) safe_to_apply <= review cut
 *   - "code_review_missing_signal"(ESCALATE) safe_to_apply null/absent
 *   - "abstained_evidence"        (ESCALATE) global rule in engine.ts.
 * v1 never returns DENY.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const codeReviewPolicy: PolicyDefinition = {
  name: "code-review",
  version: "1.0.0",
  description: "Workflow-facing alias of the review-family 0.85/0.5 safe_to_apply cut points.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "code-review", version: "1.0.0" };
    const sig = (ctx.evidence?.signals ?? []).find(
      (s) => (s.metadata as Record<string, unknown> | undefined)?.question === "safe_to_apply",
    );
    const v = sig?.signal_strength;
    if (typeof v !== "number") {
      return { decision: "ESCALATE", reason_codes: ["code_review_missing_signal"], policy };
    }
    if (v > t.reviewAuto) return { decision: "ALLOW", reason_codes: ["code_review_auto_allow"], policy };
    if (v > t.reviewReview) return { decision: "REVIEW", reason_codes: ["code_review_needs_review"], policy };
    return { decision: "ESCALATE", reason_codes: ["code_review_escalate"], policy };
  },
};
