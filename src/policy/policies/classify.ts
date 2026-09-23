/**
 * classify@1.0.0 — batch item labeling (informational).
 *
 * Evidence consumed: one `choice` signal per item built by
 * `classifyEvidence` (evidence.ts, `metadata.question === "class_<i>_<id>"`):
 * `candidate` = chosen class, `distribution` = raw class shares
 * (uncalibrated), `metadata.item_id` = item id, `metadata.missing_answer`
 * set when the backend gave no answer for the item.
 *
 * Thresholds: NONE numeric in v1 (legacy classify had no cut point; the
 * label is reported verbatim). Firmness comes from signal presence, not
 * from a tuned cut.
 *
 * Reason codes (exhaustive):
 *   - "classify_labeled_allow"   (ALLOW)    every item has a firm answer
 *   - "classify_no_items"        (ESCALATE) zero class signals
 *   - "classify_missing_signal"  (ESCALATE) any item with missing_answer or
 *                                           null candidate/distribution
 *   - "classify_empty_distribution" (ESCALATE) any item whose distribution
 *                                           is empty (winner indeterminate)
 *   - "abstained_evidence"       (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains on missing/empty items).
 * v1 never returns REVIEW or DENY.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const classifyPolicy: PolicyDefinition = {
  name: "classify",
  version: "1.0.0",
  description: "Batch labeling; every firm item allows, missing/empty items escalate.",
  evaluate(ctx: PolicyEvalContext, _t: PolicyThresholds): PolicyDecision {
    const policy = { name: "classify", version: "1.0.0" };
    void _t;
    const signals = ctx.evidence?.signals ?? [];
    if (signals.length === 0) {
      return { decision: "ESCALATE", reason_codes: ["classify_no_items"], policy };
    }
    for (const s of signals) {
      const meta = (s.metadata ?? {}) as Record<string, unknown>;
      if (meta.missing_answer === true || s.candidate === null || s.candidate === undefined || s.distribution === null || s.distribution === undefined) {
        return { decision: "ESCALATE", reason_codes: ["classify_missing_signal"], policy };
      }
      if (Object.keys(s.distribution).length === 0) {
        return { decision: "ESCALATE", reason_codes: ["classify_empty_distribution"], policy };
      }
    }
    return { decision: "ALLOW", reason_codes: ["classify_labeled_allow"], policy };
  },
};
