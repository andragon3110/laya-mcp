/**
 * bench-ronda3 G2 (R3T3+R3T4): versioned lane smoke + live screen matrix
 * for the 3 G2 binary-guard sidecars (horizon :8777, galvanize :8778,
 * mdeberta-es :8780) plus the laya-multilingual baseline (:8765,
 * unmodified server) in EVERY table.
 *
 * COVERAGE (honest, no fake mapping): screen is the home lane -- a pure
 * injection binary cannot do relevance ranking, claim gating, or topic
 * classification. The G2 harness therefore serves ONLY the screen lane
 * through the guards; classify / gate / rerank / find are recorded as
 * documented gaps (manifest `coverage.gaps` + spike S3), never faked.
 * The sidecars themselves answer POST /predict {text, labels} on a
 * synonym axis (injection/safe labels score the binary head, everything
 * else scores 0.0 -- see each py/*_server.py), so the transport is
 * contract-generic; the lane policy is what refuses the other four.
 *
 * MODES:
 *   node evals/smoke-r3g2-lanes.mjs [--live]
 *     Versioned smoke: 5 r1 screen cases (EN/ES normal + EN/ES
 *     adversarial + EN ambiguous) x 3 G2 guards = 15 live cases,
 *     asserting the score.mjs screen result shape + exit 0. (--live is
 *     an explicit alias: smoke is always live; there is no stub path.)
 *   node evals/smoke-r3g2-lanes.mjs --matrix [--out <dir>] [--model <m>]
 *     Live screen matrix: r1 screen (12) + v2 screen (32) per backend
 *     (horizon, galvanize, mdeberta, laya-baseline), same oracles + same
 *     scoring (scoreIndependentDecision, the same fn score.mjs --corpus
 *     r1 uses) + same 60s CPU timeout budget for EVERY backend incl.
 *     laya. Output: <out>/<model>/{manifest,metrics,composed}.json per
 *     model (default out evals/results/v22-g2-matrix/). Refuses to
 *     overwrite a non-empty model dir (new version per run, never
 *     silently; never touches v1-v21*).
 *
 * EXIT CODES: 0 green/measured (misses are DATA, never a failure); 2
 * backend refused (sidecar down -- probe refusal, never a silent stub) or
 * overwrite refusal; 1 any other failure (shape/assert/IO).
 * This script never starts a server and never builds a venv: boot the G2
 * sidecars first with py/.venv-r3g2 (ports 8777/8778/8780) + laya :8765.
 *
 * MEASUREMENT, NOT PROMOTION: thresholds OFF (pure argmax +
 * omit-on-null, no margin m, no tau -- no validated tau exists for these
 * binary heads; tuning is Fase-2 work on validation data, NEVER on
 * r1/v2). Fixed argmax->handler-band magnitudes sit at the public policy
 * band centers (see G1ChoiceClient in evals/lanes-r1.mjs, inherited
 * verbatim: screen 0.92/0.5/0.1 vs 0.75/0.25), chosen a priori, never
 * from r1/v2 outcomes. Per-case rows carry raw backend scores + margins
 * for threshold design; verdicts never read them. Sharpness is NOT
 * calibration: reliability INPUTS (signal+correctness pairs + bin
 * counts) are recorded for diagrams, but no ECE / Brier / P/R is
 * computed and no probability is claimed (metrics.mjs honesty rule).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GliclassClient,
  lanePredictFactory,
} from "./lanes-r1.mjs";
import {
  probeSidecar,
  resolveLaneBaseUrl,
  resolveBackendRevisions,
  LIVE_CLIENT_DEFAULTS,
} from "./live-client.mjs";
import { r1CasesFor } from "./corpus-index.mjs";
import {
  WRONG_CONFIDENT_TAUS,
  abstentionStats,
  scoreIndependentDecision,
  wrongConfident,
} from "./metrics.mjs";
import * as screen from "./suites/screen.mjs";
import * as v2screen from "./corpus-v2/screen.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

/** G2 model inventory (setup-time facts from spike S1/S2; the sidecars
 *  themselves report revision null + unpinned, never a hash). */
const MODELS = {
  horizon: { repo: "Horizon-Labs/prompt-injection-guard-small", sha: "e0e88c4e940ee7e1b52bdf943d501ec696b83b9b", port: 8777, server: "py/horizon_guard_server.py" },
  galvanize: { repo: "usezn/Galvanize-60M", sha: "7bf8df0d3c9cd724c5773a1c73d7c81ebb0f2082", port: 8778, server: "py/galvanize_server.py" },
  mdeberta: { repo: "edithngalame/mdeberta-v3-prompt-injection-en-es", sha: "04afb3c60e2ce15b8a3717a654a252226ab3f2e4", port: 8780, server: "py/mdeberta_es_server.py" },
  laya: { repo: "convaiinnovations/laya-multilingual", sha: null, port: 8765, server: "py/laya_server.py (unmodified v0.4.0)" },
};
const G2_BACKENDS = ["horizon", "galvanize", "mdeberta"];
const MATRIX_BACKENDS = ["horizon", "galvanize", "mdeberta", "laya"];
const OUT_SUBDIR = { horizon: "horizon", galvanize: "galvanize", mdeberta: "mdeberta", laya: "laya-baseline" };

/** Uniform lane caller budget for the G2 matrix (task-mandated 60s CPU,
 *  identical for guards AND the laya baseline). */
const G2_CALL_TIMEOUT_MS = 60000;

/** Versioned smoke pins: 5 r1 screen cases (EN/ES normal + EN/ES
 *  adversarial + EN ambiguous) x 3 guards = 15 live cases. */
const SMOKE_CASES = [
  "r1-screen-en-normal-01",
  "r1-screen-es-normal-01",
  "r1-screen-en-adversarial-01",
  "r1-screen-es-adversarial-01",
  "r1-screen-en-ambiguous-01",
];

const SCREEN_ASSESSMENTS = new Set(["valid", "ambiguous", "irrelevant", "malicious-instruction"]);

/** Primitives a pure injection binary cannot cover (recorded, not run). */
const COVERAGE_GAPS = {
  classify: "binary SAFE/INJECTION head has no topic axis: non-screen labels score 0.0 server-side, so argmax would fake a verdict -- lane refused, gap recorded.",
  gate: "binary head has no SUPPORTED/CONTRADICTED/ABSTAIN notion: all three gate labels score 0.0, first-max would fake SUPPORTED -- lane refused, gap recorded.",
  rerank: "binary head has no relevance notion: candidate texts cannot be ordered -- lane refused, gap recorded.",
  find: "binary head has no query/candidate matching notion -- lane refused, gap recorded.",
};

const round1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);
const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

/**
 * bench-ronda3 G2 (R3T3): binary-guard lane client. Inherits the G1
 * L1/L2 screen adjudication VERBATIM from GliclassClient (same POST
 * /predict contract, same [benign, suspicious, malicious] label set,
 * same argmax->band magnitudes at the public policy centers, same
 * 0.9/0.9 substance/relevance prior) -- the ONLY overrides are the
 * scoring transport (per-guard baseUrl + error prefix + 60s G2 budget),
 * the model tag, the routing taus (both OFF: pure-argmax first
 * measurement; no validated tau exists for these binary heads), and the
 * coverage rule below. The sidecar maps benign->1-p / malicious->p /
 * suspicious->0.0, so lane-side argmax over the three labels reduces to
 * a benign/malicious binary (documented in each server file).
 *
 * Coverage: screen-shaped questions (is_injection) ONLY. Any other shape
 * (classify/gate/rerank/find question dicts) THROWS an explicit gap
 * error -- the harness records the gap instead of faking a mapping.
 */
class G2GuardClient extends GliclassClient {
  constructor(baseUrl, modelTag) {
    if (!G2_BACKENDS.includes(modelTag)) {
      throw new Error(`G2GuardClient needs a G2 model tag (${G2_BACKENDS.join("/")}), got ${JSON.stringify(modelTag)}`);
    }
    super(baseUrl);
    this.modelTag = modelTag;
    this.gateMarginTau = null;
    this.screenMarginTau = null;
  }

  async scoreLabels(text, labels, { timeoutMs = G2_CALL_TIMEOUT_MS } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ text, labels }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body?.detail === "string" ? body.detail : (body?.code ?? res.status);
        throw new Error(`${this.modelTag}-server POST /predict returned HTTP ${res.status}: ${String(detail).slice(0, 200)}`);
      }
      if (!Array.isArray(body.scores)) {
        throw new Error(`${this.modelTag}-server returned invalid payload (missing scores[])`);
      }
      return { scores: body.scores, latencyMs: Number(body.latency_ms ?? 0) };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`${this.modelTag}-server`)) throw err;
      throw new Error(err?.name === "AbortError" ? `${this.modelTag}-server timed out after ${timeoutMs}ms` : `${this.modelTag}-server unreachable at ${this.baseUrl}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async predict(state, questions, opts) {
    const keys = Object.keys(questions ?? {});
    if (keys.length === 0) {
      return { answers: {}, confidence: {}, routing: {}, model: this.modelTag, latencyMs: 0, usage: {} };
    }
    if (Object.hasOwn(questions, "is_injection")) return this.predictScreen(state, questions, opts);
    const shape = keys.some((k) => k.startsWith("class_")) ? "classify"
      : keys.some((k) => k.startsWith("relevance_")) ? "rerank"
      : Object.hasOwn(questions, "exists") ? "find" : "gate";
    throw new Error(`${this.modelTag} lane gap (not served): ${shape} -- ${COVERAGE_GAPS[shape]}`);
  }
}

const G2_SERVICE = {
  horizon: "horizon-guard-server",
  galvanize: "galvanize-server",
  mdeberta: "mdeberta-es-server",
  laya: "laya-server",
};

function baseUrlFor(backend, env = process.env) {
  if (backend === "laya") return resolveLaneBaseUrl("screen", env);
  return `http://127.0.0.1:${MODELS[backend].port}`;
}

/**
 * Connect the screen lane x backend with the uniform G2 60s CPU budget,
 * or THROW the exit-2-style refusal (never a silent stub). Guards speak
 * POST /predict via G2GuardClient (screen-only); laya delegates to
 * dist/client.js LayaClient.
 */
async function connectG2(backend) {
  const baseUrl = baseUrlFor(backend);
  const probe = await probeSidecar({
    baseUrl,
    service: G2_SERVICE[backend] ?? backend,
    note: `${backend} sidecar unreachable at ${baseUrl}; screen x ${backend} refused (exit 2), never stubbed`,
    timeoutMs: LIVE_CLIENT_DEFAULTS.probeTimeoutMs,
  });
  if (!probe.reachable) {
    throw new Error(`screen x ${backend} refused (exit 2): ${probe.error} -- ${probe.note}`);
  }
  let client;
  if (G2_BACKENDS.includes(backend)) {
    client = new G2GuardClient(baseUrl, backend);
  } else if (backend === "laya") {
    const { LayaClient } = await import(pathToFileURL(path.join(repoRoot, "dist", "client.js")).href);
    client = new LayaClient(baseUrl);
  } else {
    throw new Error(`smoke-r3g2 serves backends ${[...G2_BACKENDS, "laya"].join("/")} only, got ${JSON.stringify(backend)}`);
  }
  return { probe, deps: { fakeClient: lanePredictFactory(client, G2_CALL_TIMEOUT_MS) }, client };
}

function refuseExit2(msg) {
  console.error(`REFUSED (exit 2): ${String(msg).split("\n")[0]}`);
  process.exit(2);
}

function assertSmokeShape(body) {
  const probs = [];
  if (!body || typeof body !== "object") probs.push("empty body");
  if (typeof body?.decision?.decision !== "string") probs.push("body.decision.decision not a string");
  if (typeof body?.abstention?.abstained !== "boolean") probs.push("body.abstention.abstained not boolean");
  if (!SCREEN_ASSESSMENTS.has(body?.assessment)) probs.push(`assessment outside known set: ${JSON.stringify(body?.assessment)}`);
  if (probs.length > 0) throw new Error(`smoke shape violation (screen): ${probs.join("; ")}`);
}

async function runSmoke() {
  console.log("r3g2-lanes smoke: 5 r1 screen cases x 3 G2 guards = 15 live cases (down -> exit 2, never stubbed)");
  let n = 0;
  for (const backend of G2_BACKENDS) {
    for (const caseId of SMOKE_CASES) {
      let conn;
      try {
        conn = await connectG2(backend);
      } catch (err) {
        refuseExit2(`screen x ${backend}: ${err.message}`);
      }
      const { probe, deps } = conn;
      const c = r1CasesFor("screen").find((x) => x.id === caseId);
      if (!c) throw new Error(`smoke case ${caseId} not found in r1 screen corpus`);
      const t0 = performance.now();
      const body = await screen.invoke(deps, c.input, c.stub, {});
      const wall = performance.now() - t0;
      assertSmokeShape(body);
      n++;
      console.log(
        `ok - screen x ${backend} / ${caseId}: decision=${body.decision.decision} ` +
        `assessment=${body.assessment} abstained=${body.abstention.abstained} ` +
        `injection_signal=${round1(body?.signals?.injection?.signal)} ` +
        `wall_ms=${round1(wall)} reported_latency_ms=${round1(body.latency_ms)} (device=${probe.device ?? "unreported"})`,
      );
    }
  }
  console.log(`smoke: ${n}/${G2_BACKENDS.length * SMOKE_CASES.length} screen lanes green (exit 0)`);
}

/** Live-signal judgments for wrong_confident (score.mjs SIGNAL_MAP):
 *  correct = the SAME scoreIndependentDecision the row scoring uses
 *  (decision AND task), so slices never disagree with the matrix. */
function judgmentsForGold(body, gold) {
  const s = scoreIndependentDecision("screen", body, gold);
  const correct = s.decisionOk && s.taskOk;
  const flag = body?.abstention?.abstained === true;
  const sig = body?.signals?.injection?.signal;
  return [{ correct, signal: typeof sig === "number" ? sig : null, abstained: flag, threw: false }];
}

/**
 * Reliability INPUTS for future diagrams (descriptive data only -- no ECE,
 * no Brier, no probability claim; metrics.mjs honesty rule; sharpness is
 * not calibration). 10 equal-width bins over the recorded signals.
 */
function reliabilityInputs(judgments) {
  const pts = judgments
    .filter((j) => !j.threw && !j.abstained && typeof j.signal === "number")
    .map((j) => ({ signal: j.signal, correct: j.correct }));
  const bins = Array.from({ length: 10 }, (_, i) => {
    const lo = i / 10, hi = (i + 1) / 10;
    const inBin = pts.filter((p) => (i === 9 ? p.signal >= lo && p.signal <= hi : p.signal >= lo && p.signal < hi));
    const acc = inBin.length === 0 ? null : inBin.filter((p) => p.correct).length / inBin.length;
    const avg = inBin.length === 0 ? null : inBin.reduce((a, p) => a + p.signal, 0) / inBin.length;
    return { bin: `[${lo.toFixed(1)},${hi.toFixed(1)}${i === 9 ? "]" : ")"}`, n: inBin.length, accuracy: acc, avg_signal: avg };
  });
  return {
    n: pts.length,
    points: pts,
    bins,
    ece_note: "inputs only: no ECE/Brier computed and no probability claimed (metrics.mjs honesty rule); guard sharpness is NOT calibration -- draw diagrams before any claim.",
  };
}

function gitCommit() {
  try {
    const full = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return { commit: full, commit_short: full.slice(0, 7) };
  } catch {
    return { commit: "unknown (git unavailable)", commit_short: "unknown" };
  }
}

function splitAcc(rows, key) {
  const acc = (pred) => {
    const sub = rows.filter(pred);
    const correct = sub.filter((r) => r[key]).length;
    return { n: sub.length, correct, accuracy: sub.length === 0 ? null : correct / sub.length };
  };
  return { all: acc(() => true), en: acc((r) => r.lang === "en"), es: acc((r) => r.lang === "es") };
}

function caseList(corpus) {
  if (corpus === "r1") return r1CasesFor("screen").map((c) => ({ ...c, corpus }));
  return (v2screen.cases ?? []).map((c) => ({ id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, input: c.input, gold: c.gold, stub: c.stub ?? { answers: {} }, corpus }));
}

async function runBackendMatrix(backend) {
  let conn;
  try {
    conn = await connectG2(backend);
  } catch (err) {
    refuseExit2(`screen x ${backend}: ${err.message}`);
  }
  const { probe, deps, client } = conn;
  const rows = [];
  const judgments = [];
  const walls = [];
  const reported = [];
  let reportedTotal = 0;
  for (const corpus of ["r1", "v2"]) {
    for (const c of caseList(corpus)) {
      if (client && typeof client.callLog !== "undefined") client.callLog = [];
      const t0 = performance.now();
      try {
        const body = await screen.invoke(deps, c.input, c.stub ?? { answers: {} }, {});
        const wall = performance.now() - t0;
        walls.push(wall);
        const rep = typeof body?.latency_ms === "number" ? body.latency_ms : null;
        if (rep !== null) { reported.push(rep); reportedTotal += rep; }
        const s = scoreIndependentDecision("screen", body, c.gold);
        judgments.push(...judgmentsForGold(body, c.gold));
        rows.push({
          corpus, id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: false,
          wall_ms: round1(wall), reported_latency_ms: rep === null ? null : round1(rep),
          n_calls: client && Array.isArray(client.callLog) ? client.callLog.length : null,
          abstained: body?.abstention?.abstained === true,
          decisionActual: body?.decision?.decision ?? null, decisionGold: c.gold.decision ?? null,
          taskActual: s.taskActual, taskGold: s.taskGold,
          decOk: s.decisionOk, taskOk: s.taskOk, abstOk: s.abstainedOk,
          judgments: [],
          calls: client && Array.isArray(client.callLog) ? client.callLog.map((e) => ({
            key: e.key, top: e.top, top_score: e.top_score, margin: e.margin,
            scores: e.scores, latency_ms: round1(e.latencyMs),
          })) : [],
        });
      } catch (err) {
        const wall = performance.now() - t0;
        walls.push(wall);
        judgments.push({ correct: false, signal: null, abstained: false, threw: true });
        rows.push({
          corpus, id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: true,
          wall_ms: round1(wall), reported_latency_ms: null, n_calls: null,
          error: String(err?.message ?? err).split("\n")[0],
          abstained: false, decisionActual: null, decisionGold: c.gold.decision ?? null,
          taskActual: null, taskGold: null, decOk: false, taskOk: false, abstOk: false,
          judgments: [], calls: [],
        });
      }
    }
  }
  const scored = rows.filter((r) => !r.threw);
  const dec = splitAcc(scored, "decOk");
  const task = splitAcc(scored, "taskOk");
  const r1rows = scored.filter((r) => r.corpus === "r1");
  const v2rows = scored.filter((r) => r.corpus === "v2");
  const lane = {
    laneBackend: backend, baseUrl: probe.baseUrl,
    cases: rows.length, threw: rows.length - scored.length,
    decision: dec.all, decision_en: dec.en, decision_es: dec.es,
    task: task.all, task_en: task.en, task_es: task.es,
    r1: {
      n: r1rows.length,
      decision: { n: r1rows.length, correct: r1rows.filter((r) => r.decOk).length },
      task: { n: r1rows.length, correct: r1rows.filter((r) => r.taskOk).length },
    },
    v2: {
      n: v2rows.length,
      decision: { n: v2rows.length, correct: v2rows.filter((r) => r.decOk).length },
      task: { n: v2rows.length, correct: v2rows.filter((r) => r.taskOk).length },
    },
    abstained: scored.filter((r) => r.abstained).length,
    abstention: abstentionStats(rows.map((r) => ({ threw: r.threw === true, abstained: r.abstained === true }))),
    abstention_rate: abstentionStats(rows.map((r) => ({ threw: r.threw === true, abstained: r.abstained === true }))).abstention_rate,
    wrong_confident: { signal: "injection signal", taus: WRONG_CONFIDENT_TAUS, ...wrongConfident(judgments) },
    reliability: reliabilityInputs(judgments),
    latency: {
      wall_ms_p50: round1(pct(walls, 0.5)), wall_ms_p95: round1(pct(walls, 0.95)),
      reported_ms_p50: round1(pct(reported, 0.5)), reported_ms_p95: round1(pct(reported, 0.95)),
      wall_ms_total: round1(walls.reduce((a, b) => a + b, 0)),
      reported_ms_total: round1(reportedTotal),
      wall_ms_per_case: walls.map(round1),
    },
    rows,
  };
  const w = lane.wrong_confident.slices
    ? lane.wrong_confident.slices.map((x) => `${x.tau}:${x.rate === null ? "n/a" : x.rate.toFixed(3)}`).join(" ") : "n/a";
  console.log(
    `| ${backend} screen | r1 dec ${lane.r1.decision.correct}/${lane.r1.n} task ${lane.r1.task.correct}/${lane.r1.n} | ` +
    `v2 dec ${lane.v2.decision.correct}/${lane.v2.n} task ${lane.v2.task.correct}/${lane.v2.n} | ` +
    `abst ${lane.abstained} threw ${lane.threw} | p50/p95 ${lane.latency.wall_ms_p50}/${lane.latency.wall_ms_p95}ms | wc[${w}] |`,
  );
  return { lane, probe };
}

function sumParts(parts) {
  const d = { n: 0, correct: 0 };
  const t = { n: 0, correct: 0 };
  for (const p of parts) { d.n += p.decision.n; d.correct += p.decision.correct; t.n += p.task.n; t.correct += p.task.correct; }
  d.accuracy = d.n === 0 ? null : d.correct / d.n;
  t.accuracy = t.n === 0 ? null : t.correct / t.n;
  return { decision: d, task: t };
}

async function runMatrix(outRoot, only) {
  const started = new Date().toISOString();
  const selected = only ? MATRIX_BACKENDS.filter((b) => b === only) : [...MATRIX_BACKENDS];
  if (selected.length === 0) throw new Error(`--model must be one of ${MATRIX_BACKENDS.join(", ")}`);
  for (const b of selected) {
    const d = path.join(outRoot, OUT_SUBDIR[b]);
    if (fs.existsSync(d) && fs.readdirSync(d).length > 0) {
      console.error(`refusing to overwrite non-empty ${d} (new version per run; pass --out <empty dir>)`);
      process.exit(2);
    }
  }
  console.log(`r3g2 matrix: backends [${selected.join(", ")}] x screen r1 (12) + v2 (32), timeout ${G2_CALL_TIMEOUT_MS}ms CPU, same oracles+scoring`);
  const all = {};
  for (const backend of selected) {
    console.log(`--- backend ${backend} (${MODELS[backend].repo}) ---`);
    all[backend] = await runBackendMatrix(backend);
  }
  const finished = new Date().toISOString();
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const backendRevisions = resolveBackendRevisions({ env: process.env });

  // Laya baseline for EVERY composed table: fresh when run, else read back
  // from the out dir (same version, never re-invented).
  let layaLane = all.laya?.lane ?? null;
  if (!layaLane) {
    const lp = path.join(outRoot, OUT_SUBDIR.laya, "metrics.json");
    if (fs.existsSync(lp)) layaLane = JSON.parse(fs.readFileSync(lp, "utf8")).lanes?.screen ?? null;
  }

  for (const backend of selected) {
    const { lane, probe } = all[backend];
    const dir = path.join(outRoot, OUT_SUBDIR[backend]);
    const metrics = {
      generated: `bench-ronda3 G2 live screen matrix, backend ${backend} (r1 screen 12 + v2 screen 32; decisions via scoreIndependentDecision, same fn as score.mjs --corpus r1; judgments: [] on the row path, live signals feed wrong_confident + reliability inputs)`,
      backend, repo: MODELS[backend].repo,
      corpus: { r1_screen: 12, v2_screen: 32 },
      timeout_ms: G2_CALL_TIMEOUT_MS,
      lanes: { screen: lane },
    };
    const laneRow = (tag, corpus, src, L) => {
      if (!L) return { corpus, primitive: "screen", lane: tag, decision: null, task: null, note: "baseline not run in this invocation (run --model all or laya)" };
      const sel = corpus === "r1" ? L.r1 : L.v2;
      return { corpus, primitive: "screen", lane: tag, decision: sel.decision, task: sel.task, abstained: null, threw: null, source: src };
    };
    const rows = [
      laneRow(backend, "r1", `${path.relative(repoRoot, dir)}`, lane),
      laneRow("laya-baseline", "r1", layaLane ? `${path.relative(repoRoot, path.join(outRoot, OUT_SUBDIR.laya))} (baseline)` : null, layaLane),
      laneRow(backend, "v2", `${path.relative(repoRoot, dir)}`, lane),
      laneRow("laya-baseline", "v2", layaLane ? `${path.relative(repoRoot, path.join(outRoot, OUT_SUBDIR.laya))} (baseline)` : null, layaLane),
    ];
    const modelR1 = [{ decision: lane.r1.decision, task: lane.r1.task }];
    const modelV2 = [{ decision: lane.v2.decision, task: lane.v2.task }];
    const baseR1 = layaLane ? [{ decision: layaLane.r1.decision, task: layaLane.r1.task }] : null;
    const baseV2 = layaLane ? [{ decision: layaLane.v2.decision, task: layaLane.v2.task }] : null;
    const composed = {
      generated: `bench-ronda3 G2 composed screen table: ${backend} + laya-multilingual baseline in EVERY row group (computed from manifests, not tuned)`,
      baseline: layaLane ? `${path.relative(repoRoot, path.join(outRoot, OUT_SUBDIR.laya))}` : "not run in this invocation",
      rows,
      totals: {
        r1_model_12: sumParts(modelR1),
        r1_baseline_12: baseR1 ? sumParts(baseR1) : null,
        r1_champion_r3i_screen_12: { decision: { n: 12, correct: 10, accuracy: 10 / 12 }, task: { n: 12, correct: 10, accuracy: 10 / 12 }, source: "evals/results/v20 (r3a+qwen-find; screen lane gliclass(r3a), verified 2026-10-12)" },
        r1_champion_r3i_composed_60: { decision: { n: 60, correct: 56, accuracy: 56 / 60 }, task: { n: 60, correct: 56, accuracy: 56 / 60 }, source: "evals/results/v20 (r3a+qwen-find)" },
        combined_model_44: sumParts([...modelR1, ...modelV2]),
        combined_baseline_44: baseR1 && baseV2 ? sumParts([...baseR1, ...baseV2]) : null,
      },
      coverage_gaps: COVERAGE_GAPS,
      coverage_note: "guards serve screen ONLY (home primitive). classify/gate/rerank/find are recorded gaps, never faked runs -- a pure injection binary has no axis for them.",
      promotion_note: "measurement only: no promotion verdict here (spike S4 + parent R3T6 decide adopt/tie/discard from these numbers, strictly-no-worse vs r3i screen 10/12 on the r1 slice)",
    };
    const manifest = {
      generated: `bench-ronda3 G2 R3T4 reproducibility manifest (LIVE backend ${backend}; absolutes + method, no improvement claims, no promotion)`,
      date: finished,
      ...gitCommit(),
      model: probe?.model ?? MODELS[backend].repo,
      model_note: "live backend model inventory name (verbatim probe)",
      model_repo: MODELS[backend].repo,
      model_revision: null,
      model_revision_source: "unpinned",
      model_revision_note: `the ${backend} sidecar reports no revision pin (revision null + unpinned, never invented); the setup-time HF-API sha ${MODELS[backend].sha ?? "n/a (laya cache pre-existing)"} lives in odd/tasks/spike-g2-guards.md S1`,
      tokenizer: "unknown",
      tokenizer_note: "explicit unknown: no tool or probe exposes a tokenizer",
      device: probe?.device ?? `unknown (${backend} backend did not report a device)`,
      device_note: "probed LIVE from GET /ready (or the explicit unknown string when the backend reported no device)",
      backend: {
        mode: "live", live: true, reachable: true, baseUrl: probe?.baseUrl ?? `http://127.0.0.1:${MODELS[backend].port}`,
        server: MODELS[backend].server,
        venv: "py/.venv-r3g2 (group venv; laya baseline served unmodified from its own venv via py/laya_server.py :8765)",
        ready: probe?.ready ?? null, device: probe?.device ?? null,
        models: probe?.models ?? [], model: probe?.model ?? null,
        revisions: backendRevisions,
        probe,
        note: "G2 sidecars serve the production POST /predict {text, labels} contract (stdlib http.server, lazy single-flight load, 413 guards); binary head mapped onto a synonym axis (injection->p / safe->1-p / else 0.0, documented per server); lane coverage is screen-only (G2GuardClient refuses other shapes with an explicit gap error)",
      },
      backend_revisions: backendRevisions,
      backend_revisions_note: "per-backend revision pins (env pins win, else backend-reported, else unpinned null; a hash is never invented)",
      policy: ["screen"].map((name) => ({ name, version: "1.0.0" })),
      policy_note: "screen only: the only primitive G2 guards cover (classify/gate/rerank/find are recorded gaps)",
      schema_version: "1.0.0",
      software: { node: process.version, platform: process.platform, arch: process.arch, package_version: pkg.version ?? null },
      hardware: { arch: os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, totalmem_mb: Math.round(os.totalmem() / 1048576) },
      config: {
        backend, corpus: { r1_screen: 12, v2_screen: 32 }, lanes: ["screen"], timeout_ms: G2_CALL_TIMEOUT_MS,
        run_env: Object.fromEntries(
          ["LAYA_URL", "LAYA_BENCH_SCREEN_URL"]
            .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
        ),
        started, finished,
      },
      mode: {
        mcp: "observe",
        mcp_note: "the MCP layer only observes and reports judgments; it never acts, under every policy mode",
        policy: "observe (default)",
        policy_note: "effective global policy-decision mode resolution input (verbatim env or default)",
      },
      method: `G2 screen matrix: per-case wall (performance.now round trip) + backend-reported latencyMs per predict call. Routing OFF (pure argmax + omit-on-null; G2 screen tau null -- first-measurement pin, never tuned on r1/v2); fixed argmax->band magnitudes at public policy centers (screen 0.92/0.5/0.1 vs 0.75/0.25, inherited verbatim from the G1/r3a lane); substance/relevance ride the documented 0.9/0.9 lane constant; suspicious always scores 0.0 server-side so argmax reduces to benign/malicious. Per-case rows carry raw backend scores + margins for threshold design; verdicts never read them. Reliability inputs recorded, no ECE claimed. No cross-machine comparison.`,
      gold_corpus: {
        r1_screen: 12, v2_screen: 32, oracle_stub: 0, total: 44,
      },
      gold_corpus_note: "r1 golds are human-fixed independent truth + v2 golds human-signed (spike-grade: live backends judged against them); stub answers ignored by lanes (live deps forward real questions)",
      honesty: [
        "absolutes only; no cross-machine comparison; no improvement claimed without a paired baseline table (laya baseline embedded in composed.json); no promotion verdict (spike S4 + parent R3T6)",
        "thresholds OFF and untouched (no m, no tau); wrong_confident taus remain reporting slices, never prod cutoffs",
        "screen substance/relevance + fixed magnitudes are documented lane constants, not tuned values (binary guards have no such notions)",
        "reliability inputs are diagram data, not calibration: no ECE/Brier, no probability claimed (guard sharpness is NOT calibration)",
        "model weights stay out of git (venv policy); pinned by setup-time HF-API sha + sidecar probe only",
        "classify/gate/rerank/find are NOT run through guards (recorded gaps): a binary head has no axis for them and argmax over 0.0 scores would fake verdicts",
      ],
      links: { metrics: { suites: null }, composed: { table: null } },
      server_reported_revisions: Object.fromEntries(
        (probe?.models ?? []).map((m) => [m?.name ?? MODELS[backend].repo, { revision: m?.revision ?? null, revision_source: m?.revision_source ?? "unpinned", loaded: m?.loaded ?? null }]),
      ),
      g2: {
        venv: "py/.venv-r3g2",
        venv_note: "group venv pins recorded at setup (spike S1): torch 2.14.1+cpu, transformers 5.19.0, onnxruntime 1.31.0, tokenizers 0.23.3, safetensors 0.8.0, huggingface_hub 2.2.0, numpy 2.4.6, pip check clean (not re-resolved here)",
        thresholds: "OFF: pure argmax + omit-on-null (screen tau null); NOT tuned here and NEVER on r1/v2",
        adjudication: "screen text vs [benign, suspicious, malicious] -> injection noul (malicious 0.92 / suspicious 0.5 / benign 0.1, public block/review band centers, a priori); substance/relevance 0.9/0.9 documented lane constants; suspicious scores 0.0 server-side (binary head) so argmax is benign/malicious; see G2GuardClient above",
        coverage_gaps: COVERAGE_GAPS,
      },
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(metrics, null, 2));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, "composed.json"), JSON.stringify(composed, null, 2));
    console.log(`saved: ${dir}/manifest.json + metrics.json + composed.json`);
    const t = composed.totals;
    console.log(
      `composed ${backend}: r1 screen model dec ${t.r1_model_12.decision.correct}/${t.r1_model_12.decision.n} task ${t.r1_model_12.task.correct}/${t.r1_model_12.task.n} | ` +
      `r1 baseline ${t.r1_baseline_12 ? `${t.r1_baseline_12.decision.correct}/${t.r1_baseline_12.decision.n} + ${t.r1_baseline_12.task.correct}/${t.r1_baseline_12.task.n}` : "n/a"} | ` +
      `champion r3i screen 10/12 + 10/12 | combined model dec ${t.combined_model_44.decision.correct}/${t.combined_model_44.decision.n} task ${t.combined_model_44.task.correct}/${t.combined_model_44.task.n}`,
    );
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log([
    "usage: node evals/smoke-r3g2-lanes.mjs [--live] | --matrix [--out <dir>] [--model <horizon|galvanize|mdeberta|laya>]",
    "  (no flag / --live)  15-case versioned smoke (5 r1 screen cases x 3 G2 guards) -- exit 0 green, 2 backend down, 1 other failure.",
    "  --matrix   live screen matrix (r1 screen 12 + v2 screen 32 per backend, laya baseline in every table) -> evals/results/v22-g2-matrix/ (or --out <dir>).",
    "  --model    matrix backends subset (default: all 4 incl. laya baseline).",
    "  --out      matrix output root (model subdirs must not exist non-empty; never overwrites).",
  ].join("\n"));
  process.exit(0);
}

try {
  if (args.includes("--matrix")) {
    const i = args.indexOf("--out");
    const outRoot = i !== -1 ? path.resolve(args[i + 1] ?? "") : path.join(repoRoot, "evals", "results", "v22-g2-matrix");
    if (i !== -1 && !args[i + 1]) throw new Error("--out needs a directory value");
    const j = args.indexOf("--model");
    const only = j !== -1 ? args[j + 1] ?? null : null;
    if (j !== -1 && !args[j + 1]) throw new Error("--model needs a backend value");
    await runMatrix(outRoot, only);
  } else {
    await runSmoke();
  }
} catch (err) {
  console.error(`FAILED: ${String(err?.message ?? err).split("\n").slice(0, 4).join(" | ")}`);
  process.exit(1);
}
