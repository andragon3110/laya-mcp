/**
 * WS-D (finetune-r3j-complete / Regulus) calibration measurement plumbing.
 *
 * From per-row { predicted_label, confidence, correct } JSON score files
 * (NEVER live model calls) → reliability-diagram bins + ECE +
 * max-calibration-error + Brier score + per-bin counts, with exclusion
 * honesty mirroring evals/metrics.mjs (abstained / null-signal rows are
 * counted in `excluded`, never silently dropped from denominators).
 *
 * HONESTY RULES (see evals/calibration.md):
 * - Inputs MUST be validation-split score files (r3i baseline scores and
 *   regulus-v1 scores, fed by WS-E). ECE/Brier may be claimed on the
 *   validation split ONLY — never on r1, never on stub runs.
 * - A `confidence` value here is a raw backend signal until a temperature
 *   fit on validation says otherwise. No output of this module is a
 *   production threshold or a certified probability.
 * - Empty input or all-excluded input REFUSES (exit 2) instead of printing
 *   zeros: there is no calibration of nothing.
 * - Temperature T is fit on validation ONLY (minimize NLL) and is always
 *   reported together with its fit_data_id.
 *
 * Row schema (JSON array, file or stdin):
 *   { "id": "optional",
 *     "predicted_label": "string|null (null counts as abstained)",
 *     "gold_label": "string|null (optional, informational)",
 *     "confidence": "number in [0,1]|null (null = null-signal, excluded)",
 *     "correct": "boolean (required on scored rows)",
 *     "abstained": "boolean (optional, default false)" }
 *
 * Usage:
 *   node evals/reliability.mjs <scores.json> [--json] [--csv] [--bins N]
 *   node evals/reliability.mjs <scores.json> --fit-temperature --fit-data-id <id> [--save-temp <file>]
 *   node evals/reliability.mjs <scores.json> --apply-temperature <temp.json>
 *   node evals/reliability.mjs --self-test
 *   node evals/reliability.mjs --help
 */

import { readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_BINS = 10;
const EPS = 1e-12;
const T_MIN = 0.05;
const T_MAX = 10;

/** Clamp a probability away from 0/1 for stable log math. */
function clampP(p) {
  return Math.min(1 - EPS, Math.max(EPS, p));
}

function isScoredConfidence(c) {
  return typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1;
}

/**
 * Partition rows into scored vs excluded, mirroring metrics.mjs
 * wrongConfident exclusion honesty (threw/abstained/null_signal counted).
 * Rows here never throw (offline score files), so excluded =
 * { abstained, null_signal }.
 */
export function partition(rows) {
  const excluded = { abstained: 0, null_signal: 0 };
  const scored = [];
  for (const r of rows) {
    const abstained = r?.abstained === true || r?.predicted_label === null;
    if (abstained) {
      excluded.abstained++;
      continue;
    }
    if (!isScoredConfidence(r?.confidence) || typeof r?.correct !== "boolean") {
      excluded.null_signal++;
      continue;
    }
    scored.push(r);
  }
  return { scored, excluded };
}

/**
 * Reliability bins + ECE + max-calibration-error + Brier.
 * @param rows raw input rows (partitioned internally; exclusions reported).
 * @param numBins equal-width bins over [0,1] (default 10).
 * @returns { n, excluded, bins, ece, max_calibration_error, brier }
 *   bins: [{ bin, lo, hi, n, mean_confidence, accuracy, gap }] (gap/accuracy
 *   null on empty bins; empty bins contribute 0 to ECE).
 */
export function reliability(rows, numBins = DEFAULT_BINS) {
  const { scored, excluded } = partition(rows);
  const n = scored.length;
  const bins = [];
  for (let b = 0; b < numBins; b++) {
    const lo = b / numBins;
    const hi = (b + 1) / numBins;
    const inBin =
      b === numBins - 1
        ? scored.filter((r) => r.confidence >= lo && r.confidence <= hi)
        : scored.filter((r) => r.confidence >= lo && r.confidence < hi);
    if (inBin.length === 0) {
      bins.push({ bin: b, lo, hi, n: 0, mean_confidence: null, accuracy: null, gap: null });
    } else {
      const mean_confidence = inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length;
      const accuracy = inBin.filter((r) => r.correct).length / inBin.length;
      bins.push({ bin: b, lo, hi, n: inBin.length, mean_confidence, accuracy, gap: Math.abs(accuracy - mean_confidence) });
    }
  }
  const ece = bins.reduce((s, b) => s + (b.n === 0 ? 0 : (b.n / n) * b.gap), 0);
  const gaps = bins.filter((b) => b.n > 0).map((b) => b.gap);
  const max_calibration_error = gaps.length === 0 ? null : Math.max(...gaps);
  const brier = scored.reduce((s, r) => s + (r.confidence - (r.correct ? 1 : 0)) ** 2, 0) / n;
  return { n, excluded, bins, ece, max_calibration_error, brier };
}

// --- Temperature scaling (single T on the correctness logit) ---
//
// The confidence p is treated as P(correct). T scales its logit:
//   p_T = sigmoid(logit(p) / T),  logit(p) = log(p / (1 - p)).
// T > 1 softens (fixes overconfidence), T < 1 sharpens (fixes
// underconfidence), T = 1 is identity. Fit = minimize NLL of the
// correctness labels on validation rows. Deterministic grid + refine.

function logit(p) {
  const c = clampP(p);
  return Math.log(c / (1 - c));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Calibrated confidence for raw confidence p under temperature T. */
export function scaleConfidence(p, T) {
  return sigmoid(logit(p) / T);
}

/** Mean NLL of correctness labels under temperature T. */
export function nll(scored, T) {
  let s = 0;
  for (const r of scored) {
    const p = clampP(scaleConfidence(r.confidence, T));
    s += r.correct ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / scored.length;
}

/**
 * Fit single temperature T on validation rows (minimize NLL).
 * @returns { T, fit_data_id, n, nll_before, nll_after }
 */
export function fitTemperature(rows, fitDataId) {
  const { scored } = partition(rows);
  // Coarse log-spaced grid, then two golden-section-style refinements.
  let best = { T: 1, loss: nll(scored, 1) };
  for (let i = 0; i <= 80; i++) {
    const T = T_MIN * (T_MAX / T_MIN) ** (i / 80);
    const loss = nll(scored, T);
    if (loss < best.loss) best = { T, loss };
  }
  for (let pass = 0; pass < 3; pass++) {
    const span = pass === 0 ? 0.2 : 0.05;
    const lo = Math.max(T_MIN, best.T * (1 - span));
    const hi = Math.min(T_MAX, best.T * (1 + span));
    for (let i = 0; i <= 100; i++) {
      const T = lo + ((hi - lo) * i) / 100;
      const loss = nll(scored, T);
      if (loss < best.loss) best = { T, loss };
    }
  }
  return {
    T: best.T,
    fit_data_id: fitDataId ?? null,
    n: scored.length,
    nll_before: nll(scored, 1),
    nll_after: best.loss,
  };
}

/** Return rows with confidence mapped through temperature T (exclusions untouched). */
export function applyTemperature(rows, T) {
  return rows.map((r) =>
    r?.abstained === true || r?.predicted_label === null || !isScoredConfidence(r?.confidence)
      ? { ...r }
      : { ...r, confidence: scaleConfidence(r.confidence, T), calibrated_with_T: T },
  );
}

// --- Self-test fixtures (synthetic, deterministic) ---

function fixtureCalibrated() {
  // 100 rows per level, exactly `level` fraction correct → ECE = 0.
  const rows = [];
  for (const level of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    for (let i = 0; i < 100; i++) {
      rows.push({
        id: `cal-${level}-${i}`,
        predicted_label: "x",
        confidence: level,
        correct: i < Math.round(level * 100),
      });
    }
  }
  return rows;
}

function fixtureOverconfident() {
  // Confidence 0.9 everywhere, accuracy 0.5 → ECE = 0.4.
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ id: `over-${i}`, predicted_label: "x", confidence: 0.9, correct: i < 100 });
  }
  return rows;
}

function fixtureUnderconfident() {
  // Confidence 0.6 everywhere, accuracy 0.9 → ECE = 0.3.
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ id: `under-${i}`, predicted_label: "x", confidence: 0.6, correct: i < 180 });
  }
  return rows;
}

function fixtureExcluded() {
  return [
    { id: "a1", predicted_label: "x", confidence: 0.9, correct: true, abstained: true },
    { id: "a2", predicted_label: null, confidence: 0.9, correct: false },
    { id: "n1", predicted_label: "x", confidence: null, correct: true },
    { id: "n2", predicted_label: "x", correct: false },
    { id: "ok", predicted_label: "x", confidence: 0.8, correct: true },
  ];
}

export function selfTest() {
  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
  };
  const cal = reliability(fixtureCalibrated());
  const over = reliability(fixtureOverconfident());
  const under = reliability(fixtureUnderconfident());
  check("calibrated ECE ≈ 0", cal.ece < 1e-9, `ECE=${cal.ece}`);
  check("overconfident ECE ≈ 0.4", Math.abs(over.ece - 0.4) < 1e-9, `ECE=${over.ece}`);
  check("underconfident ECE ≈ 0.3", Math.abs(under.ece - 0.3) < 1e-9, `ECE=${under.ece}`);
  check("overconfident ECE >> calibrated ECE", over.ece > 10 * Math.max(cal.ece, 1e-9), `${over.ece} vs ${cal.ece}`);
  check("underconfident ECE >> calibrated ECE", under.ece > 10 * Math.max(cal.ece, 1e-9), `${under.ece} vs ${cal.ece}`);
  check("overconfident Brier ≈ 0.41", Math.abs(over.brier - 0.41) < 1e-9, `Brier=${over.brier}`);
  check("underconfident Brier ≈ 0.18", Math.abs(under.brier - 0.18) < 1e-9, `Brier=${under.brier}`);
  check("overconfident MCE ≈ 0.4", Math.abs(over.max_calibration_error - 0.4) < 1e-9, `MCE=${over.max_calibration_error}`);
  const exc = reliability(fixtureExcluded());
  check("exclusions counted", exc.excluded.abstained === 2 && exc.excluded.null_signal === 2 && exc.n === 1, JSON.stringify(exc.excluded));
  const tOver = fitTemperature(fixtureOverconfident(), "selftest-over");
  const tUnder = fitTemperature(fixtureUnderconfident(), "selftest-under");
  check("overconfident fit T > 1", tOver.T > 1 && tOver.nll_after < tOver.nll_before, `T=${tOver.T}`);
  check("underconfident fit T < 1", tUnder.T < 1 && tUnder.nll_after < tUnder.nll_before, `T=${tUnder.T}`);
  check("fit carries data id", tOver.fit_data_id === "selftest-over", `fit_data_id=${tOver.fit_data_id}`);
  const applied = reliability(applyTemperature(fixtureOverconfident(), tOver.T));
  check("apply T lowers overconfident ECE", applied.ece < over.ece, `${applied.ece} < ${over.ece}`);
  return { results, fixtures: { calibrated: cal, overconfident: over, underconfident: under }, temps: { tOver, tUnder } };
}

// --- CLI ---

const HELP = `reliability.mjs — WS-D calibration measurement plumbing (Regulus)

From per-row { predicted_label, confidence, correct } JSON score files
(validation split ONLY, never r1, never live model calls) compute
reliability-diagram bins + ECE + max-calibration-error + Brier score.

Usage:
  node evals/reliability.mjs <scores.json> [--json] [--csv] [--bins N]
  node evals/reliability.mjs <scores.json> --fit-temperature --fit-data-id <id> [--save-temp <file>]
  node evals/reliability.mjs <scores.json> --apply-temperature <temp.json>
  node evals/reliability.mjs --self-test
  node evals/reliability.mjs --help

Input: JSON array of rows (file, or stdin with --stdin):
  { "id": "...", "predicted_label": "L"|null, "confidence": 0.0-1.0|null,
    "correct": true|false, "abstained": false }

Output: JSON (default) or per-bin CSV (--csv). Exit 2 on empty input or
all-excluded input (refuses instead of printing zeros). See
evals/calibration.md for when ECE may be claimed.`;

function fail(msg) {
  process.stderr.write(`reliability.mjs: ${msg}\n`);
  process.exit(2);
}

function toCSV(rep) {
  const lines = ["bin,lo,hi,n,mean_confidence,accuracy,gap"];
  for (const b of rep.bins) {
    lines.push(
      [b.bin, b.lo.toFixed(2), b.hi.toFixed(2), b.n, b.mean_confidence ?? "", b.accuracy ?? "", b.gap ?? ""].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

async function readInput(args) {
  if (args.includes("--stdin")) {
    let s = "";
    for await (const chunk of process.stdin) s += chunk;
    return s;
  }
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) fail("no input file (pass <scores.json>, --stdin, or --self-test; see --help)");
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    fail(`cannot read "${file}": ${err.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args.includes("--self-test")) {
    const { results, fixtures, temps } = selfTest();
    console.log("fixture ECE table (synthetic, deterministic):");
    console.log("| fixture | n | ECE | MCE | Brier |");
    console.log("|---|---|---|---|---|");
    for (const [k, f] of Object.entries(fixtures)) {
      console.log(`| ${k} | ${f.n} | ${f.ece.toFixed(3)} | ${f.max_calibration_error.toFixed(3)} | ${f.brier.toFixed(3)} |`);
    }
    console.log(`temperature fits: overconfident T=${temps.tOver.T.toFixed(3)} (NLL ${temps.tOver.nll_before.toFixed(3)}→${temps.tOver.nll_after.toFixed(3)}), underconfident T=${temps.tUnder.T.toFixed(3)} (NLL ${temps.tUnder.nll_before.toFixed(3)}→${temps.tUnder.nll_after.toFixed(3)})`);
    let failed = 0;
    for (const r of results) {
      console.log(`${r.pass ? "ok" : "FAIL"} - ${r.name} (${r.detail})`);
      if (!r.pass) failed++;
    }
    console.log(failed === 0 ? `self-test: ${results.length}/${results.length} passed.` : `self-test: ${failed} FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
    return;
  }
  const raw = await readInput(args);
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (err) {
    fail(`invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(rows)) fail("input must be a JSON array of rows");
  if (rows.length === 0) fail("empty input: no rows, refusing to print zeros");
  const numBins = (() => {
    const i = args.indexOf("--bins");
    if (i === -1) return DEFAULT_BINS;
    const v = Number(args[i + 1]);
    if (!Number.isInteger(v) || v < 1 || v > 100) fail("--bins must be an integer 1..100");
    return v;
  })();
  let work = rows;
  let applied_T = null;
  const ai = args.indexOf("--apply-temperature");
  if (ai !== -1) {
    const f = args[ai + 1];
    if (!f || f.startsWith("-")) fail("--apply-temperature needs a temp JSON file");
    let t;
    try {
      t = JSON.parse(readFileSync(f, "utf8"));
    } catch (err) {
      fail(`cannot read temperature file "${f}": ${err.message}`);
    }
    if (typeof t?.T !== "number" || !(t.T >= T_MIN && t.T <= T_MAX)) fail("temperature file must hold { T, fit_data_id }");
    applied_T = t.T;
    work = applyTemperature(rows, t.T);
  }
  const rep = reliability(work, numBins);
  if (rep.n === 0) fail(`all ${rows.length} rows excluded ${JSON.stringify(rep.excluded)}: refusing to print zeros`);
  const out = { ...rep, bins_count: numBins, ...(applied_T !== null ? { applied_T } : {}) };
  if (args.includes("--fit-temperature")) {
    const di = args.indexOf("--fit-data-id");
    if (di === -1 || !args[di + 1] || args[di + 1].startsWith("-")) {
      fail("--fit-temperature requires --fit-data-id <id> (temperature is always reported with its fit data)");
    }
    const fit = fitTemperature(rows, args[di + 1]);
    out.temperature_fit = fit;
    const si = args.indexOf("--save-temp");
    if (si !== -1) {
      const f = args[si + 1];
      if (!f || f.startsWith("-")) fail("--save-temp needs a file path");
      writeFileSync(f, JSON.stringify({ T: fit.T, fit_data_id: fit.fit_data_id }, null, 2) + "\n");
      out.temperature_saved = f;
    }
  }
  if (args.includes("--csv")) console.log(toCSV(rep));
  else console.log(JSON.stringify(out, null, 2));
}

await main();
