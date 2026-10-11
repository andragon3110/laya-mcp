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
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext, PolicyRef } from "../types.js";

function noul(signals: Signal[], question: string): number | null {
  const sig = signals.find((s) => (s.metadata as Record<string, unknown> | undefined)?.question === question);
  const v = sig?.signal_strength;
  return typeof v === "number" ? v : null;
}

/**
 * S5 (spike-guards wiring): shield-small firm INJECTION cut.
 *
 * Provenance (measured-on-20, NEVER a probability, NEVER calibrated): on
 * the 20 fixed transfer cases in odd/tasks/spike-guards.md S4, measured
 * attacks scored at or above 0.9996 and measured benigns at or below
 * 0.0013 -- a four-decade gap. 0.99 sits inside that gap: every measured
 * attack clears it, every measured benign misses it. It is a documented
 * operating point on those 20 cases, not a calibrated threshold and not
 * a claim about evasive or out-of-distribution text (REVIEW-blindness and
 * the zero-width blind spot are restated limits, see S5).
 *
 * Override: SHIELD_FIRM_SCORE (finite number in [0, 1]; missing,
 * non-finite, or out-of-range values fall back to the default below
 * without throwing). The override resolved green against the existing
 * threshold batteries (they never set it and never touch this file),
 * so it ships as an env knob, not a second constant. Risk never moves
 * this cut: a firm pre-filter hit is a confirmed-harm exit (same fixed-
 * point doctrine as thresholds.ts), and the edge is deliberately `>=`
 * (at-or-above fires), unlike the strict `>` injection cuts below.
 *
 * I/O boundary (same style as loader thresholds / mode resolution):
 * `resolveShieldFirmScore` is pure over an explicit env dict;
 * `evaluate` below reads the live process env per call (never cached at
 * import, so operators and tests can set/unset without a reload).
 */
export const SHIELD_FIRM_SCORE_DEFAULT = 0.99;
export const SHIELD_FIRM_SCORE_ENV = "SHIELD_FIRM_SCORE";

export function resolveShieldFirmScore(env: Record<string, string | undefined>): number {
  const raw = env[SHIELD_FIRM_SCORE_ENV];
  if (raw === undefined) return SHIELD_FIRM_SCORE_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) return SHIELD_FIRM_SCORE_DEFAULT;
  return v;
}

/** Locate the shield pre-filter number (detector_score, never confidence). */
function shieldScore(signals: Signal[]): number | null {
  const sig = signals.find(
    (s) => s.detector === "shield" && (s.metadata as Record<string, unknown> | undefined)?.shield_prefilter === true,
  );
  const v = sig?.detector_score;
  return typeof v === "number" ? v : null;
}

/**
 * The 1.0.0 judge path, shared verbatim by 1.0.0 and 1.1.0 (only the
 * stamped `policy` ref differs). Below-firm or absent shield, 1.1.0
 * judges EXACTLY as 1.0.0: same cuts, same strict >/ < edges, same
 * reason codes.
 */
function judgeLike100(ctx: PolicyEvalContext, t: PolicyThresholds, policy: PolicyRef): PolicyDecision {
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
}

export const screenPolicy: PolicyDefinition = {
  name: "screen",
  version: "1.0.0",
  description: "Injection/substance gate preserving the pre-P1 screen cut points (0.75/0.25/0.4).",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    return judgeLike100(ctx, t, { name: "screen", version: "1.0.0" });
  },
};

/**
 * screen@1.1.0 -- 1.0.0 judge PLUS exactly one rule: a present shield
 * pre-filter signal at or above the firm cut short-circuits to DENY with
 * the NEW reason code `screen_shield_prefilter` (policy {screen, 1.1.0}).
 * The shield rule runs FIRST (before the missing-signal exit, before the
 * global-abstention-exempt judge bands): on the handler fast path the
 * Laya judge never ran, so its signals are null and only the shield
 * number decides. Below firm or absent shield, this delegates to
 * judgeLike100 -- every 1.0.0 cut and reason code preserved. The engine
 * global rule still precedes all of this: abstained evidence ESCALATEs
 * even with a firm shield number present (pinned by battery).
 */
export const screenPolicy11: PolicyDefinition = {
  name: "screen",
  version: "1.1.0",
  description:
    "1.0.0 judge plus the shield-small pre-filter: firm INJECTION (>= 0.99 measured-on-20) DENYs as screen_shield_prefilter; below firm judges as 1.0.0.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "screen", version: "1.1.0" };
    const firm = resolveShieldFirmScore(process.env as Record<string, string | undefined>);
    const s = shieldScore(ctx.evidence?.signals ?? []);
    if (s !== null && s >= firm) {
      return { decision: "DENY", reason_codes: ["screen_shield_prefilter"], policy };
    }
    return judgeLike100(ctx, t, policy);
  },
};
