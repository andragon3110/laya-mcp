/**
 * Fase-7 T5 benchmarks: primitives + rerank scale sweep + model load/warm/cold.
 *
 * SCOPE (T5 only): absolute latency/throughput/memory/candidate-count numbers
 * over the REAL handlers (from dist/) with deterministic stubs. No metrics
 * (T4), no versioned results writing here (manifest.mjs owns saveRun; this
 * file orchestrates --save), no EVALUATION.md, no integration (T6).
 * No models, no GPU, no network, no pip.
 *
 * METHOD (inherits fase-4 T7; absolutes only, never asserted, never compared
 * across machines, no improvement claimed -- there is no baseline):
 * - Stub LayaClient reports a configurable `latencyMs` field; the measured
 *   wall time (performance.now deltas) is pipeline overhead. Reported
 *   `latency_ms` (stub field) and wall time are printed as SEPARATE columns
 *   so overhead vs stub time never conflate (an optional `delayMs` can also
 *   burn wall time; unused by default).
 * - Memory is process.memoryUsage().heapUsed sampled at documented points
 *   (absolute process heap in MB, approx: whole Node process, single sample,
 *   no GC forcing -- GC noise applies).
 * - Throughput = inputCount / meanWall (cand/s) and 1000 / meanWall (ops/s).
 * - Quantiles are nearest-rank p50/p95/p99 (same definition as
 *   src/metrics.ts `quantile`, reimplemented here so evals stays free of src
 *   imports beyond the dist handlers the T3 harness already uses).
 * - Rerank N in [10, 50, 100, 500, 1000] at top_k=10 with the fase-4
 *   deterministic pool (item i carries (i*7+3)%4 of the 3 query tokens +
 *   fixed filler). N > 64 cannot run the stubbed judge end to end (the 64
 *   transport cap rejects before pruning), so those rows report the pure
 *   selector + the projected judge load, exactly like fase-4 T5.
 * - Quality = MRR/nDCG from evals/metrics.mjs rankingMetrics against a
 *   construction-truth gold (pool item i carries (i*7+3)%4 query tokens, so
 *   ideal = token-count desc, stable; the selector scores preScore=k/3, but
 *   the gold is computed from the construction formula, never from the
 *   selector under test). The e2e judge stub for N <= 64 carries ONE intentional
 *   adjacent swap (positions 0/1) so the numbers prove the metric pipeline
 *   discriminates order differences; magnitudes stay oracle-assigned, so
 *   every quality number below measures harness conservation under a stub
 *   ceiling -- NOT backend ranking quality. No thresholds anywhere.
 *
 * STUB HONESTY (inherits T3): stub answers are the suites' oracle-derived
 * canonicals (each suite's cases[0]); the stub is NOT the model and nothing
 * here transfers to the real backend.
 *
 * Run from the repo root:
 *   node evals/bench.mjs            # human-readable tables (absolutes)
 *   node evals/bench.mjs --json     # machine-readable report on stdout
 *   node evals/bench.mjs --save     # run + capture T4 metrics + manifest,
 *                                   # save versioned run under evals/results/
 *                                   # (NEVER overwrites: new version per run)
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { rankingMetrics } from "./metrics.mjs";
import {
  buildRerankQuestionsWithInfo,
  handleRerank,
  resolveRerankSelection,
  selectRerankCandidates,
} from "../dist/tools/rerank.js";

export const BENCH_SUITES = [classify, decide, verify, screen, pii, extract, find, rerank, review, gate];

export const BENCH_METHOD =
  "single process; stub-reported latency_ms kept separate from measured wall " +
  "(wall = pipeline overhead; stubs report latency_ms as a field, never " +
  "conflated; optional injected delay via delayMs, unused by default); " +
  "memory = absolute heapUsed in MB (approx, whole process, single sample, " +
  "no GC forcing); quantiles = nearest-rank p50/p95/p99 (src/metrics.ts " +
  "definition); throughput = count/meanWall; rerank N>64 = pure selector + " +
  "projected judge (64 transport cap); quality = MRR/nDCG vs " +
  "construction-truth gold (stub ceiling, NOT backend quality); absolutes " +
  "only, no baseline, no claims.";

export const BENCH_CONFIG_DEFAULT = {
  reps: 15,
  e2eReps: 5,
  stubLatencyMs: 0,
  topK: 10,
  rerankNs: [10, 50, 100, 500, 1000],
  seed: "none (deterministic construction, no RNG)",
};

/** Nearest-rank quantile over an ascending-sorted copy. Null when empty. */
export function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(q * sortedAsc.length);
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[idx];
}

/** Summarize wall samples: { count, p50, p95, p99, mean, min, max }. */
export function summarizeSamples(samples) {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, p99: null, mean: null, min: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    count: samples.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export const heapMB = () => process.memoryUsage().heapUsed / 1048576;

/**
 * Configurable-latency stub factory. Signature-compatible with the T3 deps
 * fakeClient: (answers, capture) => LayaClient. `latencyMs` is REPORTED in
 * the response (the latency_ms column); `delayMs` is actually awaited ( wall
 * includes it). Defaults 0/0 keep benches fast; the latency demo row uses
 * delayMs > 0 to show the wall = overhead + stub-delay split explicitly.
 */
export function stubClientFactory({ latencyMs = 0, delayMs = 0 } = {}) {
  return (answers, capture) => ({
    predict: async (_args, questions) => {
      if (capture) capture.questions = questions;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { answers, confidence: {}, routing: {}, model: "evals-bench-stub", latencyMs, usage: {} };
    },
  });
}

/** GLiNER sidecar stub holder (mirrors the T3 makePiiCtx shape). */
export function makeBenchPiiCtx(findings) {
  return {
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
  };
}

/**
 * Fake live-probe holder for the model-load shape demo. Returns canned
 * /models + /ready payloads after an optional injected delay; measures only
 * holder plumbing, never real model loading (no local weights exist here).
 */
export function makeProbeHolder({ latencyMs = 0, delayMs = 0 } = {}) {
  const models = [{ name: "stub-model", loaded: true, revision: null, device: "unknown (stub)" }];
  const ready = { ready: true, reason: null, device: "unknown (stub)", loaded: ["stub-model"], failed: [] };
  const wait = async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  };
  return {
    models: async () => {
      await wait();
      return { models, latencyMs };
    },
    ready: async () => {
      await wait();
      return { ready, latencyMs };
    },
  };
}

/** Canonical input size per primitive (unit documented per row). */
export function inputCountOf(suiteName, input) {
  switch (suiteName) {
    case "classify":
      return { count: input.items?.length ?? null, unit: "items" };
    case "verify":
      return { count: input.claims?.length ?? null, unit: "claims" };
    case "screen":
    case "review":
      return { count: 1, unit: "call" };
    case "pii":
      return { count: 1, unit: "text" };
    case "extract":
      return { count: input.fields?.length ?? null, unit: "fields" };
    case "find":
    case "rerank":
      return { count: input.candidates?.length ?? null, unit: "candidates" };
    case "gate":
      return { count: input.claims?.length ?? null, unit: "claims" };
    case "decide":
      return { count: input.candidates?.length ?? null, unit: "options" };
    default:
      return { count: null, unit: "call" };
  }
}

function benchDeps(factory) {
  return { fakeClient: factory, makePiiCtx: makeBenchPiiCtx };
}

/**
 * Bench one primitive on its suite canonical (cases[0]): reps e2e wall
 * samples; the FIRST sample is reported separately as cold_first_ms
 * (primer-live in a fresh stub context), the rest as the warm distribution.
 */
export async function benchPrimitive(suite, { reps = BENCH_CONFIG_DEFAULT.reps, factory = stubClientFactory() } = {}) {
  const canonical = suite.cases[0];
  const deps = benchDeps(factory);
  const walls = [];
  let reportedLatency = null;
  let pruning = null;
  let threw = null;
  for (let r = 0; r < reps; r++) {
    const capture = {};
    const t0 = performance.now();
    try {
      const body = await suite.invoke(deps, canonical.input, canonical.stub, capture);
      walls.push(performance.now() - t0);
      if (r === 0) {
        reportedLatency = typeof body.latency_ms === "number" ? body.latency_ms : null;
        pruning = body.pruning !== undefined ? body.pruning : null;
      }
    } catch (err) {
      threw = String(err?.message ?? err).split("\n")[0];
      break;
    }
  }
  const { count, unit } = inputCountOf(suite.name, canonical.input);
  const warm = summarizeSamples(walls.slice(1));
  const meanForRate = warm.mean ?? (walls.length > 0 ? walls[0] : null);
  return {
    suite: suite.name,
    primitive: suite.primitive,
    canonical: canonical.id,
    canonical_kind: canonical.kind,
    reps: walls.length,
    threw,
    input: { count, unit },
    stub_latency_ms: 0,
    reported_latency_ms: reportedLatency,
    cold_first_ms: walls.length > 0 ? walls[0] : null,
    warm_wall_ms: warm,
    ops_per_s: meanForRate !== null && meanForRate > 0 ? 1000 / meanForRate : null,
    cand_per_s: meanForRate !== null && meanForRate > 0 && typeof count === "number" ? (count / meanForRate) * 1000 : null,
    pruning,
    mem_heap_mb: heapMB(),
  };
}

/** Latency-split demo: classify canonical with stub REPORTED latency 0 vs 5ms.
 * No delay is injected, so wall stays ~= pipeline overhead in both rows while
 * the reported column moves: the two numbers never conflate. */
export async function benchLatencyDemo({ reps = 8 } = {}) {
  const rows = [];
  for (const latencyMs of [0, 5]) {
    const row = await benchPrimitive(classify, { reps, factory: stubClientFactory({ latencyMs }) });
    row.stub_latency_ms = latencyMs;
    row.demo = `classify stub reports ${latencyMs}ms (reported moves, wall ~= overhead; never conflated)`;
    rows.push(row);
  }
  return rows;
}

const RERANK_QUERY = "apple red harvest";
const RERANK_TOP_K = 10;

export function rerankPool(n) {
  const toks = ["apple", "red", "harvest"];
  return Array.from({ length: n }, (_, i) => {
    const k = (i * 7 + 3) % 4;
    return { id: `e${i}`, text: [...toks.slice(0, k), `filler${i}`, "doc", "body", "text"].join(" ") };
  });
}

/**
 * Construction-truth gold: pool item i carries k=(i*7+3)%4 query tokens by
 * construction (see rerankPool), and the selector scores preScore=k/3, so the
 * ideal order is k desc, stable by index -- computed here from the
 * CONSTRUCTION formula, never from the selector under test (no circularity).
 * At the N=10 no-op boundary the selector keeps input order unscored, so
 * selector quality there honestly reports the un-re-ranked order.
 */
export function constructionGoldOrder(n) {
  return Array.from({ length: n }, (_, i) => ({ i, k: (i * 7 + 3) % 4 }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .map(({ i }) => `e${i}`);
}

/**
 * Rerank scale sweep. Quality gold = constructionGoldOrder(n) (token-count
 * truth, independent of the selector); selector quality measures top_k
 * retention (MRR_sel is 1 iff the gold top-1 survives pruning); the e2e judge stub
 * (N <= 64 only) carries one intentional adjacent swap so MRR/nDCG prove
 * the metric pipeline discriminates. N > 64 rows are selector-only +
 * projected judge (64 transport cap rejects before pruning).
 */
export async function benchRerankSweep({ ns = BENCH_CONFIG_DEFAULT.rerankNs, topK = RERANK_TOP_K, selRepsFor = null } = {}) {
  const rows = [];
  for (const n of ns) {
    const pool = rerankPool(n);
    const memPool = heapMB();
    const gold = constructionGoldOrder(n);
    const sel = resolveRerankSelection({ top_k: topK });
    const reps = selRepsFor ? selRepsFor(n) : n <= 100 ? 200 : 50;
    let first = null;
    const selWalls = [];
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      first = selectRerankCandidates(pool, RERANK_QUERY, sel);
      selWalls.push(performance.now() - t0);
    }
    const kept = first.shown.length;
    const dropped = first.dropped;
    const selQuality = rankingMetrics(first.shown.map((c) => c.id), gold);
    let e2e = null;
    if (n <= 64) {
      const built = buildRerankQuestionsWithInfo({ query: RERANK_QUERY, candidates: pool, top_k: topK });
      const answers = {};
      built.shown.forEach((c, i) => {
        answers[`relevance_${i}_${c.id}`] = { noul: 0.9 - i * 0.001 };
      });
      const keys = Object.keys(answers);
      if (keys.length >= 2) {
        const tmp = answers[keys[0]];
        answers[keys[0]] = answers[keys[1]];
        answers[keys[1]] = tmp;
      }
      const e2eWalls = [];
      let body = null;
      for (let r = 0; r < BENCH_CONFIG_DEFAULT.e2eReps; r++) {
        const t0 = performance.now();
        body = JSON.parse(await handleRerank(stubClientFactory()(answers), { query: RERANK_QUERY, candidates: pool, top_k: topK }));
        e2eWalls.push(performance.now() - t0);
      }
      const judgeQuality = rankingMetrics(body.ranked.map((c) => c.id), gold);
      e2e = {
        wall_ms: summarizeSamples(e2eWalls),
        ranked: body.ranked.length,
        swap_note: "intentional adjacent swap of stub positions 0/1 (discrimination proof; stub ceiling applies)",
        mrr: judgeQuality.mrr,
        ndcg: judgeQuality.ndcg,
        map: judgeQuality.map,
      };
    }
    const selSummary = summarizeSamples(selWalls);
    const selMean = selSummary.mean;
    rows.push({
      n,
      top_k: topK,
      kept,
      dropped,
      pruning_ratio: dropped / n,
      e2e_projected: n > 64,
      e2e_note: n > 64 ? "projected judge load (transport rejects pools > 64 with input_too_large before pruning)" : null,
      selector_wall_ms: selSummary,
      selector_cand_per_s: selMean !== null && selMean > 0 ? Math.round(n / (selMean / 1000)) : null,
      e2e,
      mrr_selector: selQuality.mrr,
      ndcg_selector: selQuality.ndcg,
      mem_heap_mb: memPool,
    });
  }
  return rows;
}

/**
 * Model load / warm / cold. No local weights exist in this repo (the backend
 * is remote laya-server + gliner sidecar), so real model-load timing needs a
 * live backend and is NOT measured here: cold/warm import covers the MCP-side
 * load that exists, and the probe holder demonstrates the live-probe shape
 * (capabilities.ts recordProbe path) with injected latency only.
 */
export async function benchModelLoad() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const target = path.join(here, "..", "dist", "tools", "rerank.js");
  const targetUrl = pathToFileURL(target).href;
  const t0 = performance.now();
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(targetUrl)})`], { stdio: "pipe" });
  const coldImportMs = performance.now() - t0;
  const warmWalls = [];
  for (let r = 0; r < 5; r++) {
    const s = performance.now();
    await import("../dist/tools/rerank.js");
    warmWalls.push(performance.now() - s);
  }
  const holder = makeProbeHolder({ latencyMs: 3 });
  const probeWalls = [];
  let firstProbe = null;
  for (let r = 0; r < 11; r++) {
    const s = performance.now();
    const [m, rd] = await Promise.all([holder.models(), holder.ready()]);
    const w = performance.now() - s;
    if (r === 0) firstProbe = { wall_ms: w, models: m.models.length, ready: rd.ready.ready, reported_latency_ms: m.latencyMs };
    else probeWalls.push(w);
  }
  return {
    cold_import_wall_ms: coldImportMs,
    cold_import_note: "fresh node process spawn + import (includes spawn cost; MCP-side load only)",
    warm_import_wall_ms: summarizeSamples(warmWalls),
    warm_import_note: "in-process cached re-import (same specifier: ESM cache hit)",
    primer_live_note: "primer-live first-call cost is recorded per primitive as cold_first_ms (fresh stub context, modules warm)",
    probe_holder: {
      cold_first: firstProbe,
      warm_wall_ms: summarizeSamples(probeWalls),
      note: "fake /models+/ready holder (reports 3ms, burns no wall time); shape demo only -- real model load needs a live backend",
    },
    limit: "no local model weights in this repo; real model-load/warm/cold timing requires live laya-server + gliner (T6 integration scope), not measured here",
  };
}

/** Full bench report (pure data; printing/saving is the CLI layer below). */
export async function runBench(config = {}) {
  const cfg = { ...BENCH_CONFIG_DEFAULT, ...config };
  const memBaseline = heapMB();
  const primitives = [];
  for (const suite of BENCH_SUITES) {
    primitives.push(await benchPrimitive(suite, { reps: cfg.reps, factory: stubClientFactory({ latencyMs: cfg.stubLatencyMs }) }));
  }
  const latencyDemo = await benchLatencyDemo({ reps: Math.min(8, cfg.reps) });
  const rerankSweep = await benchRerankSweep({
    ns: cfg.rerankNs,
    topK: cfg.topK,
    selRepsFor: typeof cfg.selReps === "number" ? () => cfg.selReps : null,
  });
  const modelLoad = await benchModelLoad();
  return {
    generated: "fase-7 T5 (oracle-stub canonicals + real handlers; stub ceiling, not backend quality)",
    method: BENCH_METHOD,
    config: cfg,
    mem_baseline_heap_mb: memBaseline,
    primitives,
    latency_demo: latencyDemo,
    rerank_sweep: rerankSweep,
    model_load: modelLoad,
  };
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const wantSave = args.includes("--save");

function printTables(rep) {
  console.log("\nFase-7 T5 benchmarks (deterministic stubs + real handlers; absolutes, no baseline claims):");
  console.log(`method: ${rep.method}`);
  console.log("\n| primitive | canonical | N | stub_ms | reported_ms | cold_1st_ms | warm_p50 | warm_p95 | warm_p99 | ops/s | cand/s | pruning | mem_MB~ |");
  console.log("|-----------|-----------|---|---------|-------------|-------------|----------|----------|----------|-------|--------|---------|---------|");
  const fmt = (v) => (v === null || v === undefined ? "n/a" : typeof v === "number" ? (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1)) : String(v));
  for (const r of rep.primitives) {
    const pr = r.pruning ? `${r.pruning.kept}kept/${r.pruning.dropped}drop` : "n/a";
    console.log(
      `| ${r.primitive} | ${r.canonical} | ${r.input.count ?? "n/a"} ${r.input.unit} | ${r.stub_latency_ms} | ${fmt(r.reported_latency_ms)} | ${fmt(r.cold_first_ms)} | ${fmt(r.warm_wall_ms.p50)} | ${fmt(r.warm_wall_ms.p95)} | ${fmt(r.warm_wall_ms.p99)} | ${fmt(r.ops_per_s)} | ${fmt(r.cand_per_s)} | ${pr} | ${r.mem_heap_mb.toFixed(1)} |`,
    );
  }
  console.log("\nlatency-split demo (reported moves, wall ~= overhead; never conflated):");
  for (const r of rep.latency_demo) console.log(`- ${r.demo}: cold_1st=${fmt(r.cold_first_ms)}ms warm_p50=${fmt(r.warm_wall_ms.p50)}ms reported=${fmt(r.reported_latency_ms)}ms`);
  console.log("\n| N | kept | dropped | ratio | sel_p50 | sel_p95 | sel_cand/s | e2e_wall_p50 | MRR_sel | nDCG_sel | MRR_judge | nDCG_judge | mem_MB~ |");
  console.log("|---|------|---------|-------|---------|---------|------------|-------------|---------|----------|-----------|------------|---------|");
  for (const r of rep.rerank_sweep) {
    console.log(
      `| ${r.n} | ${r.kept} | ${r.dropped} | ${r.pruning_ratio.toFixed(3)} | ${fmt(r.selector_wall_ms.p50)} | ${fmt(r.selector_wall_ms.p95)} | ${r.selector_cand_per_s ?? "n/a"} | ${r.e2e ? fmt(r.e2e.wall_ms.p50) : "n/a (>64 cap)"} | ${fmt(r.mrr_selector)} | ${fmt(r.ndcg_selector)} | ${r.e2e ? fmt(r.e2e.mrr) : "n/a"} | ${r.e2e ? fmt(r.e2e.ndcg) : "n/a"} | ${r.mem_heap_mb.toFixed(1)} |`,
    );
  }
  console.log("(N>64: projected judge load; transport rejects pools > 64 before pruning.)");
  console.log("\nmodel load / warm / cold (MCP-side only; no local weights):");
  console.log(`- cold import wall: ${rep.model_load.cold_import_wall_ms.toFixed(1)}ms (${rep.model_load.cold_import_note})`);
  console.log(`- warm import p50: ${fmt(rep.model_load.warm_import_wall_ms.p50)}ms`);
  console.log(`- probe holder cold: ${fmt(rep.model_load.probe_holder.cold_first.wall_ms)}ms, warm p50: ${fmt(rep.model_load.probe_holder.warm_wall_ms.p50)}ms`);
  console.log(`- limit: ${rep.model_load.limit}`);
  console.log("(rows within one run share the process: compare shapes, not machines; no improvement claimed.)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rep = await runBench();
  if (wantSave) {
    const { buildManifest, saveRun, captureScoreMetrics } = await import("./manifest.mjs");
    const metrics = captureScoreMetrics();
    const manifest = await buildManifest({ bench: rep, metrics });
    const saved = saveRun({ manifest, bench: rep, metrics });
    if (!asJson) printTables(rep);
    console.log(`\nsaved versioned run: ${saved.path} (manifest.json + bench.json + metrics.json; never overwritten)`);
  } else if (asJson) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    printTables(rep);
  }
}
