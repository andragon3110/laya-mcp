/**
 * fut-a-calibracion T2 reliability tests: brierScore()/ece() in
 * evals/metrics.mjs against hand-computed fixtures.
 *
 * Every expected value below was computed by hand (arithmetic in each
 * comment). These tests fix the METHOD (binning, denominators, honest
 * nulls), never live numbers: no timing assertions, no thresholds on
 * recorded values. No models, no GPU, no network, no pip: pure functions
 * only.
 *
 * Run from the repo root: node tests/live_cal_reliability.mjs
 */
import assert from "node:assert";
import { approx, brierScore, ece } from "../evals/metrics.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- brierScore: (0.9,T),(0.1,F) -> (0.01 + 0.01)/2 = 0.01.
check("brierScore near-perfect pair", () => {
  const m = brierScore([
    { signal: 0.9, correct: true },
    { signal: 0.1, correct: false },
  ]);
  assert.deepEqual({ n: m.n }, { n: 2 });
  assert.ok(approx(m.brier, 0.01), `brier ${m.brier}`);
});

// --- brierScore: (1,T),(0,F),(0.5,T),(0.5,F) -> (0+0+0.25+0.25)/4 = 0.125.
check("brierScore hand fixture with maximal-uncertainty pair", () => {
  const m = brierScore([
    { signal: 1, correct: true },
    { signal: 0, correct: false },
    { signal: 0.5, correct: true },
    { signal: 0.5, correct: false },
  ]);
  assert.equal(m.n, 4);
  assert.ok(approx(m.brier, 0.125), `brier ${m.brier}`);
});

// --- brierScore: worst case (0,T),(1,F) -> (1+1)/2 = 1.
check("brierScore worst case is 1", () => {
  const m = brierScore([
    { signal: 0, correct: true },
    { signal: 1, correct: false },
  ]);
  assert.ok(approx(m.brier, 1), `brier ${m.brier}`);
});

// --- brierScore: empty input yields honest null, never 0.
check("brierScore empty is null", () => {
  assert.deepEqual(brierScore([]), { n: 0, brier: null });
});

// --- ece: (0.0,F),(1.0,T) -> bin0 |0-0|=0, bin9 |1-1|=0 -> ece 0.
// Signal 1.0 lands in the last bin WITHOUT counting as clamped.
check("ece perfectly calibrated two-bin case", () => {
  const m = ece(
    [
      { signal: 0.0, correct: false },
      { signal: 1.0, correct: true },
    ],
    10,
  );
  assert.equal(m.n, 2);
  assert.equal(m.bins, 10);
  assert.equal(m.clamped, 0);
  assert.ok(approx(m.ece, 0), `ece ${m.ece}`);
  assert.equal(m.binsDetail.length, 10);
  assert.equal(m.binsDetail[0].n, 1);
  assert.equal(m.binsDetail[9].n, 1);
});

// --- ece: (0.9,T),(0.8,T),(0.2,F),(0.1,F), 10 bins.
// bin9: |1-0.9|*1/4=0.025; bin8: |1-0.8|*1/4=0.05;
// bin2: |0-0.2|*1/4=0.05; bin1: |0-0.1|*1/4=0.025 -> ece 0.15.
check("ece hand fixture is 0.15", () => {
  const m = ece(
    [
      { signal: 0.9, correct: true },
      { signal: 0.8, correct: true },
      { signal: 0.2, correct: false },
      { signal: 0.1, correct: false },
    ],
    10,
  );
  assert.equal(m.n, 4);
  assert.equal(m.clamped, 0);
  assert.ok(approx(m.ece, 0.15), `ece ${m.ece}`);
  assert.ok(approx(m.binsDetail[9].accuracy, 1), "bin9 accuracy");
  assert.ok(approx(m.binsDetail[9].confidence, 0.9), "bin9 confidence");
  assert.ok(approx(m.binsDetail[2].accuracy, 0), "bin2 accuracy");
});

// --- ece: out-of-range signals clamp into edge bins and are COUNTED,
// never dropped. (1.2,T) -> bin9 with clamped=1.
check("ece out-of-range signals clamp and count", () => {
  const m = ece([{ signal: 1.2, correct: true }], 10);
  assert.equal(m.n, 1);
  assert.equal(m.clamped, 1);
  assert.equal(m.binsDetail[9].n, 1);
  assert.ok(approx(m.ece, 0.2), `ece ${m.ece}`);
});

// --- ece: empty bins keep null accuracy/confidence; empty input is null.
check("ece empty input is null with 10 empty bins", () => {
  const m = ece([], 10);
  assert.equal(m.n, 0);
  assert.equal(m.ece, null);
  assert.equal(m.binsDetail.length, 10);
  assert.ok(m.binsDetail.every((b) => b.n === 0 && b.accuracy === null && b.confidence === null));
});

// --- ece: custom bin count is honored (4 bins: 0.9->bin3, 0.1->bin0).
check("ece custom bin count", () => {
  const m = ece(
    [
      { signal: 0.9, correct: true },
      { signal: 0.1, correct: false },
    ],
    4,
  );
  assert.equal(m.bins, 4);
  assert.equal(m.binsDetail.length, 4);
  assert.equal(m.binsDetail[3].n, 1);
  assert.equal(m.binsDetail[0].n, 1);
  assert.ok(approx(m.ece, 0.1), `ece ${m.ece}`);
});

console.log(`\nlive_cal_reliability: ${passed} checks passed (method fixtures, no live numbers).`);
