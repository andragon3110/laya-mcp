/**
 * extract@1.0.0 — structured field values from verbatim candidates (informational).
 *
 * Evidence consumed: one `choice` signal per field built by
 * `extractEvidence` (evidence.ts), keyed by `metadata.field_id`:
 * `candidate` = winning key ("none" when the judge picked none),
 * `distribution` = raw shares (uncalibrated),
 * `metadata.candidate_count` = candidates the judge saw (20-cap),
 * `metadata.invalid_pattern` set for unparseable regexes,
 * `metadata.status` = legacy extracted/not_found (informational only).
 * Entity-mode signals additionally carry `span` + `detector_score`.
 *
 * Thresholds: NONE numeric in v1 (legacy extract had no cut point; values
 * are verbatim substrings, never model-generated). Firmness = candidates
 * existed and the pattern parsed. A firm "none" (judge saw candidates and
 * rejected them) is still a firm answer -> ALLOW; only zero-candidate /
 * invalid-pattern fields escalate.
 *
 * Reason codes (exhaustive):
 *   - "extract_values_allow"  (ALLOW)    every field firm (extracted or
 *                                        firm not_found)
 *   - "extract_no_fields"     (ESCALATE) zero field signals
 *   - "extract_no_candidates" (ESCALATE) any field with candidate_count 0
 *   - "extract_invalid_pattern"(ESCALATE) any field with invalid_pattern
 *   - "extract_missing_signal"(ESCALATE) any field with null choice/dist
 *   - "abstained_evidence"    (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains on zero-candidate/invalid-pattern fields).
 * v1 never returns REVIEW or DENY.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const extractPolicy: PolicyDefinition = {
  name: "extract",
  version: "1.0.0",
  description: "Verbatim field extraction; firm fields allow, zero-candidate/invalid fields escalate.",
  evaluate(ctx: PolicyEvalContext, _t: PolicyThresholds): PolicyDecision {
    const policy = { name: "extract", version: "1.0.0" };
    void _t;
    const signals = ctx.evidence?.signals ?? [];
    if (signals.length === 0) {
      return { decision: "ESCALATE", reason_codes: ["extract_no_fields"], policy };
    }
    for (const s of signals) {
      const meta = (s.metadata ?? {}) as Record<string, unknown>;
      if (meta.invalid_pattern === true) {
        return { decision: "ESCALATE", reason_codes: ["extract_invalid_pattern"], policy };
      }
      if (s.candidate === null || s.candidate === undefined || s.distribution === null || s.distribution === undefined) {
        return { decision: "ESCALATE", reason_codes: ["extract_missing_signal"], policy };
      }
      if (meta.candidate_count === 0) {
        return { decision: "ESCALATE", reason_codes: ["extract_no_candidates"], policy };
      }
    }
    return { decision: "ALLOW", reason_codes: ["extract_values_allow"], policy };
  },
};
