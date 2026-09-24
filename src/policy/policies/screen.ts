/**
 * screen@1.0.0 — prompt-injection / substance gate.
 *
 * Evidence consumed: three Router `noul` signals built by
 * `screenEvidence` (evidence.ts), located by `metadata.question`:
 *   - "is_injection"  -> `signal_strength` (uncalibrated)
 *   - "has_substance" -> `signal_strength` (uncalibrated)
 *   - "is_relevant"   -> carried for audit only; v1 does NOT branch on it
 *     (preserved: the legacy handler computed relevance but never used it
 *     in the action expression).
 *
 * Thresholds (origin: screen.ts legacy action, behavior preserved, NOT
 * calibrated): `screenInjectionBlock` (v1 0.75, strict `>`),
 * `screenInjectionReview` (v1 0.25, strict `>`), `screenSubstanceSkip`
 * (v1 0.4, strict `<`). Exact-edge semantics: 0.75 -> REVIEW (not block),
 * 0.25 -> substance branch, 0.4 -> PASS (not skip).
 *
 * Reason codes (exhaustive):
 *   - "screen_injection_block"   (DENY)    injection > block
 *   - "screen_injection_review"  (REVIEW)  injection > review
 *   - "screen_skip_low_substance"(REVIEW)  low substance, no injection flag
 *   - "screen_pass"              (ALLOW)   firm signals, no flag tripped
 *   - "screen_missing_signal"    (ESCALATE) injection or substance null/absent
 *   - "abstained_evidence"       (ESCALATE) global rule, applied in engine.ts
 *     before this policy runs (missing Router answers abstain in evidence.ts).
 *
 * Risk (fut-b-semantica T2): `risk` moves ONLY the two injection cuts by
 * the shared RISK_CUT_DELTA (thresholds.ts) -- high tightens (block 0.70 /
 * review 0.20), low relaxes (block 0.80 / review 0.30) with default
 * thresholds. The substance cut is fixed (not a safety band). No version
 * bump: risk "normal"/unset is byte-identical to the pre-T2 cuts, and
 * reason codes are unchanged.
 */
import type { Signal } from "../../evidence.js";
import type { PolicyThresholds } from "../thresholds.js";
import { riskCutDelta } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

function noul(signals: Signal[], question: string): number | null {
  const sig = signals.find((s) => (s.metadata as Record<string, unknown> | undefined)?.question === question);
  const v = sig?.signal_strength;
  return typeof v === "number" ? v : null;
}

export const screenPolicy: PolicyDefinition = {
  name: "screen",
  version: "1.0.0",
  description: "Injection/substance gate preserving the pre-P1 screen cut points (0.75/0.25/0.4).",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "screen", version: "1.0.0" };
    const signals = ctx.evidence?.signals ?? [];
    const injection = noul(signals, "is_injection");
    const substance = noul(signals, "has_substance");
    if (injection === null || substance === null) {
      return { decision: "ESCALATE", reason_codes: ["screen_missing_signal"], policy };
    }
    // fut-b-semantica T2 (risk-effective, no bump: risk "normal"/unset keeps
    // the v1 0.75/0.25 cuts byte-identical): risk shifts ONLY the injection
    // cuts -- high lowers them (easier to DENY/REVIEW), low raises them.
    // Exact-edge semantics stay strict >/ <: 0.70/0.80 -> REVIEW (not block)
    // under high/low respectively. The substance cut and the missing-signal
    // exit are fixed points -- risk never moves them.
    const delta = riskCutDelta(ctx.risk);
    if (injection > t.screenInjectionBlock - delta) {
      return { decision: "DENY", reason_codes: ["screen_injection_block"], policy };
    }
    if (injection > t.screenInjectionReview - delta) {
      return { decision: "REVIEW", reason_codes: ["screen_injection_review"], policy };
    }
    if (substance < t.screenSubstanceSkip) {
      return { decision: "REVIEW", reason_codes: ["screen_skip_low_substance"], policy };
    }
    return { decision: "ALLOW", reason_codes: ["screen_pass"], policy };
  },
};
