/**
 * Fase-7 T4 shared metrics: pure functions, no I/O, no thresholds.
 *
 * SCOPE (T4 only): binary classification metrics (accuracy / precision /
 * recall / F1 / FPR / FNR), decision accuracy, abstention rate, ranking
 * metrics (MRR / nDCG / MAP / top-k hit), score agreement helpers, and
 * wrong_confident_rate slices. No benchmarks (T5), no EVALUATION.md.
 *
 * HONESTY RULES (see evals/calibration.md for the full verdict):
 * - Every numeric signal in this repo is UNCALIBRATED. Nothing here is a
 *   probability, nothing here is a confidence, and no output of this module
 *   may be used as a production threshold (wrong_confident taus are
 *   reporting slices only).
 * - Brier score and ECE are live-miscalibration DIAGNOSTICS only
 *   (brierScore()/ece() below): they quantify how far a raw primitive
 *   signal is from behaving like a probability, over (signal, outcome)
 *   pairs measured against a LIVE backend (see evals/live-cal.mjs). They
 *   never promote a signal to a probability, never justify a production
 *   threshold, and are meaningless over oracle-stub signals (which match
 *   by construction).
 * - Zero denominators yield null (honest absence), never 0, 1, or NaN.
 * - Null signals, abstained cases, and input_too_large throws are EXCLUDED
 *   from denominators by the caller; each function documents its own
 *   denominator and the runner reports every exclusion count.
 */

export const WRONG_CONFIDENT_TAUS = [0.7, 0.8, 0.9, 0.95];

/** Approximate equality for tests (float log2 math). */
export function approx(a, b, eps = 1e-6) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= eps;
}

function safeDiv(num, den) {
  return den === 0 ? null : num / den;
}

/**
 * Binary metrics over pre-binarized pairs.
 * @param pairs Array<{ actual: boolean, predicted: boolean }>.
 *   Callers MUST exclude nulls/abstentions before calling.
 * @returns { n, tp, tn, fp, fn, accuracy, precision, recall, f1, fpr, fnr }
 *   (ratios are null when their denominator is 0).
 */
export function binaryMetrics(pairs) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const p of pairs) {
    if (p.actual && p.predicted) tp++;
    else if (!p.actual && !p.predicted) tn++;
    else if (!p.actual && p.predicted) fp++;
    else fn++;
  }
  const n = pairs.length;
  const accuracy = safeDiv(tp + tn, n);
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = tp + fp === 0 || tp + fn === 0 ? null : precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  const fpr = safeDiv(fp, fp + tn);
  const fnr = safeDiv(fn, fn + tp);
  return { n, tp, tn, fp, fn, accuracy, precision, recall, f1, fpr, fnr };
}

/**
 * Exact-match decision accuracy.
 * @param records Array<{ actual: string, predicted: string }>.
 *   Throw-cases and abstentions excluded by the caller.
 */
export function decisionAccuracy(records) {
  const correct = records.filter((r) => r.actual === r.predicted).length;
  return { n: records.length, correct, accuracy: safeDiv(correct, records.length) };
}

/**
 * Abstention accounting. Throws (input_too_large fail-fast cases) are
 * reported separately and excluded from the rate denominator.
 * @param cases Array<{ threw: boolean, abstained: boolean }>.
 */
export function abstentionStats(cases) {
  const total = cases.length;
  const errors = cases.filter((c) => c.threw).length;
  const scored = total - errors;
  const abstained = cases.filter((c) => !c.threw && c.abstained).length;
  return { total, errors, scored, abstained, abstention_rate: safeDiv(abstained, scored) };
}

/**
 * Ranking metrics of one predicted order against one gold order.
 * Relevance grades come FROM the gold order: rel = 1 / goldRank
 * (gold top = 1.0, second = 0.5, ...). The ideal (IDCG) is the gold order
 * itself, so a perfect prediction scores exactly 1.0.
 * MRR / MAP use the gold top-1 as the single relevant doc (for a single
 * relevant doc AP == RR; both are reported for contract completeness).
 * @param predictedIds ids in predicted rank order.
 * @param goldOrder ids in gold (ideal) rank order.
 * @param ks top-k cutoffs for hit rates (gold top-1 in predicted top-k).
 */
export function rankingMetrics(predictedIds, goldOrder, ks = [1, 3]) {
  const goldRank = new Map(goldOrder.map((id, i) => [id, i + 1]));
  const relOf = (id) => (goldRank.has(id) ? 1 / goldRank.get(id) : 0);
  const dcg = (order) =>
    order.reduce((s, id, i) => s + (i === 0 ? relOf(id) : relOf(id) / Math.log2(i + 2)), 0);
  const ideal = dcg(goldOrder);
  const actual = dcg(predictedIds);
  const ndcg = ideal === 0 ? null : actual / ideal;
  const topRank = predictedIds.indexOf(goldOrder[0]);
  const rr = goldOrder.length === 0 ? null : topRank === -1 ? 0 : 1 / (topRank + 1);
  const topK = {};
  for (const k of ks) topK[`top_${k}`] = goldOrder.length === 0 ? null : topRank !== -1 && topRank < k ? 1 : 0;
  return { ndcg, mrr: rr, map: rr, ...{ topK } };
}

/** Mean of per-case ranking metric dicts (nulls excluded per metric). */
export function meanRanking(perCase, ks = [1, 3]) {
  const mean = (vals) => {
    const v = vals.filter((x) => x !== null);
    return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
  };
  const out = {
    n: perCase.length,
    mrr: mean(perCase.map((m) => m.mrr)),
    ndcg: mean(perCase.map((m) => m.ndcg)),
    map: mean(perCase.map((m) => m.map)),
    topK: {},
  };
  for (const k of ks) out.topK[`top_${k}`] = mean(perCase.map((m) => m.topK[`top_${k}`]));
  return out;
}

/**
 * Rubric score agreement (review/gate 0-2 scores) for FUTURE oracles.
 * T3 golds hold decisions, not rubric scores, so the T4 runner reports
 * score agreement as not-computable; this helper exists so T5+ oracles
 * with score golds reuse one definition. Nulls excluded by the caller.
 */
export function scoreAgreement(pairs) {
  if (pairs.length === 0) return { n: 0, exact_match_rate: null, mae: null };
  const exact = pairs.filter((p) => p.actual === p.predicted).length;
  const mae = pairs.reduce((s, p) => s + Math.abs(p.actual - p.predicted), 0) / pairs.length;
  return { n: pairs.length, exact_match_rate: exact / pairs.length, mae };
}

/**
 * Brier score over live (signal, outcome) pairs. Diagnostic only: measures
 * how far the raw primitive signal is from behaving like a probability.
 * @param pairs Array<{ signal: number, correct: boolean }>.
 *   Callers MUST exclude null-signal/abstained/threw judgments before
 *   calling (same denominator as wrongConfident). Outcome is 1 when the
 *   judgment was correct, 0 otherwise.
 * @returns { n, brier } (brier is null when n is 0; 0 = perfect).
 */
export function brierScore(pairs) {
  if (pairs.length === 0) return { n: 0, brier: null };
  const sum = pairs.reduce((a, p) => a + (p.signal - (p.correct ? 1 : 0)) ** 2, 0);
  return { n: pairs.length, brier: sum / pairs.length };
}

/**
 * Expected Calibration Error over live (signal, outcome) pairs, equal-width
 * bins over [0,1]. Diagnostic only (same honesty rule as brierScore).
 * @param pairs Array<{ signal: number, correct: boolean }> (nulls excluded
 *   by the caller).
 * @param bins bin count (default 10 per the calibration task).
 * @returns { n, bins, ece, binsDetail } where ece = SUM_bins
 *   |accuracy - confidence| * (n_bin / n). Signals outside [0,1] (never
 *   expected from noul/probability signals) clamp into the edge bins and
 *   are counted in `clamped` rather than dropped. Empty input yields
 *   ece null (honest absence).
 */
export function ece(pairs, bins = 10) {
  const detail = Array.from({ length: bins }, (_, i) => ({
    bin: i,
    lo: i / bins,
    hi: (i + 1) / bins,
    n: 0,
    accuracy: null,
    confidence: null,
  }));
  if (pairs.length === 0) return { n: 0, bins, ece: null, clamped: 0, binsDetail: detail };
  let clamped = 0;
  const sums = detail.map(() => ({ correct: 0, signal: 0 }));
  for (const p of pairs) {
    let idx = Math.floor(p.signal * bins);
    if (p.signal < 0 || p.signal > 1) {
      clamped++;
      idx = Math.min(bins - 1, Math.max(0, idx));
    } else {
      idx = Math.min(bins - 1, Math.max(0, idx));
    }
    detail[idx].n++;
    sums[idx].correct += p.correct ? 1 : 0;
    sums[idx].signal += p.signal;
  }
  let weighted = 0;
  for (let i = 0; i < bins; i++) {
    if (detail[i].n === 0) continue;
    detail[i].accuracy = sums[i].correct / detail[i].n;
    detail[i].confidence = sums[i].signal / detail[i].n;
    weighted += Math.abs(detail[i].accuracy - detail[i].confidence) * (detail[i].n / pairs.length);
  }
  return { n: pairs.length, bins, ece: weighted, clamped, binsDetail: detail };
}

/**
 * wrong_confident_rate slices. One item = one scored judgment with its
 * primitive-specific signal (see evals/score.mjs SIGNAL_MAP for which
 * signal each primitive uses; rerank is excluded with justification).
 * @param items Array<{ correct: boolean, signal: number|null, abstained: boolean, threw: boolean }>.
 *   Null-signal, abstained, and threw items are OUTSIDE the denominator.
 * @param taus reporting slices (NEVER production thresholds).
 * @returns per tau { tau, scored, confident, wrong_and_confident, rate,
 *   conditional_wrong_given_confident } where rate is the JOINT rate
 *   P(wrong AND signal >= tau) over scored items.
 */
export function wrongConfident(items, taus = WRONG_CONFIDENT_TAUS) {
  const scored = items.filter((it) => !it.threw && !it.abstained && typeof it.signal === "number");
  const excluded = {
    threw: items.filter((it) => it.threw).length,
    abstained: items.filter((it) => !it.threw && it.abstained).length,
    null_signal: items.filter((it) => !it.threw && !it.abstained && typeof it.signal !== "number").length,
  };
  return {
    scored: scored.length,
    excluded,
    slices: taus.map((tau) => {
      const confident = scored.filter((it) => it.signal >= tau);
      const wrong = confident.filter((it) => !it.correct).length;
      return {
        tau,
        confident: confident.length,
        wrong_and_confident: wrong,
        rate: safeDiv(wrong, scored.length),
        conditional_wrong_given_confident: safeDiv(wrong, confident.length),
      };
    }),
  };
}
