/**
 * bench-ronda3 G1 (R3T3+R3T4): versioned lane smoke + full live matrix for
 * the 3 G1 choice-sidecar lanes (arc :8774, zesyde :8775, thx :8776) plus
 * the laya-multilingual baseline (:8765, unmodified server) in EVERY table.
 *
 * MODES:
 *   node evals/smoke-r3g1-lanes.mjs [--live]
 *     Versioned smoke: ONE r1 EN-normal case x 5 lanes (classify / screen /
 *     gate / rerank / find) x 3 G1 models = 15 live cases, asserting the
 *     score.mjs result shape per lane + exit 0. (--live is an explicit
 *     alias: smoke is always live; there is no stub path here.)
 *   node evals/smoke-r3g1-lanes.mjs --matrix [--out <dir>] [--model <m>]
 *     Full live matrix: r1 (60: 12 x classify/gate/screen/rerank/find) +
 *     v2 (80 signed: 26 classify + 22 gate + 32 screen; no v2 rerank/find
 *     corpus exists) per backend, same oracles + same scoring
 *     (scoreIndependentDecision, the same fn score.mjs --corpus r1 uses) +
 *     same 60s CPU timeout budget for EVERY backend incl. laya. Output:
 *     <out>/<model>/{manifest,metrics,composed}.json per model
 *     (arc, zesyde, thx, laya-baseline; default out
 *     evals/results/v21-g1-matrix/). Refuses to overwrite a non-empty
 *     model dir (new version per run, never silently; never touches
 *     v1-v20 or v21-g1 smoke).
 *
 * EXIT CODES: 0 green/measured (misses are DATA, never a failure); 2
 * backend refused (sidecar down -- probe refusal, never a silent stub) or
 * overwrite refusal; 1 any other failure (shape/assert/IO).
 * This script never starts a server and never builds a venv: boot the G1
 * sidecars first with py/.venv-r3g1 (ports 8774/8775/8776) + laya :8765.
 *
 * MEASUREMENT, NOT PROMOTION: thresholds OFF (pure argmax +
 * omit-on-ABSTAIN/null, no margin m, no tau -- the gliclass screen tau does
 * not transfer across score scales; tuning is Fase-2 work on validation
 * data, NEVER on r1/v2). Fixed argmax->handler-band magnitudes sit at the
 * public policy band centers (see G1ChoiceClient in evals/lanes-r1.mjs),
 * chosen a priori, never from r1/v2 outcomes. Per-case rows carry raw
 * backend scores + margins for threshold design; verdicts never read them.
 * Sharpness is NOT calibration: reliability INPUTS (signal+correctness
 * pairs + bin counts) are recorded for diagrams, but no ECE / Brier / P/R
 * is computed and no probability is claimed (metrics.mjs honesty rule).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  probeLane,
  G1ChoiceClient,
  G1_BACKENDS,
  G1_CALL_TIMEOUT_MS,
  lanePredictFactory,
} from "./lanes-r1.mjs";
import { r1CasesFor } from "./corpus-index.mjs";
import {
  WRONG_CONFIDENT_TAUS,
  abstentionStats,
  goldVerdictList,
  scoreIndependentDecision,
  wrongConfident,
} from "./metrics.mjs";
import { resolveBackendRevisions } from "./live-client.mjs";
import * as classify from "./suites/classify.mjs";
import * as gate from "./suites/gate.mjs";
import * as screen from "./suites/screen.mjs";
import * as rerank from "./suites/rerank.mjs";
import * as find from "./suites/find.mjs";
import * as v2classify from "./corpus-v2/classify.mjs";
import * as v2gate from "./corpus-v2/gate.mjs";
import * as v2screen from "./corpus-v2/screen.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

const SUITES = { classify, gate, screen, rerank, find };
const V2 = { classify: v2classify.cases, gate: v2gate.cases, screen: v2screen.cases };
const R1_LANES = ["classify", "gate", "screen", "rerank", "find"];
const V2_LANES = ["classify", "gate", "screen"];

/** G1 model inventory (setup-time facts from spike S1/S2; the sidecars
 *  themselves report revision null + unpinned, never a hash). */
const MODELS = {
  arc: { repo: "Arc53/arc-decide-0.4b-v0.2", sha: "6133def38cef4629f22d0243adc6e21b9426451c", port: 8774, server: "py/arc_decide_server.py" },
  zesyde: { repo: "zoebchhatriwala/Zesyde-150M-Multilingual-Router", sha: "f10c672b0e75403315157b5485382f079b950ebc", port: 8775, server: "py/zesyde_server.py" },
  thx: { repo: "doofz/THX-01", sha: "bef2e2478be7acd79429324a658558a57552a2e8", port: 8776, server: "py/thx_server.py" },
  laya: { repo: "convaiinnovations/laya-multilingual", sha: null, port: 8765, server: "py/laya_server.py (unmodified v0.4.0)" },
};
const MATRIX_BACKENDS = ["arc", "zesyde", "thx", "laya"];
const OUT_SUBDIR = { arc: "arc", zesyde: "zesyde", thx: "thx", laya: "laya-baseline" };

/** Versioned smoke pins: one r1 EN-normal case per lane (normal class). */
const SMOKE_CASES = [
  { lane: "classify", caseId: "r1-classify-en-normal-01" },
  { lane: "gate", caseId: "r1-gate-en-normal-01" },
  { lane: "screen", caseId: "r1-screen-en-normal-01" },
  { lane: "rerank", caseId: "r1-rerank-en-normal-01" },
  { lane: "find", caseId: "r1-find-en-normal-01" },
];

const GATE_VERDICTS = new Set(["SUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE", "ABSTAIN"]);
const SCREEN_ASSESSMENTS = new Set(["valid", "ambiguous", "irrelevant", "malicious-instruction"]);

const round1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);
const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

/** r1 convention: ABSTAIN-verdict golds score through verdicts with the
 *  top-level `abstained` key stripped (the missing-signal path reports an
 *  ABSTAIN verdict + ESCALATE without setting the flag). v2 gate golds
 *  share the shape. */
function goldFor(lane, gold) {
  if (lane === "gate") {
    const list = Array.isArray(gold.verdicts) ? gold.verdicts : gold.verdict !== undefined ? [gold.verdict] : [];
    if (list.includes("ABSTAIN")) return Object.fromEntries(Object.entries(gold).filter(([k]) => k !== "abstained"));
  }
  return gold;
}

function assertSmokeShape(lane, body) {
  const probs = [];
  if (!body || typeof body !== "object") probs.push("empty body");
  if (typeof body?.decision?.decision !== "string") probs.push("body.decision.decision not a string");
  if (typeof body?.abstention?.abstained !== "boolean") probs.push("body.abstention.abstained not boolean");
  if (lane === "classify") {
    if (!Array.isArray(body?.classifications) || typeof body.classifications[0]?.classification !== "string") {
      probs.push("classifications[0].classification not a string");
    }
  } else if (lane === "gate") {
    const vs = body?.claims?.map((c) => c.verdict) ?? [];
    if (!Array.isArray(body?.claims) || vs.length === 0 || vs.some((v) => !GATE_VERDICTS.has(v))) {
      probs.push(`claims verdicts outside {${[...GATE_VERDICTS].join(",")}}: ${JSON.stringify(vs)}`);
    }
  } else if (lane === "screen") {
    if (!SCREEN_ASSESSMENTS.has(body?.assessment)) probs.push(`assessment outside known set: ${JSON.stringify(body?.assessment)}`);
  } else if (lane === "rerank") {
    if (!Array.isArray(body?.ranked) || body.ranked.some((r) => typeof r?.id !== "string")) {
      probs.push("ranked ids not string[]");
    }
  } else if (lane === "find") {
    if (typeof body?.winner !== "string") probs.push("winner not a string");
    if (typeof body?.exists !== "boolean") probs.push("exists not boolean");
  }
  if (probs.length > 0) throw new Error(`smoke shape violation (${lane}): ${probs.join("; ")}`);
}

function taskOf(lane, body) {
  if (lane === "classify") return (body.classifications ?? []).map((c) => c.classification);
  if (lane === "gate") return (body.claims ?? []).map((c) => c.verdict);
  if (lane === "screen") return body.assessment;
  if (lane === "rerank") return (body.ranked ?? []).map((r) => r.id);
  if (lane === "find") return body.winner;
  return null;
}

/**
 * Connect one lane x backend with the uniform G1 60s CPU budget, or THROW
 * the exit-2-style refusal (never a silent stub). G1 backends speak POST
 * /predict via G1ChoiceClient; laya lanes delegate to dist/client.js
 * LayaClient. No makeRerankCtx anywhere: find/rerank judge through the
 * lane fakeClient answers exactly like the r3a matrices.
 */
async function connectG1(lane, backend) {
  const probe = await probeLane(lane, backend);
  if (!probe.reachable) {
    throw new Error(`lane ${lane} x ${backend} refused (exit 2): ${probe.error} -- ${probe.note}`);
  }
  let client;
  if (G1_BACKENDS.includes(backend)) {
    client = new G1ChoiceClient(probe.baseUrl, backend);
  } else if (backend === "laya") {
    const { LayaClient } = await import(pathToFileURL(path.join(repoRoot, "dist", "client.js")).href);
    client = new LayaClient(probe.baseUrl);
  } else {
    throw new Error(`smoke-r3g1 serves backends ${[...G1_BACKENDS, "laya"].join("/")} only, got ${JSON.stringify(backend)}`);
  }
  return { probe, deps: { fakeClient: lanePredictFactory(client, G1_CALL_TIMEOUT_MS) }, client };
}

function refuseExit2(msg) {
  console.error(`REFUSED (exit 2): ${String(msg).split("\n")[0]}`);
  process.exit(2);
}

async function runSmoke() {
  console.log("r3g1-lanes smoke: 1 r1 EN-normal case x 5 lanes x 3 G1 models (down -> exit 2, never stubbed)");
  let n = 0;
  for (const backend of G1_BACKENDS) {
    for (const { lane, caseId } of SMOKE_CASES) {
      let conn;
      try {
        conn = await connectG1(lane, backend);
      } catch (err) {
        refuseExit2(`lane ${lane} x ${backend}: ${err.message}`);
      }
      const { probe, deps } = conn;
      const c = r1CasesFor(lane).find((x) => x.id === caseId);
      if (!c) throw new Error(`smoke case ${caseId} not found in r1 corpus (${lane})`);
      const t0 = performance.now();
      const body = await SUITES[lane].invoke(deps, c.input, c.stub, {});
      const wall = performance.now() - t0;
      assertSmokeShape(lane, body);
      n++;
      console.log(
        `ok - ${lane} x ${backend} / ${caseId}: decision=${body.decision.decision} ` +
        `abstained=${body.abstention.abstained} task=${JSON.stringify(taskOf(lane, body))} ` +
        `wall_ms=${round1(wall)} reported_latency_ms=${round1(body.latency_ms)} (device=${probe.device ?? "unreported"})`,
      );
    }
  }
  console.log(`smoke: ${n}/${G1_BACKENDS.length * SMOKE_CASES.length} lanes green (exit 0)`);
}

/** Live-signal judgments for wrong_confident (score.mjs SIGNAL_MAP) +
 *  reliability inputs. correct = the SAME scoreIndependentDecision the
 *  row scoring uses (decision AND task), so slices never disagree with
 *  the matrix. Rerank reports no-aplica (within-call only by contract). */
function judgmentsFor(suiteName, body, gold) {
  const s = scoreIndependentDecision(suiteName, body, goldFor(suiteName, gold));
  const correct = s.decisionOk && s.taskOk;
  const flag = body?.abstention?.abstained === true;
  const J = (signal) => ({ correct, signal: typeof signal === "number" ? signal : null, abstained: flag, threw: false });
  if (suiteName === "classify") {
    return (body?.classifications ?? []).map((c) => J(c.winner_probability));
  }
  if (suiteName === "gate") {
    return (body?.claims ?? []).map((c) => J(c.signal));
  }
  if (suiteName === "screen") {
    return [J(body?.signals?.injection?.signal)];
  }
  if (suiteName === "find") {
    return [J(body?.winner_probability)];
  }
  return []; // rerank: no aplica
}

const WRONG_SIGNAL_NAME = {
  classify: "winner_probability",
  gate: "per-claim support signal",
  screen: "injection signal",
  find: "winner_probability",
  rerank: null,
};

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
    ece_note: "inputs only: no ECE/Brier computed and no probability claimed (metrics.mjs honesty rule); arc/thx sharpness is NOT calibration -- draw diagrams before any claim.",
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

function caseList(corpus, lane) {
  if (corpus === "r1") return r1CasesFor(lane).map((c) => ({ ...c, corpus }));
  return (V2[lane] ?? []).map((c) => ({ id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, input: c.input, gold: c.gold, stub: c.stub ?? { answers: {} }, corpus }));
}

async function runBackendMatrix(backend) {
  const lanes = {};
  const probes = {};
  const laneNames = [...R1_LANES];
  for (const lane of laneNames) {
    const suite = SUITES[lane];
    let conn;
    try {
      conn = await connectG1(lane, backend);
    } catch (err) {
      refuseExit2(`lane ${lane} x ${backend}: ${err.message}`);
    }
    const { probe, deps, client } = conn;
    probes[`${lane}x${backend}`] = probe;
    const corpora = V2_LANES.includes(lane) ? ["r1", "v2"] : ["r1"];
    const rows = [];
    const judgments = [];
    const walls = [];
    const reported = [];
    let reportedTotal = 0;
    for (const corpus of corpora) {
      for (const c of caseList(corpus, lane)) {
        if (client && typeof client.callLog !== "undefined") client.callLog = [];
        const t0 = performance.now();
        try {
          const body = await suite.invoke(deps, c.input, c.stub ?? { answers: {} }, {});
          const wall = performance.now() - t0;
          walls.push(wall);
          const rep = typeof body?.latency_ms === "number" ? body.latency_ms : null;
          if (rep !== null) { reported.push(rep); reportedTotal += rep; }
          const s = scoreIndependentDecision(suite.name, body, goldFor(lane, c.gold));
          judgments.push(...judgmentsFor(suite.name, body, c.gold));
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
    const wc = lane === "rerank"
      ? { status: "no aplica", reason: "relevance_score is within-call only by contract (never comparable across calls); a single score has no correctness value, so no tau slice is meaningful." }
      : { signal: WRONG_SIGNAL_NAME[lane], taus: WRONG_CONFIDENT_TAUS, ...wrongConfident(judgments) };
    lanes[lane] = {
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
      wrong_confident: wc,
      reliability: lane === "rerank" ? { status: "no aplica (same contract reason as wrong_confident)" } : reliabilityInputs(judgments),
      latency: {
        wall_ms_p50: round1(pct(walls, 0.5)), wall_ms_p95: round1(pct(walls, 0.95)),
        reported_ms_p50: round1(pct(reported, 0.5)), reported_ms_p95: round1(pct(reported, 0.95)),
        wall_ms_total: round1(walls.reduce((a, b) => a + b, 0)),
        reported_ms_total: round1(reportedTotal),
        wall_ms_per_case: walls.map(round1),
      },
      rows,
    };
    const w = lanes[lane].wrong_confident.slices
      ? lanes[lane].wrong_confident.slices.map((x) => `${x.tau}:${x.rate === null ? "n/a" : x.rate.toFixed(3)}`).join(" ") : "n/a";
    console.log(
      `| ${backend} ${lane} | r1 dec ${lanes[lane].r1.decision.correct}/${lanes[lane].r1.n} task ${lanes[lane].r1.task.correct}/${lanes[lane].r1.n} | ` +
      `v2 dec ${lanes[lane].v2.decision.correct}/${lanes[lane].v2.n} task ${lanes[lane].v2.task.correct}/${lanes[lane].v2.n} | ` +
      `abst ${lanes[lane].abstained} threw ${lanes[lane].threw} | p50/p95 ${lanes[lane].latency.wall_ms_p50}/${lanes[lane].latency.wall_ms_p95}ms | wc[${w}] |`,
    );
  }
  return { lanes, probes };
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
  console.log(`r3g1 matrix: backends [${selected.join(", ")}] x r1 (60) + v2 (80), timeout ${G1_CALL_TIMEOUT_MS}ms CPU, same oracles+scoring`);
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
  let layaLanes = all.laya?.lanes ?? null;
  if (!layaLanes) {
    const lp = path.join(outRoot, OUT_SUBDIR.laya, "metrics.json");
    if (fs.existsSync(lp)) layaLanes = JSON.parse(fs.readFileSync(lp, "utf8")).lanes;
  }

  for (const backend of selected) {
    const { lanes, probes } = all[backend];
    const dir = path.join(outRoot, OUT_SUBDIR[backend]);
    const firstProbe = probes[`${R1_LANES[0]}x${backend}`];
    const metrics = {
      generated: `bench-ronda3 G1 FULL live matrix, backend ${backend} (r1 independents + v2 signed; decisions via scoreIndependentDecision, same fn as score.mjs --corpus r1; judgments: [] on the row path, live signals feed wrong_confident + reliability inputs)`,
      backend, repo: MODELS[backend].repo,
      corpus: { r1: 60, v2: 80 },
      timeout_ms: G1_CALL_TIMEOUT_MS,
      lanes,
    };
    const laneRow = (tag, corpus, lane, src) => {
      const L = src === "model" ? lanes[lane] : layaLanes?.[lane];
      if (!L) return null;
      const sel = corpus === "r1" ? L.r1 : L.v2;
      return { corpus, primitive: lane, lane: tag, decision: sel.decision, task: sel.task, abstained: null, threw: null, source: src === "model" ? `${path.relative(repoRoot, dir)}` : `${path.relative(repoRoot, path.join(outRoot, OUT_SUBDIR.laya))} (baseline)` };
    };
    const rows = [];
    for (const lane of R1_LANES) {
      const m = laneRow(backend, "r1", lane, "model");
      if (m) rows.push(m);
      const b = layaLanes ? laneRow("laya-baseline", "r1", lane, "baseline") : null;
      rows.push(b ?? { corpus: "r1", primitive: lane, lane: "laya-baseline", decision: null, task: null, note: "baseline not run in this invocation (run --model all or laya)" });
    }
    for (const lane of V2_LANES) {
      const m = laneRow(backend, "v2", lane, "model");
      if (m) rows.push(m);
      const b = layaLanes ? laneRow("laya-baseline", "v2", lane, "baseline") : null;
      rows.push(b ?? { corpus: "v2", primitive: lane, lane: "laya-baseline", decision: null, task: null, note: "baseline not run in this invocation (run --model all or laya)" });
    }
    const modelR1 = R1_LANES.map((lane) => ({ decision: lanes[lane].r1.decision, task: lanes[lane].r1.task }));
    const modelV2 = V2_LANES.map((lane) => ({ decision: lanes[lane].v2.decision, task: lanes[lane].v2.task }));
    const baseR1 = layaLanes ? R1_LANES.map((lane) => ({ decision: layaLanes[lane].r1.decision, task: layaLanes[lane].r1.task })) : null;
    const baseV2 = layaLanes ? V2_LANES.map((lane) => ({ decision: layaLanes[lane].v2.decision, task: layaLanes[lane].v2.task })) : null;
    const composed = {
      generated: `bench-ronda3 G1 composed table: ${backend} lanes + laya-multilingual baseline in EVERY row group (computed from manifests, not tuned)`,
      baseline: layaLanes ? `${path.relative(repoRoot, path.join(outRoot, OUT_SUBDIR.laya))}` : "not run in this invocation",
      rows,
      totals: {
        r1_model_60: sumParts(modelR1),
        r1_baseline_60: baseR1 ? sumParts(baseR1) : null,
        r1_champion_r3i_60: { decision: { n: 60, correct: 56, accuracy: 56 / 60 }, task: { n: 60, correct: 56, accuracy: 56 / 60 }, source: "evals/results/v20 (r3a+qwen-find)" },
        combined_model_140: sumParts([...modelR1, ...modelV2]),
        combined_baseline_140: baseR1 && baseV2 ? sumParts([...baseR1, ...baseV2]) : null,
      },
      promotion_note: "measurement only: no promotion verdict here (spike S4 + parent R3T6 decide adopt/tie/discard from these numbers, strictly-no-worse vs r3i 56/60+56/60 on the r1 slice)",
    };
    const manifest = {
      generated: `bench-ronda3 G1 R3T4 reproducibility manifest (LIVE backend ${backend}; absolutes + method, no improvement claims, no promotion)`,
      date: finished,
      ...gitCommit(),
      model: firstProbe?.model ?? MODELS[backend].repo,
      model_note: "live backend model inventory name (verbatim probe)",
      model_repo: MODELS[backend].repo,
      model_revision: null,
      model_revision_source: "unpinned",
      model_revision_note: `the ${backend} sidecar reports no revision pin (revision null + unpinned, never invented); the setup-time HF-API sha ${MODELS[backend].sha ?? "n/a (laya cache pre-existing)"} lives in odd/tasks/spike-g1-arc-zesyde-thx.md S1`,
      tokenizer: "unknown",
      tokenizer_note: "explicit unknown: no tool or probe exposes a tokenizer",
      device: firstProbe?.device ?? `unknown (${backend} backend did not report a device)`,
      device_note: "probed LIVE from GET /ready (or the explicit unknown string when the backend reported no device)",
      backend: {
        mode: "live", live: true, reachable: true, baseUrl: firstProbe?.baseUrl ?? `http://127.0.0.1:${MODELS[backend].port}`,
        server: MODELS[backend].server,
        venv: "py/.venv-r3g1 (group venv; laya baseline served unmodified from the same venv via py/laya_server.py :8765)",
        ready: firstProbe?.ready ?? null, device: firstProbe?.device ?? null,
        models: firstProbe?.models ?? [], model: firstProbe?.model ?? null,
        revisions: backendRevisions,
        probes,
        note: "G1 sidecars serve the production POST /predict {text, labels} contract (stdlib http.server, lazy single-flight load, 413 guards); gate fan-out = one POST per claim lane-side; find = query-as-text vs candidate texts lane-side; omission lives lane-side (servers always return scores)",
      },
      backend_revisions: backendRevisions,
      backend_revisions_note: "per-backend revision pins (env pins win, else backend-reported, else unpinned null; a hash is never invented)",
      policy: ["classify", "code-review", "compare", "decide", "extract", "find", "gate", "normal", "pii", "rerank", "review", "screen", "security", "verify"].map((name) => ({ name, version: "1.0.0" })),
      policy_note: "live registry truth (availability-independent); 14 entries",
      schema_version: "1.0.0",
      software: { node: process.version, platform: process.platform, arch: process.arch, package_version: pkg.version ?? null },
      hardware: { arch: os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, totalmem_mb: Math.round(os.totalmem() / 1048576) },
      config: {
        backend, corpus: { r1: 60, v2: 80 }, lanes: R1_LANES, timeout_ms: G1_CALL_TIMEOUT_MS,
        run_env: Object.fromEntries(
          ["LAYA_BENCH_RERANK_URL", "LAYA_BENCH_FIND_URL", "RERANK_URL", "LAYA_URL"]
            .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
        ),
        run_env_note: "laya rerank/find lanes resolve via LAYA_BENCH_RERANK_URL/_FIND_URL (fallback RERANK_URL); the G1 matrix points both at the laya baseline :8765 so every table carries the same baseline backend",
        started, finished,
      },
      mode: {
        mcp: "observe",
        mcp_note: "the MCP layer only observes and reports judgments; it never acts, under every policy mode",
        policy: "observe (default)",
        policy_note: "effective global policy-decision mode resolution input (verbatim env or default)",
      },
      method: `G1 FULL matrix: per-case wall (performance.now round trip) + backend-reported latencyMs per predict call. Routing OFF (pure argmax + omit-on-ABSTAIN/null; G1_GATE_MARGIN_TAU=null, G1_SCREEN_MARGIN_TAU=null -- first-measurement pin, never tuned on r1/v2); fixed argmax->band magnitudes at public policy centers (gate 0.9/0.1 vs claimVerified 0.8; screen 0.92/0.5/0.1 vs 0.75/0.25; gate rubric 2/2/0.95 + screen substance/relevance 0.9/0.9 documented lane constants; find argmax id->score, 1/N baseline inside handler). Per-case rows carry raw backend scores + margins for threshold design; verdicts never read them. Reliability inputs recorded, no ECE claimed. No cross-machine comparison.`,
      gold_corpus: {
        r1_independent: 60, v2_signed: 80, oracle_stub: 0, total: 140,
        per_suite: [
          ...R1_LANES.map((lane) => ({ suite: lane, r1: 12, v2: V2_LANES.includes(lane) ? V2[lane].length : 0 })),
        ],
      },
      gold_corpus_note: "r1 golds are human-fixed independent truth + v2 golds human-signed (spike-grade: live backends judged against them); stub answers ignored by lanes (live deps forward real questions)",
      honesty: [
        "absolutes only; no cross-machine comparison; no improvement claimed without a paired baseline table (laya baseline embedded in composed.json); no promotion verdict (spike S4 + parent R3T6)",
        "thresholds OFF and untouched (no m, no tau); wrong_confident taus remain reporting slices, never prod cutoffs",
        "gate rubric + screen substance/relevance + fixed magnitudes are documented lane constants, not tuned values (choice backends have no such notions)",
        "reliability inputs are diagram data, not calibration: no ECE/Brier, no probability claimed (arc/thx sharpness is NOT calibration)",
        "model weights stay out of git (venv policy); pinned by setup-time HF-API sha + sidecar probe only",
      ],
      links: { metrics: { suites: null }, composed: { table: null } },
      server_reported_revisions: Object.fromEntries(
        (firstProbe?.models ?? []).map((m) => [m?.name ?? MODELS[backend].repo, { revision: m?.revision ?? null, revision_source: m?.revision_source ?? "unpinned", loaded: m?.loaded ?? null }]),
      ),
      g1: {
        venv: "py/.venv-r3g1",
        venv_note: "group venv pins recorded at setup (spike S1): torch 2.14.1+cpu, transformers 5.19.0, onnxruntime 1.31.0, zesyde 1.0.1, thx01 1.0.0, laya 0.3.23 --no-deps, pip check clean (not re-resolved here)",
        thresholds: "OFF: pure argmax + omit-on-ABSTAIN/null (gate and screen taus null); NOT tuned here and NEVER on r1/v2",
        adjudication: "classify item-text vs criteria keys; gate one POST per claim (evidence || claim, 3 labels) -> claim/refute noul pair; screen text + 3 labels -> injection noul; rerank query-as-text + candidate texts -> noul order; find query-as-text + candidate texts -> exists choice; see G1ChoiceClient in evals/lanes-r1.mjs",
      },
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(metrics, null, 2));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, "composed.json"), JSON.stringify(composed, null, 2));
    console.log(`saved: ${dir}/manifest.json + metrics.json + composed.json`);
    const t = composed.totals;
    console.log(
      `composed ${backend}: r1 model dec ${t.r1_model_60.decision.correct}/${t.r1_model_60.decision.n} task ${t.r1_model_60.task.correct}/${t.r1_model_60.task.n} | ` +
      `r1 baseline ${t.r1_baseline_60 ? `${t.r1_baseline_60.decision.correct}/${t.r1_baseline_60.decision.n} + ${t.r1_baseline_60.task.correct}/${t.r1_baseline_60.task.n}` : "n/a"} | ` +
      `champion r3i 56/60 + 56/60 | combined model dec ${t.combined_model_140.decision.correct}/${t.combined_model_140.decision.n} task ${t.combined_model_140.task.correct}/${t.combined_model_140.task.n}`,
    );
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log([
    "usage: node evals/smoke-r3g1-lanes.mjs [--live] | --matrix [--out <dir>] [--model <arc|zesyde|thx|laya>]",
    "  (no flag / --live)  15-case versioned smoke (1 r1 EN-normal case x 5 lanes x 3 G1 models) -- exit 0 green, 2 backend down, 1 other failure.",
    "  --matrix   full live matrix (r1 60 + v2 80 per backend, laya baseline in every table) -> evals/results/v21-g1-matrix/ (or --out <dir>).",
    "  --model    matrix backends subset (default: all 4 incl. laya baseline).",
    "  --out      matrix output root (model subdirs must not exist non-empty; never overwrites).",
  ].join("\n"));
  process.exit(0);
}

try {
  if (args.includes("--matrix")) {
    const i = args.indexOf("--out");
    const outRoot = i !== -1 ? path.resolve(args[i + 1] ?? "") : path.join(repoRoot, "evals", "results", "v21-g1-matrix");
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
