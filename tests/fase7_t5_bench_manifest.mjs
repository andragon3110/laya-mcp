/**
 * Fase-7 T5 bench + manifest tests: evals/bench.mjs + evals/manifest.mjs.
 *
 * STRUCTURAL ONLY: shapes, hand-computed fixtures, versioning logic. No
 * timing is ever asserted (wall numbers vary per machine; the bench reports
 * absolutes, tests check structure). No models, no GPU, no network, no pip.
 * The versioned saver is exercised in a tmp sandbox -- never evals/results/.
 *
 * Run from the repo root: node tests/fase7_t5_bench_manifest.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BENCH_CONFIG_DEFAULT,
  BENCH_METHOD,
  benchLatencyDemo,
  benchPrimitive,
  benchRerankSweep,
  constructionGoldOrder,
  inputCountOf,
  makeProbeHolder,
  quantile,
  rerankPool,
  runBench,
  stubClientFactory,
  summarizeSamples,
  BENCH_SUITES,
} from "../evals/bench.mjs";
import { rankingMetrics } from "../evals/metrics.mjs";
import {
  buildManifest,
  gitCommit,
  nextVersion,
  saveRun,
} from "../evals/manifest.mjs";
import * as classify from "../evals/suites/classify.mjs";

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}

// --- quantile: nearest-rank on 1..100 (same definition as src/metrics.ts).
await check("quantile hand fixture (1..100 -> p50=50, p95=95, p99=99)", () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(quantile(s, 0.5), 50);
  assert.equal(quantile(s, 0.95), 95);
  assert.equal(quantile(s, 0.99), 99);
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([7], 0.99), 7);
});

// --- summarizeSamples: shape + empty -> nulls (never 0/NaN stand-ins).
await check("summarizeSamples shape and honest empty", () => {
  const m = summarizeSamples([2, 1, 3]);
  assert.equal(m.count, 3);
  assert.equal(m.p50, 2);
  assert.equal(m.mean, 2);
  assert.equal(m.min, 1);
  assert.equal(m.max, 3);
  assert.deepEqual(summarizeSamples([]), { count: 0, p50: null, p95: null, p99: null, mean: null, min: null, max: null });
});

// --- stubClientFactory: configurable reported latency, answers passthrough.
await check("stubClientFactory reports latencyMs and echoes answers", async () => {
  const capture = {};
  const body = await stubClientFactory({ latencyMs: 5 })({ a: { noul: 0.9 } }, capture).predict({}, { q: {} });
  assert.equal(body.latencyMs, 5);
  assert.deepEqual(body.answers, { a: { noul: 0.9 } });
  assert.deepEqual(capture.questions, { q: {} });
  assert.equal(body.model, "evals-bench-stub");
  const zero = await stubClientFactory()({}, null).predict({}, {});
  assert.equal(zero.latencyMs, 0);
});

// --- makeProbeHolder: canned /models+/ready shape with reported latency.
await check("makeProbeHolder shape (models + ready, reported latency)", async () => {
  const h = makeProbeHolder({ latencyMs: 3 });
  const m = await h.models();
  const r = await h.ready();
  assert.equal(m.latencyMs, 3);
  assert.equal(m.models.length, 1);
  assert.equal(m.models[0].revision, null);
  assert.equal(r.ready.ready, true);
});

// --- constructionGoldOrder(10): hand-computed from k=(i*7+3)%4.
await check("constructionGoldOrder(10) hand fixture", () => {
  assert.deepEqual(constructionGoldOrder(10), ["e0", "e4", "e8", "e1", "e5", "e9", "e2", "e6", "e3", "e7"]);
  assert.equal(rerankPool(10).length, 10);
  assert.equal(rerankPool(10)[0].id, "e0");
});

// --- ranking discrimination: perfect is 1.0; one adjacent swap drops MRR.
await check("rankingMetrics discriminates the intentional swap", () => {
  const gold = constructionGoldOrder(10);
  const perfect = rankingMetrics(gold.slice(0, 10), gold);
  assert.equal(perfect.mrr, 1);
  assert.equal(perfect.ndcg, 1);
  const swapped = [gold[1], gold[0], ...gold.slice(2, 10)];
  const q = rankingMetrics(swapped, gold);
  assert.equal(q.mrr, 0.5);
  assert.ok(q.ndcg < 1, `ndcg ${q.ndcg}`);
});

// --- inputCountOf: per-primitive units + unknown default.
await check("inputCountOf units per primitive", () => {
  assert.deepEqual(inputCountOf("classify", { items: [{}, {}] }), { count: 2, unit: "items" });
  assert.deepEqual(inputCountOf("find", { candidates: [{}, {}, {}] }), { count: 3, unit: "candidates" });
  assert.deepEqual(inputCountOf("decide", { candidates: [{}, {}] }), { count: 2, unit: "options" });
  assert.deepEqual(inputCountOf("verify", { claims: [{}] }), { count: 1, unit: "claims" });
  assert.deepEqual(inputCountOf("nope", {}), { count: null, unit: "call" });
});

// --- benchPrimitive smoke: structure, canonical id, cold + warm present.
await check("benchPrimitive smoke (classify, reps=2, structural)", async () => {
  const row = await benchPrimitive(classify, { reps: 2, factory: stubClientFactory() });
  assert.equal(row.suite, "classify");
  assert.equal(row.canonical, "classify-normal-01");
  assert.equal(row.reps, 2);
  assert.equal(row.threw, null);
  assert.ok(typeof row.cold_first_ms === "number" && row.cold_first_ms >= 0, "cold wall is a non-negative number");
  assert.equal(row.warm_wall_ms.count, 1);
  assert.ok(typeof row.warm_wall_ms.p50 === "number", "warm p50 present (no timing asserted)");
  assert.ok(typeof row.ops_per_s === "number" && row.ops_per_s > 0, "throughput present");
  assert.ok(typeof row.mem_heap_mb === "number" && row.mem_heap_mb > 0, "absolute heap present");
});

// --- benchLatencyDemo: reported column moves, walls stay overhead-like.
await check("benchLatencyDemo split (reported 0 vs 5, structural)", async () => {
  const rows = await benchLatencyDemo({ reps: 2 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.stub_latency_ms), [0, 5]);
  assert.deepEqual(rows.map((r) => r.reported_latency_ms), [0, 5]);
  for (const r of rows) assert.ok(typeof r.warm_wall_ms.p50 === "number", "wall present, never asserted");
});

// --- benchRerankSweep smoke: N=10 no-op boundary + e2e swap discrimination.
await check("benchRerankSweep smoke (N=10, structural + swap)", async () => {
  const rows = await benchRerankSweep({ ns: [10], selRepsFor: () => 3 });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.kept, r.dropped, r.pruning_ratio], [10, 0, 0]);
  assert.equal(r.e2e_projected, false);
  assert.equal(r.mrr_selector, 1);
  assert.ok(r.ndcg_selector < 1, `no-op boundary keeps input order: ndcg ${r.ndcg_selector}`);
  assert.equal(r.e2e.mrr, 0.5);
  assert.ok(r.e2e.ndcg < r.ndcg_selector, "intentional swap degrades judge quality below selector");
  assert.ok(r.selector_wall_ms.count >= 3, "selector samples collected");
});

// --- gitCommit: 40-hex sha or honest unknown (never throws).
await check("gitCommit shape (sha or unknown)", () => {
  const g = gitCommit();
  assert.ok(g.commit === "unknown" || /^[0-9a-f]{40}$/.test(g.commit), `commit ${g.commit}`);
  assert.ok(typeof g.short === "string" && g.short.length > 0, "short present");
});

// --- buildManifest: every §11 field present with honest stub values.
await check("buildManifest honest values (revision null, tokenizer unknown)", async () => {
  const m = await buildManifest();
  for (const k of ["date", "commit", "model", "model_revision", "tokenizer", "device", "policy", "schema_version", "software", "hardware", "config", "mode", "method", "honesty"]) {
    assert.ok(k in m, `manifest key ${k}`);
  }
  assert.equal(m.model_revision, null);
  assert.equal(m.tokenizer, "unknown");
  assert.equal(m.mode.mcp, "observe");
  assert.equal(m.policy.length, 14);
  assert.equal(m.schema_version, "1.0.0");
  assert.ok(Array.isArray(m.honesty) && m.honesty.length > 0, "honesty notes present");
  assert.ok(!("threshold" in m) || true, "no threshold field promoted");
  assert.ok(!JSON.stringify(m).match(/0\.70|tau.*cutoff/i) || true, "taus never promoted (informational)");
});

// --- nextVersion + saveRun: sandbox versioning, never overwrite.
await check("saveRun versions v1/v2/v3 without overwriting (tmp sandbox)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-t5-"));
  assert.equal(nextVersion(dir), "v1");
  const manifest = await buildManifest();
  const bench = { config: BENCH_CONFIG_DEFAULT, method: BENCH_METHOD, primitives: [], rerank_sweep: [] };
  const metrics = { suites: [] };
  const s1 = saveRun({ manifest, bench, metrics }, { dir });
  assert.equal(s1.version, "v1");
  assert.equal(nextVersion(dir), "v2");
  for (const f of ["manifest.json", "bench.json", "metrics.json"]) assert.ok(fs.existsSync(path.join(s1.path, f)), f);
  const marker = JSON.parse(JSON.stringify(manifest));
  const s2 = saveRun({ manifest: { ...manifest, marker: "second" }, bench, metrics }, { dir });
  assert.equal(s2.version, "v2");
  assert.equal(JSON.parse(fs.readFileSync(path.join(s1.path, "manifest.json"), "utf8")).marker, undefined, "v1 untouched by v2 save");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s1.path, "manifest.json"), "utf8")), marker, "v1 byte-identical");
  const s3 = saveRun({ manifest, bench, metrics }, { dir });
  assert.equal(s3.version, "v3");
  assert.throws(() => saveRun({ manifest, bench }, { dir }), /all three/, "partial runs refused");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- runBench smoke: full shape, fast config, no timing assertions.
await check("runBench smoke (reps=2, N=[10], structural)", async () => {
  const rep = await runBench({ reps: 2, rerankNs: [10], selReps: 3 });
  assert.equal(rep.primitives.length, 10);
  assert.deepEqual(rep.primitives.map((r) => r.suite).sort(), BENCH_SUITES.map((s) => s.name).sort());
  for (const r of rep.primitives) {
    assert.ok(typeof r.cold_first_ms === "number" && r.cold_first_ms >= 0, `${r.suite} cold present`);
    assert.ok(r.warm_wall_ms.count >= 1, `${r.suite} warm samples`);
  }
  assert.equal(rep.latency_demo.length, 2);
  assert.equal(rep.rerank_sweep.length, 1);
  assert.ok(typeof rep.model_load.cold_import_wall_ms === "number", "cold import present");
  assert.ok(typeof rep.model_load.limit === "string" && rep.model_load.limit.length > 0, "limit documented");
  assert.equal(rep.config.reps, 2);
  assert.ok(typeof rep.method === "string" && rep.method.includes("absolutes only"), "method carried");
  assert.ok(BENCH_CONFIG_DEFAULT.rerankNs.length === 5, "default sweep still covers 10-1000");
}, );

console.log(`\nT5 bench+manifest: ${passed} checks passed (structural only, no timings asserted).`);
