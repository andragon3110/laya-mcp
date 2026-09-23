/**
 * Fase-7 T4 metrics runner: applies evals/metrics.mjs to the 11 T3 suites.
 *
 * SCOPE (T4 only): run every suite case against the REAL handler (from
 * dist/) with the same oracle-derived deterministic stub as evals/run.mjs,
 * binarize each output against its gold, and report per-primitive metrics
 * + wrong_confident_rate slices. No benchmarks (T5), no versioned
 * results/ (T5 owns evals/results/); this runner saves to --out
 * (default artifacts/, untracked) or prints --json to stdout.
 *
 * STUB HONESTY (inherits T3): signals are oracle-assigned, so every number
 * below measures harness + handler plumbing under a stub ceiling -- NOT
 * backend quality. Nothing here transfers to the real backend.
 *
 * SIGNAL MAP for wrong_confident (one honest signal per primitive):
 *   classify/decide/find/extract/compare -> winner_probability (top choice share)
 *   verify/gate                  -> per-claim support signal (noul)
 *   screen                       -> injection signal (the safety-relevant noul;
 *                                   substance/relevance are audit-only)
 *   review                       -> safe_to_apply signal
 *   pii                          -> max detector_score over findings
 *                                   (null when zero findings -> excluded)
 *   rerank                       -> NO APLICA: relevance_score is within-call
 *                                   only by contract, never comparable, and a
 *                                   single score has no correctness value.
 * Taus (0.70/0.80/0.90/0.95) are REPORTING slices, NEVER prod thresholds.
 *
 * DENOMINATORS (nulls/abstentions out, counts always reported):
 *   decision/task accuracy: all non-throw cases (fail-fast throws are
 *     limit tests, not quality judgments; counted in abstention.errors).
 *   binary P/R/F1 (ALLOW polarity): non-throw AND non-abstained cases only
 *     (abstention behavior is measured by abstention_rate instead).
 *   ranking (rerank): non-throw AND non-abstained cases only.
 *   wrong_confident: non-throw, non-abstained, non-null-signal judgments.
 *
 * Run from the repo root: node evals/score.mjs [--json] [--out <path>]
 */
import fs from "node:fs";
import path from "node:path";
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
import {
  WRONG_CONFIDENT_TAUS,
  abstentionStats,
  binaryMetrics,
  decisionAccuracy,
  meanRanking,
  rankingMetrics,
  wrongConfident,
} from "./metrics.mjs";

const SUITES = [classify, decide, verify, screen, pii, extract, find, rerank, review, gate, compare];

/* Same oracle-stub deps as evals/run.mjs (canonical orchestration there). */
const fakeClient = (answers, capture) => ({
  predict: async (_args, questions) => {
    if (capture) capture.questions = questions;
    return { answers, confidence: {}, routing: {}, model: "evals-oracle-stub", latencyMs: 0, usage: {} };
  },
});
const makePiiCtx = (findings) => ({
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
});
const deps = { fakeClient, makePiiCtx };

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const goldLabels = (gold) =>
  gold.classifications !== undefined ? gold.classifications : gold.classification !== undefined ? [gold.classification] : null;
const goldVerdicts = (gold) =>
  gold.verdicts !== undefined ? gold.verdicts : gold.verdict !== undefined ? [gold.verdict] : null;

/**
 * Per-suite task extraction: { taskActual, taskGold, hasTask, judgments }
 * where each judgment is { correct, signal } for wrong_confident. Signals
 * follow the SIGNAL_MAP above; suites without a signal return judgments
 * with signal: null plus a wrongNote (rerank: never; review/gate scores:
 * n/a). hasTask is false only when the gold defines no task output
 * (limit throws never reach here); explicit null golds (extract null
 * value, decide null selection) ARE tasks and must be counted.
 */
function extractJudgments(suiteName, body, gold) {
  switch (suiteName) {
    case "classify": {
      const pred = body.classifications.map((c) => c.classification);
      const labels = goldLabels(gold);
      return {
        taskActual: pred,
        taskGold: labels,
        judgments: body.classifications.map((c, i) => ({
          correct: labels ? c.classification === labels[i] : true,
          signal: c.winner_probability ?? null,
        })),
      };
    }
    case "decide":
      return {
        taskActual: body.selected,
        taskGold: gold.selected ?? null,
        hasTask: "selected" in gold,
        judgments: [{ correct: gold.selected === undefined || body.selected === gold.selected, signal: body.winner_probability ?? null }],
      };
    case "verify":
    case "gate": {
      const rows = suiteName === "verify" ? body.verdicts : body.claims;
      const gv = goldVerdicts(gold);
      return {
        taskActual: rows.map((v) => v.verdict),
        taskGold: gv,
        judgments: rows.map((v, i) => ({ correct: gv ? v.verdict === gv[i] : true, signal: v.signal ?? null })),
      };
    }
    case "screen":
      return {
        taskActual: body.assessment,
        taskGold: gold.assessment ?? null,
        judgments: [{ correct: body.decision.decision === gold.decision, signal: body.signals.injection.signal ?? null }],
      };
    case "pii": {
      const scores = (body.findings ?? []).map((f) => f.detector_score).filter((s) => typeof s === "number");
      return {
        taskActual: body.secrets_found,
        taskGold: gold.secrets_found ?? null,
        judgments: [{ correct: body.decision.decision === gold.decision, signal: scores.length > 0 ? Math.max(...scores) : null }],
      };
    }
    case "extract":
      return {
        taskActual: body.results[0]?.value ?? null,
        taskGold: gold.value !== undefined ? gold.value : null,
        hasTask: "value" in gold,
        judgments: [
          {
            correct: gold.value !== undefined ? (body.results[0]?.value ?? null) === gold.value : true,
            signal: body.results[0]?.winner_probability ?? null,
          },
        ],
      };
    case "find":
      return {
        taskActual: body.winner,
        taskGold: gold.winner ?? null,
        judgments: [{ correct: gold.winner === undefined || body.winner === gold.winner, signal: body.winner_probability ?? null }],
      };
    case "compare":
      return {
        taskActual: body.overall.relation ?? null,
        taskGold: gold.relation ?? null,
        hasTask: "relation" in gold,
        judgments: [{ correct: gold.relation === undefined || body.overall.relation === gold.relation, signal: body.overall.winner_probability ?? null }],
      };
    case "review":
      return {
        taskActual: body.decision.decision,
        taskGold: gold.decision,
        judgments: [{ correct: body.decision.decision === gold.decision, signal: body.rubric.safe_to_apply.signal ?? null }],
      };
    case "rerank":
      return { taskActual: body.ranked.map((r) => r.id), taskGold: gold.order ?? null, judgments: [], wrongNote: "no aplica" };
    default:
      return { taskActual: null, taskGold: null, judgments: [] };
  }
}

const FAMILY = { rerank: "ranking", review: "agreement", gate: "agreement" };

async function scoreSuite(suite) {
  const rows = [];
  for (const c of suite.cases) {
    const capture = {};
    try {
      const body = await suite.invoke(deps, c.input, c.stub, capture);
      if (c.expectError) {
        rows.push({ id: c.id, threw: false, unexpectedPass: true, gold: c.gold });
      } else {
        const ext = extractJudgments(suite.name, body, c.gold);
        rows.push({
          id: c.id,
          threw: false,
          abstained: body.abstention.abstained === true,
          decisionActual: body.decision.decision,
          decisionGold: c.gold.decision,
          ...ext,
        });
      }
    } catch (err) {
      rows.push({ id: c.id, threw: true, expectedThrow: c.expectError !== undefined && String(err?.message ?? err).includes(c.expectError) });
    }
  }
  const usable = rows.filter((r) => !r.threw && !r.unexpectedPass);
  const family = FAMILY[suite.name] ?? "binary";
  const out = {
    suite: suite.name,
    primitive: suite.primitive,
    family,
    cases: rows.length,
    abstention: abstentionStats(rows.map((r) => ({ threw: r.threw === true || r.unexpectedPass === true, abstained: r.abstained === true }))),
    decision: decisionAccuracy(usable.filter((r) => r.decisionGold !== undefined).map((r) => ({ actual: r.decisionGold, predicted: r.decisionActual }))),
  };
  const judged = usable.filter((r) => !r.abstained && r.decisionGold !== undefined);
  if (family === "ranking") {
    const ranked = usable.filter((r) => !r.abstained && Array.isArray(r.taskGold));
    out.ranking = {
      n: ranked.length,
      excluded_abstained_or_throw: usable.length - ranked.length + (rows.length - usable.length),
      ...meanRanking(ranked.map((r) => rankingMetrics(r.taskActual, r.taskGold))),
    };
    out.wrong_confident = { status: "no aplica", reason: "relevance_score is within-call only by contract (never comparable across calls); a single score has no correctness value, so no tau slice is meaningful." };
  } else {
    const taskRows = usable.filter((r) => (r.hasTask !== undefined ? r.hasTask : r.taskGold !== null && r.taskGold !== undefined));
    const taskCorrect = taskRows.filter((r) => eq(r.taskActual, r.taskGold)).length;
    out.task = { n: taskRows.length, correct: taskCorrect, accuracy: taskRows.length === 0 ? null : taskCorrect / taskRows.length };
    if (family === "binary") {
      out.binary_allow_polarity = binaryMetrics(
        judged.map((r) => ({ actual: r.decisionGold === "ALLOW", predicted: r.decisionActual === "ALLOW" })),
      );
    } else {
      out.score_agreement = { status: "no computable en T3", reason: "T3 golds hold decisions, not rubric-score oracles; see scoreAgreement() in evals/metrics.mjs for the T5+ definition." };
    }
    const judgments = usable.flatMap((r) => r.judgments.map((j) => ({ ...j, threw: false, abstained: r.abstained })));
    out.wrong_confident = { signal: suite.name === "screen" ? "injection signal" : suite.name === "review" ? "safe_to_apply signal" : suite.name === "pii" ? "max detector_score" : suite.name === "gate" || suite.name === "verify" ? "per-claim support signal" : "winner_probability", taus: WRONG_CONFIDENT_TAUS, ...wrongConfident(judgments) };
  }
  return out;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--json") continue;
  if (args[i] === "--out") {
    i++;
    continue;
  }
  if (args[i].startsWith("-")) continue;
  rest.push(args[i]);
}
const filter = rest[0];
const outIdx = args.indexOf("--out");
const selected = filter ? SUITES.filter((s) => s.name === filter) : SUITES;
if (selected.length === 0) {
  console.error(`unknown suite "${filter}"; known: ${SUITES.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

const report = {
  generated: "fase-7 T4 (oracle stub + real handlers; stub ceiling, not backend quality)",
  taus: WRONG_CONFIDENT_TAUS,
  taus_note: "reporting slices only; NEVER production thresholds (see evals/calibration.md)",
  suites: [],
};
for (const suite of selected) report.suites.push(await scoreSuite(suite));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("\nFase-7 T4 metrics (oracle stub ceiling;taus are slices, never thresholds):");
  console.log("| suite | fam | dec_acc | task_acc | bin_F1 | abst | wc@0.80 | wc@0.95 |");
  console.log("|-------|-----|---------|----------|--------|------|---------|---------|");
  const fmt = (v) => (v === null || v === undefined ? "n/a" : typeof v === "number" ? v.toFixed(3) : String(v));
  for (const s of report.suites) {
    const wc = s.wrong_confident?.slices ? s.wrong_confident.slices.map((x) => fmt(x.rate)).join("/") : "n/a";
    const w80 = s.wrong_confident?.slices ? fmt(s.wrong_confident.slices[1].rate) : "n/a";
    const w95 = s.wrong_confident?.slices ? fmt(s.wrong_confident.slices[3].rate) : "n/a";
    void wc;
    const bin = s.binary_allow_polarity ? fmt(s.binary_allow_polarity.f1) : s.ranking ? `MRR ${fmt(s.ranking.mrr)}` : "n/a";
    console.log(`| ${s.suite} | ${s.family} | ${fmt(s.decision.accuracy)} | ${s.task ? fmt(s.task.accuracy) : "n/a"} | ${bin} | ${fmt(s.abstention.abstention_rate)} | ${w80} | ${w95} |`);
  }
}
if (outIdx !== -1 || !asJson) {
  const outPath = outIdx !== -1 ? args[outIdx + 1] : path.join("artifacts", "evals-t4-metrics.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nsaved: ${outPath} (untracked; versioned evals/results/ is T5)`);
}
