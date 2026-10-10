#!/usr/bin/env node
/**
 * decider-bench.mjs — Strands Decider 2B over r1 lanes + v2 split.
 *
 * Same suites, same fakeClient injection, same scoreIndependentDecision as
 * the gliclass matrices (smoke-r3a-lanes.mjs --matrix, validate-v2.mjs):
 * the ONLY swap is the scoring transport (DeciderClient behind the
 * GliclassClient interface). Needs the Decider server up:
 *   strands-decider serve StrandsAgents/strands-decider-2B-hobson-v21 --port 8001
 *
 * Gate gold normalization mirrors validate-v2.mjs (ABSTAIN verdicts score
 * with the `abstained` key stripped). Rerank/find are OUT OF SCOPE: ordering
 * is not a single choice (documented, not attempted).
 *
 * Usage: node evals/decider-bench.mjs [--out <empty dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { lanePredictFactory } from "./lanes-r1.mjs";
import { r1CasesFor } from "./corpus-index.mjs";
import { scoreIndependentDecision } from "./metrics.mjs";
import { DeciderClient } from "./decider-client.mjs";
import * as classify from "./suites/classify.mjs";
import * as gate from "./suites/gate.mjs";
import * as screen from "./suites/screen.mjs";
import * as v2classify from "./corpus-v2/classify.mjs";
import * as v2gate from "./corpus-v2/gate.mjs";
import * as v2screen from "./corpus-v2/screen.mjs";

const SUITES = { classify, gate, screen };
const V2 = { classify: v2classify, gate: v2gate, screen: v2screen };
const BACKEND = "decider-2b-hobson-v21";

function goldFor(lane, gold) {
  if (lane === "gate") {
    const list = Array.isArray(gold.verdicts) ? gold.verdicts : gold.verdict !== undefined ? [gold.verdict] : [];
    if (list.includes("ABSTAIN")) return Object.fromEntries(Object.entries(gold).filter(([k]) => k !== "abstained"));
  }
  return gold;
}

const outDir = (() => {
  const i = process.argv.indexOf("--out");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
if (outDir && fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
  console.error(`refusing to overwrite non-empty ${outDir}`);
  process.exit(1);
}

const client = new DeciderClient("http://127.0.0.1:8001");
const deps = { fakeClient: lanePredictFactory(client) };
const summary = {};

async function runSet(tag, lane, cases) {
  const suite = SUITES[lane];
  let dec = 0, task = 0, abst = 0, threw = 0;
  const misses = [];
  for (const c of cases) {
    let body = null;
    try {
      // Dummy stub.answers for v2 cases (same role as validate-v2.mjs:
      // live ignores stub answers; suites only read stub.answers).
      body = await suite.invoke(deps, c.input, c.stub ?? { answers: {} }, {});
    } catch (err) {
      threw++;
      misses.push(`${c.id}: THREW ${String(err?.message ?? err).slice(0, 120)}`);
      continue;
    }
    const s = scoreIndependentDecision(suite.name, body, goldFor(lane, c.gold));
    if (s.decisionOk) dec++;
    if (s.taskOk) task++;
    else misses.push(`${c.id}: task ${JSON.stringify(s.taskGold)}->${JSON.stringify(s.taskActual)}`);
    if (body?.abstention?.abstained === true) abst++;
  }
  summary[`${tag}:${lane}`] = { n: cases.length, dec, task, abst, threw };
  console.log(`| ${tag} ${lane} | dec ${dec}/${cases.length} | task ${task}/${cases.length} | abst ${abst} threw ${threw} |`);
  for (const m of misses) console.log(`  miss ${m}`);
}

for (const lane of Object.keys(SUITES)) {
  await runSet("r1", lane, r1CasesFor(SUITES[lane].name));
}
for (const lane of Object.keys(V2)) {
  await runSet("v2", lane, V2[lane].cases);
}
console.log(`DECIDER-BENCH: ${JSON.stringify(summary)}`);
if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "decider.json"), JSON.stringify({
    generated: "decider-2b spike matrix (same suites+scoring as gliclass; bare-name options lower bound)",
    backend: BACKEND, summary,
  }, null, 2));
  console.log(`saved: ${path.join(outDir, "decider.json")}`);
}
