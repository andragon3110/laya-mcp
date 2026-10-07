/**
 * Fase-7 T5 reproducibility manifest + versioned results writer.
 *
 * SCOPE (T5 only): per-run manifest (model/revision/tokenizer/policy/schema/
 * software/hardware/device/config/mode + date + git commit) and the
 * never-overwrite versioned saver for evals/results/vN/ (manifest.json +
 * bench.json + metrics.json), plus the gold_corpus provenance census
 * (harness-spike-ready T5: independent vs oracle-stub counts per suite).
 * No benchmarks (bench.mjs), no metrics (T4),
 * no EVALUATION.md, no integration (T6). No models, no GPU, no network.
 *
 * HONEST VALUES IN THIS REPO (stub runs, no live backend):
 * - model: the stub id ("evals-oracle-stub" for T3/T4 canonicals,
 *   "evals-bench-stub" for bench runs); revision is the honest null (stubs
 *   resolve no pin; cf. capabilities.ts revision_source "unpinned").
 * - tokenizer: the explicit string "unknown" -- no tool and neither probe in
 *   laya_capabilities exposes a tokenizer (models carry name/repo/loaded/
 *   revision/device/circuit only; see src/tools/capabilities.ts).
 * - device: "unknown (stub run; no live backend)" -- capabilities reports
 *   backend.device / models[].device probed LIVE, and nothing was probed.
 * - policy: the live registry truth via dist/policy/loader.js listPolicies()
 *   (14 entries; availability-independent per capabilities.ts).
 * - schema: ENVELOPE_SCHEMA_VERSION from dist/envelope.js.
 * - mode: mcp "observe" always (the MCP layer never acts, per
 *   capabilities.ts); policy mode is the LAYA_MODE resolution (default
 *   observe) recorded verbatim from the environment.
 *
 * Run from the repo root:
 *   node evals/manifest.mjs          # human-readable manifest for THIS tree
 *   node evals/manifest.mjs --json   # manifest JSON on stdout (no bench run)
 *   node evals/manifest.mjs --live --json  # manifest with live-backend probe
 *                                    # (refuses, exit 2, when unreachable)
 *   node evals/manifest.mjs --save   # full orchestration: bench + T4 score
 *                                    # capture + manifest, saved versioned
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENVELOPE_SCHEMA_VERSION } from "../dist/envelope.js";
import { listPolicies } from "../dist/policy/loader.js";
import * as classifySuite from "./suites/classify.mjs";
import * as decideSuite from "./suites/decide.mjs";
import * as verifySuite from "./suites/verify.mjs";
import * as screenSuite from "./suites/screen.mjs";
import * as piiSuite from "./suites/pii.mjs";
import * as extractSuite from "./suites/extract.mjs";
import * as findSuite from "./suites/find.mjs";
import * as rerankSuite from "./suites/rerank.mjs";
import * as reviewSuite from "./suites/review.mjs";
import * as gateSuite from "./suites/gate.mjs";
import * as compareSuite from "./suites/compare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const require = createRequire(path.join(repoRoot, "package.json"));

export const RESULTS_DIR_DEFAULT = path.join(repoRoot, "evals", "results");

const GOLD_CORPUS_SUITES = [
  classifySuite, decideSuite, verifySuite, screenSuite, piiSuite,
  extractSuite, findSuite, rerankSuite, reviewSuite, gateSuite, compareSuite,
];

/**
 * T5-spike gold provenance census: per case, case.gold_source wins, else
 * the suite goldSource default ("oracle-stub"). Pure data for the
 * manifest gold_corpus block and the EVALUATION.md spike table; it never
 * changes what run/score/bench execute.
 */
export function goldCorpusCounts() {
  const perSuite = GOLD_CORPUS_SUITES.map((s) => {
    const def = s.goldSource ?? "oracle-stub";
    const independent = s.cases.filter((c) => (c.gold_source ?? def) === "independent").length;
    return { suite: s.name, total: s.cases.length, independent, oracle_stub: s.cases.length - independent };
  });
  const independent = perSuite.reduce((a, r) => a + r.independent, 0);
  const total = perSuite.reduce((a, r) => a + r.total, 0);
  return { independent, oracle_stub: total - independent, total, per_suite: perSuite };
}

/** git HEAD sha, or "unknown" with the reason (never throws). */
export function gitCommit() {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return { commit: sha, short: sha.slice(0, 7) };
  } catch {
    /* git absent (exported tree): fall through to honest unknown */
  }
  return { commit: "unknown", short: "unknown", note: "git unavailable; tree identity unrecorded" };
}

export function softwareInfo() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    package_version: require("./package.json")?.version ?? "unknown",
  };
}

export function hardwareInfo() {
  return {
    arch: process.arch,
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model ?? "unknown",
    totalmem_mb: Math.round(os.totalmem() / 1048576),
  };
}

/**
 * Full per-run manifest. `bench`/`metrics` are optional summaries the saver
 * links (counts only -- the full payloads live in bench.json/metrics.json).
 * `backend` is the live-client descriptor (see evals/live-client.mjs):
 * null/absent means the stub default (honest nulls as below); a reachable
 * live descriptor records the probed model id, the resolved revision pin
 * (or the explicit unpinned null -- never an invented hash), and the
 * probed device.
 */
export async function buildManifest({ bench = null, metrics = null, backend = null } = {}) {
  const git = gitCommit();
  const live = backend?.live === true && backend?.reachable === true;
  return {
    generated: live
      ? `fase-7 T5+spike reproducibility manifest (LIVE backend ${backend.baseUrl}; absolutes + method, no improvement claims)`
      : "fase-7 T5 reproducibility manifest (stub run; absolutes + method, no improvement claims)",
    date: new Date().toISOString(),
    commit: git.commit,
    commit_short: git.short,
    ...(git.note ? { commit_note: git.note } : {}),
    model: live ? backend.model : bench ? "evals-bench-stub" : "evals-oracle-stub",
    model_note: live
      ? `live backend model inventory name at ${backend.baseUrl} (verbatim probe; "name unreported" when the backend sent none)`
      : "no real model involved; stub id only (T3/T4 canonicals use evals-oracle-stub, bench runs use evals-bench-stub)",
    model_revision: live ? backend.model_revision : null,
    model_revision_source: live ? backend.model_revision_source : "unpinned",
    model_revision_note: live
      ? "operator pin (LAYA_MODEL_REVISION) wins, else the backend-reported revision, else the honest null (cf. capabilities revision_source unpinned; a hash is never invented)"
      : "honest null: stubs resolve no pin (cf. capabilities revision_source unpinned; a hash is never invented)",
    tokenizer: "unknown",
    tokenizer_note: "explicit unknown: laya_capabilities exposes name/repo/loaded/revision/device/circuit per model, never a tokenizer",
    device: live ? backend.device : "unknown (stub run; no live backend)",
    device_note: live
      ? "probed LIVE from GET /ready (or the explicit unknown string when the backend reported no device)"
      : "capabilities reports backend.device / models[].device probed LIVE; nothing was probed in this run",
    backend: backend ?? { mode: "stub", live: false, reachable: false, note: "stub default: no backend probed" },
    policy: listPolicies(),
    policy_note: "live registry truth (availability-independent); 14 entries",
    schema_version: ENVELOPE_SCHEMA_VERSION,
    software: softwareInfo(),
    hardware: hardwareInfo(),
    config: bench?.config ?? { note: "no bench attached (manifest-only run)" },
    mode: {
      mcp: "observe",
      mcp_note: "the MCP layer only observes and reports judgments; it never acts, under every policy mode",
      policy: process.env.LAYA_MODE ?? "observe (default)",
      policy_note: "effective global policy-decision mode resolution input (verbatim env or default)",
    },
    method: bench?.method ?? "n/a (manifest-only run; see evals/bench.mjs BENCH_METHOD for bench runs)",
    gold_corpus: goldCorpusCounts(),
    gold_corpus_note:
      "provenance census (case gold_source wins, else the suite goldSource default): " +
      "independent golds carry human-fixed truth (spike-grade: a live backend is judged against them), " +
      "oracle-stub golds were written together with their stub answers (plumbing-grade: live mismatches " +
      "measure backend-vs-oracle divergence, never backend quality)",
    honesty: [
      "absolutes only; no cross-machine comparison; no improvement claimed (no baseline exists)",
      "stub ceiling: numbers measure harness + handler plumbing, never backend quality",
      "thresholds untouched (CERO cambios en src/); wrong_confident taus remain reporting slices, never prod cutoffs",
    ],
    links: {
      bench: bench ? { primitives: bench.primitives?.length ?? null, rerank_rows: bench.rerank_sweep?.length ?? null } : null,
      metrics: metrics ? { suites: metrics.suites?.length ?? null } : null,
    },
  };
}

/**
 * Spike S4: score the rerank/find suites through the connected Qwen lane
 * (live deps with a ready rerank sidecar). Per case: invoke via the suite
 * adapter (which routes to Qwen when rerankReady), check against the case
 * gold, record pass/threw + the judged output. Pure data for the
 * manifest spike_qwen block; it never changes what run/score/bench
 * execute. Independent golds judge the backend; oracle-stub mismatches
 * measure backend-vs-oracle divergence (documented, not failure).
 */
export async function scoreRerankFindLive(deps) {
  const suites = [findSuite, rerankSuite];
  const cases = [];
  for (const suite of suites) {
    for (const c of suite.cases) {
      const capture = {};
      try {
        const body = await suite.invoke(deps, c.input, c.stub, capture);
        if (c.expectError) {
          cases.push({ suite: suite.name, id: c.id, kind: c.kind, gold_source: c.gold_source ?? suite.goldSource ?? "oracle-stub", pass: false, threw: false, detail: `expected throw /${c.expectError}/ but got output` });
        } else {
          let actual = null;
          try {
            actual = suite.check(body, c.gold);
            cases.push({ suite: suite.name, id: c.id, kind: c.kind, gold_source: c.gold_source ?? suite.goldSource ?? "oracle-stub", pass: true, threw: false, actual });
          } catch (err) {
            cases.push({ suite: suite.name, id: c.id, kind: c.kind, gold_source: c.gold_source ?? suite.goldSource ?? "oracle-stub", pass: false, threw: false, actual, detail: String(err?.message ?? err).split("\n").slice(0, 3).join(" | ") });
          }
        }
      } catch (err) {
        if (c.expectError && String(err?.message ?? err).includes(c.expectError)) {
          cases.push({ suite: suite.name, id: c.id, kind: c.kind, gold_source: c.gold_source ?? suite.goldSource ?? "oracle-stub", pass: true, threw: true, actual: { threw: c.expectError } });
        } else {
          cases.push({ suite: suite.name, id: c.id, kind: c.kind, gold_source: c.gold_source ?? suite.goldSource ?? "oracle-stub", pass: false, threw: true, detail: String(err?.message ?? err).split("\n").slice(0, 3).join(" | ") });
        }
      }
    }
  }
  const ind = cases.filter((r) => r.gold_source === "independent");
  const indPass = ind.filter((r) => r.pass).length;
  return {
    lane: "qwen-rerank (rerank suite direct + find via argmax-over-rerank-scores; see evals/suites/rerank.mjs + find.mjs S4 notes)",
    cases: cases.length,
    passed: cases.filter((r) => r.pass).length,
    threw: cases.filter((r) => r.threw && !r.pass).length,
    independent: { n: ind.length, passed: indPass, ids: ind.map((r) => `${r.suite}/${r.id}:${r.pass ? "pass" : "FAIL"}`) },
    honesty: "independent golds judge the backend (human-fixed truth); oracle-stub mismatches measure backend-vs-oracle divergence, never backend quality",
    rows: cases,
  };
}
/** Capture the T4 score report via subprocess (reuses score.mjs untouched).
 * `live: true` passes --live through so a live bench saves paired live
 * metrics; the stub default captures the stub report as before. */
export function captureScoreMetrics({ live = false } = {}) {
  const argv = [path.join(repoRoot, "evals", "score.mjs"), "--json"];
  if (live) argv.push("--live");
  const out = execFileSync(process.execPath, argv, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** Next free version under dir (v1, v2, ...). Never reuses an existing one. */
export function nextVersion(dir = RESULTS_DIR_DEFAULT) {
  let n = 1;
  while (fs.existsSync(path.join(dir, `v${n}`))) n++;
  return `v${n}`;
}

/**
 * Save one versioned run: dir/vN/{manifest.json,bench.json,metrics.json}.
 * NEVER overwrites: the version directory is created non-recursively and an
 * EEXIST races to the next free version. Returns { version, path }.
 */
export function saveRun({ manifest, bench, metrics }, { dir = RESULTS_DIR_DEFAULT } = {}) {
  if (!manifest || !bench || !metrics) throw new Error("saveRun needs { manifest, bench, metrics } (all three; no partial runs)");
  fs.mkdirSync(dir, { recursive: true });
  let version = nextVersion(dir);
  let runDir = path.join(dir, version);
  while (true) {
    try {
      fs.mkdirSync(runDir, { recursive: false });
      break;
    } catch (err) {
      if (err?.code === "EEXIST") {
        version = nextVersion(dir);
        runDir = path.join(dir, version);
        continue;
      }
      throw err;
    }
  }
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(runDir, "bench.json"), JSON.stringify(bench, null, 2));
  fs.writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  return { version, path: runDir };
}

const args = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const asJson = args.includes("--json");
  if (args.includes("--save")) {
    const { runBench } = await import("./bench.mjs");
    const { connectLiveBackend, isLiveEnabled, makeLiveDeps, resolveLiveBackend } = await import("./live-client.mjs");
    let live = null;
    let backend = null;
    if (isLiveEnabled(args, process.env)) {
      backend = await resolveLiveBackend({ argv: args, env: process.env });
      if (!backend.reachable) {
        console.error(`\nmanifest --live refused: backend unreachable at ${backend.baseUrl ?? "unknown"} (${backend.error ?? "no probe result"}). Start laya-server or run the stub default (no --live).`);
        process.exit(2);
      }
      const { client, gliner, rerank } = await connectLiveBackend({ baseUrl: backend.baseUrl, glinerUrl: backend.glinerUrl, rerankUrl: backend.rerankUrl });
      live = { backend, deps: makeLiveDeps({ client, gliner, rerank }), client };
    }
    const bench = await runBench({}, live);
    const metrics = captureScoreMetrics({ live: live !== null });
    const manifest = await buildManifest({ bench, metrics, backend: bench.backend });
    // Spike S4: when the Qwen sidecar was probed reachable, score the
    // rerank/find suites through it and version the pass inside the
    // manifest (independent golds judge; oracle-stub mismatches are
    // backend-vs-oracle divergence, never quality).
    if (live !== null && backend.rerank?.reachable === true) {
      manifest.spike_qwen = await scoreRerankFindLive(live.deps);
    }
    const saved = saveRun({ manifest, bench, metrics });
    if (asJson) console.log(JSON.stringify({ saved, manifest }, null, 2));
    else {
      console.log(`saved versioned run: ${saved.path} (manifest.json + bench.json + metrics.json; never overwritten)`);
      console.log(`commit=${manifest.commit_short} date=${manifest.date} model=${manifest.model} revision=${manifest.model_revision} tokenizer=${manifest.tokenizer}`);
    }
  } else {
    let backend = null;
    const { isLiveEnabled, resolveLiveBackend } = await import("./live-client.mjs");
    if (isLiveEnabled(args, process.env)) {
      backend = await resolveLiveBackend({ argv: args, env: process.env });
      if (!backend.reachable) {
        console.error(`\nmanifest --live refused: backend unreachable at ${backend.baseUrl ?? "unknown"} (${backend.error ?? "no probe result"}). Start laya-server or run the stub default (no --live).`);
        process.exit(2);
      }
    }
    const manifest = await buildManifest({ backend });
    if (asJson) console.log(JSON.stringify(manifest, null, 2));
    else {
      console.log("\nFase-7 T5 manifest (this tree; stub-run honest values):");
      for (const [k, v] of Object.entries(manifest)) {
        if (typeof v === "object" && v !== null) console.log(`- ${k}: ${JSON.stringify(v).slice(0, 160)}`);
        else console.log(`- ${k}: ${v}`);
      }
    }
  }
}
