/**
 * Doubt-gate-es T1 multi-run runner: N passes with per-pass report + variance.
 *
 * SCOPE (T1 only): repetition parameter + per-pass report + stability summary
 * over ANY suite in evals/suites/ (*.mjs, including the doubt-gate-es suites).
 * No refactor of evals/run.mjs, evals/score.mjs, or any existing suite: this
 * file reuses the same suite contract (name/primitive/cases/invoke/check) and
 * the same oracle-stub deps as evals/run.mjs, discovered dynamically.
 *
 * WHAT IT REPORTS per run: per-pass pass/fail + pass_rate; per-case stability
 * across passes (same check output every pass? same captured backend questions
 * every pass? -- the latter is the T2 harness-fidelity signal: questions must
 * be byte-identical between passes salvo expected model variance); and a
 * variance summary (flip counts, unstable-case lists).
 *
 * HONESTY: under the oracle stub every pass is deterministic BY CONSTRUCTION,
 * so expected variance here is ZERO -- a non-zero flip on stub runs means the
 * harness/handler is nondeterministic, not the model. Real model variance is
 * measured by T2 live runs reusing this runner shape. No thresholds, no gates,
 * no answer_confidence logic here (that is T3).
 *
 * Run from the repo root:
 *   node evals/multirun.mjs [--passes N] [--suite name] [--json]
 *   --passes N  repeat each suite N times (default 3, minimum 1)
 *   --suite     only suites whose `name` equals this value
 *   --json      machine-readable report on stdout
 * Exit 0 when every case passes every pass, 1 otherwise, 2 on bad usage.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = path.join(here, "suites");

/** Same oracle-stub deps as evals/run.mjs (canonical orchestration there). */
const fakeClient = (answers, capture) => ({
  predict: async (_args, questions) => {
    if (capture) capture.questions = questions;
    return { answers, confidence: {}, routing: {}, model: "evals-oracle-stub", latencyMs: 0, usage: {} };
  },
});
const makePiiCtx = (findings) => ({
  glinerReady: () => true,
  gliner: {
    piiScan: async () => ({
      findings,
      counts: Object.fromEntries(
        [...new Set(findings.map((f) => f.type))].map((t) => [t, findings.filter((f) => f.type === t).length]),
      ),
      latencyMs: 0,
    }),
    extractEntities: async () => ({ spansByType: {}, latencyMs: 0 }),
  },
});
const deps = { fakeClient, makePiiCtx };

function usageError(msg) {
  console.error(`multirun: ${msg}`);
  console.error("usage: node evals/multirun.mjs [--passes N] [--suite name] [--json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
let passes = 3;
let filter = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--passes") {
    const n = Number(args[i + 1]);
    if (!Number.isInteger(n) || n < 1) usageError(`--passes needs an integer >= 1 (got "${args[i + 1]}")`);
    passes = n;
    i++;
  } else if (args[i] === "--suite") {
    if (!args[i + 1]) usageError("--suite needs a suite name");
    filter = args[i + 1];
    i++;
  } else if (args[i] === "--json") {
    /* handled above */
  } else {
    usageError(`unknown argument "${args[i]}"`);
  }
}

const suiteFiles = fs
  .readdirSync(SUITES_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .sort();
if (suiteFiles.length === 0) {
  console.error("multirun: no suites found in evals/suites/");
  process.exit(2);
}

const suites = [];
for (const f of suiteFiles) {
  const mod = await import(pathToFileURL(path.join(SUITES_DIR, f)).href);
  for (const key of ["name", "primitive", "cases", "invoke", "check"]) {
    if (mod[key] === undefined) {
      console.error(`multirun: suite file ${f} violates the harness contract (missing export "${key}"); refusing to run partial.`);
      process.exit(2);
    }
  }
  if (!Array.isArray(mod.cases)) {
    console.error(`multirun: suite file ${f} violates the harness contract ("cases" is not an array); refusing to run partial.`);
    process.exit(2);
  }
  suites.push(mod);
}
const selected = filter ? suites.filter((s) => s.name === filter) : suites;
if (selected.length === 0) usageError(`unknown suite "${filter}"; known: ${suites.map((s) => s.name).join(", ")}`);

async function runCaseOnce(suite, c) {
  const capture = {};
  try {
    const body = await suite.invoke(deps, c.input, c.stub, capture);
    if (c.expectError) {
      return { pass: false, detail: `expected throw /${c.expectError}/ but got output`, output: null, questions: null };
    }
    const output = suite.check(body, c.gold);
    return { pass: true, output, questions: capture.questions ?? null };
  } catch (err) {
    if (c.expectError && String(err?.message ?? err).includes(c.expectError)) {
      return { pass: true, output: { threw: c.expectError }, questions: null };
    }
    return { pass: false, detail: String(err?.message ?? err).split("\n").slice(0, 4).join(" | "), output: null, questions: null };
  }
}

const report = {
  generated: "doubt-gate-es T1 multi-run (oracle stub + real handlers; stub ceiling, zero expected variance)",
  passes,
  suites: [],
  variance: { total_cases: 0, flipped_cases: 0, unstable_decisions: 0, unstable_questions: 0 },
};

for (const suite of selected) {
  const suiteRep = { suite: suite.name, primitive: suite.primitive, passes: [], cases: [] };
  const perCase = suite.cases.map((c) => ({ id: c.id, kind: c.kind, doubt: c.doubt ?? null, passByPass: [], outputs: [], questions: [] }));
  for (let p = 0; p < passes; p++) {
    let passed = 0;
    for (let i = 0; i < suite.cases.length; i++) {
      const r = await runCaseOnce(suite, suite.cases[i]);
      perCase[i].passByPass.push(r.pass);
      perCase[i].outputs.push(r.pass ? JSON.stringify(r.output) : `FAIL: ${r.detail}`);
      perCase[i].questions.push(r.questions === null ? null : JSON.stringify(r.questions));
      if (r.pass) passed++;
    }
    suiteRep.passes.push({ pass_index: p, total: suite.cases.length, passed, failed: suite.cases.length - passed });
  }
  for (const pc of perCase) {
    const passAll = pc.passByPass.every(Boolean);
    const passAny = pc.passByPass.some(Boolean);
    const stableDecision = new Set(pc.outputs).size === 1;
    const questionSamples = pc.questions.filter((q) => q !== null);
    const stableQuestions = questionSamples.length === 0 || new Set(questionSamples).size === 1;
    suiteRep.cases.push({
      id: pc.id,
      kind: pc.kind,
      doubt: pc.doubt,
      pass_by_pass: pc.passByPass,
      pass_all: passAll,
      flipped: passAny && !passAll,
      stable_decision: stableDecision,
      stable_questions: stableQuestions,
    });
    report.variance.total_cases++;
    if (passAny && !passAll) report.variance.flipped_cases++;
    if (!stableDecision) report.variance.unstable_decisions++;
    if (!stableQuestions) report.variance.unstable_questions++;
  }
  report.suites.push(suiteRep);
}

const allPass = report.suites.every((s) => s.cases.every((c) => c.pass_all));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nDoubt-gate-es T1 multi-run: ${passes} pass(es), oracle stub (deterministic; expected variance 0):`);
  console.log("| suite | pass | passed/total |");
  console.log("|-------|------|--------------|");
  for (const s of report.suites) {
    for (const p of s.passes) console.log(`| ${s.suite} | ${p.pass_index} | ${p.passed}/${p.total} |`);
  }
  console.log(`\nvariance: ${report.variance.total_cases} cases, flips=${report.variance.flipped_cases}, unstable_decisions=${report.variance.unstable_decisions}, unstable_questions=${report.variance.unstable_questions}.`);
  const bad = report.suites.flatMap((s) => s.cases.filter((c) => !c.pass_all || !c.stable_decision).map((c) => `${s.suite}/${c.id}`));
  if (bad.length > 0) console.log(`unstable/failing: ${bad.join(", ")}`);
  console.log("(stub ceiling: flips here would mean harness/handler nondeterminism, never model variance. T2 measures live variance with this runner shape.)");
}
process.exit(allPass ? 0 : 1);
