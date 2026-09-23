/**
 * gate@1.0.0 — completion gate: rubric safety + per-claim verification.
 *
 * Evidence consumed: signals built by `gateEvidence` (evidence.ts):
 *   - `score` signals (correctness/spec_match, raw 0-2, audit only).
 *   - one `noul` signal (`metadata.question === "safe_to_apply"`,
 *     `signal_strength` uncalibrated).
 *   - one `noul` signal per claim (`metadata.question === "claim_<i>"`,
 *     `signal_strength` uncalibrated, `candidate` = claim text;
 *     `metadata.verdict` is informational only, recomputed here).
 *
 * Thresholds (origin: gate.ts legacy action + verify.ts verdicts, behavior
 * preserved, NOT calibrated; SHARED via thresholds.ts — the 0.8/0.4 claim
 * literals duplicated in verify.ts/gate.ts are one table now):
 * `claimVerified` (v1 0.8, `>=`), `claimContradicted` (v1 0.4, `<`
 * contradicted), `reviewAuto` (v1 0.85, strict `>` for auto).
 * Preserved logic order: contradicted claims dominate safety — any
 * contradicted claim ESCALATEs even with high safe_to_apply. Low safety
 * WITHOUT contradicted claims REVIEWs (never escalates on safety alone —
 * the deliberate difference from review@1.0.0).
 *
 * DELIBERATE RUBRIC DIFFERENCE vs review@1.0.0 (P1-T5, documented here
 * instead of widened): gate consumes only the correctness/spec_match
 * `score` signals plus safe_to_apply and the per-claim support signals.
 * test_gap/blast_radius are NOT asked by laya_gate (the TS builder keeps
 * 3 fixed rubric questions so 61 claims still fit the 64-question server
 * budget): coverage breadth belongs to laya_review, completion
 * truthfulness belongs here. The review-family `score` signals are
 * audit-only in v1 — the DECISION reads safe_to_apply + claim signals.
 *
 * Reason codes (exhaustive):
 *   - "gate_contradicted_escalate" (ESCALATE) any claim < contradicted cut
 *   - "gate_auto_allow"            (ALLOW)    no contradicted + safe > auto
 *   - "gate_review"                (REVIEW)   otherwise (incl. low safety
 *                                            alone, unsupported claims alone)
 *   - "gate_missing_signal"        (ESCALATE) safe_to_apply or any claim
 *                                            signal null/absent
 *   - "abstained_evidence"         (ESCALATE) global rule in engine.ts.
 * v1 never returns DENY (gate refuses authority; worst case is ESCALATE).
 */
import type { Signal } from "../../evidence.js";
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const gatePolicy: PolicyDefinition = {
  name: "gate",
  version: "1.0.0",
  description: "Completion gate: contradicted claims escalate, then the shared 0.85 auto cut applies.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "gate", version: "1.0.0" };
    const signals: Signal[] = ctx.evidence?.signals ?? [];
    const safe = signals.find(
      (s) => (s.metadata as Record<string, unknown> | undefined)?.question === "safe_to_apply",
    )?.signal_strength;
    const claims = signals.filter((s) => {
      const q = (s.metadata as Record<string, unknown> | undefined)?.question;
      return typeof q === "string" && q.startsWith("claim_");
    });
    if (typeof safe !== "number") {
      return { decision: "ESCALATE", reason_codes: ["gate_missing_signal"], policy };
    }
    for (const c of claims) {
      if (typeof c.signal_strength !== "number") {
        return { decision: "ESCALATE", reason_codes: ["gate_missing_signal"], policy };
      }
      if ((c.signal_strength as number) < t.claimContradicted) {
        return { decision: "ESCALATE", reason_codes: ["gate_contradicted_escalate"], policy };
      }
    }
    if (safe > t.reviewAuto) return { decision: "ALLOW", reason_codes: ["gate_auto_allow"], policy };
    return { decision: "REVIEW", reason_codes: ["gate_review"], policy };
  },
};
