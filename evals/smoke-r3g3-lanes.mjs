/**
 * bench-ronda3 G3 (R3T3+R3T4): versioned lane smoke + full live matrix for
 * minilm-NLI :8779 (full 5 lanes) + gliclass-stock :8782 (full 5 lanes,
 * STOCK weights reference) + policylm :8771 (screen only, honest subset)
 * + modernbert-probe :8781 (probe only: load + 1 MLM forward pass +
 * honest 409 on /predict, never lanes) plus the laya-multilingual
 * baseline (:8765, unmodified server) in EVERY table.
 *
 * MODES:
 *   node evals/smoke-r3g3-lanes.mjs [--live]
 *     Versioned smoke: ONE r1 EN-normal case x 5 lanes (classify / screen /
 *     gate / rerank / find) x 2 choice backends (minilm, gliclass-stock) =
 *     10 live cases + policylm screen x 5 r1 cases (EN/ES normal, EN/ES
 *     adversarial, EN ambiguous) + modernbert probe checks (live+ready+
 *     /probe shape+/predict 409), asserting the score.mjs result shape per
 *     lane + exit 0. (--live is an explicit alias: smoke is always live;
 *     there is no stub path here.)
 *   node evals/smoke-r3g3-lanes.mjs --matrix [--out <dir>] [--model <m>]
 *     Full live matrix: r1 (60: 12 x classify/gate/screen/rerank/find) +
 *     v2 (80 signed: 26 classify + 22 gate + 32 screen; no v2 rerank/find
 *     corpus exists) per choice backend (minilm, gliclass-stock, laya);
 *     policylm runs screen only (r1 12 + v2 32, honest subset -- classify
 *     is a recorded gap: topic membership is not a policy violation);
 *     modernbert captures probe evidence only (GET /probe + POST /predict
 *     409, never lanes). Same oracles + same scoring
 *     (scoreIndependentDecision, the same fn score.mjs --corpus r1 uses) +
 *     same 60s CPU timeout budget for EVERY backend incl. laya. Output:
 *     <out>/<model>/{manifest,metrics,composed}.json per model
 *     (minilm, gliclass-stock, policylm, modernbert-probe, laya-baseline;
 *     default out evals/results/v23-g3-matrix/). Refuses to overwrite a
 *     non-empty model dir (new version per run, never silently; never
 *     touches v1-v22*).
 *
 * EXIT CODES: 0 green/measured (misses are DATA, never a failure); 2
 * backend refused (sidecar down -- probe refusal, never a silent stub) or
 * overwrite refusal; 1 any other failure (shape/assert/IO).
 * This script never starts a server and never builds a venv: boot the G3
 * sidecars first with py/.venv-r3g3 (minilm :8779, gliclass-stock :8782,
 * modernbert-probe :8781) + py/.venv-r3g3-policylm (policylm :8771) +
 * laya :8765.
 *
 * MEASUREMENT, NOT PROMOTION: thresholds OFF (pure argmax +
 * omit-on-ABSTAIN/null, no margin m, no tau -- the gliclass screen tau does
 * not transfer across score scales; tuning is Fase-2 work on validation
 * data, NEVER on r1/v2). Fixed argmax->handler-band magnitudes sit at the
 * public policy band centers (see G3ChoiceClient above, inherited verbatim
 * from GliclassClient),
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
  GliclassClient,
  PolicylmClient,
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
import { resolveBackendRevisions, probeSidecar, LIVE_CLIENT_DEFAULTS } from "./live-client.mjs";
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

/** G3 model inventory (setup-time facts from spike S1/S2; minilm +
 *  gliclass-stock report revision null + unpinned, policylm reports its
 *  pinned v1.2, modernbert reports null + unpinned -- never a hash). */
const MODELS = {
  minilm: { repo: "MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli", sha: "0a71e92a985b6e1ad1828cf67ce9c459639c1dca", port: 8779, server: "py/minilm_server.py" },
  "gliclass-stock": { repo: "knowledgator/gliclass-multilang-mini", sha: "0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b", port: 8782, server: "py/gliclass_stock_server.py" },
  policylm: { repo: "musubilabs/policylm-1.7b", sha: "b3b2cd408a08a68ab6a30c1fc1e440204e44d57e", revision: "v1.2", port: 8771, server: "py/policylm_r3g3_server.py" },
  modernbert: { repo: "answerdotai/ModernBERT-base", sha: "8949b909ec900327062f0ebf497f51aef5e6f0c8", port: 8781, server: "py/modernbert_probe_server.py" },
  laya: { repo: "convaiinnovations/laya-multilingual", sha: null, port: 8765, server: "py/laya_server.py (unmodified v0.4.0)" },
};
/** Choice backends (full 5-primitive lanes over POST /predict). ModernBERT
 *  is a probe (no lanes) and policylm serves screen only. */
const G3_CHOICE_BACKENDS = ["minilm", "gliclass-stock"];
const MATRIX_BACKENDS = ["minilm", "gliclass-stock", "policylm", "modernbert", "laya"];
const OUT_SUBDIR = { minilm: "minilm", "gliclass-stock": "gliclass-stock", policylm: "policylm", modernbert: "modernbert-probe", laya: "laya-baseline" };

/**
 * bench-ronda3 G3 (R3T3): choice-sidecar lane client for minilm +
 * gliclass-stock. Both sidecars expose the SAME POST /predict
 * {text, labels} contract as the G1 choice sidecars (scores[] +
 * flagged[] + latency_ms, 413 past ceiling, single-label answered vs an
 * "other" contrast server-side), so every adjudication path is inherited
 * VERBATIM from GliclassClient -- the ONLY overrides are the scoring
 * transport (per-model baseUrl + error prefix + 60s G3 budget default),
 * the model tag, the routing taus (both OFF: pure-argmax first
 * measurement, no validated tau transfers across score scales), and the
 * find lane below (GliclassClient has none). Lane methodology (L1/L2
 * magnitudes, omission routing, duplicate-label dedup) is the G1/r3a pin
 * verbatim; the models differ only in weights, never in lane semantics.
 */
const G3_CALL_TIMEOUT_MS = 60000;
const G3_BACKENDS = ["minilm", "gliclass-stock"];

class G3ChoiceClient extends GliclassClient {
  constructor(baseUrl, modelTag) {
    if (!G3_BACKENDS.includes(modelTag)) {
      throw new Error(`G3ChoiceClient needs a G3 choice tag (${G3_BACKENDS.join("/")}), got ${JSON.stringify(modelTag)}`);
    }
    super(baseUrl ?? `http://127.0.0.1:${MODELS[modelTag].port}`);
    this.modelTag = modelTag;
    this.gateMarginTau = null;
    this.screenMarginTau = null;
  }

  async scoreLabels(text, labels, { timeoutMs = G3_CALL_TIMEOUT_MS } = {}) {
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
    if (Object.hasOwn(questions, "exists")) return this.predictFind(state, questions, opts);
    return super.predict(state, questions, opts);
  }

  /**
   * Duplicate-label guard (lane-side; the py servers are out of scope for
   * this task). Exact-duplicate texts are REAL corpus cases (r1 ambiguous
   * ties: identical bodies must tie with input order kept, never
   * misroute), so the lane dedupes: unique labels ride ONE POST, scores
   * expand back index-aligned (duplicates share the score = an exact tie;
   * first-max argmax keeps input order, the documented tie pin). callLog
   * records the labels actually sent plus the dedup counts -- never a
   * silent cut. No-op when labels are already unique.
   */
  async postLogged(lane, key, text, labels, opts) {
    const uniq = [...new Set(labels)];
    if (uniq.length === labels.length) return super.postLogged(lane, key, text, labels, opts);
    const { scores: uscores, latencyMs } = await this.scoreLabels(text, uniq, opts);
    const byLabel = new Map();
    uscores.forEach((s, i) => {
      const lab = uniq[i];
      if (typeof s?.score === "number" && !byLabel.has(lab)) byLabel.set(lab, s.score);
    });
    const scores = labels.map((lab) => ({ label: lab, score: byLabel.has(lab) ? byLabel.get(lab) : null }));
    const top = this.argmax(scores);
    const topIdx = scores.findIndex((s) => s === top);
    const rest = scores.filter((s, i) => i !== topIdx && typeof s?.score === "number").map((s) => s.score);
    this.callLog.push({
      lane, key, labels: [...uniq],
      dedup: { sent_unique: uniq.length, expanded: labels.length },
      scores: scores.map((s) => ({ label: s?.label ?? null, score: typeof s?.score === "number" ? s.score : null })),
      top: top?.label ?? null, top_score: top?.score ?? null,
      margin: top === null || rest.length === 0 ? null : top.score - Math.max(...rest),
      latencyMs,
    });
    return { scores, top, latencyMs };
  }

  /**
   * Find (S4 qwen/gte template, adapted to a choice POST): the shown
   * candidate full texts ride as labels in criteria order (excluding the
   * handler-owned "none" criterion, which is a verdict, not a label);
   * index-aligned scores map back to {choice: topId, probabilities}.
   * Empty pool / null answer OMITS exists (handler none-path ESCALATEs).
   */
  async predictFind(state, questions, opts) {
    const query = state?.query;
    const pool = Array.isArray(state?.candidates) ? state.candidates : null;
    const criteria = questions?.exists?.criteria ?? {};
    if (typeof query !== "string" || query === "" || pool === null) {
      throw new Error(`${this.modelTag} lane unavailable: predictFind only serves find-shaped calls ({query, candidates})`);
    }
    const byId = new Map(pool.filter((c) => c && typeof c.id === "string").map((c) => [c.id, String(c.text ?? "")]));
    const items = [];
    for (const id of Object.keys(criteria)) {
      if (id === "none") continue; // handler-owned verdict, never a label
      const text = byId.get(id);
      const label = (typeof text === "string" && text !== "") ? text : String(criteria[id] ?? "");
      if (label === "") continue; // omit -> handler none-path
      items.push({ id, text: label });
    }
    const answers = {};
    let latencyMs = 0;
    if (items.length > 0) {
      const { scores, latencyMs: ms } = await this.postLogged(
        "find", "exists", query, items.map((it) => it.text), opts);
      latencyMs += ms;
      const probabilities = {};
      items.forEach((it, idx) => {
        const s = scores[idx];
        if (s && typeof s.score === "number") probabilities[it.id] = s.score;
      });
      const top = this.argmax(items.map((it, idx) => {
        const s = scores[idx];
        return s && typeof s.score === "number" ? { label: it.id, score: s.score } : null;
      }).filter(Boolean));
      if (top !== null) answers.exists = { choice: top.label, probabilities };
    }
    return { answers, confidence: {}, routing: {}, model: this.modelTag, latencyMs, usage: {} };
  }
}

/** Versioned smoke pins: one r1 EN-normal case per lane (normal class)
 *  for the two choice backends. */
const SMOKE_CASES = [
  { lane: "classify", caseId: "r1-classify-en-normal-01" },
  { lane: "gate", caseId: "r1-gate-en-normal-01" },
  { lane: "screen", caseId: "r1-screen-en-normal-01" },
  { lane: "rerank", caseId: "r1-rerank-en-normal-01" },
  { lane: "find", caseId: "r1-find-en-normal-01" },
];

/** Versioned smoke pins: 5 r1 screen cases for the policylm honest subset
 *  (EN/ES normal + EN/ES adversarial + EN ambiguous, the G2 pin). */
const POLICYLM_SMOKE_CASES = [
  "r1-screen-en-normal-01",
  "r1-screen-es-normal-01",
  "r1-screen-en-adversarial-01",
  "r1-screen-es-adversarial-01",
  "r1-screen-en-ambiguous-01",
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
 * Connect one lane x backend with the uniform G3 60s CPU budget, or THROW
 * the exit-2-style refusal (never a silent stub). G3 choice backends speak
 * POST /predict via G3ChoiceClient; policylm screen delegates to the
 * lanes-r1 PolicylmClient (screen-shaped only); laya lanes delegate to
 * dist/client.js LayaClient via probeLane. G3 sidecars are NOT registered
 * in lanes-r1 LANES (that file is out of scope), so they probe by explicit
 * port URL -- same refusal vocabulary as probeLane. No makeRerankCtx
 * anywhere: find/rerank judge through the lane fakeClient answers exactly
 * like the r3a matrices.
 */
async function connectG3(lane, backend) {
  let probe;
  if (G3_BACKENDS.includes(backend) || backend === "policylm") {
    const baseUrl = `http://127.0.0.1:${MODELS[backend].port}`;
    probe = await probeSidecar({
      baseUrl,
      service: `${backend}-server`,
      note: `${backend} sidecar unreachable at ${baseUrl}; lane ${lane} x ${backend} refused (exit 2), never stubbed`,
      timeoutMs: LIVE_CLIENT_DEFAULTS.probeTimeoutMs,
    });
  } else {
    probe = await probeLane(lane, backend);
  }
  if (!probe.reachable) {
    throw new Error(`lane ${lane} x ${backend} refused (exit 2): ${probe.error} -- ${probe.note}`);
  }
  let client;
  if (G3_BACKENDS.includes(backend)) {
    client = new G3ChoiceClient(probe.baseUrl, backend);
  } else if (backend === "policylm") {
    client = new PolicylmClient(probe.baseUrl);
  } else if (backend === "laya") {
    const { LayaClient } = await import(pathToFileURL(path.join(repoRoot, "dist", "client.js")).href);
    client = new LayaClient(probe.baseUrl);
  } else {
    throw new Error(`smoke-r3g3 serves backends ${[...G3_BACKENDS, "policylm", "laya"].join("/")} (+ modernbert probe) only, got ${JSON.stringify(backend)}`);
  }
  return { probe, deps: { fakeClient: lanePredictFactory(client, G3_CALL_TIMEOUT_MS) }, client };
}

function refuseExit2(msg) {
  console.error(`REFUSED (exit 2): ${String(msg).split("\n")[0]}`);
  process.exit(2);
}

/** Primitives PolicyLM cannot cover honestly (recorded, not run): topic
 *  membership is not a policy violation, so classifying refund/cancel/other
 *  as violations would fake verdicts. PolicylmClient (lanes-r1) serves
 *  screen-shaped questions only and throws on other shapes. */
const POLICYLM_GAPS = {
  classify: "policy-violation framing has no topic axis: scoring refund/cancel/other as violations would fake a verdict -- lane refused, gap recorded.",
  gate: "no SUPPORTED/CONTRADICTED/ABSTAIN notion -- lane refused, gap recorded.",
  rerank: "no relevance notion: candidate texts cannot be ordered -- lane refused, gap recorded.",
  find: "no query/candidate matching notion -- lane refused, gap recorded.",
};

async function runSmoke() {
  console.log("r3g3-lanes smoke: 5 lanes x 2 choice backends + policylm screen x5 + modernbert probe (down -> exit 2, never stubbed)");
  let n = 0;
  for (const backend of G3_BACKENDS) {
    for (const { lane, caseId } of SMOKE_CASES) {
      let conn;
      try {
        conn = await connectG3(lane, backend);
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
  for (const caseId of POLICYLM_SMOKE_CASES) {
    let conn;
    try {
      conn = await connectG3("screen", "policylm");
    } catch (err) {
      refuseExit2(`screen x policylm: ${err.message}`);
    }
    const { probe, deps } = conn;
    const c = r1CasesFor("screen").find((x) => x.id === caseId);
    if (!c) throw new Error(`smoke case ${caseId} not found in r1 screen corpus`);
    const t0 = performance.now();
    const body = await SUITES.screen.invoke(deps, c.input, c.stub, {});
    const wall = performance.now() - t0;
    assertSmokeShape("screen", body);
    n++;
    console.log(
      `ok - screen x policylm / ${caseId}: decision=${body.decision.decision} ` +
      `assessment=${body.assessment} injection_signal=${round1(body?.signals?.injection?.signal)} ` +
      `wall_ms=${round1(wall)} reported_latency_ms=${round1(body.latency_ms)} (device=${probe.device ?? "unreported"})`,
    );
  }
  await runModernbertProbeSmoke();
  n += 4;
  console.log(`smoke: ${n}/${G3_BACKENDS.length * SMOKE_CASES.length + POLICYLM_SMOKE_CASES.length + 4} checks green (exit 0)`);
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

/**
 * ModernBERT probe smoke: /live alive + /ready 200-ready + /probe shape
 * (mlm-forward-pass with a 3-D logits shape and a string top token) +
 * POST /predict honest 409 (code no_zero_shot). Connection failure is an
 * exit-2 refusal; shape violations throw (exit 1). Never a lane judgment.
 */
async function runModernbertProbeSmoke() {
  const base = `http://127.0.0.1:${MODELS.modernbert.port}`;
  let live, ready, probed, refused;
  try {
    live = await (await fetch(`${base}/live`)).json();
    const r1 = await fetch(`${base}/ready`);
    ready = { status: r1.status, body: await r1.json() };
    const r2 = await fetch(`${base}/probe`);
    probed = { status: r2.status, body: await r2.json() };
    const r3 = await fetch(`${base}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", labels: ["a"] }),
    });
    refused = { status: r3.status, body: await r3.json() };
  } catch (err) {
    refuseExit2(`modernbert probe unreachable at ${base}: ${err.message}`);
  }
  const probs = [];
  if (live?.alive !== true) probs.push("/live not alive");
  if (ready?.status !== 200 || ready?.body?.status !== "ready") probs.push("/ready not 200-ready");
  const pb = probed?.body ?? {};
  if (probed?.status !== 200 || pb.probe !== "mlm-forward-pass" || !Array.isArray(pb.logits_shape) || pb.logits_shape.length !== 3 || typeof pb.top_token !== "string") probs.push("/probe shape violation");
  if (refused?.status !== 409 || refused?.body?.code !== "no_zero_shot") probs.push("/predict not an honest 409 no_zero_shot");
  if (probs.length > 0) throw new Error(`modernbert probe smoke violation: ${probs.join("; ")}`);
  console.log(
    `ok - modernbert probe: ready device=${ready?.body?.device ?? "?"} ` +
    `probe_top=${JSON.stringify(pb.top_token)} seq=${pb.sequence_length} ` +
    `probe_latency_ms=${round1(pb.latency_ms)} predict=409 no_zero_shot`,
  );
}

async function runBackendMatrix(backend, laneNames) {
  const lanes = {};
  const probes = {};
  for (const lane of laneNames) {
    const suite = SUITES[lane];
    let conn;
    try {
      conn = await connectG3(lane, backend);
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

/**
 * ModernBERT probe capture (no lanes exist for a backbone): GET /live +
 * /ready + /models + /probe + POST /predict (expects the honest 409).
 * Saved verbatim into modernbert-probe/ as the versioned probe evidence.
 * Connection failure is an exit-2 refusal, never a silent stub.
 */
async function captureModernbertProbe() {
  const base = `http://127.0.0.1:${MODELS.modernbert.port}`;
  const get = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let live, ready, models, probed, refused;
  try {
    live = await get("/live");
    ready = await get("/ready");
    models = await get("/models");
    probed = await get("/probe");
    const r = await fetch(`${base}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Please refund my last payment.", labels: ["refund", "cancel", "other"] }),
    });
    refused = { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (err) {
    console.error(`REFUSED (exit 2): modernbert probe unreachable at ${base}: ${String(err?.message ?? err).split("\n")[0]}`);
    process.exit(2);
  }
  return { baseUrl: base, live, ready, models, probed, refused };
}

function saveModernbertProbe(outRoot, captured, ctx) {
  const dir = path.join(outRoot, OUT_SUBDIR.modernbert);
  fs.mkdirSync(dir, { recursive: true });
  const doc = {
    generated: "bench-ronda3 G3 modernbert probe evidence (NO lanes: a masked-LM backbone has no zero-shot axis; GET /probe proves load+run, POST /predict proves the honest 409 refusal)",
    date: ctx.finished,
    ...ctx.git,
    model_repo: MODELS.modernbert.repo,
    model_revision: null,
    model_revision_source: "unpinned",
    model_revision_note: `the modernbert probe reports no revision pin (revision null + unpinned, never invented); the setup-time HF-API sha ${MODELS.modernbert.sha} lives in odd/tasks/spike-g3-backbones.md S1`,
    venv: "py/.venv-r3g3",
    backend_revisions: ctx.backendRevisions,
    captured,
    gap: "classify/screen/gate/rerank/find NOT served by modernbert (no_zero_shot 409): recorded gap, never a fake mapping; finetune-probe verdict lives in spike S4 + R3T5.",
  };
  fs.writeFileSync(path.join(dir, "probe.json"), JSON.stringify(doc, null, 2));
  console.log(`saved: ${dir}/probe.json (no lanes -- probe evidence only)`);
  return doc;
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
  console.log(`r3g3 matrix: backends [${selected.join(", ")}] x choice r1 (60) + v2 (80), policylm screen r1 (12) + v2 (32), modernbert probe only; timeout ${G3_CALL_TIMEOUT_MS}ms CPU, same oracles+scoring`);
  const all = {};
  for (const backend of selected) {
    console.log(`--- backend ${backend} (${MODELS[backend].repo}) ---`);
    if (backend === "modernbert") {
      all[backend] = { probeOnly: await captureModernbertProbe() };
    } else {
      const laneNames = backend === "policylm" ? ["screen"] : [...R1_LANES];
      all[backend] = await runBackendMatrix(backend, laneNames);
    }
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
    if (backend === "modernbert") {
      saveModernbertProbe(outRoot, all[backend].probeOnly, { finished, git: gitCommit(), backendRevisions });
      continue;
    }
    const { lanes, probes } = all[backend];
    const modelLaneNames = Object.keys(lanes);
    const fullLanes = modelLaneNames.length === R1_LANES.length;
    const dir = path.join(outRoot, OUT_SUBDIR[backend]);
    const firstProbe = probes[`${modelLaneNames[0]}x${backend}`];
    const metrics = {
      generated: `bench-ronda3 G3 live matrix, backend ${backend} (r1 independents + v2 signed; decisions via scoreIndependentDecision, same fn as score.mjs --corpus r1; judgments: [] on the row path, live signals feed wrong_confident + reliability inputs)`,
      backend, repo: MODELS[backend].repo,
      corpus: backend === "policylm" ? { r1_screen: 12, v2_screen: 32 } : { r1: 60, v2: 80 },
      timeout_ms: G3_CALL_TIMEOUT_MS,
      lanes,
    };
    const laneRow = (tag, corpus, lane, src) => {
      const L = src === "model" ? lanes[lane] : layaLanes?.[lane];
      if (!L) return null;
      const sel = corpus === "r1" ? L.r1 : L.v2;
      return { corpus, primitive: lane, lane: tag, decision: sel.decision, task: sel.task, abstained: null, threw: null, source: src === "model" ? `${path.relative(repoRoot, dir)}` : `${path.relative(repoRoot, path.join(outRoot, OUT_SUBDIR.laya))} (baseline)` };
    };
    const rows = [];
    for (const lane of modelLaneNames) {
      const m = laneRow(backend, "r1", lane, "model");
      if (m) rows.push(m);
      const b = layaLanes ? laneRow("laya-baseline", "r1", lane, "baseline") : null;
      rows.push(b ?? { corpus: "r1", primitive: lane, lane: "laya-baseline", decision: null, task: null, note: "baseline not run in this invocation (run --model all or laya)" });
    }
    for (const lane of modelLaneNames.filter((l) => V2_LANES.includes(l))) {
      const m = laneRow(backend, "v2", lane, "model");
      if (m) rows.push(m);
      const b = layaLanes ? laneRow("laya-baseline", "v2", lane, "baseline") : null;
      rows.push(b ?? { corpus: "v2", primitive: lane, lane: "laya-baseline", decision: null, task: null, note: "baseline not run in this invocation (run --model all or laya)" });
    }
    const modelR1 = modelLaneNames.map((lane) => ({ decision: lanes[lane].r1.decision, task: lanes[lane].r1.task }));
    const modelV2 = modelLaneNames.filter((l) => V2_LANES.includes(l)).map((lane) => ({ decision: lanes[lane].v2.decision, task: lanes[lane].v2.task }));
    const baseR1 = layaLanes ? modelLaneNames.filter((l) => layaLanes[l]).map((lane) => ({ decision: layaLanes[lane].r1.decision, task: layaLanes[lane].r1.task })) : null;
    const baseV2 = layaLanes ? modelLaneNames.filter((l) => V2_LANES.includes(l) && layaLanes[l]).map((lane) => ({ decision: layaLanes[lane].v2.decision, task: layaLanes[lane].v2.task })) : null;
    const totals = fullLanes
      ? {
        r1_model_60: sumParts(modelR1),
        r1_baseline_60: baseR1 ? sumParts(baseR1) : null,
        r1_champion_r3i_60: { decision: { n: 60, correct: 56, accuracy: 56 / 60 }, task: { n: 60, correct: 56, accuracy: 56 / 60 }, source: "evals/results/v20 (r3a+qwen-find)" },
        combined_model_140: sumParts([...modelR1, ...modelV2]),
        combined_baseline_140: baseR1 && baseV2 ? sumParts([...baseR1, ...baseV2]) : null,
      }
      : {
        r1_model_12: sumParts(modelR1),
        r1_baseline_12: baseR1 ? sumParts(baseR1) : null,
        r1_champion_r3i_screen_12: { decision: { n: 12, correct: 10, accuracy: 10 / 12 }, task: { n: 12, correct: 10, accuracy: 10 / 12 }, source: "evals/results/v20 (r3a+qwen-find; screen lane gliclass(r3a), verified 2026-10-12)" },
        r1_champion_r3i_composed_60: { decision: { n: 60, correct: 56, accuracy: 56 / 60 }, task: { n: 60, correct: 56, accuracy: 56 / 60 }, source: "evals/results/v20 (r3a+qwen-find)" },
        combined_model_44: sumParts([...modelR1, ...modelV2]),
        combined_baseline_44: baseR1 && baseV2 ? sumParts([...baseR1, ...baseV2]) : null,
      };
    const composed = {
      generated: `bench-ronda3 G3 composed table: ${backend} lanes + laya-multilingual baseline in EVERY row group (computed from manifests, not tuned)`,
      baseline: layaLanes ? `${path.relative(repoRoot, path.join(outRoot, OUT_SUBDIR.laya))}` : "not run in this invocation",
      rows,
      totals,
      promotion_note: "measurement only: no promotion verdict here (spike S4 + parent R3T6 decide adopt/tie/discard from these numbers, strictly-no-worse vs r3i 56/60+56/60 on the r1 slice, screen 10/12 for the policylm subset)",
      ...(fullLanes ? {} : {
        coverage_gaps: POLICYLM_GAPS,
        coverage_note: "policylm serves screen ONLY (honest subset: policy-violation framing has no topic axis). classify/gate/rerank/find are recorded gaps, never faked runs.",
      }),
    };
    const manifest = {
      generated: `bench-ronda3 G3 R3T4 reproducibility manifest (LIVE backend ${backend}; absolutes + method, no improvement claims, no promotion)`,
      date: finished,
      ...gitCommit(),
      model: firstProbe?.model ?? MODELS[backend].repo,
      model_note: "live backend model inventory name (verbatim probe)",
      model_repo: MODELS[backend].repo,
      model_revision: null,
      model_revision_source: "unpinned",
      model_revision_note: `the ${backend} sidecar reports no revision pin (revision null + unpinned, never invented); the setup-time HF-API sha ${MODELS[backend].sha ?? "n/a (laya cache pre-existing)"} lives in odd/tasks/spike-g3-backbones.md S1 (policylm additionally reports pinned revision v1.2, the ronda1 pattern)`,
      tokenizer: "unknown",
      tokenizer_note: "explicit unknown: no tool or probe exposes a tokenizer",
      device: firstProbe?.device ?? `unknown (${backend} backend did not report a device)`,
      device_note: "probed LIVE from GET /ready (or the explicit unknown string when the backend reported no device)",
      backend: {
        mode: "live", live: true, reachable: true, baseUrl: firstProbe?.baseUrl ?? `http://127.0.0.1:${MODELS[backend].port}`,
        server: MODELS[backend].server,
        venv: backend === "policylm" ? "py/.venv-r3g3-policylm (isolated: transformers 4.57.6 per the model card, pip check clean)" : "py/.venv-r3g3 (group venv, pip check clean)",
        venv_note: "laya-multilingual baseline served unmodified on :8765 from its own pre-existing process/venv (never touched by G3 setup)",
        ready: firstProbe?.ready ?? null, device: firstProbe?.device ?? null,
        models: firstProbe?.models ?? [], model: firstProbe?.model ?? null,
        revisions: backendRevisions,
        probes,
        note: "G3 choice sidecars (minilm, gliclass-stock) serve the production POST /predict {text, labels} contract (stdlib http.server, lazy single-flight load, 413 guards); policylm serves POST /predict {message, categories} (explicit-mode single category, ronda1 pattern); gate fan-out = one POST per claim lane-side (choice backends); find = query-as-text vs candidate texts lane-side; omission lives lane-side (servers always return scores)",
      },
      backend_revisions: backendRevisions,
      backend_revisions_note: "per-backend revision pins (env pins win, else backend-reported, else unpinned null; a hash is never invented)",
      policy: ["classify", "code-review", "compare", "decide", "extract", "find", "gate", "normal", "pii", "rerank", "review", "screen", "security", "verify"].map((name) => ({ name, version: "1.0.0" })),
      policy_note: "live registry truth (availability-independent); 14 entries",
      schema_version: "1.0.0",
      software: { node: process.version, platform: process.platform, arch: process.arch, package_version: pkg.version ?? null },
      hardware: { arch: os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, totalmem_mb: Math.round(os.totalmem() / 1048576) },
      config: {
        backend, corpus: backend === "policylm" ? { r1_screen: 12, v2_screen: 32 } : { r1: 60, v2: 80 }, lanes: modelLaneNames, timeout_ms: G3_CALL_TIMEOUT_MS,
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
      method: `G3 matrix: per-case wall (performance.now round trip) + backend-reported latencyMs per predict call. Routing OFF (pure argmax + omit-on-ABSTAIN/null; gate and screen taus null -- first-measurement pin, never tuned on r1/v2); fixed argmax->band magnitudes at public policy centers (gate 0.9/0.1 vs claimVerified 0.8; screen 0.92/0.5/0.1 vs 0.75/0.25; gate rubric 2/2/0.95 + screen substance/relevance 0.9/0.9 documented lane constants; find argmax id->score, 1/N baseline inside handler). Scoring backends: minilm = per-label NLI entailment probability (hypothesis "This example is {}.", entail id resolved live from config); gliclass-stock = ZeroShotClassificationPipeline multi-label scores; policylm = explicit-mode single-category score (injection leg only). Per-case rows carry raw backend scores + margins for threshold design; verdicts never read them. Reliability inputs recorded, no ECE claimed. No cross-machine comparison.`,
      gold_corpus: fullLanes
        ? {
          r1_independent: 60, v2_signed: 80, oracle_stub: 0, total: 140,
          per_suite: [
            ...modelLaneNames.map((lane) => ({ suite: lane, r1: 12, v2: V2_LANES.includes(lane) ? V2[lane].length : 0 })),
          ],
        }
        : {
          r1_screen: 12, v2_screen: 32, oracle_stub: 0, total: 44,
          per_suite: [{ suite: "screen", r1: 12, v2: V2.screen.length }],
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
      g3: {
        venv: backend === "policylm" ? "py/.venv-r3g3-policylm" : "py/.venv-r3g3",
        venv_note: "group venv pins recorded at setup (spike S1): torch 2.14.1+cpu, transformers 5.19.0, onnxruntime 1.31.0, tokenizers 0.23.3, safetensors 0.8.0, huggingface_hub 2.2.0, numpy 2.4.6, gliclass 0.1.20, pip check clean (not re-resolved here); policylm isolated venv: torch 2.14.1+cpu, transformers 4.57.6 (card pin), huggingface_hub 0.36.2, safetensors, tokenizers 0.22.2, numpy 2.4.6, pip check clean",
        thresholds: "OFF: pure argmax + omit-on-ABSTAIN/null (gate and screen taus null); NOT tuned here and NEVER on r1/v2",
        adjudication: "choice backends: classify item-text vs criteria keys; gate one POST per claim (evidence || claim, 3 labels) -> claim/refute noul pair; screen text + 3 labels -> injection noul; rerank query-as-text + candidate texts -> noul order; find query-as-text + candidate texts -> exists choice; see G3ChoiceClient above. policylm: screen text via explicit-mode single category (prompt injection) -> injection noul only (substance/relevance omitted -> handler ESCALATEs); all other policylm lanes are recorded gaps (POLICYLM_GAPS). modernbert: no lanes (probe only).",
      },
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(metrics, null, 2));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, "composed.json"), JSON.stringify(composed, null, 2));
    console.log(`saved: ${dir}/manifest.json + metrics.json + composed.json`);
    const t = composed.totals;
    const mKey = fullLanes ? "r1_model_60" : "r1_model_12";
    const bKey = fullLanes ? "r1_baseline_60" : "r1_baseline_12";
    const cKey = fullLanes ? "combined_model_140" : "combined_model_44";
    const champ = fullLanes ? "champion r3i 56/60 + 56/60" : "champion r3i screen 10/12 + 10/12";
    console.log(
      `composed ${backend}: r1 model dec ${t[mKey].decision.correct}/${t[mKey].decision.n} task ${t[mKey].task.correct}/${t[mKey].task.n} | ` +
      `r1 baseline ${t[bKey] ? `${t[bKey].decision.correct}/${t[bKey].decision.n} + ${t[bKey].task.correct}/${t[bKey].task.n}` : "n/a"} | ` +
      `${champ} | combined model dec ${t[cKey].decision.correct}/${t[cKey].decision.n} task ${t[cKey].task.correct}/${t[cKey].task.n}`,
    );
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log([
    "usage: node evals/smoke-r3g3-lanes.mjs [--live] | --matrix [--out <dir>] [--model <minilm|gliclass-stock|policylm|modernbert|laya>]",
    "  (no flag / --live)  19-check versioned smoke (5 lanes x 2 choice backends + policylm screen x5 + modernbert probe x4) -- exit 0 green, 2 backend down, 1 other failure.",
    "  --matrix   live matrix (choice backends r1 60 + v2 80; policylm screen r1 12 + v2 32; modernbert probe only; laya baseline in every table) -> evals/results/v23-g3-matrix/ (or --out <dir>).",
    "  --model    matrix backends subset (default: all 5 incl. laya baseline).",
    "  --out      matrix output root (model subdirs must not exist non-empty; never overwrites).",
  ].join("\n"));
  process.exit(0);
}

try {
  if (args.includes("--matrix")) {
    const i = args.indexOf("--out");
    const outRoot = i !== -1 ? path.resolve(args[i + 1] ?? "") : path.join(repoRoot, "evals", "results", "v23-g3-matrix");
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
