/**
 * compare@1.0.0 — passage relation judgments (informational).
 *
 * Evidence consumed: `choice` signals built by `compareEvidence`
 * (evidence.ts): one `metadata.question === "overall"` signal plus one per
 * aspect (`metadata.aspect` = aspect label). `candidate` = relation
 * (same_fact / contradicts / different_facts), `distribution` = raw shares
 * (uncalibrated). A missing backend answer surfaces as a null candidate
 * (compareEvidence passes choice null through; the abstention message
 * lists the missing keys).
 *
 * Thresholds: NONE in v1 (legacy compare had no cut point). The relation
 * VALUE never gates: same_fact, contradicts and different_facts are all
 * reportable findings, so every firm judgment set -> ALLOW. Only signal
 * absence escalates.
 *
 * Reason codes (exhaustive):
 *   - "compare_related_allow" (ALLOW)    overall + every aspect firm
 *   - "compare_no_judgment"   (ESCALATE) zero compare signals
 *   - "compare_missing_signal"(ESCALATE) any judgment null/absent
 *   - "abstained_evidence"    (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains on missing overall/aspect answers).
 * v1 never returns REVIEW or DENY.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const comparePolicy: PolicyDefinition = {
  name: "compare",
  version: "1.0.0",
  description: "Relation judgments; firm overall+aspects allow, missing answers escalate.",
  evaluate(ctx: PolicyEvalContext, _t: PolicyThresholds): PolicyDecision {
    const policy = { name: "compare", version: "1.0.0" };
    void _t;
    const signals = ctx.evidence?.signals ?? [];
    if (signals.length === 0) {
      return { decision: "ESCALATE", reason_codes: ["compare_no_judgment"], policy };
    }
    for (const s of signals) {
      if (s.candidate === null || s.candidate === undefined || s.distribution === null || s.distribution === undefined) {
        return { decision: "ESCALATE", reason_codes: ["compare_missing_signal"], policy };
      }
    }
    return { decision: "ALLOW", reason_codes: ["compare_related_allow"], policy };
  },
};
