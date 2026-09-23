/**
 * Fase-7 T4 metrics tests: evals/metrics.mjs against hand-computed fixtures.
 *
 * Every expected value below was computed by hand (see the arithmetic in
 * each comment); approx() tolerance is 1e-6 except the nDCG case (log2
 * math, hand-rounded to 6 decimals, tolerance 1e-4). No models, no GPU,
 * no network, no pip: pure functions only.
 *
 * Run from the repo root: node tests/fase7_t4_metrics.mjs
 */
import assert from "node:assert";
import {
  WRONG_CONFIDENT_TAUS,
  abstentionStats,
  approx,
  binaryMetrics,
  decisionAccuracy,
  meanRanking,
  rankingMetrics,
  scoreAgreement,
  wrongConfident,
} from "../evals/metrics.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- binaryMetrics: TP=2 TN=1 FP=1 FN=1 (n=5).
// acc=3/5=0.6; P=2/3; R=2/3; F1=2/3; FPR=1/2=0.5; FNR=1/3.
check("binaryMetrics hand fixture (2/1/1/1)", () => {
  const pairs = [
    { actual: true, predicted: true },
    { actual: true, predicted: true },
    { actual: false, predicted: false },
    { actual: false, predicted: true },
    { actual: true, predicted: false },
  ];
  const m = binaryMetrics(pairs);
  assert.deepEqual({ n: m.n, tp: m.tp, tn: m.tn, fp: m.fp, fn: m.fn }, { n: 5, tp: 2, tn: 1, fp: 1, fn: 1 });
  assert.ok(approx(m.accuracy, 0.6), `accuracy ${m.accuracy}`);
  assert.ok(approx(m.precision, 2 / 3), `precision ${m.precision}`);
  assert.ok(approx(m.recall, 2 / 3), `recall ${m.recall}`);
  assert.ok(approx(m.f1, 2 / 3), `f1 ${m.f1}`);
  assert.ok(approx(m.fpr, 0.5), `fpr ${m.fpr}`);
  assert.ok(approx(m.fnr, 1 / 3), `fnr ${m.fnr}`);
});

// --- binaryMetrics: zero denominators yield null, never 0/1/NaN.
// All actual=false, all predicted=false: P=0/0, R=0/0, F1=null, FNR=0/0.
check("binaryMetrics zero denominators are null", () => {
  const m = binaryMetrics([
    { actual: false, predicted: false },
    { actual: false, predicted: false },
  ]);
  assert.equal(m.accuracy, 1);
  assert.equal(m.precision, null);
  assert.equal(m.recall, null);
  assert.equal(m.f1, null);
  assert.equal(m.fpr, 0);
  assert.equal(m.fnr, null);
});

// --- decisionAccuracy: 3 of 4 exact matches -> 0.75.
check("decisionAccuracy 3/4", () => {
  const m = decisionAccuracy([
    { actual: "ALLOW", predicted: "ALLOW" },
    { actual: "ESCALATE", predicted: "ESCALATE" },
    { actual: "DENY", predicted: "DENY" },
    { actual: "REVIEW", predicted: "ALLOW" },
  ]);
  assert.deepEqual(m, { n: 4, correct: 3, accuracy: 0.75 });
});

// --- abstentionStats: 8 total, 1 throw, 2 abstained -> rate 2/7.
check("abstentionStats excludes throws from the rate", () => {
  const m = abstentionStats([
    { threw: false, abstained: false },
    { threw: false, abstained: false },
    { threw: false, abstained: false },
    { threw: false, abstained: false },
    { threw: false, abstained: false },
    { threw: false, abstained: true },
    { threw: false, abstained: true },
    { threw: true, abstained: false },
  ]);
  assert.deepEqual({ total: m.total, errors: m.errors, scored: m.scored, abstained: m.abstained }, { total: 8, errors: 1, scored: 7, abstained: 2 });
  assert.ok(approx(m.abstention_rate, 2 / 7), `rate ${m.abstention_rate}`);
});

// --- rankingMetrics: pred [b,a,c] vs gold [a,b,c], rel = 1/goldRank.
// DCG = 0.5 + 1/log2(3) + (1/3)/2 = 1.297596; IDCG = 1 + 0.5/log2(3) + 1/6
// = 1.482132; nDCG ~= 0.875493. MRR: gold-top `a` at pred rank 2 -> 0.5.
// MAP (single relevant doc) == MRR == 0.5. top_1=0, top_2=1, top_3=1.
check("rankingMetrics hand fixture (pred [b,a,c], gold [a,b,c])", () => {
  const m = rankingMetrics(["b", "a", "c"], ["a", "b", "c"], [1, 2, 3]);
  assert.ok(Math.abs(m.ndcg - 0.875493) <= 1e-4, `ndcg ${m.ndcg}`);
  assert.ok(approx(m.mrr, 0.5), `mrr ${m.mrr}`);
  assert.ok(approx(m.map, 0.5), `map ${m.map}`);
  assert.deepEqual(m.topK, { top_1: 0, top_2: 1, top_3: 1 });
});

// --- rankingMetrics: perfect order scores exactly 1.0 everywhere.
check("rankingMetrics perfect order is 1.0", () => {
  const m = rankingMetrics(["a", "b"], ["a", "b"], [1, 3]);
  assert.equal(m.ndcg, 1);
  assert.equal(m.mrr, 1);
  assert.equal(m.map, 1);
  assert.deepEqual(m.topK, { top_1: 1, top_3: 1 });
});

// --- meanRanking: means over per-case dicts, nulls excluded per metric.
check("meanRanking averages with null exclusion", () => {
  const m = meanRanking(
    [
      { mrr: 1, ndcg: 1, map: 1, topK: { top_1: 1 } },
      { mrr: 0.5, ndcg: null, map: 0.5, topK: { top_1: 0 } },
    ],
    [1],
  );
  assert.equal(m.n, 2);
  assert.ok(approx(m.mrr, 0.75), `mrr ${m.mrr}`);
  assert.equal(m.ndcg, 1);
  assert.ok(approx(m.map, 0.75), `map ${m.map}`);
  assert.ok(approx(m.topK.top_1, 0.5), `top_1 ${m.topK.top_1}`);
});

// --- scoreAgreement: [{1,1},{2,1},{0,2}] -> exact 1/3, mae (0+1+2)/3 = 1.
check("scoreAgreement hand fixture", () => {
  const m = scoreAgreement([
    { actual: 1, predicted: 1 },
    { actual: 2, predicted: 1 },
    { actual: 0, predicted: 2 },
  ]);
  assert.equal(m.n, 3);
  assert.ok(approx(m.exact_match_rate, 1 / 3), `exact ${m.exact_match_rate}`);
  assert.equal(m.mae, 1);
  const empty = scoreAgreement([]);
  assert.deepEqual(empty, { n: 0, exact_match_rate: null, mae: null });
});

// --- wrongConfident: scored=3 (one null-signal + one abstained excluded).
// signals: wrong@0.9, right@0.85, wrong@0.6.
// tau .70/.80 -> confident 2, wrong 1, rate 1/3, cond 1/2.
// tau .90    -> confident 1, wrong 1, rate 1/3, cond 1.
// tau .95    -> confident 0, wrong 0, rate 0,   cond null.
check("wrongConfident hand fixture with exclusions", () => {
  const items = [
    { correct: false, signal: 0.9, abstained: false, threw: false },
    { correct: true, signal: 0.85, abstained: false, threw: false },
    { correct: false, signal: 0.6, abstained: false, threw: false },
    { correct: true, signal: null, abstained: false, threw: false },
    { correct: false, signal: 0.99, abstained: true, threw: false },
  ];
  const m = wrongConfident(items, [0.7, 0.8, 0.9, 0.95]);
  assert.equal(m.scored, 3);
  assert.deepEqual(m.excluded, { threw: 0, abstained: 1, null_signal: 1 });
  const [s70, s80, s90, s95] = m.slices;
  assert.deepEqual([s70.confident, s70.wrong_and_confident], [2, 1]);
  assert.ok(approx(s70.rate, 1 / 3), `s70 ${s70.rate}`);
  assert.ok(approx(s70.conditional_wrong_given_confident, 0.5), `s70c ${s70.conditional_wrong_given_confident}`);
  assert.ok(approx(s80.rate, 1 / 3), `s80 ${s80.rate}`);
  assert.deepEqual([s90.confident, s90.wrong_and_confident], [1, 1]);
  assert.ok(approx(s90.rate, 1 / 3), `s90 ${s90.rate}`);
  assert.equal(s90.conditional_wrong_given_confident, 1);
  assert.deepEqual([s95.confident, s95.wrong_and_confident], [0, 0]);
  assert.equal(s95.rate, 0);
  assert.equal(s95.conditional_wrong_given_confident, null);
});

check("default taus are the four reporting slices", () => {
  assert.deepEqual(WRONG_CONFIDENT_TAUS, [0.7, 0.8, 0.9, 0.95]);
});

console.log(`\nT4 metrics: ${passed} checks passed (pure functions, no backend).`);
