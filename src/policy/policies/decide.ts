/**
 * decide@1.0.0 — bounded option pick + requirement checks (informational).
 *
 * Evidence consumed: signals built by `decideEvidence` (evidence.ts):
 *   - one `choice` signal (`metadata.question === "selected"`):
 *     `candidate` = winning option, `distribution` = raw shares
 *     (uncalibrated), `winner_probability` = top share (null when empty).
 *   - one `noul` signal per requirement (`metadata.question` =
 *     requirement key): `signal_strength` = raw support (uncalibrated),
 *     `metadata.missing_answer` set when the backend gave no answer.
 *
 * Thresholds (origin: evidence.ts decideEvidence `< 0.8` unsupported band,
 * which mirrors the verify 0.8 cut; behavior preserved, NOT calibrated):
 * `requireSupport` (v1 0.8, requirement signal `>=` support counts as met).
 * Edge: exactly 0.8 -> supported.
 *
 * Decision (v1 ALLOW-or-ESCALATE only; REVIEW/DENY reserved for future
 * calibration): firm winner + every requirement met -> ALLOW; anything
 * else -> ESCALATE (consistent with evidence.ts, which abstains on the
 * same bands — the direct checks below cover hand-built evidence that
 * arrives without the abstention flag).
 *
 * Reason codes (exhaustive):
 *   - "decide_selected_allow"       (ALLOW)    firm winner, all met
 *   - "decide_no_selection"         (ESCALATE) selected null/absent
 *   - "decide_empty_distribution"   (ESCALATE) empty winner distribution
 *   - "decide_missing_signal"       (ESCALATE) any requirement null/missing
 *   - "decide_requirement_unsupported" (ESCALATE) any requirement < support
 *   - "abstained_evidence"          (ESCALATE) global rule in engine.ts.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const decidePolicy: PolicyDefinition = {
  name: "decide",
  version: "1.0.0",
  description: "Bounded pick; firm winner with all requirements met allows, else escalates.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "decide", version: "1.0.0" };
    const signals = ctx.evidence?.signals ?? [];
    const selected = signals.find(
      (s) => (s.metadata as Record<string, unknown> | undefined)?.question === "selected",
    );
    if (!selected || selected.candidate === null || selected.candidate === undefined) {
      return { decision: "ESCALATE", reason_codes: ["decide_no_selection"], policy };
    }
    if (selected.distribution === null || selected.distribution === undefined || selected.winner_probability === null || selected.winner_probability === undefined) {
      return { decision: "ESCALATE", reason_codes: ["decide_empty_distribution"], policy };
    }
    for (const s of signals) {
      if (s === selected) continue;
      const meta = (s.metadata ?? {}) as Record<string, unknown>;
      if (meta.missing_answer === true || typeof s.signal_strength !== "number") {
        return { decision: "ESCALATE", reason_codes: ["decide_missing_signal"], policy };
      }
      if ((s.signal_strength as number) < t.requireSupport) {
        return { decision: "ESCALATE", reason_codes: ["decide_requirement_unsupported"], policy };
      }
    }
    return { decision: "ALLOW", reason_codes: ["decide_selected_allow"], policy };
  },
};
