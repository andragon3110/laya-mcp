/**
 * rerank@1.0.0 — candidate ordering (informational).
 *
 * Evidence consumed: one Router `noul` signal per candidate built by
 * `rerankEvidence` (evidence.ts), `relevance_score` = raw relevance
 * (uncalibrated), `candidate` = candidate id, `metadata.question` =
 * "relevance_<i>_<id>", `metadata.rank` = legacy sort position
 * (informational only).
 *
 * Thresholds: NONE in v1 (legacy rerank never cut; it sorts). The policy
 * authorizes USE of the ordering as informational output, it does not
 * re-rank: every firm signal set -> ALLOW.
 *
 * Reason codes (exhaustive):
 *   - "rerank_ordered_allow" (ALLOW)    every candidate has a firm signal
 *   - "rerank_no_candidates" (ESCALATE) zero relevance signals
 *   - "rerank_missing_signal"(ESCALATE) any candidate relevance null/absent
 *   - "abstained_evidence"   (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains on empty/missing candidates).
 * v1 never returns REVIEW or DENY.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const rerankPolicy: PolicyDefinition = {
  name: "rerank",
  version: "1.0.0",
  description: "Authorizes use of the relevance ordering when every candidate signal is firm.",
  evaluate(ctx: PolicyEvalContext, _t: PolicyThresholds): PolicyDecision {
    const policy = { name: "rerank", version: "1.0.0" };
    void _t;
    const signals = ctx.evidence?.signals ?? [];
    if (signals.length === 0) {
      return { decision: "ESCALATE", reason_codes: ["rerank_no_candidates"], policy };
    }
    for (const s of signals) {
      if (typeof s.relevance_score !== "number") {
        return { decision: "ESCALATE", reason_codes: ["rerank_missing_signal"], policy };
      }
    }
    return { decision: "ALLOW", reason_codes: ["rerank_ordered_allow"], policy };
  },
};
