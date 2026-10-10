/**
 * Phase-2 validation baseline (pre-training, READ-ONLY measurement).
 *
 * Runs the signed v2 split (20 cases: 10 classify + 4 gate + 6 screen)
 * through the live gliclass(r3a) lanes and records the baseline a future
 * micro-train must beat. Modeled on evals/smoke-r3a-lanes.mjs --matrix:
 * same lane clients, same scoreIndependentDecision, same row shape.
 * Differences (deliberate, baseline purpose): no rerank lane (no v2 cases),
 * no wrong_confident slices, no composed table, output to /tmp/v2baseline
 * (repo stays clean), r1 harness files untouched.
 *
 * EXIT CODES: 0 measured (even with misses -- misses are data); 2 backend
 * refused (sidecar down at :8770); 1 any other failure.
 * Boot first: GLICLASS_MODEL=<r3a ckpt> py/.venv-r1/bin/python py/gliclass_server.py
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  probeLane,
  GliclassClient,
  lanePredictFactory,
  LANE_CALL_TIMEOUT_MS,
} from "./lanes-r1.mjs";
import { scoreIndependentDecision } from "./metrics.mjs";
import * as classifyCases from "./corpus-v2/classify.mjs";
import * as gateCases from "./corpus-v2/gate.mjs";
import * as screenCases from "./corpus-v2/screen.mjs";
import * as classify from "./suites/classify.mjs";
import * as gate from "./suites/gate.mjs";
import * as screen from "./suites/screen.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = { classify, gate, screen };
const V2 = { classify: classifyCases.cases, gate: gateCases.cases, screen: screenCases.cases };
const LANES = ["classify", "gate", "screen"];
const round1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);

// r1 convention (corpus-index.mjs r1CasesFor): ABSTAIN golds score through
// verdicts with the `abstained` key stripped. v2 gate golds share the shape.
function goldFor(lane, gold) {
  if (lane === "gate") {
    const list = Array.isArray(gold.verdicts) ? gold.verdicts : gold.verdict !== undefined ? [gold.verdict] : [];
    if (list.includes("ABSTAIN")) return Object.fromEntries(Object.entries(gold).filter(([k]) => k !== "abstained"));
  }
  return gold;
}

const outDir = process.argv[2] ?? "/tmp/v2baseline";
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
  console.error(`refusing to overwrite non-empty ${outDir}`);
  process.exit(1);
}

const summary = {};
const laneRows = {};
for (const lane of LANES) {
  const suite = SUITES[lane];
  const probe = await probeLane(lane, "gliclass");
  if (!probe.reachable) {
    console.error(`REFUSED lane ${lane} x gliclass (exit 2): ${probe.error}`);
    process.exit(2);
  }
  const client = new GliclassClient(probe.baseUrl);
  const deps = { fakeClient: lanePredictFactory(client) };
  const rows = [];
  for (const c of V2[lane]) {
    client.callLog = [];
    const t0 = performance.now();
    try {
      // Live ignores stub answers (lanePredictFactory passes _answers through
      // unused); the dummy only satisfies suite.invoke's stub.answers read —
      // same role as stubForR1's synthesized answers on the r1 path.
      const body = await suite.invoke(deps, c.input, c.stub ?? { answers: {} }, {});
      const wall = performance.now() - t0;
      const s = scoreIndependentDecision(suite.name, body, goldFor(lane, c.gold));
      rows.push({
        id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: false,
        wall_ms: round1(wall),
        abstained: body?.abstention?.abstained === true,
        decisionActual: body?.decision?.decision ?? null, decisionGold: c.gold.decision ?? null,
        taskActual: s.taskActual, taskGold: s.taskGold,
        decOk: s.decisionOk, taskOk: s.taskOk, abstOk: s.abstainedOk,
        judgments: [],
        gliclass: client.callLog.map((e) => ({
          key: e.key, top: e.top, top_score: e.top_score, margin: e.margin,
          scores: e.scores, latency_ms: round1(e.latencyMs),
        })),
      });
    } catch (err) {
      rows.push({
        id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: true,
        error: String(err?.message ?? err).split("\n")[0],
        abstained: false, decisionActual: null, decisionGold: c.gold.decision ?? null,
        taskActual: null, taskGold: null, decOk: false, taskOk: false, abstOk: false,
        judgments: [], gliclass: [],
      });
    }
  }
  const scored = rows.filter((r) => !r.threw);
  const dec = scored.filter((r) => r.decOk).length;
  const task = scored.filter((r) => r.taskOk).length;
  summary[lane] = { n: rows.length, threw: rows.length - scored.length, dec, task, abstained: scored.filter((r) => r.abstained).length };
  laneRows[lane] = rows;
  console.log(`| ${lane} | dec ${dec}/${rows.length} | task ${task}/${rows.length} | abst ${summary[lane].abstained} threw ${summary[lane].threw} |`);
  for (const r of rows) {
    if (!r.decOk || !r.taskOk) {
      const g = ((r.gliclass ?? []).length ? r.gliclass[0] : {});
      console.log(`  miss ${r.id}${r.threw ? " THREW:" + (r.error ?? "?") : ""}: dec ${r.decisionGold}->${r.decisionActual} task ${JSON.stringify(r.taskGold)}->${JSON.stringify(r.taskActual)} top ${g.top}@${g.top_score}`);
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "metrics.json"),
  JSON.stringify({
    generated: "phase-2 validation BASELINE (pre-training, read-only): signed v2 batch-1 (20) over live gliclass(r3a)",
    backend: "gliclass(r3a) :8770",
    corpus: "v2-batch-1",
    timeout_ms: LANE_CALL_TIMEOUT_MS,
    summary,
    lanes: Object.fromEntries(LANES.map((lane) => [lane, { summary: summary[lane], rows: laneRows[lane] }])),
  }, null, 2) + "\n",
);
console.log(`saved: ${outDir}/metrics.json`);
console.log(`BASELINE: ${JSON.stringify(summary)}`);
