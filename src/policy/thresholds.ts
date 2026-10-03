/**
 * P1-T4: single shared v1 threshold table.
 *
 * ORIGIN (every value): behavior preserved from the pre-P1 handlers, NOT
 * calibrated. There is no calibration harness in this repo, so these numbers
 * are honest pass-throughs of what the code already did. Do not read them as
 * probabilities; several are raw Router `noul` outputs (uncalibrated signals).
 *
 * Source mapping (handler -> threshold):
 *   - screen.ts `injection > 0.75 ? block : injection > 0.25 ? review :
 *     substance < 0.4 ? skip : pass`
 *       -> screenInjectionBlock = 0.75, screenInjectionReview = 0.25,
 *          screenSubstanceSkip = 0.4
 *   - verify.ts + gate.ts `prob >= 0.8 ? verified : prob >= 0.4 ? unsupported
 *     : contradicted` (DUPLICATED literal in both handlers; unified here)
 *       -> claimVerified = 0.8, claimContradicted = 0.4 (shared by the
 *          verify@1.0.0 and gate@1.0.0 policies; the duplication is gone)
 *   - review.ts `safe > 0.85 ? auto : safe > 0.5 ? review : escalate` and
 *     gate.ts `contradicted > 0 ? escalate : safe > 0.85 ? auto : review`
 *       -> reviewAuto = 0.85, reviewReview = 0.5 (shared; the review/gate
 *          LOGIC differs — gate escalates only on contradicted claims —
 *          but the safe_to_apply CUT POINTS are one table)
 *   - decide via evidence.ts decideEvidence `requirement signal < 0.8`
 *     counts as unsupported
 *       -> requireSupport = 0.8
 *   - pii.ts `SECRET_TYPES = {api_key, token_secreto, password}` with
 *     `secrets > 0 ? block : findings > 0 ? review : pass`
 *       -> secretTypes = ["api_key", "token_secreto", "password"]
 *          (count-based, no numeric cut point)
 *   - doubt-gate-es T3 `minConfidence = 0.90` (UNCALIBRATED-CONSERVATIVE):
 *     the global doubt gate in engine.ts escalates when the case
 *     min-confidence falls below this cut. Unlike every value above, this
 *     number is NOT preserved behavior -- it comes from
 *     `evals/results/doubt-gate-es/BASELINE.md` §6, which found NO positive
 *     calibration signal (bands overlap: >=0.90 -> 0/6, 0.80-0.90 -> 0.50,
 *     <0.80 -> 0.43 on effectively ~19 cases), so the cut is a conservative
 *     tripwire (~95% of ES-like traffic escalates: 108/114 case-passes <
 *     0.90, p90 = 0.877), explicitly NOT a measurement. See
 *     DOUBT_GATE_UNCALIBRATED below; do NOT lower it to "reduce noise"
 *     (0.50 would escalate nothing: min observed is 0.5155).
 *
 * ENV OVERRIDES (documented; for ops/tests only — overrides do NOT
 * calibrate anything, they only move the preserved cut points):
 *   - LAYA_POLICY_SCREEN_BLOCK          (default 0.75)
 *   - LAYA_POLICY_SCREEN_REVIEW         (default 0.25)
 *   - LAYA_POLICY_SCREEN_SUBSTANCE_SKIP (default 0.4)
 *   - LAYA_POLICY_CLAIM_VERIFIED        (default 0.8)
 *   - LAYA_POLICY_CLAIM_CONTRADICTED    (default 0.4)
 *   - LAYA_POLICY_REVIEW_AUTO           (default 0.85)
 *   - LAYA_POLICY_REVIEW_MIN            (default 0.5)
 *   - LAYA_POLICY_REQUIRE_SUPPORT       (default 0.8)
 *   - LAYA_POLICY_SECRET_TYPES          (default "api_key,token_secreto,password";
 *                                        comma-separated list)
 *   - LAYA_POLICY_MIN_CONFIDENCE        (default 0.90, doubt-gate-es T3;
 *                                        UNCALIBRATED -- see DOUBT_GATE_UNCALIBRATED)
 * Missing or non-finite values fall back to the v1 defaults above (no
 * throw: the engine stays total). Resolution happens in loader.ts at load
 * time; the decision path itself never touches process.env.
 */

export interface PolicyThresholds {
  screenInjectionBlock: number;
  screenInjectionReview: number;
  screenSubstanceSkip: number;
  /** Shared verify+gate cut: signal >= this is a verified claim. */
  claimVerified: number;
  /**
   * Legacy verify+gate low-support cut (v1 0.4, `<` contradicted).
   *
   * fut-b-semantica T3: verify@1.0.0 and gate@1.0.0 NO LONGER consult this
   * field -- inferring contradiction from low support labelled absence of
   * evidence a refutation. CONTRADICTED now needs a firm refutation probe
   * (refute >= claimVerified) plus weak support. The field stays in the
   * table (defaults, LAYA_POLICY_CLAIM_CONTRADICTED override, and the
   * v1-defaults battery) for compat; no value changed (NOT calibrated).
   */
  claimContradicted: number;
  /** Shared review+gate+code-review cut: safe_to_apply > this is auto/allow. */
  reviewAuto: number;
  /** Shared review cut: safe_to_apply > this (and <= auto) needs review. */
  reviewReview: number;
  /** decide requirement cut: signal < this is an unsupported requirement. */
  requireSupport: number;
  /**
   * doubt-gate-es T3: global doubt-gate cut. The engine escalates (never
   * blocks) when the case min-confidence falls below this value.
   * UNCALIBRATED-CONSERVATIVE 0.90 -- see DOUBT_GATE_UNCALIBRATED.
   */
  minConfidence: number;
  /** PII secret types (count-based, from pii.ts SECRET_TYPES). */
  secretTypes: string[];
}

/** v1 defaults: byte-equivalent to the pre-P1 handler literals. */
export const THRESHOLDS_V1: PolicyThresholds = {
  screenInjectionBlock: 0.75,
  screenInjectionReview: 0.25,
  screenSubstanceSkip: 0.4,
  claimVerified: 0.8,
  claimContradicted: 0.4,
  reviewAuto: 0.85,
  reviewReview: 0.5,
  requireSupport: 0.8,
  minConfidence: 0.9,
  secretTypes: ["api_key", "token_secreto", "password"],
};

/**
 * doubt-gate-es T3: the `minConfidence` cut above is UNCALIBRATED.
 *
 * `evals/results/doubt-gate-es/BASELINE.md` §4/§6 (T2, N = 6 passes over 20
 * ES cases + 80-case anchor): declared model confidence does NOT separate
 * hits from misses on these slices (bands overlap), so no data-driven cut
 * exists. Per the task contract the gate ships at the conservative tripwire
 * 0.90 anyway -- escalating on doubt, never blocking, never inventing
 * certainty -- with ~95% escalation expected on ES-like traffic until real
 * labels exist. `true` while this holds; flip only with a measured
 * recalibration, never to quiet the gate.
 */
export const DOUBT_GATE_UNCALIBRATED = true;

/**
 * fut-b-semantica T2: risk strictness delta (NOT calibrated -- same honesty
 * as the v1 table above: a documented step, not a measured cut).
 *
 * Semantics (per-policy documentation owns the exact application):
 *   - risk "high" tightens bands by +DELTA (harder to ALLOW, easier to
 *     DENY/REVIEW/ESCALATE-adjacent outcomes);
 *   - risk "low" relaxes bands by -DELTA;
 *   - risk "normal" (default) applies zero delta: byte-identical v1 cuts.
 *
 * Fixed points (never moved by risk, in any policy): the global abstention
 * rule (engine.ts), missing-signal escalations, and confirmed-harm exits
 * (e.g. contradicted-claim escalation, secret DENY, clean ALLOW). Risk moves
 * leniency bands only, never safety floors.
 */
export const RISK_CUT_DELTA = 0.05;

/** Pure resolver: signed cut adjustment for a risk tier (0 when unset/unknown). */
export function riskCutDelta(risk: string | undefined): number {
  if (risk === "high") return RISK_CUT_DELTA;
  if (risk === "low") return -RISK_CUT_DELTA;
  return 0;
}

/** Env var names for each override (single source; loader/tests reuse). */
export const THRESHOLD_ENV_VARS = {
  screenInjectionBlock: "LAYA_POLICY_SCREEN_BLOCK",
  screenInjectionReview: "LAYA_POLICY_SCREEN_REVIEW",
  screenSubstanceSkip: "LAYA_POLICY_SCREEN_SUBSTANCE_SKIP",
  claimVerified: "LAYA_POLICY_CLAIM_VERIFIED",
  claimContradicted: "LAYA_POLICY_CLAIM_CONTRADICTED",
  reviewAuto: "LAYA_POLICY_REVIEW_AUTO",
  reviewReview: "LAYA_POLICY_REVIEW_MIN",
  requireSupport: "LAYA_POLICY_REQUIRE_SUPPORT",
  minConfidence: "LAYA_POLICY_MIN_CONFIDENCE",
  secretTypes: "LAYA_POLICY_SECRET_TYPES",
} as const;

function numOrDefault(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Pure resolver: apply an env-like dict over the v1 defaults.
 * Takes the dict as an argument so tests never touch process.env.
 */
export function resolveThresholds(env: Record<string, string | undefined>): PolicyThresholds {
  const secretsRaw = env[THRESHOLD_ENV_VARS.secretTypes];
  const secretTypes =
    secretsRaw === undefined || secretsRaw.trim() === ""
      ? [...THRESHOLDS_V1.secretTypes]
      : secretsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  return {
    screenInjectionBlock: numOrDefault(env[THRESHOLD_ENV_VARS.screenInjectionBlock], THRESHOLDS_V1.screenInjectionBlock),
    screenInjectionReview: numOrDefault(env[THRESHOLD_ENV_VARS.screenInjectionReview], THRESHOLDS_V1.screenInjectionReview),
    screenSubstanceSkip: numOrDefault(env[THRESHOLD_ENV_VARS.screenSubstanceSkip], THRESHOLDS_V1.screenSubstanceSkip),
    claimVerified: numOrDefault(env[THRESHOLD_ENV_VARS.claimVerified], THRESHOLDS_V1.claimVerified),
    claimContradicted: numOrDefault(env[THRESHOLD_ENV_VARS.claimContradicted], THRESHOLDS_V1.claimContradicted),
    reviewAuto: numOrDefault(env[THRESHOLD_ENV_VARS.reviewAuto], THRESHOLDS_V1.reviewAuto),
    reviewReview: numOrDefault(env[THRESHOLD_ENV_VARS.reviewReview], THRESHOLDS_V1.reviewReview),
    requireSupport: numOrDefault(env[THRESHOLD_ENV_VARS.requireSupport], THRESHOLDS_V1.requireSupport),
    minConfidence: numOrDefault(env[THRESHOLD_ENV_VARS.minConfidence], THRESHOLDS_V1.minConfidence),
    secretTypes: secretTypes.length > 0 ? secretTypes : [...THRESHOLDS_V1.secretTypes],
  };
}

/** I/O boundary: read the live process env. Called ONLY from loader.ts. */
export function thresholdsFromEnv(): PolicyThresholds {
  return resolveThresholds({ ...(process.env as Record<string, string | undefined>) });
}
