/**
 * laya-calibration T2: per-scenario doubt-gate cuts (ADDITIVE, no policy change).
 *
 * Source: `evals/results/laya-calibration/CALIBRATION.md` §6 (T1). T1 found NO
 * separable cell at usable n, so every row carries the uniform conservative
 * tripwire 0.90-UNCALIBRATED (the only non-flagged row is extract; classify /
 * gate carry BROKEN-GOLDS, find carries INVERTED). These numbers are NOT
 * calibrated measurements -- do NOT lower them to "reduce noise", do NOT fit
 * temperature, and do NOT gate on entropy `confidence` (see CALIBRATION.md
 * §8 for the full NOT list).
 *
 * Per-call plumbing: each row also carries the optional `lang` /
 * `head_max_len` / `min_confidence` fields, all UNSET in T2 (auto-detect;
 * measured ES routing shows no pass correlation; the SDK `min_confidence`
 * answer fields have no handler consumer yet). `scenarioPredictOpts` builds
 * the `PredictOpts` from the row, so UNSET rows produce byte-identical
 * `/predict` payloads (the client only spreads set fields).
 *
 * Consumption: `evaluateForTool` (mode.ts) selects the cut by MCP tool name
 * and overrides `thresholds.minConfidence` with the row value; tools without
 * a row fall back to the global `thresholds.minConfidence`. `thresholds.ts`
 * defaults are untouched (still honest v1 + UNCALIBRATED flag).
 */
import type { PredictOpts } from "../client.js";

/** T1 disposition flags. Informational only: they never move a cut. */
export type ScenarioCutFlag = "BROKEN-GOLDS" | "INVERTED";

export interface ScenarioCut {
  /** Doubt-gate cut for this scenario. Uniform 0.90 in T2 (UNCALIBRATED). */
  minConfidence: number;
  /** True while the cut is a conservative tripwire, not a measurement. */
  uncalibrated: boolean;
  /** T1 flag for this scenario (absent = no flag). */
  flag?: ScenarioCutFlag;
  /** Effective-n behind the row (repeats are not independent; ~= cases). */
  n: string;
  /** One-line T1 justification (from CALIBRATION.md §6). */
  justification: string;
  /** Per-call `lang` hint. UNSET in T2 (auto-detect). */
  lang?: string | undefined;
  /** Per-call `head_max_len`. UNSET in T2 (our max is 4 options). */
  head_max_len?: number | undefined;
  /** Per-call SDK `min_confidence`. UNSET in T2 (no handler consumer yet). */
  min_confidence?: number | undefined;
}

/**
 * Per-scenario table keyed by MCP tool name. All cuts 0.90-UNCALIBRATED per
 * T1 §6; all per-call fields unset per T1 §7.5-7.7 (plumbing only, zero
 * behavior change in T2).
 */
export const SCENARIO_CUTS: Record<string, ScenarioCut> = {
  laya_screen: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "7+66",
    justification: "bands overlap/inverted; >=.90 band empty in ES; review-by-default",
  },
  laya_verify: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "6+48",
    justification: ">=.90 = 0/6 (overconfidence exhibit); base ECE .164 at n=6, not fittable",
  },
  laya_rerank: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "6",
    justification: "best ECE (.087) but n=6 single-pass; keep, do not tune to it",
  },
  laya_extract: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "7",
    justification: "only >=.90-hit cell (2/2); 0.90 already exploits it (sole row without a flag)",
  },
  laya_review: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "7",
    justification: "score-scale piles minConf ~.4, 0.90 escalates 7/7; do NOT lower to quiet it",
  },
  laya_gate: {
    minConfidence: 0.9,
    uncalibrated: true,
    flag: "BROKEN-GOLDS",
    n: "7",
    justification: "0/7 pass; cut meaningless until golds fixed",
  },
  laya_classify: {
    minConfidence: 0.9,
    uncalibrated: true,
    flag: "BROKEN-GOLDS",
    n: "7",
    justification: "0/7 pass; cut meaningless until golds fixed",
  },
  laya_compare: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "7",
    justification: "ECE .720; >=.90 = 0/3",
  },
  laya_decide: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "7",
    justification: "#394 pattern (6/7 >=.90, 1/6 pass); raising the cut cannot fix",
  },
  laya_find: {
    minConfidence: 0.9,
    uncalibrated: true,
    flag: "INVERTED",
    n: "7",
    justification: "higher band worse (1/4 vs 2/3); do not tune a cut to this",
  },
  laya_pii: {
    minConfidence: 0.9,
    uncalibrated: true,
    n: "unmeasured",
    justification: "no per-scenario measurement in T1 (count-based policy); uniform fallback",
  },
};

/** Row for a tool name, or null when the tool has no calibrated row. */
export function scenarioCutFor(toolName: string): ScenarioCut | null {
  return SCENARIO_CUTS[toolName] ?? null;
}

/**
 * Per-call predict options for a tool from its scenario row. All fields are
 * UNSET in T2, so this returns `{}` for every known tool today (and for
 * unknown tools) -- byte-identical `/predict` payloads. Future per-scenario
 * values flow through automatically once a row sets them.
 */
export function scenarioPredictOpts(toolName: string): PredictOpts {
  const cut = scenarioCutFor(toolName);
  if (!cut) return {};
  return {
    ...(cut.lang != null ? { lang: cut.lang } : {}),
    ...(cut.head_max_len != null ? { head_max_len: cut.head_max_len } : {}),
    ...(cut.min_confidence != null ? { min_confidence: cut.min_confidence } : {}),
  };
}

/**
 * Effective doubt-gate cut for a tool: the scenario row when known, else the
 * global fallback. Pure (no env read here; the caller supplies the fallback
 * from its resolved thresholds).
 */
export function scenarioMinConfidence(toolName: string, fallback: number): number {
  const cut = scenarioCutFor(toolName);
  return cut ? cut.minConfidence : fallback;
}
