/**
 * Fase-7 T3 eval harness: ONE common runner for the 11 eval suites.
 *
 * SCOPE (T3 only): load each suite dataset, run every case against the REAL
 * handler (from dist/) with an oracle-derived deterministic stub, compare the
 * output against the case gold. No metrics (T4), no benchmarks (T5), no
 * EVALUATION.md. No models, no GPU, no network, no pip.
 *
 * STUB HONESTY: the stub is NOT the model. Each suite documents its stub
 * model (`stubModel`: which backend signal each oracle answer emulates and
 * why that signal is plausible for the input) and its limits (`stubLimits`:
 * what the stub cannot prove). Stub answers are derived FROM the case oracle
 * (the signal a real backend would plausibly return for that input), never
 * arbitrary canned responses: e.g. a claim directly stated by the evidence
 * gets a high support signal, an obfuscated injection gets a low detector
 * signal (detector blind spot), a missing backend answer is `{}`.
 *
 * REUSE: fakeClient + question capture follow tests/fase4_t7_gaps_benchmarks.mjs
 * and tests/t7_semantic_adversarial.mjs; the GLiNER sidecar stub mirrors the
 * fakePiiCtx from the latter. Suites hold ONLY data + thin per-primitive
 * adapters (invoke + check); all orchestration lives here.
 *
 * Run from the repo root:  node evals/run.mjs [suite] [--json]
 *   suite  optional suite name filter (e.g. `verify`); default runs all 10.
 *   --json print a machine-readable summary instead of the per-case log.
 * Exit 0 when every gold matches, 1 otherwise.
 */
import * as classify from "./suites/classify.mjs";
import * as decide from "./suites/decide.mjs";
import * as verify from "./suites/verify.mjs";
import * as screen from "./suites/screen.mjs";
import * as pii from "./suites/pii.mjs";
import * as extract from "./suites/extract.mjs";
import * as find from "./suites/find.mjs";
import * as rerank from "./suites/rerank.mjs";
import * as review from "./suites/review.mjs";
import * as gate from "./suites/gate.mjs";
import * as compare from "./suites/compare.mjs";

const SUITES = [classify, decide, verify, screen, pii, extract, find, rerank, review, gate, compare];

/** Deterministic oracle stub: answers come FROM the case oracle (see above). */
const fakeClient = (answers, capture) => ({
  predict: async (_args, questions) => {
    if (capture) capture.questions = questions;
    return { answers, confidence: {}, routing: {}, model: "evals-oracle-stub", latencyMs: 0, usage: {} };
  },
});

/** GLiNER sidecar stub: reports exactly the oracle spans (detector stand-in). */
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

async function runCase(suite, c) {
  const capture = {};
  try {
    const body = await suite.invoke(deps, c.input, c.stub, capture);
    if (c.expectError) {
      return { id: c.id, kind: c.kind, pass: false, detail: `expected throw /${c.expectError}/ but got output` };
    }
    const actual = suite.check(body, c.gold);
    const qkeys = capture.questions ? Object.keys(capture.questions) : [];
    return { id: c.id, kind: c.kind, pass: true, actual, qkeys };
  } catch (err) {
    if (c.expectError && String(err?.message ?? err).includes(c.expectError)) {
      return { id: c.id, kind: c.kind, pass: true, actual: { threw: c.expectError }, qkeys: [] };
    }
    return { id: c.id, kind: c.kind, pass: false, detail: String(err?.message ?? err).split("\n").slice(0, 4).join(" | ") };
  }
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const filter = args.find((a) => a !== "--json" && !a.startsWith("-"));
const selected = filter ? SUITES.filter((s) => s.name === filter) : SUITES;
if (selected.length === 0) {
  console.error(`unknown suite "${filter}"; known: ${SUITES.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

const report = { suites: [], total: 0, passed: 0, failed: 0 };
for (const suite of selected) {
  const suiteRep = { suite: suite.name, primitive: suite.primitive, cases: [] };
  for (const c of suite.cases) {
    const r = await runCase(suite, c);
    suiteRep.cases.push(r);
    report.total++;
    if (r.pass) report.passed++;
    else report.failed++;
    if (!asJson) {
      if (r.pass) console.log(`ok - ${suite.name}/${r.id} [${r.kind}]`);
      else console.log(`FAIL - ${suite.name}/${r.id} [${r.kind}]: ${r.detail}`);
    }
  }
  report.suites.push(suiteRep);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("\nFase-7 T3 evals (oracle stub + real handlers, no models involved):");
  console.log("| suite | cases | passed | failed |");
  console.log("|-------|-------|--------|--------|");
  for (const s of report.suites) {
    const p = s.cases.filter((c) => c.pass).length;
    console.log(`| ${s.suite} | ${s.cases.length} | ${p} | ${s.cases.length - p} |`);
  }
  console.log(`total: ${report.total} cases, ${report.passed} passed, ${report.failed} failed.`);
  console.log("(stub honesty: each suite documents its stubModel + stubLimits; the stub is NOT the model.)");
}
process.exit(report.failed === 0 ? 0 : 1);
