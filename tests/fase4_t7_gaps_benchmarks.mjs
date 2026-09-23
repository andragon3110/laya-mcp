/**
 * Fase-4 T7 (writer W5): §7 gap coverage + per-primitive benchmarks.
 *
 * SCOPE: ONLY the gaps left by the T3-T6 batteries (verified by grep over
 * tests/fase4_{extract,find,rerank,decide}*.mjs on 2026-09-23 — every §7
 * case already covered there is mapped below and NOT re-tested here), plus
 * the §7-mandated benchmarks. No functional code changes; every assertion
 * runs the real handlers/builders against stub LayaClients and fakes
 * (no models, no GPU, no network).
 *
 * §7 case map (cero/uno/muchos/idénticos/similares/incorrecto/ambigüedad/
 * vacío/enorme/límites) — EXISTING = cited, NEW = asserted in this file:
 *
 *   extract (battery: fase4_extract_primitives.mjs, 22 checks)
 *     cero      EXISTING (regex empty doc; entities fully filtered/empty)
 *     uno       NEW  §7-extract-uno
 *     muchos    EXISTING (25 matches -> 20 + dropped 5)
 *     idénticos NEW  §7-extract-identicos (same text x3, distinct offsets)
 *     similares EXISTING (doc25 val0..val24 same-pattern family + top_k cut)
 *     incorrecto EXISTING (hallucinated m99/g99; span/doc mismatch)
 *     ambigüedad NEW  §7-extract-ambigüedad (tie: no abstention by design)
 *     vacío     EXISTING (empty document -> ESCALATE)
 *     enorme    EXISTING (oversized document -> input_too_large)
 *     límites   EXISTING (top_k/max_candidates ceiling) + NEW §7-extract-fields (>64 fields)
 *
 *   find (battery: fase4_find_primitives.mjs, 26 checks)
 *     cero      EXISTING (0 candidates; fully pruned pool)
 *     uno       NEW  §7-find-uno (1 candidate: 1/N baseline always abstains)
 *     muchos    EXISTING (25 pool, top_k=5)
 *     idénticos EXISTING (exact-dedup to one criterion)
 *     similares EXISTING (tied shares -> ambiguous -> ESCALATE)
 *     incorrecto NEW  §7-find-incorrecto (unknown judge id passes verbatim)
 *     ambigüedad EXISTING (tie + NONE paths)
 *     vacío     NEW  §7-find-vacio (empty query e2e, all-zero scores)
 *     enorme    NEW  §7-find-enorme (6000-char query passes through)
 *     límites   EXISTING (>250 pool; top_k > 250)
 *
 *   rerank (battery: fase4_rerank_primitives.mjs, 26 checks + 10-1000 eval)
 *     cero      EXISTING (0 candidates -> ESCALATE rerank_no_candidates)
 *     uno       NEW  §7-rerank-uno
 *     muchos    EXISTING (eval 10/50/100/500/1000)
 *     idénticos EXISTING (dupes both judged, own scores)
 *     similares EXISTING (firm ties keep input order)
 *     incorrecto EXISTING (missing answer -> null last + ESCALATE)
 *     ambigüedad NEW  §7-rerank-ambigüedad (exact ties: ALLOW, no tie-abstention)
 *     vacío     NEW  §7-rerank-vacio (empty-text candidate still judged)
 *     enorme    EXISTING (2000-char truncation + truncation x pruning)
 *     límites   EXISTING (>64 pool; top_k > 64; cap checked before pruning)
 *
 *   decide (battery: fase4_decide_twostage.mjs, 11 checks)
 *     cero      NEW  §7-decide-cero (0 options -> input_too_large)
 *     uno       EXISTING (1 option -> input_too_large)
 *     muchos    NEW  §7-decide-muchos (6 options e2e; 7 rejected)
 *     idénticos NEW  §7-decide-identicos (same description, resolve by id)
 *     similares EXISTING (flat distribution -> ESCALATE)
 *     incorrecto EXISTING (unknown winner id reaches stage 2 verbatim)
 *     ambigüedad EXISTING (flat band; null selection; stage-2 silence)
 *     vacío     NEW  §7-decide-vacio (empty decision string resolves)
 *     enorme    NEW  §7-decide-enorme (500-char description sliced to 240)
 *     límites   EXISTING (>32 requirements) + NEW §7-decide-muchos (>6 options)
 *
 * BENCHMARKS (trailing sections, absolutes only, no improvement claims):
 * per primitive: candidate count, pruning ratio, stub inference latency
 * (zero-latency stub => reported wall time is pipeline overhead), approx
 * process memory (absolute heapUsed sampled right after pool construction), throughput
 * (candidates/s of the pure selector/builder). With/without pruning where
 * the primitive prunes (extract/find/rerank); decide reports the
 * requirements sweep instead (it has no pruning stage). Method printed
 * above each table; every ratio/count is also assert()ed (deterministic),
 * timings/memory are printed, never asserted.
 *
 * Run after build from the repo root:  node tests/fase4_t7_gaps_benchmarks.mjs
 */
import assert from "node:assert";
import { LIMITS } from "../dist/limits.js";
import {
  handleExtract,
  buildRegexQuestionsWithInfo,
} from "../dist/tools/extract.js";
import {
  handleFind,
  buildFindQuestionsWithInfo,
  selectFindCandidates,
  resolveFindSelection,
} from "../dist/tools/find.js";
import {
  handleRerank,
  buildRerankQuestionsWithInfo,
  selectRerankCandidates,
  resolveRerankSelection,
} from "../dist/tools/rerank.js";
import { handleDecide } from "../dist/tools/decide.js";

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}
function throwsInputTooLarge(fn, field, limit, actual) {
  assert.throws(fn, (err) => {
    assert.match(String(err?.message ?? err), /input_too_large/, "code vocabulary");
    assert.match(String(err?.message ?? err), new RegExp(`field="${field}"`), "field name");
    if (limit !== undefined)
      assert.match(String(err?.message ?? err), new RegExp(`limit=${limit}`), "limit value");
    if (actual !== undefined)
      assert.match(String(err?.message ?? err), new RegExp(`actual=${actual}`), "actual value");
    assert.equal(err?.detail?.code, "input_too_large", "structured detail");
    return true;
  });
}
const fakeClient = (answers, latencyMs = 0, capture = null) => ({
  predict: async (_args, questions) => {
    if (capture) capture.questions = questions;
    return { answers, confidence: {}, routing: {}, model: "fase4-t7-test", latencyMs, usage: {} };
  },
});

// ============================================================ §7 EXTRACT ===
await check("§7-extract-uno: single regex match -> 1 criterion + none, grounded offsets", async () => {
  const built = buildRegexQuestionsWithInfo({
    document: "only AB12 here",
    fields: [{ id: "f", description: "F", pattern: "[A-Z]{2}\\d{2}" }],
  });
  assert.deepEqual(Object.keys(built.questions.extract_0_f.criteria), ["m0", "none"]);
  assert.equal(built.truncated, false);
  assert.equal(built.dropped, 0);
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_f: { choice: "m0", probabilities: { m0: 0.9, none: 0.1 } } }),
      { document: "only AB12 here", fields: [{ id: "f", description: "F", pattern: "[A-Z]{2}\\d{2}" }], source: "regex" },
    ),
  );
  assert.equal(body.results[0].value, "AB12");
  assert.equal(body.results[0].status, "extracted");
  assert.deepEqual([body.results[0].start, body.results[0].end], [5, 9]);
  assert.equal("only AB12 here".slice(5, 9), "AB12");
  assert.equal(body.decision.decision, "ALLOW");
});

await check("§7-extract-identicos: same surface text x3 -> m0/m1/m2 at distinct grounded offsets", async () => {
  const doc = "AB12 AB12 AB12";
  const built = buildRegexQuestionsWithInfo({
    document: doc,
    fields: [{ id: "f", description: "F", pattern: "[A-Z]{2}\\d{2}" }],
  });
  assert.deepEqual(Object.keys(built.questions.extract_0_f.criteria), ["m0", "m1", "m2", "none"]);
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_f: { choice: "m2", probabilities: { m2: 0.8, none: 0.2 } } }),
      { document: doc, fields: [{ id: "f", description: "F", pattern: "[A-Z]{2}\\d{2}" }], source: "regex" },
    ),
  );
  assert.equal(body.results[0].value, "AB12");
  assert.deepEqual([body.results[0].start, body.results[0].end], [10, 14], "third occurrence, not the first");
  assert.equal(doc.slice(body.results[0].start, body.results[0].end), "AB12");
});

await check("§7-extract-ambigüedad: tied 0.5/0.5 resolves to the stated choice, NO abstention (by design)", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_f: { choice: "m0", probabilities: { m0: 0.5, m1: 0.5 } } }),
      { document: "AB12 CD34", fields: [{ id: "f", description: "F", pattern: "[A-Z]{2}\\d{2}" }], source: "regex" },
    ),
  );
  assert.equal(body.results[0].value, "AB12");
  assert.equal(body.results[0].winner_probability, 0.5);
  assert.equal(body.abstention.abstained, false, "extract has no tie detection: choice is authoritative");
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["extract_values_allow"]);
});

await check("§7-extract-fields: 65 fields rejected with input_too_large (limit 64)", async () => {
  const fields = Array.from({ length: 65 }, (_, i) => ({ id: `f${i}`, description: "F", pattern: "x+" }));
  throwsInputTooLarge(
    () => buildRegexQuestionsWithInfo({ document: "x", fields }),
    "fields",
    LIMITS.maxExtractFields,
    65,
  );
  await assert.rejects(
    handleExtract(fakeClient({}), { document: "x", fields, source: "regex" }),
    /input_too_large/,
  );
});

// =============================================================== §7 FIND ===
await check("§7-find-uno: single candidate, firm 0.9 -> ESCALATE on the 1/N weak-winner baseline", async () => {
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "a", probabilities: { a: 0.9, none: 0.1 } } }),
      { query: "q", candidates: [{ id: "a", text: "A" }] },
    ),
  );
  assert.equal(body.winner, "a", "winner value kept verbatim");
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /weak winner/, "0.9 <= 1/1: a lone candidate can never clear its own baseline");
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
  assert.equal(body.pruned, false);
});

await check("§7-find-incorrecto: unknown judge id passes through verbatim (ids are not validated)", async () => {
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "zzz", probabilities: { zzz: 0.9, none: 0.1 } } }),
      { query: "q", candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }] },
    ),
  );
  assert.equal(body.winner, "zzz", "no id allow-list: the judge's token is echoed");
  assert.equal(body.exists, true);
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["find_winner_allow"]);
});

await check("§7-find-vacio: empty query + top_k=1 keeps the FIRST in input order (all scores 0)", async () => {
  const capture = { questions: null };
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "a", probabilities: { a: 0.8, none: 0.2 } } }, 0, capture),
      { query: "", candidates: [{ id: "a", text: "Apple" }, { id: "b", text: "Banana" }], top_k: 1 },
    ),
  );
  assert.deepEqual(Object.keys(capture.questions.exists.criteria).sort(), ["a", "none"], "zero-score ties keep input order");
  assert.deepEqual(body.pruning, { kept: 1, dropped: 1, method: "token-overlap+exact-dedup" });
  assert.equal(body.winner, "a");
  assert.equal(body.decision.decision, "ALLOW");
});

await check("§7-find-enorme: 6000-char query has no length guard, passes through on the legacy path", async () => {
  const query = "apple ".repeat(1000);
  assert.equal(query.length, 6000);
  const body = JSON.parse(
    await handleFind(
      fakeClient({ exists: { choice: "a", probabilities: { a: 0.8, none: 0.2 } } }),
      { query, candidates: [{ id: "a", text: "apple" }, { id: "b", text: "banana" }] },
    ),
  );
  assert.equal(body.pruned, false, "250-ceiling default: no pruning triggered");
  assert.deepEqual(body.pruning, { kept: 2, dropped: 0, method: "token-overlap+exact-dedup" });
  assert.equal(body.winner, "a");
  assert.equal(body.decision.decision, "ALLOW");
});

// ============================================================= §7 RERANK ===
await check("§7-rerank-uno: single candidate -> rank 1 + ALLOW (no 1/N baseline in rerank)", async () => {
  const body = JSON.parse(
    await handleRerank(fakeClient({ relevance_0_a: { noul: 0.8 } }), {
      query: "q",
      candidates: [{ id: "a", text: "A" }],
    }),
  );
  assert.deepEqual(body.ranked, [{ rank: 1, id: "a", relevance_score: 0.8 }]);
  assert.equal(body.abstention.abstained, false, "contrast with find §7-find-uno: rerank never applies a uniform baseline");
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["rerank_ordered_allow"]);
  assert.equal(body.pruned, false);
});

await check("§7-rerank-ambigüedad: exact 0.5/0.5 ties keep order + ALLOW (no tie-abstention in rerank)", async () => {
  const body = JSON.parse(
    await handleRerank(
      fakeClient({ relevance_0_a: { noul: 0.5 }, relevance_1_b: { noul: 0.5 } }),
      { query: "q", candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }] },
    ),
  );
  assert.deepEqual(body.ranked.map((r) => r.id), ["a", "b"], "stable, no invented value");
  assert.equal(body.abstention.abstained, false, "contrast with find ties (-> ESCALATE): rerank orders, never abstains on ties");
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["rerank_ordered_allow"]);
});

await check("§7-rerank-vacio: empty-text candidate is still judged (score 0 pre-filter, judge decides)", async () => {
  const body = JSON.parse(
    await handleRerank(
      fakeClient({ relevance_0_a: { noul: 0.7 }, relevance_1_b: { noul: 0.3 } }),
      { query: "apple", candidates: [{ id: "a", text: "" }, { id: "b", text: "apple pie" }] },
    ),
  );
  assert.equal(body.evidence.signals.length, 2, "empty text contributes a real signal, never a missing row");
  assert.deepEqual(body.ranked.map((r) => r.id), ["a", "b"], "FINAL order is the judge's");
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ALLOW");
});

// ============================================================= §7 DECIDE ===
await check("§7-decide-cero: 0 options rejected with input_too_large (minimum 2)", async () => {
  await assert.rejects(handleDecide(fakeClient({}), { decision: "d", candidates: [] }), (err) => {
    assert.match(String(err?.message ?? err), /input_too_large/);
    assert.match(String(err?.message ?? err), /field="candidates"/);
    assert.match(String(err?.message ?? err), /limit=2/);
    assert.match(String(err?.message ?? err), /actual=0/);
    return true;
  });
});

await check("§7-decide-muchos: 6 options (ceiling) resolve e2e; 7 rejected with input_too_large", async () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, description: `Option ${i}` }));
  const probs = { o0: 0.5, o1: 0.1, o2: 0.1, o3: 0.1, o4: 0.1, o5: 0.1 };
  const calls = [];
  const rec = {
    predict: async (state, questions) => {
      calls.push(questions);
      return { answers: { selected: { choice: "o0", probabilities: probs } }, confidence: {}, routing: {}, model: "fase4-t7-test", latencyMs: 5, usage: {} };
    },
  };
  const body = JSON.parse(await handleDecide(rec, { decision: "d", candidates: six }));
  assert.equal(calls.length, 1, "no requirements -> single call even at the option ceiling");
  assert.equal(body.selected, "o0");
  assert.equal(body.decision.decision, "ALLOW", "0.5 clears the 1/6 uniform baseline");
  assert.deepEqual(body.decision.policy, { name: "decide", version: "1.0.0" });
  const seven = [...six, { id: "o6", description: "Option 6" }];
  await assert.rejects(handleDecide(fakeClient({}), { decision: "d", candidates: seven }), (err) => {
    assert.match(String(err?.message ?? err), /input_too_large/);
    assert.match(String(err?.message ?? err), /field="candidates"/);
    assert.match(String(err?.message ?? err), /limit=6/);
    assert.match(String(err?.message ?? err), /actual=7/);
    return true;
  });
});

await check("§7-decide-identicos: identical descriptions resolve by id; stage 2 scoped to the picked id", async () => {
  const calls = [];
  const rec = {
    predict: async (state, questions) => {
      const i = calls.length;
      calls.push(questions);
      if (i === 0)
        return { answers: { selected: { choice: "b", probabilities: { a: 0.3, b: 0.7 } } }, confidence: {}, routing: {}, model: "fase4-t7-test", latencyMs: 5, usage: {} };
      return { answers: { requirement_0: { noul: 0.9 } }, confidence: {}, routing: {}, model: "fase4-t7-test", latencyMs: 9, usage: {} };
    },
  };
  const body = JSON.parse(
    await handleDecide(rec, {
      decision: "d",
      candidates: [{ id: "a", description: "same" }, { id: "b", description: "same" }],
      requirements: ["must hold"],
    }),
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1].requirement_0.instructions, /"b"/, "identical text cannot disambiguate: the id does");
  assert.equal(body.selected, "b");
  assert.equal(body.decision.decision, "ALLOW");
});

await check("§7-decide-vacio: empty decision string still builds and resolves (no empty-text guard)", async () => {
  const body = JSON.parse(
    await handleDecide(fakeClient({ selected: { choice: "a", probabilities: { a: 0.8, b: 0.2 } } }, 5), {
      decision: "",
      candidates: [{ id: "a" }, { id: "b" }],
    }),
  );
  assert.equal(body.selected, "a");
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ALLOW");
});

await check("§7-decide-enorme: 500-char description is sliced to 240 in the stage-1 criteria", async () => {
  const calls = [];
  const rec = {
    predict: async (state, questions) => {
      calls.push(questions);
      return { answers: { selected: { choice: "a", probabilities: { a: 0.8, b: 0.2 } } }, confidence: {}, routing: {}, model: "fase4-t7-test", latencyMs: 5, usage: {} };
    },
  };
  await handleDecide(rec, {
    decision: "d",
    candidates: [{ id: "a", description: "y".repeat(500) }, { id: "b", description: "B" }],
  });
  assert.equal(calls[0].selected.criteria.a.length, 240, "judge sees the cut text, never the full 500 chars");
  assert.equal(calls[0].selected.criteria.b, "B");
});

console.log(`\nFase-4 T7 §7 gaps: ${passed} checks passed (no server, no LLM involved).`);

// ========================================================== BENCHMARKS ===
// Method (all primitives): single process, Node 24; deterministic fakes;
// stub LayaClient with latencyMs 0 so the measured wall time is pure
// pipeline overhead (selector/builder + handler + JSON), reported
// separately from the stub-reported latency_ms field. Reps average
// performance.now() deltas; memory is one process.memoryUsage().heapUsed
// sample taken right after pool construction (absolute process heap in
// MB, approx: it includes the whole Node process, not just the pool;
// single sample, no GC forcing — GC noise applies). Throughput = pool
// ratios and kept sets are assert()ed (deterministic); timings and memory
// are PRINTED absolutes, never asserted, never compared across machines,
// and no improvement over any baseline is claimed (there is no pre-T7
// benchmark to compare against).
const heapMB = () => process.memoryUsage().heapUsed / 1048576;
const meanMs = (fn, reps) => {
  fn();
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) fn();
  return (performance.now() - t0) / reps;
};
const benchRows = [];
async function benchE2eWall(fn, reps) {
  await fn();
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) await fn();
  return (performance.now() - t0) / reps;
}

// ---- extract: 200-match regex doc, default (20 shown) vs top_k=5 ----
// Method: doc of 200 "v000 ".."v199 " tokens (~1200 chars, under the 20000
// state cap); pattern v\d{3}; builder reps 200; stub e2e reps 20 with a
// canned m0 answer (judge content is irrelevant to pipeline cost).
{
  const doc = Array.from({ length: 200 }, (_, i) => `v${String(i).padStart(3, "0")}`).join(" ");
  const fields = [{ id: "f", description: "F", pattern: "v\\d{3}" }];
  const builtDefault = buildRegexQuestionsWithInfo({ document: doc, fields });
  const builtTop5 = buildRegexQuestionsWithInfo({ document: doc, fields, top_k: 5 });
  const memPool = heapMB();
  assert.equal(Object.keys(builtDefault.questions.extract_0_f.criteria).length, 21, "20 + none");
  assert.deepEqual([builtDefault.truncated, builtDefault.dropped], [true, 180]);
  assert.deepEqual([builtTop5.truncated, builtTop5.dropped], [true, 195]);
  const selMsDefault = meanMs(() => buildRegexQuestionsWithInfo({ document: doc, fields }), 200);
  const selMsTop5 = meanMs(() => buildRegexQuestionsWithInfo({ document: doc, fields, top_k: 5 }), 200);
  const e2eDefault = await benchE2eWall(
    () => handleExtract(fakeClient({ extract_0_f: { choice: "m0", probabilities: { m0: 0.9, none: 0.1 } } }), { document: doc, fields, source: "regex" }),
    20,
  );
  const e2eTop5 = await benchE2eWall(
    () => handleExtract(fakeClient({ extract_0_f: { choice: "m0", probabilities: { m0: 0.9, none: 0.1 } } }), { document: doc, fields, source: "regex", top_k: 5 }),
    20,
  );
  void e2eTop5;
  benchRows.push({
    primitive: "extract",
    mode: "default (shown 20)",
    n: 200, kept: 20, dropped: 180, ratio: (180 / 200).toFixed(3),
    selMs: selMsDefault.toFixed(3), e2eMs: e2eDefault.toFixed(3),
    tput: Math.round(200 / (selMsDefault / 1000)), mem: memPool.toFixed(1),
  });
  benchRows.push({
    primitive: "extract",
    mode: "top_k=5",
    n: 200, kept: 5, dropped: 195, ratio: (195 / 200).toFixed(3),
    selMs: selMsTop5.toFixed(3), e2eMs: e2eTop5.toFixed(3),
    tput: Math.round(200 / (selMsTop5 / 1000)), mem: memPool.toFixed(1),
  });
}

// ---- find: 250-pool, legacy (kept 250) vs top_k=10 ----
// Method: query of 5 tokens "alpha beta gamma delta epsilon"; item i
// covers (i%5)+1 query tokens + filler, so scores cycle 0.2..1.0
// deterministically; legacy path keeps input order (no scoring);
// top_k=10 keeps the ten earliest score-1.0 items. Selector reps 100;
// stub e2e reps 10 (firm canned answer on the deterministic kept head).
{
  const toks = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const query = toks.join(" ");
  const pool = Array.from({ length: 250 }, (_, i) => ({
    id: `p${i}`,
    text: [...toks.slice(0, (i % 5) + 1), `filler${i}`].join(" "),
  }));
  const memPool = heapMB();
  const legacy = buildFindQuestionsWithInfo({ query, candidates: pool });
  const pruned = buildFindQuestionsWithInfo({ query, candidates: pool, top_k: 10 });
  assert.equal(legacy.pruned, false);
  assert.deepEqual(legacy.pruning, { kept: 250, dropped: 0, method: "token-overlap+exact-dedup" });
  assert.deepEqual(pruned.pruning, { kept: 10, dropped: 240, method: "token-overlap+exact-dedup" });
  assert.deepEqual(pruned.shown.map((c) => c.id), ["p4", "p9", "p14", "p19", "p24", "p29", "p34", "p39", "p44", "p49"]);
  const sel = resolveFindSelection({ top_k: 10 });
  const selMsLegacy = meanMs(() => selectFindCandidates(pool, query, resolveFindSelection({})), 100);
  const selMsPruned = meanMs(() => selectFindCandidates(pool, query, sel), 100);
  const e2eLegacy = await benchE2eWall(
    () => handleFind(fakeClient({ exists: { choice: "p0", probabilities: { p0: 0.9, none: 0.1 } } }), { query, candidates: pool }),
    10,
  );
  const e2ePruned = await benchE2eWall(
    () => handleFind(fakeClient({ exists: { choice: "p4", probabilities: { p4: 0.9, none: 0.1 } } }), { query, candidates: pool, top_k: 10 }),
    10,
  );
  benchRows.push({
    primitive: "find", mode: "legacy (no pruning)", n: 250, kept: 250, dropped: 0, ratio: (0).toFixed(3),
    selMs: selMsLegacy.toFixed(3), e2eMs: e2eLegacy.toFixed(3),
    tput: Math.round(250 / (selMsLegacy / 1000)), mem: memPool.toFixed(1),
  });
  benchRows.push({
    primitive: "find", mode: "top_k=10", n: 250, kept: 10, dropped: 240, ratio: (240 / 250).toFixed(3),
    selMs: selMsPruned.toFixed(3), e2eMs: e2ePruned.toFixed(3),
    tput: Math.round(250 / (selMsPruned / 1000)), mem: memPool.toFixed(1),
  });
}

// ---- rerank: 64-pool (transport max), legacy (kept 64) vs top_k=10 ----
// Method: same deterministic overlap cycle as the T5 eval
// (k=(i*7+3)%4 of 3 query tokens + fixed filler); N=64 is the largest
// pool the transport accepts, so both modes run the stubbed judge end
// to end here (unlike the T5 100/500/1000 projected rows). Reps 200/10.
{
  const query = "apple red harvest";
  const pool = Array.from({ length: 64 }, (_, i) => {
    const k = (i * 7 + 3) % 4;
    return { id: `r${i}`, text: [...["apple", "red", "harvest"].slice(0, k), `filler${i}`, "doc", "body"].join(" ") };
  });
  const memPool = heapMB();
  const legacy = buildRerankQuestionsWithInfo({ query, candidates: pool });
  const pruned = buildRerankQuestionsWithInfo({ query, candidates: pool, top_k: 10 });
  assert.equal(legacy.pruned, false);
  assert.deepEqual(legacy.pruning, { kept: 64, dropped: 0, method: "token-overlap" });
  assert.deepEqual(pruned.pruning, { kept: 10, dropped: 54, method: "token-overlap" });
  const selMsLegacy = meanMs(() => selectRerankCandidates(pool, query, resolveRerankSelection({})), 200);
  const selMsPruned = meanMs(() => selectRerankCandidates(pool, query, resolveRerankSelection({ top_k: 10 })), 200);
  const answersFor = (built) => {
    const a = {};
    built.shown.forEach((c, i) => { a[`relevance_${i}_${c.id}`] = { noul: 0.9 - i * 0.001 }; });
    return a;
  };
  const e2eLegacy = await benchE2eWall(
    () => handleRerank(fakeClient(answersFor(legacy)), { query, candidates: pool }),
    10,
  );
  const e2ePruned = await benchE2eWall(
    () => handleRerank(fakeClient(answersFor(pruned)), { query, candidates: pool, top_k: 10 }),
    10,
  );
  benchRows.push({
    primitive: "rerank", mode: "legacy (no pruning)", n: 64, kept: 64, dropped: 0, ratio: (0).toFixed(3),
    selMs: selMsLegacy.toFixed(3), e2eMs: e2eLegacy.toFixed(3),
    tput: Math.round(64 / (selMsLegacy / 1000)), mem: memPool.toFixed(1),
  });
  benchRows.push({
    primitive: "rerank", mode: "top_k=10", n: 64, kept: 10, dropped: 54, ratio: (54 / 64).toFixed(3),
    selMs: selMsPruned.toFixed(3), e2eMs: e2ePruned.toFixed(3),
    tput: Math.round(64 / (selMsPruned / 1000)), mem: memPool.toFixed(1),
  });
}

// ---- decide: requirements sweep 0/1/8/32 (no pruning stage exists) ----
// Method: 2 options, firm pick (0.8/0.2); stage latencies scripted 5+9ms
// so latency_ms is the exact deterministic sum; wall time measured over
// 20 reps per row; memory sampled around the 32-requirement args.
// Reported: /predict calls, questions per stage, stub latency sum,
// pipeline wall overhead, approx memory.
{
  const two = [{ id: "a", description: "A" }, { id: "b", description: "B" }];
  const memPool = heapMB();
  for (const nReq of [0, 1, 8, 32]) {
    const reqs = Array.from({ length: nReq }, (_, i) => `requirement ${i}`);
    const mk = () => {
      let i = 0;
      return {
        predict: async (state, questions) => {
          const stage = i++;
          const answers = stage === 0
            ? { selected: { choice: "a", probabilities: { a: 0.8, b: 0.2 } } }
            : Object.fromEntries(reqs.map((_, j) => [`requirement_${j}`, { noul: 0.95 }]));
          void state; void questions;
          return { answers, confidence: {}, routing: {}, model: "fase4-t7-test", latencyMs: stage === 0 ? 5 : 9, usage: {} };
        },
      };
    };
    const body = JSON.parse(await handleDecide(mk(), { decision: "d", candidates: two, requirements: reqs }));
    const expectCalls = nReq === 0 ? 1 : 2;
    const expectLatency = nReq === 0 ? 5 : 14;
    assert.equal(body.latency_ms, expectLatency, `decide reqs=${nReq}: stub latency sum`);
    assert.equal(body.selected, "a");
    assert.equal(body.decision.decision, "ALLOW");
    assert.equal(Object.keys(body.requirements).length, nReq);
    const wall = await benchE2eWall(() => handleDecide(mk(), { decision: "d", candidates: two, requirements: reqs }), 20);
    benchRows.push({
      primitive: "decide", mode: `reqs=${nReq} (calls=${expectCalls})`,
      n: 2, kept: expectCalls === 1 ? 1 : 1 + nReq, dropped: 0, ratio: (0).toFixed(3),
      selMs: "n/a (no pruning)", e2eMs: `${wall.toFixed(3)} wall / ${expectLatency} stub-sum`,
      tput: "n/a", mem: nReq === 32 ? memPool.toFixed(1) : "—",
    });
  }
}

console.log("\nFase-4 T7 benchmarks (deterministic stub + fakes, absolutes, no baseline claims):");
console.log("method: single process; stub latencyMs=0 (wall = pipeline overhead); memory = heapUsed right after pool construction (absolute process heap, approx); throughput = pool/selector-s.");
console.log("| primitive | mode | N | sent->judge | dropped | pruning_ratio | selector_ms | e2e_wall_ms | cand/s | mem_MB~ |");
console.log("|-----------|------|---|-------------|---------|---------------|-------------|-------------|--------|---------|");
for (const r of benchRows) {
  console.log(`| ${r.primitive} | ${r.mode} | ${r.n} | ${r.kept} | ${r.dropped} | ${r.ratio} | ${r.selMs} | ${r.e2eMs} | ${r.tput} | ${r.mem} |`);
}
console.log("(rows within one primitive share the process: compare shapes, not machines; no improvement claimed.)");
