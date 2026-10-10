/**
 * r3a-lanes G4: versioned lane smoke + full live matrix for the 4 gliclass
 * lanes (classify/gate/screen/rerank) over the r1 independent corpus (48
 * cases: 12 per lane, 6 EN + 6 ES, gold_source "independent").
 *
 * MODES (both versioned here -- this file closes the T6a unversioned-smoke
 * debt; no ad-hoc node -e matrix commands):
 *   node evals/smoke-r3a-lanes.mjs
 *     Programmatic smoke: ONE r1 case per lane (ids pinned in SMOKE_CASES
 *     below) against the running gliclass sidecar (:8770), asserting the
 *     score.mjs result shape per lane (body.decision{decision},
 *     body.abstention{abstained}, task fields per metrics.mjs) + exit 0.
 *   node evals/smoke-r3a-lanes.mjs --matrix [--out <dir>]
 *     Full matrix over r1 for the 4 gliclass lanes -> <dir> (default
 *     evals/results/v11/): manifest.json + metrics.json (per-case rows via
 *     scoreIndependentDecision, the same fn score.mjs --corpus r1 uses;
 *     judgments: [] on the R1 path, which excludes signals) + composed.json
 *     (r3a lanes + qwen/gte find columns READ from evals/results/v8+v9 --
 *     those servers are never re-run). Refuses to overwrite a non-empty
 *     out dir (new version per run, never silently).
 *
 * EXIT CODES: 0 green; 2 backend refused (sidecar down at :8770 -- probe
 * refusal, never a silent stub); 1 any other failure (shape/assert/IO).
 * This script never starts a server: boot it first with
 * GLICLASS_MODEL=<r3a checkpoint abs path> py/.venv-r1/bin/python
 * py/gliclass_server.py (port 8770). The r3a pin (run-dir + GLICLASS_MODEL
 * + sha256 of model.safetensors, COMPUTED here from the file, never
 * invented) lands in the manifest r3a block.
 *
 * MEASUREMENT, NOT PROMOTION: thresholds OFF (pure 3-way argmax +
 * omit-on-ABSTAIN/null, no margin m, no tau -- tuning them is Fase-2 work
 * on validation data, NEVER on r1). Fixed argmax->handler-band magnitudes
 * (see evals/lanes-r1.mjs GLICLASS_* constants) sit at the public policy
 * band centers, chosen a priori, never from r1 outcomes. Per-case rows
 * carry the raw gliclass scores + margins (gliclass block) so Fase-2 can
 * design m/tau from evidence; verdicts never read them.
 *
 * wrong_confident on live signals: the R1 row path excludes signals
 * (judgments: []), but the per-lane wrong_confident block below is computed
 * from REAL backend outputs (classify winner_probability, gate per-claim
 * support, screen injection noul -- the score.mjs SIGNAL_MAP), never stub
 * oracle values. Rerank reports no-aplica (relevance is within-call only by
 * contract). Taus are REPORTING slices, never prod cutoffs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  connectLane,
  probeLane,
  GliclassClient,
  lanePredictFactory,
  LANE_CALL_TIMEOUT_MS,
  GLICLASS_GATE_MARGIN_TAU,
  GLICLASS_SCREEN_MARGIN_TAU,
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

const R3A_RUN_DIR = "run-20261009T055724Z-r3a";
const R3A_CHECKPOINT_DEFAULT =
  "/home/andragon/Documents/GitHub/laya-mcp-finetune-gliclass/artifacts-ft/run-20261009T055724Z-r3a/checkpoint";
const GLICLASS_MODEL = process.env.GLICLASS_MODEL ?? R3A_CHECKPOINT_DEFAULT;

const SUITES = { classify, gate, screen, rerank };
const MATRIX_LANES = ["classify", "gate", "screen", "rerank"];

/** Versioned smoke pins: exactly one r1 case per lane (normal class). */
const SMOKE_CASES = [
  { lane: "classify", caseId: "r1-classify-en-normal-01" },
  { lane: "gate", caseId: "r1-gate-en-normal-01" },
  { lane: "screen", caseId: "r1-screen-en-normal-01" },
  { lane: "rerank", caseId: "r1-rerank-en-normal-01" },
];

const GATE_VERDICTS = new Set(["SUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE", "ABSTAIN"]);
const SCREEN_ASSESSMENTS = new Set(["valid", "ambiguous", "irrelevant", "malicious-instruction"]);

const round1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);

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
  }
  if (probs.length > 0) throw new Error(`smoke shape violation (${lane}): ${probs.join("; ")}`);
}

function taskOf(lane, body) {
  if (lane === "classify") return (body.classifications ?? []).map((c) => c.classification);
  if (lane === "gate") return (body.claims ?? []).map((c) => c.verdict);
  if (lane === "screen") return body.assessment;
  if (lane === "rerank") return (body.ranked ?? []).map((r) => r.id);
  return null;
}

async function connectOrRefuse(lane) {
  try {
    return await connectLane(lane, "gliclass");
  } catch (err) {
    if (String(err?.message ?? err).includes("refused (exit 2)")) {
      console.error(`REFUSED lane ${lane} x gliclass (exit 2): ${String(err.message).split("\n")[0]}`);
      process.exit(2);
    }
    throw err;
  }
}

async function runSmoke() {
  console.log("r3a-lanes smoke: 1 r1 case x 4 gliclass lanes (backend :8770; down -> exit 2)");
  for (const { lane, caseId } of SMOKE_CASES) {
    const { probe, deps } = await connectOrRefuse(lane);
    const c = r1CasesFor(lane).find((x) => x.id === caseId);
    if (!c) throw new Error(`smoke case ${caseId} not found in r1 corpus (${lane})`);
    const t0 = performance.now();
    const body = await SUITES[lane].invoke(deps, c.input, c.stub, {});
    const wall = performance.now() - t0;
    assertSmokeShape(lane, body);
    console.log(
      `ok - ${lane} x gliclass / ${caseId}: decision=${body.decision.decision} ` +
      `abstained=${body.abstention.abstained} task=${JSON.stringify(taskOf(lane, body))} ` +
      `wall_ms=${round1(wall)} reported_latency_ms=${round1(body.latency_ms)} (device=${probe.device ?? "unreported"})`,
    );
  }
  console.log("smoke: 4/4 lanes green (exit 0)");
}

/** Live-signal judgments for wrong_confident (score.mjs SIGNAL_MAP). */
function judgmentsFor(suiteName, body, gold) {
  const flag = body?.abstention?.abstained === true;
  const J = (correct, signal) => ({ correct, signal: typeof signal === "number" ? signal : null, abstained: flag, threw: false });
  if (suiteName === "classify") {
    const want = gold.classifications !== undefined ? gold.classifications : gold.classification !== undefined ? [gold.classification] : null;
    return (body?.classifications ?? []).map((c, i) => J(want === null ? true : c.classification === want[i], c.winner_probability));
  }
  if (suiteName === "gate") {
    const want = goldVerdictList(gold);
    return (body?.claims ?? []).map((c, i) => J(want === null ? true : c.verdict === want[i], c.signal));
  }
  if (suiteName === "screen") {
    return [J(body?.decision?.decision === gold.decision, body?.signals?.injection?.signal)];
  }
  return []; // rerank: no aplica (within-call scores, never comparable)
}

const WRONG_SIGNAL_NAME = {
  classify: "winner_probability",
  gate: "per-claim support signal",
  screen: "injection signal",
  rerank: null,
};

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
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

async function runMatrix(outDir) {
  const outTag = path.relative(repoRoot, path.resolve(outDir));
  const routingClause = `Routing (validation-seeded, never r1-tuned): gate ${GLICLASS_GATE_MARGIN_TAU === null ? "OFF (dead: ABSTAIN golds confidently SUPPORTED)" : `tau=${GLICLASS_GATE_MARGIN_TAU}`} ; screen ${GLICLASS_SCREEN_MARGIN_TAU === null ? "OFF" : `tau=${GLICLASS_SCREEN_MARGIN_TAU} (raw-margin omit → handler ESCALATE)`}; argmax otherwise`;
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    console.error(`refusing to overwrite non-empty ${outDir} (new version per run; pass --out <empty dir>)`);
    process.exit(2);
  }
  const started = new Date().toISOString();
  console.log(`r3a-lanes matrix: 4 gliclass lanes x 12 r1 cases (GLICLASS_MODEL=${GLICLASS_MODEL})`);
  const safetensors = path.join(GLICLASS_MODEL, "model.safetensors");
  if (!fs.existsSync(safetensors)) {
    console.error(`checkpoint safetensors missing at ${safetensors} (pin requires the file; never invent a hash)`);
    process.exit(1);
  }
  const sha256 = await sha256File(safetensors);
  console.log(`pin: run-dir=${R3A_RUN_DIR} sha256(model.safetensors)=${sha256}`);

  const lanes = {};
  const probes = {};
  for (const lane of MATRIX_LANES) {
    const suite = SUITES[lane];
    const probe = await probeLane(lane, "gliclass");
    probes[`${lane}xgliclass`] = probe;
    if (!probe.reachable) {
      console.error(`REFUSED lane ${lane} x gliclass (exit 2): ${probe.error} -- ${probe.note}`);
      process.exit(2);
    }
    const client = new GliclassClient(probe.baseUrl);
    const deps = { fakeClient: lanePredictFactory(client) };
    const cases = r1CasesFor(suite.name);
    const rows = [];
    const judgments = [];
    const walls = [];
    let reportedTotal = 0;
    for (const c of cases) {
      client.callLog = [];
      const t0 = performance.now();
      try {
        const body = await suite.invoke(deps, c.input, c.stub, {});
        const wall = performance.now() - t0;
        walls.push(wall);
        const rep = typeof body?.latency_ms === "number" ? body.latency_ms : null;
        if (rep !== null) reportedTotal += rep;
        const s = scoreIndependentDecision(suite.name, body, c.gold);
        judgments.push(...judgmentsFor(suite.name, body, c.gold));
        rows.push({
          id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: false,
          wall_ms: round1(wall), reported_latency_ms: rep === null ? null : round1(rep),
          n_calls: client.callLog.length,
          abstained: body?.abstention?.abstained === true,
          decisionActual: body?.decision?.decision ?? null, decisionGold: c.gold.decision ?? null,
          taskActual: s.taskActual, taskGold: s.taskGold,
          decOk: s.decisionOk, taskOk: s.taskOk, abstOk: s.abstainedOk,
          judgments: [],
          gliclass: client.callLog.map((e) => ({
            key: e.key, top: e.top, top_score: e.top_score, margin: e.margin,
            scores: e.scores, latency_ms: round1(e.latencyMs),
          })),
        });
      } catch (err) {
        const wall = performance.now() - t0;
        walls.push(wall);
        judgments.push({ correct: false, signal: null, abstained: false, threw: true });
        rows.push({
          id: c.id, lang: c.lang ?? "en", kind: c.kind ?? null, threw: true,
          wall_ms: round1(wall), reported_latency_ms: null, n_calls: client.callLog.length,
          error: String(err?.message ?? err).split("\n")[0],
          abstained: false, decisionActual: null, decisionGold: c.gold.decision ?? null,
          taskActual: null, taskGold: null, decOk: false, taskOk: false, abstOk: false,
          judgments: [],
          gliclass: client.callLog.map((e) => ({ key: e.key, top: e.top, top_score: e.top_score, margin: e.margin, scores: e.scores, latency_ms: round1(e.latencyMs) })),
        });
      }
    }
    const scored = rows.filter((r) => !r.threw);
    const dec = splitAcc(scored, "decOk");
    const task = splitAcc(scored, "taskOk");
    const wc = lane === "rerank"
      ? { status: "no aplica", reason: "relevance_score is within-call only by contract (never comparable across calls); a single score has no correctness value, so no tau slice is meaningful." }
      : { signal: WRONG_SIGNAL_NAME[lane], taus: WRONG_CONFIDENT_TAUS, ...wrongConfident(judgments) };
    lanes[lane] = {
      laneBackend: "gliclass(r3a)", baseUrl: probe.baseUrl,
      cases: rows.length, threw: rows.length - scored.length,
      decision: dec.all, decision_en: dec.en, decision_es: dec.es,
      task: task.all, task_en: task.en, task_es: task.es,
      abstained: scored.filter((r) => r.abstained).length,
      abstention: abstentionStats(rows.map((r) => ({ threw: r.threw === true, abstained: r.abstained === true }))),
      abstention_rate: abstentionStats(rows.map((r) => ({ threw: r.threw === true, abstained: r.abstained === true }))).abstention_rate,
      wrong_confident: wc,
      wall_ms_total: round1(walls.reduce((a, b) => a + b, 0)),
      wall_ms_per_case: walls.map(round1),
      reported_latency_ms_total: round1(reportedTotal),
      rows,
    };
    const w = lanes[lane].wrong_confident.slices
      ? lanes[lane].wrong_confident.slices.map((x) => `${x.tau}:${x.rate === null ? "n/a" : x.rate.toFixed(3)}`).join(" ") : "n/a";
    console.log(
      `| ${lane} | dec ${dec.all.correct}/${dec.all.n} | task ${task.all.correct}/${task.all.n} | ` +
      `abst ${lanes[lane].abstained} threw ${lanes[lane].threw} | wc[${w}] |`,
    );
  }
  const finished = new Date().toISOString();

  const metrics = {
    generated: "r3a-lanes G4 FULL matrix, backend gliclass(r3a) (r1 independents only; decisions via scoreIndependentDecision, same fn as score.mjs --corpus r1; judgments: [] on the R1 path)",
    backend: GLICLASS_MODEL,
    corpus: "r1",
    timeout_ms: LANE_CALL_TIMEOUT_MS,
    lanes,
  };

  // Composed-system table: r3a lanes (this run) + qwen/gte find columns READ
  // from evals/results/v8+v9 (never re-run here, F7 scope: find stays qwen/gte).
  const findCols = {};
  for (const [tag, file] of [["qwen", "v8"], ["gte", "v9"]]) {
    const m = JSON.parse(fs.readFileSync(path.join(repoRoot, "evals", "results", file, "metrics.json"), "utf8"));
    const f = m.lanes.find;
    findCols[tag] = { source: `evals/results/${file}`, decision: f.decision, task: f.task, abstained: f.abstained, threw: f.threw };
  }
  const prim = (lane) => ({
    lane: "gliclass(r3a)", source: outTag,
    decision: lanes[lane].decision, task: lanes[lane].task,
    abstained: lanes[lane].abstained, threw: lanes[lane].threw,
  });
  const sum = (parts) => {
    const d = { n: 0, correct: 0 };
    const t = { n: 0, correct: 0 };
    for (const p of parts) { d.n += p.decision.n; d.correct += p.decision.correct; t.n += p.task.n; t.correct += p.task.correct; }
    d.accuracy = d.n === 0 ? null : d.correct / d.n;
    t.accuracy = t.n === 0 ? null : t.correct / t.n;
    return { decision: d, task: t };
  };
  const core = [prim("classify"), prim("gate"), prim("rerank"), prim("screen")];
  const composed = {
    generated: "r3a-lanes G4 composed-system table (computed from manifests, not tuned): r3a lanes classify/gate/rerank/screen + qwen/gte find (F7 scope)",
    rows: [
      { primitive: "classify", ...core[0] },
      { primitive: "gate", ...core[1] },
      { primitive: "rerank", ...core[2] },
      { primitive: "screen", ...core[3] },
      { primitive: "find", lane: "qwen", ...findCols.qwen },
      { primitive: "find", lane: "gte", ...findCols.gte },
    ],
    totals: {
      "r3a+qwen-find": sum([...core, { decision: findCols.qwen.decision, task: findCols.qwen.task }]),
      "r3a+gte-find": sum([...core, { decision: findCols.gte.decision, task: findCols.gte.task }]),
    },
    promotion_note: "measurement only: no promotion verdict here (parent G5 decides Fase-2 from these numbers)",
  };

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const firstProbe = probes["classifyxgliclass"];
  const backendRevisions = resolveBackendRevisions({ env: process.env });
  const manifest = {
    generated: "r3a-lanes G4 reproducibility manifest (LIVE backend gliclass(r3a); absolutes + method, no improvement claims, no promotion)",
    date: finished,
    ...gitCommit(),
    model: firstProbe?.model ?? GLICLASS_MODEL,
    model_note: "live backend model inventory name at :8770 (verbatim probe; the r3a checkpoint path when served locally)",
    model_revision: null,
    model_revision_source: "unpinned",
    model_revision_note: "the gliclass sidecar reports no revision pin (revision null + unpinned, never invented); the checkpoint pin lives in the r3a block (run-dir + path + computed sha256)",
    tokenizer: "unknown",
    tokenizer_note: "explicit unknown: no tool or probe exposes a tokenizer",
    device: firstProbe?.device ?? "unknown (gliclass backend did not report a device)",
    device_note: "probed LIVE from GET /ready (or the explicit unknown string when the backend reported no device)",
    backend: {
      mode: "live", live: true, reachable: true, baseUrl: firstProbe?.baseUrl ?? "http://127.0.0.1:8770",
      lane_env: `GLICLASS_MODEL=${GLICLASS_MODEL} (server env; from_pretrained accepts the local path verbatim)`,
      ready: firstProbe?.ready ?? null, device: firstProbe?.device ?? null,
      models: firstProbe?.models ?? [], model: firstProbe?.model ?? null,
      revisions: backendRevisions,
      probes,
      note: "r3a checkpoint served through the production gliclass sidecar (py/gliclass_server.py, unchanged: S1-S4 need no server change); gate fan-out = one POST per claim lane-side; omission lives lane-side (server always returns scores)",
    },
    backend_revisions: backendRevisions,
    backend_revisions_note: "per-backend revision pins (env pins win, else backend-reported, else unpinned null; a hash is never invented)",
    policy: ["classify", "code-review", "compare", "decide", "extract", "find", "gate", "normal", "pii", "rerank", "review", "screen", "security", "verify"].map((name) => ({ name, version: "1.0.0" })),
    policy_note: "live registry truth (availability-independent); 14 entries",
    schema_version: "1.0.0",
    software: { node: process.version, platform: process.platform, arch: process.arch, package_version: pkg.version ?? null },
    hardware: { arch: os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, totalmem_mb: Math.round(os.totalmem() / 1048576) },
    config: {
      backend: "gliclass(r3a)", corpus: "r1", lanes: [...MATRIX_LANES], timeout_ms: LANE_CALL_TIMEOUT_MS,
      lane_env: `GLICLASS_MODEL=${GLICLASS_MODEL}`,
      run_env: { GLICLASS_MODEL },
      started, finished,
    },
    mode: {
      mcp: "observe",
      mcp_note: "the MCP layer only observes and reports judgments; it never acts, under every policy mode",
      policy: "observe (default)",
      policy_note: "effective global policy-decision mode resolution input (verbatim env or default)",
    },
    method: `r3a-lanes FULL matrix: per-case wall (performance.now round trip) + backend-reported latencyMs summed over the predict calls of that case. ${routingClause}; fixed argmax->band magnitudes at public policy centers (gate 0.9/0.1 vs claimVerified 0.8; screen 0.92/0.5/0.1 vs 0.75/0.25; gate rubric 2/2/0.95 + screen substance/relevance 0.9/0.9 documented lane constants). Per-case rows carry raw gliclass scores + margins for threshold design; verdicts never read them. No cross-machine comparison.`,
    gold_corpus: {
      independent: 48, oracle_stub: 0, total: 48,
      per_suite: MATRIX_LANES.map((lane) => ({ suite: lane, total: 12, independent: 12, oracle_stub: 0 })),
    },
    gold_corpus_note: "r1-only run: all 48 golds are human-fixed independent truth (spike-grade: the live backend is judged against them); stub answers are ignored by the lane (live deps forward real questions)",
    honesty: [
      "absolutes only; no cross-machine comparison; no improvement claimed (no baseline exists); no promotion verdict (parent G5)",
      "thresholds OFF and untouched (no m, no tau); wrong_confident taus remain reporting slices, never prod cutoffs",
      "gate rubric + screen substance/relevance are documented lane constants, not tuned values (GLiClass has no such notions)",
      "find column reused from evals/results/v8 (qwen) + v9 (gte) manifests (read-only; those servers never re-run here)",
      "checkpoint bytes stay out of git (F7 rule); pinned by computed sha256 + run-dir + path only",
    ],
    links: { metrics: { suites: null }, composed: { table: null } },
    server_reported_revisions: Object.fromEntries(
      (firstProbe?.models ?? []).map((m) => [m?.name ?? GLICLASS_MODEL, { revision: m?.revision ?? null, revision_source: m?.revision_source ?? "unpinned", loaded: m?.loaded ?? null }]),
    ),
    r3a: {
      run_dir: R3A_RUN_DIR,
      checkpoint: GLICLASS_MODEL,
      safetensors_sha256: sha256,
      safetensors_note: "sha256 of model.safetensors, computed at matrix time via streaming read (never invented)",
      thresholds: "OFF: pure argmax + omit-on-ABSTAIN/null (gate m=0/tau=0 equivalent; screen no threshold); NOT tuned here and NEVER on r1",
      adjudication: "classify unchanged; gate one POST per claim (evidence || claim, 3 labels) -> claim/refute noul pair; screen text + 3 labels -> injection noul; rerank query-as-text + candidate texts -> noul order; see evals/lanes-r1.mjs GLICLASS_* constants",
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "composed.json"), JSON.stringify(composed, null, 2));
  console.log(`\nsaved: ${outDir}/manifest.json + metrics.json + composed.json`);
  console.log("composed-system table (r3a lanes + qwen/gte find, computed from manifests):");
  console.log("| primitive | lane | dec | task |");
  console.log("|-----------|------|-----|------|");
  for (const r of composed.rows) {
    console.log(`| ${r.primitive} | ${r.lane} | ${r.decision.correct}/${r.decision.n} | ${r.task.correct}/${r.task.n} |`);
  }
  for (const [k, v] of Object.entries(composed.totals)) {
    console.log(`TOTAL ${k}: decision ${v.decision.correct}/${v.decision.n} task ${v.task.correct}/${v.task.n}`);
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log([
    "usage: node evals/smoke-r3a-lanes.mjs [--matrix [--out <dir>]]",
    "  (no flag)  4-lane versioned smoke (1 r1 case per lane) -- exit 0 green, 2 backend down, 1 other failure.",
    "  --matrix   full r1 matrix (48 cases) -> evals/results/v11/ (or --out <empty dir>).",
    "  --out      matrix output dir (must not exist non-empty; never overwrites).",
  ].join("\n"));
  process.exit(0);
}

try {
  if (args.includes("--matrix")) {
    const i = args.indexOf("--out");
    const outDir = i !== -1 ? path.resolve(args[i + 1] ?? "") : path.join(repoRoot, "evals", "results", "v11");
    if (i !== -1 && !args[i + 1]) throw new Error("--out needs a directory value");
    await runMatrix(outDir);
  } else {
    await runSmoke();
  }
} catch (err) {
  console.error(`FAILED: ${String(err?.message ?? err).split("\n").slice(0, 4).join(" | ")}`);
  process.exit(1);
}
