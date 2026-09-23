/**
 * review@1.0.0 — diff safety from evidence (no direct AUTO).
 *
 * Evidence consumed: signals built by `reviewEvidence` (evidence.ts):
 * four `score` signals (correctness/spec_match/test_gap/blast_radius, raw
 * 0-2 rubric numbers, carried for audit — v1 does NOT branch on them) plus
 * one `noul` signal (`metadata.question === "safe_to_apply"`,
 * `signal_strength` = raw safety output, uncalibrated). The rubric scores
 * inform the human reader; the DECISION reads only safe_to_apply, exactly
 * like the legacy handler.
 *
 * Thresholds (origin: review.ts legacy action, behavior preserved, NOT
 * calibrated; SHARED with gate@1.0.0 and code-review@1.0.0 via
 * thresholds.ts): `reviewAuto` (v1 0.85, strict `>`), `reviewReview`
 * (v1 0.5, strict `>`). Edges: 0.85 -> REVIEW (not auto), 0.5 -> ESCALATE.
 * Differs from gate@1.0.0 on purpose: review ESCALATEs on low safety
 * (<= 0.5); gate REVIEWs instead unless a claim is contradicted.
 *
 * Reason codes (exhaustive):
 *   - "review_auto_allow"   (ALLOW)    safe_to_apply > auto
 *   - "review_needs_review" (REVIEW)   safe_to_apply > review (and <= auto)
 *   - "review_escalate"     (ESCALATE) safe_to_apply <= review cut
 *   - "review_missing_signal"(ESCALATE) safe_to_apply null/absent
 *   - "abstained_evidence"  (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains on missing/mid-band safe_to_apply).
 * v1 never returns DENY (review refuses authority; worst case is ESCALATE).
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const reviewPolicy: PolicyDefinition = {
  name: "review",
  version: "1.0.0",
  description: "Diff safety preserving the pre-P1 0.85/0.5 safe_to_apply cut points.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "review", version: "1.0.0" };
    const sig = (ctx.evidence?.signals ?? []).find(
      (s) => (s.metadata as Record<string, unknown> | undefined)?.question === "safe_to_apply",
    );
    const v = sig?.signal_strength;
    if (typeof v !== "number") {
      return { decision: "ESCALATE", reason_codes: ["review_missing_signal"], policy };
    }
    if (v > t.reviewAuto) return { decision: "ALLOW", reason_codes: ["review_auto_allow"], policy };
    if (v > t.reviewReview) return { decision: "REVIEW", reason_codes: ["review_needs_review"], policy };
    return { decision: "ESCALATE", reason_codes: ["review_escalate"], policy };
  },
};
