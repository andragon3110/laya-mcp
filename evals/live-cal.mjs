/**
 * fut-a-calibracion T2 — LIVE calibration runner: the 11 eval suites against
 * the REAL backend (laya-server + gliner-server over HTTP), no oracle stub.
 *
 * SCOPE (calibration only): run every suite case against the real handlers
 * (from dist/) with live judgments, compare each output against its gold,
 * and report per-primitive accuracy / abstention / wrong_confident slices
 * (same SIGNAL_MAP and denominators as evals/score.mjs) PLUS reliability
 * diagnostics (Brier + ECE over live (signal, outcome) pairs) where a
 * binary outcome with a scalar signal exists. No thresholds, no policies,
 * no src/ changes: measure only.
 *
 * SIGNAL MAP (inherits score.mjs; compare joins the winner_probability row):
 *   classify/decide/find/extract/compare -> winner_probability
 *   verify/gate  -> per-claim support signal (noul)
 *   screen       -> injection signal | review -> safe_to_apply signal
 *   pii          -> max detector_score (null when zero findings -> excluded)
 *   rerank       -> NO APLICA (within-call only, no correctness value).
 * Full choice-dict distributions: NO APLICA (raw shares, not calibrated
 * probabilities; no scoring rule over the full distribution is computed).
 *
 * DENOMINATORS (same as score.mjs; nulls/abstentions/throws out, counts
 * always reported). Judgments pool across passes: N per primitive is the
 * pooled scored-judgment count (cases x passes minus exclusions).
 *
 * Backend endpoints come from --laya/--gliner (default 127.0.0.1:8765/8766).
 * The runner probes /ready on both servers first and aborts (exit 2, no
 * data written) unless both report ready=true. Cold-start timings and venv
 * facts are NOT probed here: pass them via --env-file (JSON) so the saved
 * manifest records the real boot evidence measured at boot time.
 *
 * Saves one versioned run via evals/manifest.mjs saveRun (never overwrites)
 * plus live-cases.json (per-case signal/verdict/latency rows) and
 * env-facts.json (verbatim copy of --env-file) inside the version dir.
 *
 * Run from the repo root (backends already up):
 *   node evals/live-cal.mjs [--passes N] [--laya URL] [--gliner URL]
 *                           [--env-file PATH] [--json]
 * Exit 0 with honest data (gold mismatches are findings, not failures);
 * exit 2 on backend-not-ready / infra errors.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
import { extractJudgments } from "./score.mjs";
import {
  WRONG_CONFIDENT_TAUS,
  abstentionStats,
  binaryMetrics,
  brierScore,
  decisionAccuracy,
  ece,
  meanRanking,
  rankingMetrics,
  wrongConfident,
} from "./metrics.mjs";
import { buildManifest, saveRun } from "./manifest.mjs";
import { LayaClient } from "../dist/client.js";
import { GlinerClient } from "../dist/gliner.js";

const SUITES = [classify, decide, verify, screen, pii, extract, find, rerank, review, gate, compare];
const FAMILY = { rerank: "ranking", review: "agreement", gate: "agreement" };

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const flagVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const PASSES = Math.max(1, Number(flagVal("--passes", "1")) || 1);
const LAYA_URL = flagVal("--laya", process.env.LAYA_URL ?? "http://127.0.0.1:8765");
const GLINER_URL = flagVal("--gliner", process.env.GLINER_URL ?? "http://127.0.0.1:8766");
const ENV_FILE = flagVal("--env-file", null);

const laya = new LayaClient(LAYA_URL);
const glinerCli = new GlinerClient(GLINER_URL);

/** Live deps: same { fakeClient, makePiiCtx } shape the suites expect. */
function makeLiveDeps(serverMs) {
  return {
    fakeClient: (_answers, capture) => ({
      predict: async (...pargs) => {
        if (capture) capture.questions = pargs[1];
        const res = await laya.predict(...pargs);
        serverMs.laya += Number(res.latencyMs ?? 0);
        return res;
      },
    }),
    // The real sidecar client behind the ToolContext shape (glinerReady was
    // verified true by the /ready probe before any case runs).
    makePiiCtx: () => ({
      glinerReady: () => true,
      gliner: {
        piiScan: async (text, extra) => {
          const res = await glinerCli.piiScan(text, extra);
          serverMs.gliner += Number(res.latencyMs ?? 0);
          return res;
        },
        extractEntities: (text, labels) => glinerCli.extractEntities(text, labels),
      },
    }),
  };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function runCaseLive(suite, c, pass) {
  const capture = {};
  const serverMs = { laya: 0, gliner: 0 };
  const liveDeps = makeLiveDeps(serverMs);
  const t0 = performance.now();
  try {
    const body = await suite.invoke(liveDeps, c.input, c.stub, capture);
    const wallMs = performance.now() - t0;
    if (c.expectError) {
      return {
        pass, suite: suite.name, id: c.id, kind: c.kind, threw: false,
        expectedThrow: c.expectError, goldMatch: false,
        detail: `expected throw /${c.expectError}/ but got output`,
        wallMs, serverMs,
      };
    }
    let goldOut = null;
    let goldMatch = true;
    let detail = null;
    try {
      goldOut = suite.check(body, c.gold);
    } catch (err) {
      goldMatch = false;
      detail = String(err?.message ?? err).split("\n").slice(0, 3).join(" | ");
    }
    const ext = extractJudgments(suite.name, body, c.gold);
    return {
      pass, suite: suite.name, id: c.id, kind: c.kind, threw: false,
      abstained: body.abstention.abstained === true,
      decisionActual: body.decision.decision ?? null,
      decisionGold: c.gold.decision ?? null,
      taskActual: ext.taskActual ?? null,
      taskGold: ext.taskGold ?? null,
      judgments: ext.judgments.map((j) => ({ correct: j.correct, signal: j.signal ?? null })),
      goldMatch, detail, goldOut, wallMs, serverMs,
    };
  } catch (err) {
    const wallMs = performance.now() - t0;
    const msg = String(err?.message ?? err);
    if (c.expectError && msg.includes(c.expectError)) {
      return {
        pass, suite: suite.name, id: c.id, kind: c.kind, threw: true,
        expectedThrow: c.expectError, goldMatch: true, wallMs, serverMs,
      };
    }
    return {
      pass, suite: suite.name, id: c.id, kind: c.kind, threw: true,
      expectedThrow: c.expectError ?? null, goldMatch: false,
      detail: msg.split("\n").slice(0, 4).join(" | "),
      backendError: err?.name ?? "Error", wallMs, serverMs,
    };
  }
}

function scoreSuiteLive(suite, rows) {
  const scored = rows.filter((r) => !r.threw);
  const family = FAMILY[suite.name] ?? "binary";
  const out = {
    suite: suite.name,
    primitive: suite.primitive,
    family,
    passes: PASSES,
    casesPerPass: suite.cases.length,
    caseRows: rows.length,
    goldMatch: {
      matched: rows.filter((r) => r.goldMatch).length,
      mismatched: rows.filter((r) => !r.goldMatch && !r.threw).length,
      threw: rows.filter((r) => r.threw).length,
    },
    accuracyVsGold: null,
    abstention: abstentionStats(
      rows.map((r) => ({ threw: r.threw === true, abstained: r.abstained === true })),
    ),
    decision: decisionAccuracy(
      scored.filter((r) => r.decisionGold !== null && r.decisionGold !== undefined)
        .map((r) => ({ actual: r.decisionGold, predicted: r.decisionActual })),
    ),
    latencyMs: {
      wallMean: rows.length === 0 ? null : rows.reduce((s, r) => s + r.wallMs, 0) / rows.length,
      serverLayaMean: rows.length === 0 ? null : rows.reduce((s, r) => s + r.serverMs.laya, 0) / rows.length,
      serverGlinerMean: rows.length === 0 ? null : rows.reduce((s, r) => s + r.serverMs.gliner, 0) / rows.length,
    },
  };
  const matchedScored = rows.filter((r) => !r.threw);
  const denom = matchedScored.length;
  out.accuracyVsGold = denom === 0 ? null : matchedScored.filter((r) => r.goldMatch).length / denom;
  const judged = scored.filter((r) => !r.abstained && r.decisionGold !== null && r.decisionGold !== undefined);
  if (family === "ranking") {
    const ranked = scored.filter((r) => !r.abstained && Array.isArray(r.taskGold));
    out.ranking = {
      n: ranked.length,
      excluded_abstained_or_throw: scored.length - ranked.length + (rows.length - scored.length),
      ...meanRanking(ranked.map((r) => rankingMetrics(r.taskActual, r.taskGold))),
    };
    out.wrong_confident = { status: "no aplica", reason: "relevance_score is within-call only by contract (never comparable across calls); a single score has no correctness value, so no tau slice is meaningful." };
    out.reliability = { status: "no aplica", reason: "rerank emits no binary outcome with a scalar signal; MRR/nDCG over orders is the quality measure. Full-distribution scoring is not computed (raw shares, not calibrated probabilities)." };
  } else {
    const taskRows = scored.filter((r) => {
      const g = r.taskGold;
      return g !== null && g !== undefined;
    });
    const taskCorrect = taskRows.filter((r) => eq(r.taskActual, r.taskGold)).length;
    out.task = { n: taskRows.length, correct: taskCorrect, accuracy: taskRows.length === 0 ? null : taskCorrect / taskRows.length };
    if (family === "binary") {
      out.binary_allow_polarity = binaryMetrics(
        judged.map((r) => ({ actual: r.decisionGold === "ALLOW", predicted: r.decisionActual === "ALLOW" })),
      );
    } else {
      out.score_agreement = { status: "no computable (gold)", reason: "golds hold decisions, not rubric-score oracles; live judgments add no score oracle either." };
    }
    const judgments = scored.flatMap((r) => (r.judgments ?? []).map((j) => ({ ...j, threw: false, abstained: r.abstained })));
    const signalLabel =
      suite.name === "screen" ? "injection signal"
      : suite.name === "review" ? "safe_to_apply signal"
      : suite.name === "pii" ? "max detector_score"
      : suite.name === "gate" || suite.name === "verify" ? "per-claim support signal"
      : "winner_probability";
    out.wrong_confident = { signal: signalLabel, taus: WRONG_CONFIDENT_TAUS, ...wrongConfident(judgments) };
    const scoredPairs = judgments
      .filter((j) => !j.threw && !j.abstained && typeof j.signal === "number")
      .map((j) => ({ signal: j.signal, correct: j.correct }));
    out.reliability = {
      signal: signalLabel,
      n: scoredPairs.length,
      excluded: out.wrong_confident.excluded ?? null,
      brier: brierScore(scoredPairs).brier,
      ...(() => {
        const e = ece(scoredPairs, 10);
        return { ece: e.ece, eceBins: e.binsDetail, eceClamped: e.clamped };
      })(),
      distributions: "no aplica: full choice-dict distributions are raw shares, not calibrated probabilities; no scoring rule over the full distribution is computed.",
    };
  }
  return out;
}

async function main() {
  // 1. Readiness probe on both backends (no stub fallback, no fake data).
  let layaReady;
  let glinerReady;
  try {
    layaReady = await laya.ready(5000);
    glinerReady = await glinerCli.ready(5000);
  } catch (err) {
    console.error(`live-cal: backend probe failed: ${String(err?.message ?? err)}`);
    process.exit(2);
  }
  if (!layaReady.ready || !glinerReady.ready) {
    console.error(
      `live-cal: backend not ready (laya ready=${layaReady.ready} reason=${layaReady.reason} | gliner ready=${glinerReady.ready} reason=${glinerReady.reason}); refusing to record stub data.`,
    );
    process.exit(2);
  }
  let layaModels = [];
  let glinerModels = [];
  try {
    layaModels = await laya.models(5000);
    glinerModels = await glinerCli.models(5000);
  } catch (err) {
    console.error(`live-cal: /models probe failed: ${String(err?.message ?? err)}`);
    process.exit(2);
  }

  // 2. N passes over all suites.
  const allRows = [];
  for (let p = 1; p <= PASSES; p++) {
    for (const suite of SUITES) {
      for (const c of suite.cases) {
        const row = await runCaseLive(suite, c, p);
        allRows.push(row);
        if (!asJson) {
          const mark = row.threw ? (row.goldMatch ? "throw-ok" : "THROW") : row.goldMatch ? "ok" : "DIFF";
          console.log(`${mark} - pass${p} ${suite.name}/${row.id} [${row.kind}] wall=${row.wallMs.toFixed(0)}ms${row.detail ? ` :: ${row.detail}` : ""}`);
        }
      }
    }
  }

  // 3. Per-suite scoring (pooled across passes).
  const suitesOut = SUITES.map((suite) =>
    scoreSuiteLive(suite, allRows.filter((r) => r.suite === suite.name)),
  );
  const metrics = {
    generated: "fut-a-calibracion T2 (LIVE backend judgments + real handlers; reliability diagnostics, never thresholds)",
    passes: PASSES,
    taus: WRONG_CONFIDENT_TAUS,
    taus_note: "reporting slices only; NEVER production thresholds (see evals/calibration.md)",
    reliability_note: "Brier/ECE are miscalibration diagnostics over live (signal, outcome) pairs; signals stay uncalibrated and no value below is a probability.",
    suites: suitesOut,
  };

  // 4. Bench-notes (this run is a measurement, not a benchmark) + manifest.
  let envFacts = { note: "no --env-file given; boot evidence not recorded by the runner" };
  if (ENV_FILE) {
    envFacts = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
  }
  const bench = {
    note: "live calibration measurement (bench-notas): no throughput/latency benchmark was run; per-case wall/server latencies live in live-cases.json as absolutes.",
    config: {
      passes: PASSES,
      layaUrl: LAYA_URL,
      glinerUrl: GLINER_URL,
      seed: "none (live backend; Router judgments are deterministic, latencies vary)",
    },
    coldStarts: envFacts.coldStarts ?? null,
    venv: envFacts.venv ?? null,
    method: "each suite case invoked against the real handler with live backend judgments; judgments pooled across passes; gold comparison via each suite check(); reliability over pooled (signal, correct) pairs with the score.mjs SIGNAL_MAP.",
  };
  const base = await buildManifest({ bench, metrics });
  const repos = (ms) => [...new Set(ms.map((m) => m.repo).filter(Boolean))];
  const manifest = {
    ...base,
    generated: "fut-a-calibracion T2 LIVE reproducibility manifest (real backend judgments; absolutes + method, no improvement claims)",
    model: `live Router checkpoints (${repos(layaModels).join(", ") || "unknown repos"}) + live GLiNER sidecar (${repos(glinerModels).join(", ") || "unknown repo"})`,
    model_note: "live backends probed via /models; no stub id involved",
    model_revision: null,
    model_revision_note: "honest null: the servers report revision_source unpinned (pins not resolvable offline); a hash is never invented",
    device: `laya-server=${layaReady.device ?? "unknown"} gliner-server=${glinerReady.device ?? "unknown"}`,
    device_note: "probed LIVE via /ready on both backends at run start (never asserted, never defaulted)",
    layaReady,
    glinerReady,
    layaModels,
    glinerModels,
    envFacts,
    honesty: [
      "live judgments on the eval golds; gold mismatches are backend findings, never harness failures",
      "signals stay uncalibrated: Brier/ECE diagnose miscalibration, they do not certify probabilities",
      "thresholds untouched (CERO cambios en src/); wrong_confident taus remain reporting slices, never prod cutoffs",
    ],
  };

  const saved = saveRun({ manifest, bench, metrics });
  const casesPath = path.join(saved.path, "live-cases.json");
  fs.writeFileSync(casesPath, JSON.stringify({ generated: metrics.generated, passes: PASSES, rows: allRows }, null, 2));
  if (ENV_FILE) {
    fs.writeFileSync(path.join(saved.path, "env-facts.json"), JSON.stringify(envFacts, null, 2));
  }

  if (asJson) {
    console.log(JSON.stringify({ saved, metrics }, null, 2));
  } else {
    console.log(`\nlive-cal: ${allRows.length} case rows (${PASSES} pass(es) x 88 cases)`);
    console.log("| suite | passes*N | goldMatch | task_acc | abst | wc@0.80 | brier | ece |");
    console.log("|-------|----------|-----------|----------|------|---------|-------|-----|");
    const fmt = (v) => (v === null || v === undefined ? "n/a" : typeof v === "number" ? v.toFixed(3) : String(v));
    for (const s of suitesOut) {
      const wc = s.wrong_confident?.slices ? fmt(s.wrong_confident.slices[1].rate) : "n/a";
      const br = s.reliability?.brier !== undefined ? fmt(s.reliability.brier) : "n/a";
      const ec = s.reliability?.ece !== undefined ? fmt(s.reliability.ece) : "n/a";
      console.log(`| ${s.suite} | ${s.caseRows} | ${fmt(s.accuracyVsGold)} | ${s.task ? fmt(s.task.accuracy) : s.ranking ? `MRR ${fmt(s.ranking.mrr)}` : "n/a"} | ${fmt(s.abstention.abstention_rate)} | ${wc} | ${br} | ${ec} |`);
    }
    console.log(`saved versioned run: ${saved.path} (manifest.json + bench.json + metrics.json + live-cases.json; never overwritten)`);
  }
}

await main();
