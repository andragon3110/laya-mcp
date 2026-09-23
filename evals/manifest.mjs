/**
 * Fase-7 T5 reproducibility manifest + versioned results writer.
 *
 * SCOPE (T5 only): per-run manifest (model/revision/tokenizer/policy/schema/
 * software/hardware/device/config/mode + date + git commit) and the
 * never-overwrite versioned saver for evals/results/vN/ (manifest.json +
 * bench.json + metrics.json). No benchmarks (bench.mjs), no metrics (T4),
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const require = createRequire(path.join(repoRoot, "package.json"));

export const RESULTS_DIR_DEFAULT = path.join(repoRoot, "evals", "results");

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
 */
export async function buildManifest({ bench = null, metrics = null } = {}) {
  const git = gitCommit();
  return {
    generated: "fase-7 T5 reproducibility manifest (stub run; absolutes + method, no improvement claims)",
    date: new Date().toISOString(),
    commit: git.commit,
    commit_short: git.short,
    ...(git.note ? { commit_note: git.note } : {}),
    model: bench ? "evals-bench-stub" : "evals-oracle-stub",
    model_note: "no real model involved; stub id only (T3/T4 canonicals use evals-oracle-stub, bench runs use evals-bench-stub)",
    model_revision: null,
    model_revision_note: "honest null: stubs resolve no pin (cf. capabilities revision_source unpinned; a hash is never invented)",
    tokenizer: "unknown",
    tokenizer_note: "explicit unknown: laya_capabilities exposes name/repo/loaded/revision/device/circuit per model, never a tokenizer",
    device: "unknown (stub run; no live backend)",
    device_note: "capabilities reports backend.device / models[].device probed LIVE; nothing was probed in this run",
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

/** Capture the T4 score report via subprocess (reuses score.mjs untouched). */
export function captureScoreMetrics() {
  const out = execFileSync(process.execPath, [path.join(repoRoot, "evals", "score.mjs"), "--json"], {
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
    const bench = await runBench();
    const metrics = captureScoreMetrics();
    const manifest = await buildManifest({ bench, metrics });
    const saved = saveRun({ manifest, bench, metrics });
    if (asJson) console.log(JSON.stringify({ saved, manifest }, null, 2));
    else {
      console.log(`saved versioned run: ${saved.path} (manifest.json + bench.json + metrics.json; never overwritten)`);
      console.log(`commit=${manifest.commit_short} date=${manifest.date} model=${manifest.model} revision=${manifest.model_revision} tokenizer=${manifest.tokenizer}`);
    }
  } else {
    const manifest = await buildManifest();
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
