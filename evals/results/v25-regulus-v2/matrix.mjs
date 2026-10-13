// WS-E regulus matrix: batch4-validation (80) + v2 (80) + r1 gliclass lanes (48).
// Same methodology as lineage (smoke-r3a-lanes --matrix + validate-v2):
// GliclassClient + lanePredictFactory + scoreIndependentDecision + same row shape.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
const R = "C:/Users/Andragon/Documents/Github/laya-mcp";
const { probeLane, lanePredictFactory, GliclassClient, LANE_CALL_TIMEOUT_MS } = await import(`file:///${R}/evals/lanes-r1.mjs`);
const { scoreIndependentDecision } = await import(`file:///${R}/evals/metrics.mjs`);
const { r1CasesFor } = await import(`file:///${R}/evals/corpus-index.mjs`);
const suites = {};
for (const s of ["classify", "gate", "screen", "rerank"]) suites[s] = await import(`file:///${R}/evals/suites/${s}.mjs`);
const b4 = {}, v2 = {};
for (const s of ["classify", "gate", "screen"]) {
  b4[s] = (await import(`file:///${R}/evals/corpus-batch4/${s}.mjs`)).cases;
  v2[s] = (await import(`file:///${R}/evals/corpus-v2/${s}.mjs`)).cases;
}
const args = process.argv.slice(2);
const outDir = args[args.indexOf("--out") + 1];
const tag = args[args.indexOf("--tag") + 1];
if (!outDir || !tag) { console.error("need --out <dir> --tag <label>"); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) { console.error(`refusing to overwrite non-empty ${outDir}`); process.exit(1); }
const round1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);
function goldFor(lane, gold) {
  if (lane === "gate") {
    const list = Array.isArray(gold.verdicts) ? gold.verdicts : gold.verdict !== undefined ? [gold.verdict] : [];
    if (list.includes("ABSTAIN")) return Object.fromEntries(Object.entries(gold).filter(([k]) => k !== "abstained"));
  }
  return gold;
}
const PLAN = [
  { corpus: "batch4", lane: "classify", cases: b4.classify }, { corpus: "batch4", lane: "gate", cases: b4.gate },
  { corpus: "batch4", lane: "screen", cases: b4.screen },
  { corpus: "v2", lane: "classify", cases: v2.classify }, { corpus: "v2", lane: "gate", cases: v2.gate },
  { corpus: "v2", lane: "screen", cases: v2.screen },
  { corpus: "r1", lane: "classify", cases: r1CasesFor("classify") }, { corpus: "r1", lane: "gate", cases: r1CasesFor("gate") },
  { corpus: "r1", lane: "screen", cases: r1CasesFor("screen") }, { corpus: "r1", lane: "rerank", cases: r1CasesFor("rerank") },
];
const summary = {};
const details = {};
for (const { corpus, lane, cases } of PLAN) {
  const key = `${corpus}:${lane}`;
  const probe = await probeLane(lane, "gliclass");
  if (!probe.reachable) { console.error(`REFUSED ${key} (exit 2): ${probe.error}`); process.exit(2); }
  const client = new GliclassClient(probe.baseUrl);
  const deps = { fakeClient: lanePredictFactory(client) };
  const rows = [];
  for (const c of cases) {
    client.callLog = [];
    const t0 = performance.now();
    try {
      const body = await suites[lane].invoke(deps, c.input, c.stub ?? { answers: {} }, {});
      const wall = performance.now() - t0;
      const s = scoreIndependentDecision(suites[lane].name, body, goldFor(lane, c.gold));
      const rep = typeof body?.latency_ms === "number" ? body.latency_ms : null;
      rows.push({ id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: false,
        wall_ms: round1(wall), reported_latency_ms: rep === null ? null : round1(rep), n_calls: client.callLog.length,
        abstained: body?.abstention?.abstained === true,
        decisionActual: body?.decision?.decision ?? null, decisionGold: c.gold.decision ?? null,
        taskActual: s.taskActual, taskGold: s.taskGold, decOk: s.decisionOk, taskOk: s.taskOk, abstOk: s.abstainedOk,
        judgments: [], gliclass: client.callLog.map((e) => ({ key: e.key, top: e.top, top_score: e.top_score, margin: e.margin, scores: e.scores, latency_ms: round1(e.latencyMs) })) });
    } catch (err) {
      rows.push({ id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: true, wall_ms: round1(performance.now() - t0),
        reported_latency_ms: null, n_calls: client.callLog.length, error: String(err?.message ?? err).split("\n")[0],
        abstained: false, decisionActual: null, decisionGold: c.gold.decision ?? null, taskActual: null, taskGold: null,
        decOk: false, taskOk: false, abstOk: false, judgments: [], gliclass: [] });
    }
  }
  const scored = rows.filter((r) => !r.threw);
  const en = scored.filter((r) => r.lang === "en"), es = scored.filter((r) => r.lang !== "en");
  summary[key] = { n: rows.length, threw: rows.length - scored.length,
    dec: scored.filter((r) => r.decOk).length, task: scored.filter((r) => r.taskOk).length,
    abstained: scored.filter((r) => r.abstained).length,
    dec_en: en.filter((r) => r.decOk).length, dec_es: es.filter((r) => r.decOk).length,
    task_en: en.filter((r) => r.taskOk).length, task_es: es.filter((r) => r.taskOk).length,
    wall_ms_total: round1(rows.reduce((a, r) => a + (r.wall_ms ?? 0), 0)),
    reported_latency_ms_total: round1(rows.reduce((a, r) => a + (r.reported_latency_ms ?? 0), 0)) };
  details[key] = rows;
  const m = summary[key];
  console.log(`| ${key} | dec ${m.dec}/${m.n} | task ${m.task}/${m.n} | abst ${m.abstained} threw ${m.threw} | EN dec ${m.dec_en} task ${m.task_en} | ES dec ${m.dec_es} task ${m.task_es} |`);
  for (const r of rows) if (!r.decOk || !r.taskOk) {
    const g = (r.gliclass ?? [])[0] ?? {};
    console.log(`  miss ${r.id}${r.threw ? " THREW:" + (r.error ?? "?") : ""}: dec ${r.decisionGold}->${r.decisionActual} task ${JSON.stringify(r.taskGold)}->${JSON.stringify(r.taskActual)} top ${g.top}@${typeof g.top_score === "number" ? g.top_score.toFixed(3) : g.top_score}`);
  }
}
// find columns (read-only, never re-run)
const findCols = {};
for (const [t, f] of [["qwen", "v8"], ["gte", "v9"]]) {
  const m = JSON.parse(fs.readFileSync(path.join(R, "evals", "results", f, "metrics.json"), "utf8"));
  findCols[t] = { source: `evals/results/${f}`, decision: m.lanes.find.decision, task: m.lanes.find.task };
}
const prim = (corpus, lane) => {
  const m = summary[`${corpus}:${lane}`];
  return { primitive: lane, corpus, lane_backend: `gliclass(${tag})`, source: outDir,
    decision: { n: m.n, correct: m.dec }, task: { n: m.n, correct: m.task }, abstained: m.abstained, threw: m.threw };
};
const sumParts = (parts) => {
  const d = { n: 0, correct: 0 }, t2 = { n: 0, correct: 0 };
  for (const p of parts) { d.n += p.decision.n; d.correct += p.decision.correct; t2.n += p.task.n; t2.correct += p.task.correct; }
  return { decision: d, task: t2 };
};
const core = [prim("r1", "classify"), prim("r1", "gate"), prim("r1", "rerank"), prim("r1", "screen")];
const composed = {
  generated: `regulus matrix composed table (backend gliclass(${tag}); r1 lanes this run + qwen/gte find from v8/v9, never re-run)`,
  rows: [...core,
    { primitive: "find", corpus: "r1", lane_backend: "qwen", ...findCols.qwen },
    { primitive: "find", corpus: "r1", lane_backend: "gte", ...findCols.gte }],
  totals: {
    [`${tag}+qwen-find`]: sumParts([...core, { decision: findCols.qwen.decision, task: findCols.qwen.task }]),
    [`${tag}+gte-find`]: sumParts([...core, { decision: findCols.gte.decision, task: findCols.gte.task }]),
  },
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify({ generated: `regulus matrix (${tag}): batch4-validation + v2 + r1 gliclass lanes`, backend: `gliclass(${tag}) :8770`, timeout_ms: LANE_CALL_TIMEOUT_MS, summary, lanes: details }, null, 2));
fs.writeFileSync(path.join(outDir, "composed.json"), JSON.stringify(composed, null, 2));
console.log(`saved: ${outDir}/metrics.json + composed.json`);
console.log("| primitive | lane | dec | task |");
for (const r of composed.rows) console.log(`| ${r.primitive} (${r.corpus ?? ""}) | ${r.lane_backend ?? r.lane} | ${r.decision.correct}/${r.decision.n} | ${r.task.correct}/${r.task.n} |`);
for (const [k, v] of Object.entries(composed.totals)) console.log(`TOTAL ${k}: decision ${v.decision.correct}/${v.decision.n} task ${v.task.correct}/${v.task.n}`);
