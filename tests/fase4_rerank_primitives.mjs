/**
 * Fase-4 T5 (rerank primitives): optional top_k pre-selection
 * (deterministic token-overlap, no LLM) -> top-K -> Laya judge.
 *
 * No server, no LLM: the real handleRerank + builders run against a stub
 * LayaClient with canned answers. Every assertion runs the real
 * rank/cap/truncate/sort pipeline underneath.
 *
 * Pinned contracts:
 *   - defaults (no new params) = legacy behaviour, zero breaking: every
 *     candidate reaches the judge in input order with legacy
 *     `relevance_<i>_<id>` keys; `relevance_score` = raw noul, nulls last;
 *   - top_k narrows the judged shortlist to the best K by query-token
 *     coverage (ties keep input order, exact duplicates KEPT -- unlike
 *     find, rerank does no dedupe: one rank per input row and
 *     near-duplicate triage needs dupes visible); the FINAL order is the
 *     judge's over the shortlist (pre-filter rank never leaks into
 *     relevance_score or `rank`);
 *   - NO min_relevance param (deliberate): relevance_score is raw,
 *     uncalibrated noul with no documented scale, so a caller cutoff would
 *     be uninterpretable; v1 sorts, never cuts (policy stays 1.0.0);
 *   - `ranking score != calibrated probability`: relevance_score orders
 *     WITHIN one call only (higher = more relevant here), 0.9 is NOT 90%,
 *     scores do NOT transfer across calls/checkpoints, and no cutoff on
 *     the score is meaningful -- act only on the ALLOW/ESCALATE decision;
 *   - questions, judge state, evidence signals, and truncated_ids cover
 *     the judged shortlist only; dropped-by-prefilter rows contribute NO
 *     signal (pruning is reported in `pruned` + `pruning:{kept, dropped,
 *     method}` plus an evidence.metadata mirror, never as missing);
 *   - entries without a string id keep legacy null-score rows (missing);
 *   - pools > 64 and top_k > 64 are rejected with input_too_large (the
 *     transport ceiling is checked BEFORE pruning: pruning never turns a
 *     413 into a silent cut);
 *   - rerank policy stays 1.0.0 (pruning composes with firmness, no change).
 *
 * The trailing eval section (absolute numbers only, no baseline claim:
 * there is no pre-T5 pruning to compare against) measures, per pool size
 * N in [10, 50, 100, 500, 1000] at top_k=10 with deterministic fakes:
 * questions that would reach Laya, pruning ratio, pure-selector latency,
 * stub end-to-end latency (N <= 64 only: larger pools hit the 64 transport
 * cap before pruning and are rejected with input_too_large), throughput.
 *
 * Run after build from the repo root:  node tests/fase4_rerank_primitives.mjs
 */
import assert from "node:assert";
import { LIMITS } from "../dist/limits.js";
import {
  rerankTool,
  handleRerank,
  truncateRerankCandidates,
  buildRerankQuestionsWithInfo,
  resolveRerankSelection,
  selectRerankCandidates,
  RERANK_PRUNE_METHOD,
} from "../dist/tools/rerank.js";

const captured = { state: null, questions: null };
const fakeClient = (answers, latencyMs = 7) => ({
  predict: async (state, questions) => {
    captured.state = state;
    captured.questions = questions;
    return { answers, confidence: {}, routing: {}, model: "fase4-t5-test", latencyMs, usage: {} };
  },
});

let passed = 0;
function check(name, fn) {
  captured.state = null;
  captured.questions = null;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}
function throwsInputTooLarge(fn, field) {
  assert.throws(fn, (err) => {
    assert.match(String(err?.message ?? err), /input_too_large/, "code vocabulary");
    assert.match(String(err?.message ?? err), new RegExp(`field="${field}"`), "field name");
    assert.equal(err?.detail?.code, "input_too_large", "structured detail");
    return true;
  });
}
const keysOf = (built) => Object.keys(built.questions);
const mkPool = (n, prefix = "c") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, text: `apple variant number ${i} red harvest` }));

// ---------------------------------------------------------- selection units ---
await check("unit: defaults resolve to legacy 64 (zero breaking) + method name", () => {
  assert.deepEqual(resolveRerankSelection({}), { topK: 64 });
  assert.deepEqual(resolveRerankSelection({ top_k: null }), { topK: 64 });
  assert.equal(RERANK_PRUNE_METHOD, "token-overlap");
});

await check("unit: top_k must be int >= 1; above 64 is input_too_large", () => {
  for (const bad of [0, -2, 1.5, "8"]) {
    assert.throws(
      () => resolveRerankSelection({ top_k: bad }),
      /top_k must be an integer >= 1/,
      `top_k=${JSON.stringify(bad)}`,
    );
  }
  throwsInputTooLarge(() => resolveRerankSelection({ top_k: 65 }), "top_k");
  assert.equal(resolveRerankSelection({ top_k: 64 }).topK, 64);
  assert.equal(resolveRerankSelection({ top_k: 3 }).topK, 3);
});

await check("unit: NO min_relevance -- the param is ignored by design (uncalibrated noul has no scale to cut)", () => {
  assert.deepEqual(resolveRerankSelection({ min_relevance: 0.9 }), { topK: 64 });
  const a = buildRerankQuestionsWithInfo({ query: "apple", candidates: mkPool(4), min_relevance: 0.99 });
  const b = buildRerankQuestionsWithInfo({ query: "apple", candidates: mkPool(4) });
  assert.deepEqual(a.questions, b.questions, "min_relevance must not move the judged set");
  assert.deepEqual(a.pruning, b.pruning);
});

await check("unit: inactive selection returns the pool verbatim (input order, preScore 0)", () => {
  const pool = [
    { id: "x", text: "Same Text!" },
    { id: "y", text: "same text" },
    { id: "z", text: "other" },
  ];
  const { shown, dropped, pruned } = selectRerankCandidates(pool, "query", { topK: 64 });
  assert.deepEqual(shown.map((c) => c.id), ["x", "y", "z"]);
  assert.ok(shown.every((c) => c.preScore === 0), "legacy path scores nothing");
  assert.equal(dropped, 0);
  assert.equal(pruned, false);
});

await check("unit: active selection ranks by overlap desc, stable ties, caps at top_k", () => {
  const pool = [
    { id: "low", text: "banana" },
    { id: "mid", text: "apple green" },
    { id: "top", text: "apple red harvest" },
    { id: "tie2", text: "apple yellow" },
    { id: "tie1", text: "apple blue" },
  ];
  const { shown, dropped, pruned } = selectRerankCandidates(pool, "apple red harvest", { topK: 3 });
  assert.deepEqual(shown.map((c) => c.id), ["top", "mid", "tie2"], "1.0, then 1/3 ties keep input order");
  assert.equal(shown[0].preScore, 1);
  assert.equal(dropped, 2);
  assert.equal(pruned, true);
});

await check("unit: empty query scores 0 everywhere -> first top_k in input order", () => {
  const { shown } = selectRerankCandidates(mkPool(5), "  ...  ", { topK: 2 });
  assert.deepEqual(shown.map((c) => c.id), ["c0", "c1"]);
});

await check("unit: NO dedupe (unlike find) -- exact duplicates are both kept, input order", () => {
  const pool = [
    { id: "dup1", text: "Apple Red!" },
    { id: "dup2", text: "apple  red" },
    { id: "other", text: "banana" },
  ];
  const { shown, dropped, pruned } = selectRerankCandidates(pool, "apple red", { topK: 2 });
  assert.deepEqual(shown.map((c) => c.id), ["dup1", "dup2"], "triage needs dupes visible");
  assert.equal(dropped, 1);
  assert.equal(pruned, true);
});

await check("unit: selector is deterministic (double call, same ids)", () => {
  const pool = mkPool(20);
  const sel = { topK: 5 };
  const a = selectRerankCandidates(pool, "apple red", sel);
  const b = selectRerankCandidates(pool, "apple red", sel);
  assert.deepEqual(a, b);
});

// ------------------------------------------------------- builder (no judge) ---
await check("builder defaults = legacy: 3 pool -> relevance_0/1/2 keys, pruned false", () => {
  const pool = [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
    { id: "c", text: "C" },
  ];
  const built = buildRerankQuestionsWithInfo({ query: "q", candidates: pool });
  assert.deepEqual(keysOf(built), ["relevance_0_a", "relevance_1_b", "relevance_2_c"]);
  assert.equal(built.pruned, false);
  assert.deepEqual(built.pruning, { kept: 3, dropped: 0, method: RERANK_PRUNE_METHOD });
});

await check("builder top_k narrows to best K with shortlist-indexed keys", () => {
  const pool = [
    { id: "low", text: "banana" },
    { id: "top", text: "apple red harvest" },
    { id: "mid", text: "apple green" },
    { id: "none", text: "cherry" },
  ];
  const built = buildRerankQuestionsWithInfo({ query: "apple red harvest", candidates: pool, top_k: 2 });
  assert.deepEqual(keysOf(built), ["relevance_0_top", "relevance_1_mid"], "ranked by overlap, keys index the shortlist");
  assert.equal(built.pruned, true);
  assert.deepEqual(built.pruning, { kept: 2, dropped: 2, method: RERANK_PRUNE_METHOD });
});

await check("builder skips entries without a string id (legacy parity: never judged)", () => {
  const built = buildRerankQuestionsWithInfo({
    query: "q",
    candidates: [{ id: "a", text: "A" }, { text: "no-id" }, { id: 7, text: "bad-id" }],
  });
  assert.deepEqual(keysOf(built), ["relevance_0_a"]);
  assert.deepEqual(built.pruning, { kept: 1, dropped: 0, method: RERANK_PRUNE_METHOD });
});

await check("builder 0 candidates -> no questions, kept 0 dropped 0", () => {
  const built = buildRerankQuestionsWithInfo({ query: "q", candidates: [] });
  assert.deepEqual(built.questions, {});
  assert.deepEqual(built.pruning, { kept: 0, dropped: 0, method: RERANK_PRUNE_METHOD });
});

await check("builder cap checked BEFORE pruning: 65 pool rejects even with top_k=2; rerankTool.buildQuestions delegates", () => {
  const big = mkPool(65);
  throwsInputTooLarge(() => buildRerankQuestionsWithInfo({ query: "q", candidates: big, top_k: 2 }), "candidates");
  throwsInputTooLarge(() => buildRerankQuestionsWithInfo({ query: "q", candidates: mkPool(3), top_k: 65 }), "top_k");
  const small = { query: "q", candidates: mkPool(2) };
  assert.deepEqual(rerankTool.buildQuestions(small), buildRerankQuestionsWithInfo(small).questions);
});

// ----------------------------------------------- truncation x pruning combined ---
await check("truncate helper is real: 2001 chars cut to 2000, id flagged", () => {
  const { candidates, truncated, truncatedIds } = truncateRerankCandidates([{ id: "long", text: "x".repeat(2001) }]);
  assert.equal(candidates[0].text.length, 2000);
  assert.equal(truncated, true);
  assert.deepEqual(truncatedIds, ["long"]);
});

await check("e2e truncation alone (no pruning): legacy truncated:true shape intact", async () => {
  const body = JSON.parse(
    await handleRerank(
      fakeClient({ relevance_0_long: { noul: 0.8 }, relevance_1_ok: { noul: 0.2 } }),
      { query: "q", candidates: [{ id: "long", text: "x".repeat(2500) }, { id: "ok", text: "short" }] },
    ),
  );
  assert.equal(body.truncated, true);
  assert.deepEqual(body.truncated_ids, ["long"]);
  assert.equal(captured.state.candidates[0].text.length, 2000, "judge state carries the cut text");
  assert.equal(body.pruned, false);
});

await check("e2e truncation x pruning: only judged longs are cut/flagged; dropped longs stay out", async () => {
  const pool = [
    { id: "keep", text: "apple red harvest " + "y".repeat(2500) },
    { id: "drop", text: "banana unrelated " + "z".repeat(2500) },
    { id: "keep2", text: "apple red" },
  ];
  const body = JSON.parse(
    await handleRerank(fakeClient({ relevance_0_keep: { noul: 0.9 }, relevance_1_keep2: { noul: 0.1 } }), {
      query: "apple red harvest",
      candidates: pool,
      top_k: 2,
    }),
  );
  assert.deepEqual(keysOf({ questions: captured.questions }), ["relevance_0_keep", "relevance_1_keep2"]);
  assert.equal(body.truncated, true);
  assert.deepEqual(body.truncated_ids, ["keep"], "dropped long text is never cut nor flagged");
  assert.equal(captured.state.candidates.length, 2, "judge state carries the shortlist only");
  assert.equal(body.pruned, true);
  assert.deepEqual(body.pruning, { kept: 2, dropped: 1, method: RERANK_PRUNE_METHOD });
});

// ------------------------------------------------------- sort / nulls / empty ---
await check("e2e null-last: missing answer sorts after firm, stable among nulls", async () => {
  const body = JSON.parse(
    await handleRerank(
      fakeClient({ relevance_0_a: { noul: 0.3 }, relevance_2_c: { noul: 0.9 } }),
      { query: "q", candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }] },
    ),
  );
  assert.deepEqual(
    body.ranked.map((r) => r.id),
    ["c", "a", "b"],
    "firm desc, then missing keeps input order",
  );
  assert.deepEqual(
    body.ranked.map((r) => r.rank),
    [1, 2, 3],
  );
  assert.equal(body.ranked[2].relevance_score, null);
});

await check("e2e firm ties keep input order (stable, no invented value)", async () => {
  const body = JSON.parse(
    await handleRerank(
      fakeClient({ relevance_0_a: { noul: 0.5 }, relevance_1_b: { noul: 0.5 }, relevance_2_c: { noul: 0.7 } }),
      { query: "q", candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }] },
    ),
  );
  assert.deepEqual(body.ranked.map((r) => r.id), ["c", "a", "b"]);
});

await check("e2e 0 candidates -> ranked [] + ABSTAIN + ESCALATE rerank_no_candidates", async () => {
  const body = JSON.parse(await handleRerank(fakeClient({}), { query: "q", candidates: [] }));
  assert.deepEqual(body.ranked, []);
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /no candidates/);
  assert.equal(body.decision.decision, "ESCALATE");
  // Engine global abstain rule wins over the policy code (same as find's
  // empty-pool path); the abstention reason still names the cause.
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
  assert.deepEqual(body.decision.policy, { name: "rerank", version: "1.0.0" });
  assert.equal(body.pruned, false);
});

await check("e2e missing judge answer -> null last + abstained ESCALATE rerank_missing_signal", async () => {
  const body = JSON.parse(
    await handleRerank(fakeClient({ relevance_0_a: { noul: 0.8 } }), {
      query: "q",
      candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
    }),
  );
  assert.equal(body.ranked[1].id, "b");
  assert.equal(body.ranked[1].relevance_score, null);
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /missing Router signal/);
  assert.equal(body.decision.decision, "ESCALATE");
  // Engine global abstain rule wins (authoritative ESCALATE either way).
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

await check("e2e entry without string id keeps a legacy null row (missing, never judged)", async () => {
  const body = JSON.parse(
    await handleRerank(fakeClient({ relevance_0_a: { noul: 0.8 } }), {
      query: "q",
      candidates: [{ id: "a", text: "A" }, { text: "no-id" }],
    }),
  );
  assert.equal(body.ranked.length, 2);
  assert.equal(body.ranked[1].relevance_score, null);
  assert.equal(body.abstention.abstained, true, "legacy parity: id-less rows abstain");
  assert.equal(body.decision.decision, "ESCALATE");
});

// ------------------------------------------------------------- e2e (stubbed) ---
await check("e2e default = legacy shape + ALLOW (policy 1.0.0) + pruned report", async () => {
  const body = JSON.parse(
    await handleRerank(fakeClient({ relevance_0_a: { noul: 0.8 }, relevance_1_b: { noul: 0.2 } }), {
      query: "q",
      candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
    }),
  );
  assert.deepEqual(body.ranked, [
    { rank: 1, id: "a", relevance_score: 0.8 },
    { rank: 2, id: "b", relevance_score: 0.2 },
  ]);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.truncated_ids, []);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["rerank_ordered_allow"]);
  assert.deepEqual(body.decision.policy, { name: "rerank", version: "1.0.0" });
  assert.equal(body.abstention.abstained, false);
  assert.ok(Array.isArray(body.evidence?.signals), "evidence shape intact");
  assert.equal(body.evidence.signals.length, 2);
  assert.equal(body.pruned, false);
  assert.deepEqual(body.pruning, { kept: 2, dropped: 0, method: RERANK_PRUNE_METHOD });
  assert.deepEqual(body.evidence.metadata?.pruning, { kept: 2, dropped: 0, method: RERANK_PRUNE_METHOD });
  assert.equal(Object.keys(captured.questions).length, 2, "judge got one question per candidate");
});

await check("e2e pruned top_k=2 over 5: 2 questions sent, ranked 2, signals 2, ALLOW", async () => {
  const pool = [
    { id: "low", text: "banana" },
    { id: "top", text: "apple red harvest" },
    { id: "mid", text: "apple green" },
    { id: "out1", text: "cherry" },
    { id: "out2", text: "date palm" },
  ];
  const body = JSON.parse(
    await handleRerank(fakeClient({ relevance_0_top: { noul: 0.4 }, relevance_1_mid: { noul: 0.9 } }), {
      query: "apple red harvest",
      candidates: pool,
      top_k: 2,
    }),
  );
  assert.deepEqual(keysOf({ questions: captured.questions }), ["relevance_0_top", "relevance_1_mid"]);
  assert.deepEqual(body.ranked.map((r) => r.id), ["mid", "top"], "FINAL order is the judge's, not the pre-filter's");
  assert.equal(body.evidence.signals.length, 2, "dropped rows contribute no signal");
  assert.equal(body.abstention.abstained, false, "dropped rows are reported, never missing");
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["rerank_ordered_allow"]);
  assert.equal(body.pruned, true);
  assert.deepEqual(body.pruning, { kept: 2, dropped: 3, method: RERANK_PRUNE_METHOD });
});

await check("e2e pruned duplicates both judged (no dedupe) -> each keeps its own score", async () => {
  const body = JSON.parse(
    await handleRerank(
      fakeClient({ relevance_0_dup1: { noul: 0.6 }, relevance_1_dup2: { noul: 0.7 }, relevance_2_other: { noul: 0.1 } }),
      {
        query: "apple red",
        candidates: [
          { id: "dup1", text: "Apple Red!" },
          { id: "dup2", text: "apple red" },
          { id: "other", text: "banana" },
        ],
        top_k: 3,
      },
    ),
  );
  assert.deepEqual(body.ranked.map((r) => r.id), ["dup2", "dup1", "other"]);
  assert.equal(body.decision.decision, "ALLOW");
});

await check("e2e oversized pool rejected with input_too_large (handler path, before pruning)", async () => {
  const big = mkPool(LIMITS.maxRerankCandidates + 1);
  await assert.rejects(handleRerank(fakeClient({}), { query: "q", candidates: big, top_k: 2 }), /input_too_large/);
});

await check("e2e double call is byte-identical (determinism, pruned or not)", async () => {
  const pool = mkPool(5);
  const mk = (extra = {}) =>
    handleRerank(fakeClient({ relevance_0_c0: { noul: 0.5 }, relevance_1_c1: { noul: 0.6 } }), {
      query: "apple",
      candidates: pool.slice(0, 2),
      ...extra,
    });
  assert.equal(await mk(), await mk());
  const mkp = (extra = {}) =>
    handleRerank(
      fakeClient({
        relevance_0_c0: { noul: 0.5 },
        relevance_1_c1: { noul: 0.6 },
        relevance_2_c2: { noul: 0.4 },
      }),
      { query: "apple", candidates: pool, top_k: 3, ...extra },
    );
  assert.equal(await mkp(), await mkp());
});

console.log(`\nFase-4 T5 rerank primitives: ${passed} checks passed (no server, no LLM involved).`);

// ------------------------------------------------------------------ eval ---
// Absolute numbers only (no baseline: pre-T5 rerank had no pruning, so
// there is nothing to claim an improvement over). Deterministic fakes:
// candidate i carries (i*7+3) % 4 of the 3 query tokens + fixed filler, so
// pre-filter ranks vary repeatably. top_k=10 fixed: N=10 is the no-op
// boundary, larger N prune. N <= 64 additionally runs the stubbed judge
// end to end; N > 64 cannot (the 64 transport cap rejects before pruning),
// so those rows report the pure selector + the projected judge load.
const EVAL_QUERY = "apple red harvest";
const EVAL_TOP_K = 10;
function evalFakePool(n) {
  const toks = ["apple", "red", "harvest"];
  return Array.from({ length: n }, (_, i) => {
    const k = (i * 7 + 3) % 4;
    return { id: `e${i}`, text: [...toks.slice(0, k), `filler${i}`, "doc", "body", "text"].join(" ") };
  });
}
const evalRows = [];
for (const n of [10, 50, 100, 500, 1000]) {
  const pool = evalFakePool(n);
  const sel = resolveRerankSelection({ top_k: EVAL_TOP_K });
  const reps = n <= 100 ? 500 : 50;
  const t0 = performance.now();
  let first = null;
  for (let r = 0; r < reps; r++) first = selectRerankCandidates(pool, EVAL_QUERY, sel);
  const selMs = (performance.now() - t0) / reps;
  assert.equal(first.shown.length, Math.min(n, EVAL_TOP_K), `eval N=${n}: kept`);
  assert.equal(first.dropped, n - first.shown.length, `eval N=${n}: dropped`);
  const ratio = first.dropped / n;
  let stubMs = null;
  let sent = null;
  if (n <= LIMITS.maxRerankCandidates) {
    const built = buildRerankQuestionsWithInfo({ query: EVAL_QUERY, candidates: pool, top_k: EVAL_TOP_K });
    const answers = {};
    built.shown.forEach((c, i) => {
      answers[`relevance_${i}_${c.id}`] = { noul: 0.9 - i * 0.001 };
    });
    const s0 = performance.now();
    const body = JSON.parse(await handleRerank(fakeClient(answers, 0), { query: EVAL_QUERY, candidates: pool, top_k: EVAL_TOP_K }));
    stubMs = performance.now() - s0;
    sent = Object.keys(captured.questions).length;
    assert.equal(sent, built.shown.length, `eval N=${n}: questions sent`);
    assert.equal(body.ranked.length, built.shown.length, `eval N=${n}: ranked`);
  }
  evalRows.push({
    n,
    kept: first.shown.length,
    sent: sent ?? first.shown.length,
    dropped: first.dropped,
    ratio,
    selMs,
    stubMs,
    tput: selMs > 0 ? Math.round(n / (selMs / 1000)) : null,
    e2e: n <= LIMITS.maxRerankCandidates,
  });
}
console.log("\nFase-4 T5 rerank eval (deterministic stub + fakes, absolutes, no baseline claims):");
console.log("| N | top_k | questions->Laya | dropped | pruning_ratio | selector_ms | stub_e2e_ms | selector_cand/s |");
console.log("|---|-------|-----------------|---------|---------------|-------------|-------------|-----------------|");
for (const r of evalRows) {
  console.log(
    `| ${r.n} | ${EVAL_TOP_K} | ${r.sent}${r.e2e ? "" : "*"} | ${r.dropped} | ${r.ratio.toFixed(2)} | ${r.selMs.toFixed(3)} | ${r.stubMs === null ? "n/a (>64 cap)" : r.stubMs.toFixed(3)} | ${r.tput === null ? "n/a" : r.tput} |`,
  );
}
console.log("* projected judge load (transport rejects pools > 64 with input_too_large before pruning).");
