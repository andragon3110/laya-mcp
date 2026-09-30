/**
 * gate@1.0.0 — completion gate: rubric safety + per-claim verification.
 *
 * Evidence consumed: signals built by `gateEvidence` (evidence.ts):
 *   - `score` signals (correctness/spec_match, raw 0-2, audit only).
 *   - one `noul` signal (`metadata.question === "safe_to_apply"`,
 *     `signal_strength` uncalibrated).
 *   - one SUPPORT `noul` signal per claim (`metadata.question ===
 *     "claim_<i>"`, `signal_strength` uncalibrated, `candidate` = claim
 *     text; `metadata.verdict` is informational only, recomputed here).
 *   - one REFUTATION `noul` signal per claim (`metadata.question ===
 *     "refute_<i>"`, `metadata.refutation === true`): the dedicated "does
 *     the evidence DENY this claim?" probe (fut-b-semantica T3). Absence of
 *     support is NEVER refutation.
 *
 * Thresholds (origin: gate.ts legacy action + verify.ts verdicts, behavior
 * preserved, NOT calibrated; SHARED via thresholds.ts):
 * `claimVerified` (v1 0.8, `>=`) is the firm band for BOTH the support and
 * the refutation probe (no new cut: nothing here is calibrated).
 * `claimContradicted` (v1 0.4) is RETAINED in the shared table (defaults,
 * env override, compat) but gate@1.0.0 no longer consults it: the v1
 * inference "support < 0.4  =>  contradicted" labelled absence of evidence
 * a refutation, which T3 removes (BREAKING vs P1-T4/T5: low support
 * without firm refutation no longer escalates as contradicted; it flows to
 * the auto/review band on safety instead. Update golds accordingly).
 * `reviewAuto` (v1 0.85, strict `>` for auto).
 * Preserved logic order: contradicted claims dominate safety — any
 * positively-refuted claim (firm refutation + weak support) ESCALATEs even
 * with high safe_to_apply. Low safety WITHOUT contradicted claims REVIEWs
 * (never escalates on safety alone — the deliberate difference from
 * review@1.0.0).
 *
 * Legacy evidence without `refute_<i>` signals (pre-T3 bundles) degrades
 * to the support-only mapping: the contradicted exit is unreachable there
 * (no probe affirmed a denial). An explicit null on any asked signal is a
 * MISSING signal (-> ESCALATE), never a weak one.
 *
 * DELIBERATE RUBRIC DIFFERENCE vs review@1.0.0 (P1-T5, documented here
 * instead of widened): gate consumes only the correctness/spec_match
 * `score` signals plus safe_to_apply and the per-claim support signals.
 * test_gap/blast_radius are NOT asked by laya_gate (the TS builder keeps
 * 3 fixed rubric questions so claims still fit the 64-question server
 * budget with two questions per claim): coverage breadth belongs to
 * laya_review, completion truthfulness belongs here. The review-family
 * `score` signals are audit-only in v1 — the DECISION reads safe_to_apply
 * + claim signals.
 *
 * Reason codes (exhaustive, T4 names kept):
 *   - "gate_contradicted_escalate" (ESCALATE) any claim with firm
 *                                            refutation + weak support
 *   - "gate_auto_allow"            (ALLOW)    no contradicted + safe > auto
 *   - "gate_review"                (REVIEW)   otherwise (incl. low safety
 *                                            alone, unsupported claims alone)
 *   - "gate_missing_signal"        (ESCALATE) safe_to_apply or any asked
 *                                            claim/refutation signal
 *                                            null/absent
 *   - "abstained_evidence"         (ESCALATE) global rule in engine.ts.
 * v1 never returns DENY (gate refuses authority; worst case is ESCALATE).
 *
 * Risk (fut-b-semantica T2): `risk` moves ONLY the auto cut by the shared
 * RISK_CUT_DELTA (thresholds.ts): high 0.90 / normal 0.85 / low 0.80 with
 * default thresholds. No version bump: risk "normal"/unset is byte-identical
 * to the pre-T2 cuts, and reason codes are unchanged.
 */
import type { Signal } from "../../evidence.js";
import type { PolicyThresholds } from "../thresholds.js";
import { riskCutDelta } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

function questionOf(s: Signal): string {
  return String((s.metadata as Record<string, unknown> | undefined)?.question ?? "");
}

export const gatePolicy: PolicyDefinition = {
  name: "gate",
  version: "1.0.0",
  description: "Completion gate: positively-refuted claims escalate, then the shared 0.85 auto cut applies.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "gate", version: "1.0.0" };
    const signals: Signal[] = ctx.evidence?.signals ?? [];
    const safe = signals.find((s) => questionOf(s) === "safe_to_apply")?.signal_strength;
    const claims = signals.filter((s) => /^claim_\d+$/.test(questionOf(s)));
    if (typeof safe !== "number") {
      return { decision: "ESCALATE", reason_codes: ["gate_missing_signal"], policy };
    }
    for (const c of claims) {
      const support = c.signal_strength;
      if (typeof support !== "number") {
        return { decision: "ESCALATE", reason_codes: ["gate_missing_signal"], policy };
      }
      const m = /^claim_(\d+)$/.exec(questionOf(c));
      const refute = m ? signals.find((s) => questionOf(s) === `refute_${m[1]}`) : undefined;
      if (refute !== undefined) {
        const denial = refute.signal_strength;
        if (typeof denial !== "number") {
          return { decision: "ESCALATE", reason_codes: ["gate_missing_signal"], policy };
        }
        // fut-b-semantica T3: contradicted needs POSITIVE refutation (firm
        // denial + weak support). Low support alone is absence of evidence
        // and flows to the safety band below -- never an escalation here.
        if (denial >= t.claimVerified && support < t.claimVerified) {
          return { decision: "ESCALATE", reason_codes: ["gate_contradicted_escalate"], policy };
        }
      }
    }
    // fut-b-semantica T2 (risk-effective, no bump: risk "normal"/unset keeps
    // the v1 0.85 cut byte-identical): risk tightens/relaxes ONLY the auto
    // band (high: 0.90, low: 0.80 with default thresholds). The contradicted
    // and missing-signal exits above are safety floors -- risk never rescues
    // them, and the shared 0.8 firm cut stays fixed (verify's table).
    // Reason codes are unchanged: the cut moved, not the contract.
    if (safe > t.reviewAuto + riskCutDelta(ctx.risk)) {
      return { decision: "ALLOW", reason_codes: ["gate_auto_allow"], policy };
    }
    return { decision: "REVIEW", reason_codes: ["gate_review"], policy };
  },
};
