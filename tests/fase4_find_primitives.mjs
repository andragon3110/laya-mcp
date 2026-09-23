/**
 * Fase-4 T4 (find primitives): cheap deterministic pre-filter
 * (token-overlap + exact-dedup, no LLM) -> top-K -> Laya judge.
 *
 * No server, no LLM: the real handleFind + builders run against a stub
 * LayaClient with canned answers. Every assertion runs the real
 * rank/filter/dedupe/cap pipeline underneath.
 *
 * Pinned contracts:
 *   - defaults (no new params) = legacy behaviour, zero breaking: every
 *     candidate (duplicates and input order included) reaches the judge;
 *   - top_k narrows the shown set to the best K by query-token coverage
 *     (ties keep input order); min_score drops candidates below the cut
 *     before the cap (never silent: counted in dropped);
 *   - `none` is always sent; a fully-pruned pool sends { none } only and
 *     resolves through the pre-existing none path to ESCALATE;
 *   - candidateCount is ALWAYS the real pre-pruning pool size (the 1/N
 *     weak-winner baseline never sees the pruned count);
 *   - output appends additive `pruned` + `pruning:{kept, dropped, method}`
 *     (plus a `pruning` mirror on evidence.metadata; signals untouched);
 *   - find policy stays 1.0.0 (pruning composes with firmness, no change).
 *
 * Run after build from the repo root:  node tests/fase4_find_primitives.mjs
 */
import assert from "node:assert";
import { LIMITS } from "../dist/limits.js";
import {
  findTool,
  handleFind,
  buildFindQuestionsWithInfo,
  resolveFindSelection,
  selectFindCandidates,
  tokenizeForFind,
  overlapScore,
  FIND_PRUNE_METHOD,
} from "../dist/tools/find.js";

const captured = { questions: null };
const fakeClient = (answers, latencyMs = 7) => ({
  predict: async (_args, questions) => {
    captured.questions = questions;
    return { answers, confidence: {}, routing: {}, model: "fase4-t4-test", latencyMs, usage: {} };
  },
});

let passed = 0;
function check(name, fn) {
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
const criteriaOf = (built) => built.questions.exists.criteria;
const nonNoneKeys = (criteria) => Object.keys(criteria).filter((k) => k !== "none");

const pool10 = [
  { id: "a", text: "apple red fruit harvest" },
  { id: "b", text: "apple green orchard" },
  { id: "c", text: "banana yellow bunch" },
  { id: "d", text: "cherry dark sweet" },
  { id: "e", text: "date palm desert" },
  { id: "f", text: "elderberry bush wine" },
  { id: "g", text: "fig tree mediterranean" },
  { id: "h", text: "grape vine cluster" },
  { id: "i", text: "honeydew melon slice" },
  { id: "j", text: "kiwi fuzzy brown" },
];

// ---------------------------------------------------------- selection units ---
await check("unit: defaults resolve to legacy 250/0 (zero breaking)", () => {
  assert.deepEqual(resolveFindSelection({}), { topK: 250, minScore: 0 });
  assert.deepEqual(resolveFindSelection({ top_k: null, min_score: null }), { topK: 250, minScore: 0 });
  assert.equal(FIND_PRUNE_METHOD, "token-overlap+exact-dedup");
});

await check("unit: top_k must be int >= 1; above 250 is input_too_large", () => {
  for (const bad of [0, -2, 1.5, "5"]) {
    assert.throws(
      () => resolveFindSelection({ top_k: bad }),
      /top_k must be an integer >= 1/,
      `top_k=${JSON.stringify(bad)}`,
    );
  }
  throwsInputTooLarge(() => resolveFindSelection({ top_k: 251 }), "top_k");
  assert.equal(resolveFindSelection({ top_k: 250 }).topK, 250);
  assert.equal(resolveFindSelection({ top_k: 3 }).topK, 3);
});

await check("unit: min_score outside [0,1] throws (edges 0/1 pass, null = default)", () => {
  for (const bad of [-0.1, 1.5, "high", NaN]) {
    assert.throws(
      () => resolveFindSelection({ min_score: bad }),
      /min_score must be a number in \[0,1\]/,
      `score=${JSON.stringify(bad)}`,
    );
  }
  assert.equal(resolveFindSelection({ min_score: 0 }).minScore, 0);
  assert.equal(resolveFindSelection({ min_score: 1 }).minScore, 1);
});

await check("unit: tokenize is case/diacritic/punctuation-insensitive; empty -> []", () => {
  assert.deepEqual(tokenizeForFind("Árbol, ROJO!  grande"), ["arbol", "rojo", "grande"]);
  assert.deepEqual(tokenizeForFind(""), []);
  assert.deepEqual(tokenizeForFind("  ...  "), []);
});

await check("unit: overlapScore is query-token coverage (0 on empty query)", () => {
  assert.equal(overlapScore(["apple", "red"], ["apple", "red", "fruit"]), 1);
  assert.equal(overlapScore(["apple", "red"], ["apple", "green"]), 0.5);
  assert.equal(overlapScore(["apple", "red"], ["banana"]), 0);
  assert.equal(overlapScore([], ["apple"]), 0);
  assert.equal(overlapScore(["apple", "apple"], ["apple"]), 1, "distinct query tokens");
});

await check("unit: inactive selection returns the pool verbatim (duplicates + order kept)", () => {
  const pool = [
    { id: "x", text: "Same Text!" },
    { id: "y", text: "same text" },
    { id: "z", text: "other" },
  ];
  const { shown, dropped, pruned } = selectFindCandidates(pool, "query", { topK: 250, minScore: 0 });
  assert.deepEqual(shown.map((c) => c.id), ["x", "y", "z"]);
  assert.ok(shown.every((c) => c.score === 0), "legacy path scores nothing");
  assert.equal(dropped, 0);
  assert.equal(pruned, false);
});

await check("unit: active selection dedupes exact, filters by min_score, ranks stable, caps", () => {
  const pool = [
    { id: "dup1", text: "Apple Red!" },
    { id: "dup2", text: "apple  red" },
    { id: "mid", text: "apple green" },
    { id: "low", text: "banana" },
  ];
  const sel = { topK: 10, minScore: 0.5 };
  const { shown, dropped, pruned } = selectFindCandidates(pool, "apple red", sel);
  assert.deepEqual(shown.map((c) => c.id), ["dup1", "mid"], "dup2 deduped, low filtered, rank desc");
  assert.equal(shown[0].score, 1);
  assert.equal(shown[1].score, 0.5);
  assert.equal(dropped, 2);
  assert.equal(pruned, true);
});

await check("unit: ties keep input order; top_k caps after ranking", () => {
  const pool = [
    { id: "t1", text: "apple x" },
    { id: "t2", text: "apple y" },
    { id: "t3", text: "apple z" },
  ];
  const { shown } = selectFindCandidates(pool, "apple", { topK: 2, minScore: 0 });
  assert.deepEqual(shown.map((c) => c.id), ["t1", "t2"]);
});

// ------------------------------------------------------- builder (no judge) ---
await check("builder defaults = legacy: 10 pool -> 10 criteria + none, pruned false", () => {
  const built = buildFindQuestionsWithInfo({ query: "apple", candidates: pool10 });
  const crit = criteriaOf(built);
  assert.deepEqual(nonNoneKeys(crit), pool10.map((c) => c.id), "input order preserved");
  assert.equal(crit.a, "apple red fruit harvest");
  assert.ok("none" in crit, "none always sent");
  assert.equal(built.pruned, false);
  assert.deepEqual(built.pruning, { kept: 10, dropped: 0, method: FIND_PRUNE_METHOD });
});

await check("builder top_k narrows to best K (assert sent criteria count)", () => {
  const built = buildFindQuestionsWithInfo({ query: "apple red", candidates: pool10, top_k: 3 });
  const crit = criteriaOf(built);
  assert.deepEqual(nonNoneKeys(crit), ["a", "b", "c"], "ranked by overlap, ties keep input order");
  assert.equal(built.pruned, true);
  assert.deepEqual(built.pruning, { kept: 3, dropped: 7, method: FIND_PRUNE_METHOD });
});

await check("builder min_score drops the unrelated before the cap (never silent)", () => {
  const built = buildFindQuestionsWithInfo({ query: "apple red", candidates: pool10, min_score: 0.5 });
  const crit = criteriaOf(built);
  assert.deepEqual(nonNoneKeys(crit), ["a", "b"]);
  assert.deepEqual(built.pruning, { kept: 2, dropped: 8, method: FIND_PRUNE_METHOD });
});

await check("builder duplicates pass on legacy path, dedupe when pruning is active", () => {
  const dups = [
    { id: "d1", text: "Apple Red!" },
    { id: "d2", text: "apple red" },
    { id: "d3", text: "banana" },
  ];
  const legacy = buildFindQuestionsWithInfo({ query: "q", candidates: dups });
  assert.deepEqual(nonNoneKeys(criteriaOf(legacy)), ["d1", "d2", "d3"]);
  assert.equal(legacy.pruned, false);
  const active = buildFindQuestionsWithInfo({ query: "apple", candidates: dups, top_k: 2 });
  assert.deepEqual(nonNoneKeys(criteriaOf(active)), ["d1", "d3"], "first duplicate kept");
  assert.deepEqual(active.pruning, { kept: 2, dropped: 1, method: FIND_PRUNE_METHOD });
});

await check("builder 0 candidates -> criteria { none } only", () => {
  const built = buildFindQuestionsWithInfo({ query: "q", candidates: [] });
  assert.deepEqual(criteriaOf(built), { none: "None of the candidates addresses the query." });
  assert.deepEqual(built.pruning, { kept: 0, dropped: 0, method: FIND_PRUNE_METHOD });
});

await check("builder keeps the 240-char slice per criterion", () => {
  const built = buildFindQuestionsWithInfo({
    query: "q",
    candidates: [{ id: "long", text: "x".repeat(500) }],
  });
  assert.equal(criteriaOf(built).long.length, 240);
});

await check("builder >250 rejected with input_too_large; findTool.buildQuestions delegates", () => {
  const big = Array.from({ length: 251 }, (_, i) => ({ id: `c${i}`, text: "t" }));
  throwsInputTooLarge(() => buildFindQuestionsWithInfo({ query: "q", candidates: big }), "candidates");
  const built = buildFindQuestionsWithInfo({ query: "q", candidates: pool10.slice(0, 2) });
  assert.deepEqual(findTool.buildQuestions({ query: "q", candidates: pool10.slice(0, 2) }), built.questions);
});

// ------------------------------------------------------------- e2e (stubbed) ---
await check("e2e strong winner -> ALLOW + legacy shape + pruned report (policy 1.0.0)", async () => {
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "a", probabilities: { a: 0.7, b: 0.2, none: 0.1 } } }),
      { query: "q", candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }] },
    ),
  );
  assert.equal(body.winner, "a");
  assert.equal(body.exists, true);
  assert.equal(body.winner_probability, 0.7);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["find_winner_allow"]);
  assert.deepEqual(body.decision.policy, { name: "find", version: "1.0.0" });
  assert.equal(body.abstention.abstained, false);
  assert.ok(Array.isArray(body.evidence?.signals), "evidence shape intact");
  assert.equal(body.pruned, false);
  assert.deepEqual(body.pruning, { kept: 2, dropped: 0, method: FIND_PRUNE_METHOD });
  assert.deepEqual(body.evidence.metadata?.pruning, { kept: 2, dropped: 0, method: FIND_PRUNE_METHOD });
  // The judge was sent every candidate + none (legacy verbatim).
  assert.deepEqual(Object.keys(captured.questions.exists.criteria).sort(), ["a", "b", "none"]);
});

await check("e2e pruned pool sends only top-K: winner among kept -> ALLOW", async () => {
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "a", probabilities: { a: 0.8, b: 0.15, none: 0.05 } } }),
      { query: "apple red", candidates: pool10, top_k: 2 },
    ),
  );
  assert.equal(body.winner, "a");
  assert.equal(body.decision.decision, "ALLOW");
  assert.equal(body.pruned, true);
  assert.deepEqual(body.pruning, { kept: 2, dropped: 8, method: FIND_PRUNE_METHOD });
  assert.deepEqual(Object.keys(captured.questions.exists.criteria).sort(), ["a", "b", "none"]);
});

await check("e2e baseline uses the REAL pre-pruning N (4, not the pruned 2)", async () => {
  // top=0.30 clears 1/4=0.25 (real N) but not 1/2=0.50 (pruned N): ALLOW
  // proves the baseline travelled pre-pruning.
  const four = pool10.slice(0, 4);
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "a", probabilities: { a: 0.3, b: 0.2, none: 0.1 } } }),
      { query: "apple red", candidates: four, top_k: 2 },
    ),
  );
  assert.deepEqual(body.pruning, { kept: 2, dropped: 2, method: FIND_PRUNE_METHOD });
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["find_winner_allow"]);
});

await check("e2e identical candidates dedupe to one criterion; judge pick -> ALLOW", async () => {
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "d1", probabilities: { d1: 0.9, none: 0.1 } } }),
      {
        query: "apple",
        candidates: [
          { id: "d1", text: "Apple!" },
          { id: "d2", text: "apple" },
          { id: "d3", text: "APPLE" },
        ],
        top_k: 2,
      },
    ),
  );
  assert.deepEqual(Object.keys(captured.questions.exists.criteria).sort(), ["d1", "none"]);
  assert.deepEqual(body.pruning, { kept: 1, dropped: 2, method: FIND_PRUNE_METHOD });
  assert.equal(body.winner, "d1");
  assert.equal(body.decision.decision, "ALLOW");
});

await check("e2e similar candidates with tied shares -> ambiguous -> ESCALATE (NONE never forced)", async () => {
  const similar = [
    { id: "s1", text: "refund policy thirty days" },
    { id: "s2", text: "refund policy thirty days extended" },
  ];
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "s1", probabilities: { s1: 0.45, s2: 0.45, none: 0.1 } } }),
      { query: "refund policy", candidates: similar },
    ),
  );
  assert.equal(body.winner, "s1", "winner value kept verbatim");
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /tie/, "tie reason");
  assert.equal(body.decision.decision, "ESCALATE", "no forced winner on ambiguity");
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

await check("e2e NONE choice is authoritative ESCALATE (winner kept, decision wins)", async () => {
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "none", probabilities: { a: 0.4, none: 0.6 } } }),
      { query: "q", candidates: [{ id: "a", text: "A" }], top_k: 1 },
    ),
  );
  assert.equal(body.winner, "none");
  assert.equal(body.exists, false);
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
  assert.deepEqual(body.decision.policy, { name: "find", version: "1.0.0" });
});

await check("e2e fully pruned pool sends { none } only -> ABSTAIN + ESCALATE", async () => {
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "none", probabilities: { none: 1 } } }),
      { query: "quantum entanglement", candidates: pool10, min_score: 0.99 },
    ),
  );
  assert.deepEqual(Object.keys(captured.questions.exists.criteria), ["none"]);
  assert.equal(body.pruned, true);
  assert.deepEqual(body.pruning, { kept: 0, dropped: 10, method: FIND_PRUNE_METHOD });
  assert.equal(body.winner, "none");
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
});

await check("e2e 0 candidates -> criteria { none } only -> ABSTAIN + ESCALATE", async () => {
  const body = JSON.parse(
    await handleFind(fakeClient({ exists: { choice: "none", probabilities: { none: 1 } } }), {
      query: "q",
      candidates: [],
    }),
  );
  assert.deepEqual(Object.keys(captured.questions.exists.criteria), ["none"]);
  assert.equal(body.winner, "none");
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.equal(body.pruned, false);
});

await check("e2e many candidates (25) with top_k=5: 5 criteria + none, grounded ids", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, text: `apple variant number ${i}` }));
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "c0", probabilities: { c0: 0.6, c1: 0.1, none: 0.05 } } }),
      { query: "apple", candidates: many, top_k: 5 },
    ),
  );
  assert.equal(nonNoneKeys(captured.questions.exists.criteria).length, 5);
  assert.deepEqual(body.pruning, { kept: 5, dropped: 20, method: FIND_PRUNE_METHOD });
  assert.equal(body.winner, "c0");
  assert.equal(body.decision.decision, "ALLOW");
});

await check("e2e oversized pool rejected with input_too_large (handler path)", async () => {
  const big = Array.from({ length: 251 }, (_, i) => ({ id: `c${i}`, text: "t" }));
  await assert.rejects(handleFind(fakeClient({}), { query: "q", candidates: big }), /input_too_large/);
});

await check("e2e double call is byte-identical (determinism, pruned or not)", async () => {
  const mk = (extra = {}) =>
    handleFind(
      fakeClient({ exists: { choice: "a", probabilities: { a: 0.7, b: 0.2, none: 0.1 } } }),
      { query: "apple red", candidates: pool10.slice(0, 4), ...extra },
    );
  assert.equal(await mk(), await mk());
  assert.equal(await mk({ top_k: 2 }), await mk({ top_k: 2 }));
});

console.log(`\nFase-4 T4 find primitives: ${passed} checks passed (no server, no LLM involved).`);
