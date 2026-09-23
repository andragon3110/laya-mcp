/**
 * Fase-4 T3 (extract primitives): top_k / min_gliner_score / max_candidates
 * + grounded values with offsets on both paths.
 *
 * No server, no LLM: the real handleExtract + builders run against a stub
 * LayaClient with canned answers and a stub GLiNER sidecar. Every assertion
 * runs the real candidate pipeline (select/filter/sort/cap) underneath.
 *
 * Pinned contracts:
 *   - defaults (no new params) = legacy slice(0,20) behaviour, zero breaking;
 *   - top_k / max_candidates narrow the shown set (effective min of both);
 *   - min_gliner_score filters entities BEFORE sorting by detector_score;
 *   - value is ALWAYS a verbatim document substring with start/end; a judge
 *     choice that maps to no exact span (hallucinated key or sidecar/doc
 *     mismatch) resolves to null/not_found, never synthesized;
 *   - count params above the LAYA_LIMITS_MAX_EXTRACT_CANDIDATES ceiling
 *     (default 20) throw input_too_large; score outside [0,1] throws;
 *   - extract policy stays 1.0.0 (filtering composes with firmness: a fully
 *     filtered field escalates via the existing extract_no_candidates).
 *
 * Run after build from the repo root:  node tests/fase4_extract_primitives.mjs
 */
import assert from "node:assert";
import { LIMITS } from "../dist/limits.js";
import {
  extractTool,
  handleExtract,
  buildRegexQuestionsWithInfo,
  resolveExtractSelection,
  selectEntitySpans,
  isGrounded,
} from "../dist/tools/extract.js";

const fakeClient = (answers, latencyMs = 7) => ({
  predict: async () => ({ answers, confidence: {}, routing: {}, model: "fase4-t3-test", latencyMs, usage: {} }),
});

const fakeEntityCtx = (spansByType) => ({
  glinerReady: () => true,
  gliner: {
    extractEntities: async () => ({ spansByType, latencyMs: 4 }),
  },
});

let passed = 0;
function check(name, fn) {
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

const doc25 = Array.from({ length: 25 }, (_, i) => `val${i}`).join(" ");
const valField = { id: "f", description: "F", pattern: "val\\d+" };

// ------------------------------------------------------- selection units ---
await check("unit: defaults resolve to legacy 20/20/0 (zero breaking)", () => {
  assert.deepEqual(resolveExtractSelection({}), {
    topK: 20,
    maxCandidates: 20,
    minGlinerScore: 0,
    shown: 20,
  });
});

await check("unit: shown is min(top_k, max_candidates)", () => {
  assert.equal(resolveExtractSelection({ top_k: 10, max_candidates: 3 }).shown, 3);
  assert.equal(resolveExtractSelection({ top_k: 3, max_candidates: 10 }).shown, 3);
});

await check("unit: selectEntitySpans filters by score, sorts desc, caps (stable ties)", () => {
  const spans = [
    { text: "low", start: 0, end: 3, confidence: 0.3, type: "t" },
    { text: "high", start: 4, end: 8, confidence: 0.9, type: "t" },
    { text: "mid", start: 9, end: 12, confidence: 0.7, type: "t" },
    { text: "mid2", start: 13, end: 17, confidence: 0.7, type: "t" },
  ];
  const shown = selectEntitySpans(spans, 0.5, 10);
  assert.deepEqual(shown.map((s) => s.text), ["high", "mid", "mid2"]);
  assert.deepEqual(selectEntitySpans(spans, 0, 2).map((s) => s.text), ["high", "mid"]);
  assert.deepEqual(selectEntitySpans(spans, 0.95, 10), []);
});

await check("unit: isGrounded accepts exact slices, rejects shifts/mismatches", () => {
  assert.equal(isGrounded("price $29 total", "$29", 6, 9), true);
  assert.equal(isGrounded("price $29 total", "$29", 7, 10), false);
  assert.equal(isGrounded("price $29 total", "$30", 6, 9), false);
  assert.equal(isGrounded("abc", "abc", 0, 3), true);
  assert.equal(isGrounded("abc", "x", -1, 1), false);
  assert.equal(isGrounded("abc", "abcd", 0, 4), false);
});

// ------------------------------------------------------------- regex path ---
await check("regex defaults = legacy: 25 matches -> 20 criteria + dropped 5", () => {
  const built = buildRegexQuestionsWithInfo({ document: doc25, fields: [valField] });
  const keys = Object.keys(built.questions.extract_0_f.criteria);
  assert.equal(keys.filter((k) => k !== "none").length, 20);
  assert.equal(built.truncated, true);
  assert.equal(built.dropped, 5);
});

await check("regex top_k=5 cuts to first 5 matches + dropped 20", () => {
  const built = buildRegexQuestionsWithInfo({ document: doc25, fields: [valField], top_k: 5 });
  const crit = built.questions.extract_0_f.criteria;
  assert.deepEqual(Object.keys(crit).filter((k) => k !== "none"), ["m0", "m1", "m2", "m3", "m4"]);
  assert.equal(crit.m4, "val4");
  assert.equal(built.truncated, true);
  assert.equal(built.dropped, 20);
});

await check("regex effective cap is min(top_k, max_candidates)", () => {
  const built = buildRegexQuestionsWithInfo({
    document: doc25,
    fields: [valField],
    top_k: 10,
    max_candidates: 3,
  });
  assert.equal(Object.keys(built.questions.extract_0_f.criteria).filter((k) => k !== "none").length, 3);
  assert.equal(built.dropped, 22);
});

await check("regex e2e: picked value carries grounded start/end offsets", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_f: { choice: "m1", probabilities: { m1: 0.8, none: 0.2 } } }),
      { document: "price $29 and $31 total", fields: [{ id: "f", description: "F", pattern: "\\$\\d+" }], source: "regex" },
    ),
  );
  const r = body.results[0];
  assert.equal(r.value, "$31");
  assert.equal(r.status, "extracted");
  assert.equal(typeof r.start, "number");
  assert.equal(typeof r.end, "number");
  assert.equal("price $29 and $31 total".slice(r.start, r.end), r.value);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.policy, { name: "extract", version: "1.0.0" });
});

await check("regex e2e top_k: m4 resolves within the narrowed set, grounded", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_f: { choice: "m4", probabilities: { m4: 0.9, none: 0.1 } } }),
      { document: doc25, fields: [valField], source: "regex", top_k: 5 },
    ),
  );
  assert.equal(body.results[0].value, "val4");
  assert.equal(doc25.slice(body.results[0].start, body.results[0].end), "val4");
  assert.equal(body.truncated, true);
  assert.equal(body.dropped, 20);
});

await check("regex hallucinated choice (m99) -> null/not_found, never synthesized", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_f: { choice: "m99", probabilities: { m99: 0.9, none: 0.1 } } }),
      { document: "price $29 total", fields: [{ id: "f", description: "F", pattern: "\\$\\d+" }], source: "regex" },
    ),
  );
  assert.equal(body.results[0].value, null);
  assert.equal(body.results[0].status, "not_found");
  assert.ok(!("start" in body.results[0]) && !("end" in body.results[0]), "no offsets on not_found");
  // Firm not_found (candidates existed, judge answered): policy still ALLOWs.
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["extract_values_allow"]);
});

await check("regex empty document -> zero candidates -> not_found + ESCALATE", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_f: { choice: "none", probabilities: { none: 1 } } }),
      { document: "", fields: [{ id: "f", description: "F", pattern: "x+" }], source: "regex" },
    ),
  );
  assert.equal(body.results[0].value, null);
  assert.equal(body.results[0].status, "not_found");
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
  // The engine global rule short-circuits abstained evidence to
  // abstained_evidence before the extract policy runs (pre-existing wiring,
  // unchanged by T3); the policy-level extract_no_candidates stays as the
  // documented reason for the same condition.
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

await check("regex oversized document rejected with input_too_large (builder + handler)", async () => {
  const big = "x".repeat(LIMITS.maxStateChars + 1);
  throwsInputTooLarge(() => extractTool.buildQuestions({ document: big, fields: [] }), "document");
  await assert.rejects(
    handleExtract(fakeClient({}), { document: big, fields: [], source: "regex" }),
    /input_too_large/,
  );
});

// ---------------------------------------------------------------- limits ---
await check("limits: top_k/max_candidates > ceiling throw input_too_large; bad ints throw", () => {
  throwsInputTooLarge(() => buildRegexQuestionsWithInfo({ document: "d", fields: [valField], top_k: 21 }), "top_k");
  throwsInputTooLarge(
    () => buildRegexQuestionsWithInfo({ document: "d", fields: [valField], max_candidates: 64 }),
    "max_candidates",
  );
  for (const bad of [0, -2, 1.5, "5"]) {
    assert.throws(
      () => buildRegexQuestionsWithInfo({ document: "d", fields: [valField], top_k: bad }),
      /must be an integer >= 1/,
      `top_k=${JSON.stringify(bad)}`,
    );
  }
  assert.equal(resolveExtractSelection({ top_k: null }).topK, 20, "null = default");
});

await check("limits: min_gliner_score outside [0,1] throws (edges 0/1 pass, null = default)", () => {
  for (const bad of [-0.1, 1.5, "high", NaN]) {
    assert.throws(
      () => resolveExtractSelection({ min_gliner_score: bad }),
      /min_gliner_score must be a number in \[0,1\]/,
      `score=${JSON.stringify(bad)}`,
    );
  }
  assert.equal(resolveExtractSelection({ min_gliner_score: 0 }).minGlinerScore, 0);
  assert.equal(resolveExtractSelection({ min_gliner_score: 1 }).minGlinerScore, 1);
  assert.equal(resolveExtractSelection({ min_gliner_score: null }).minGlinerScore, 0);
});

await check("limits: LAYA_LIMITS_MAX_EXTRACT_CANDIDATES retunes ceiling + defaults; invalid falls back", () => {
  const prev = process.env.LAYA_LIMITS_MAX_EXTRACT_CANDIDATES;
  try {
    process.env.LAYA_LIMITS_MAX_EXTRACT_CANDIDATES = "5";
    const built = buildRegexQuestionsWithInfo({ document: doc25, fields: [valField] });
    assert.equal(Object.keys(built.questions.extract_0_f.criteria).filter((k) => k !== "none").length, 5);
    assert.equal(built.dropped, 20);
    throwsInputTooLarge(
      () => buildRegexQuestionsWithInfo({ document: "d", fields: [valField], top_k: 6 }),
      "top_k",
    );
    process.env.LAYA_LIMITS_MAX_EXTRACT_CANDIDATES = "abc";
    const fallback = buildRegexQuestionsWithInfo({ document: doc25, fields: [valField] });
    assert.equal(Object.keys(fallback.questions.extract_0_f.criteria).filter((k) => k !== "none").length, 20);
  } finally {
    if (prev === undefined) delete process.env.LAYA_LIMITS_MAX_EXTRACT_CANDIDATES;
    else process.env.LAYA_LIMITS_MAX_EXTRACT_CANDIDATES = prev;
  }
});

// ------------------------------------------------------------ entities path ---
const entitySpans = {
  persona: [
    { text: "Ana", start: 0, end: 3, confidence: 0.3, type: "persona" },
    { text: "Luis", start: 5, end: 9, confidence: 0.9, type: "persona" },
    { text: "Marta", start: 11, end: 16, confidence: 0.7, type: "persona" },
  ],
};
const entityDoc = "Ana, Luis, Marta";
const entityArgs = (extra = {}) => ({
  document: entityDoc,
  fields: [{ id: "persona", description: "Nombre" }],
  source: "entities",
  ...extra,
});

await check("entities defaults: no filtering, sorted by detector_score desc", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_persona: { choice: "g0", probabilities: { g0: 0.8, none: 0.2 } } }),
      entityArgs(),
      fakeEntityCtx(entitySpans),
    ),
  );
  assert.equal(body.source, "entities");
  assert.equal(body.results[0].value, "Luis");
  assert.equal(body.results[0].detector_score, 0.9);
  assert.equal(entityDoc.slice(body.results[0].start, body.results[0].end), "Luis");
  assert.equal(body.truncated, false);
  assert.equal(body.dropped, 0);
});

await check("entities min_gliner_score filters then sorts; dropped counts filtered", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_persona: { choice: "g1", probabilities: { g1: 0.8, none: 0.2 } } }),
      entityArgs({ min_gliner_score: 0.5 }),
      fakeEntityCtx(entitySpans),
    ),
  );
  // g0 = Luis (0.9), g1 = Marta (0.7); Ana (0.3) filtered out, counted dropped.
  assert.equal(body.results[0].value, "Marta");
  assert.equal(body.results[0].detector_score, 0.7);
  assert.equal(entityDoc.slice(body.results[0].start, body.results[0].end), "Marta");
  assert.equal(body.truncated, true);
  assert.equal(body.dropped, 1);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.policy, { name: "extract", version: "1.0.0" });
});

await check("entities fully filtered -> zero shown -> not_found + ESCALATE (policy still 1.0.0)", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_persona: { choice: "none", probabilities: { none: 1 } } }),
      entityArgs({ min_gliner_score: 0.99 }),
      fakeEntityCtx(entitySpans),
    ),
  );
  assert.equal(body.results[0].value, null);
  assert.equal(body.results[0].status, "not_found");
  assert.equal(body.truncated, true);
  assert.equal(body.dropped, 3);
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
  // Same wiring as zero-proposal: the engine global rule reports
  // abstained_evidence; filtering composes with firmness, no policy change.
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
  assert.deepEqual(body.decision.policy, { name: "extract", version: "1.0.0" });
});

await check("entities hallucinated choice (g99) -> null/not_found, never synthesized", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_persona: { choice: "g99", probabilities: { g99: 0.9, none: 0.1 } } }),
      entityArgs(),
      fakeEntityCtx(entitySpans),
    ),
  );
  assert.equal(body.results[0].value, null);
  assert.equal(body.results[0].status, "not_found");
});

await check("entities span/doc mismatch -> null/not_found (sidecar never trusted blindly)", async () => {
  const lying = {
    persona: [{ text: "Ximena", start: 0, end: 6, confidence: 0.95, type: "persona" }],
  };
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_persona: { choice: "g0", probabilities: { g0: 0.9, none: 0.1 } } }),
      entityArgs(),
      fakeEntityCtx(lying),
    ),
  );
  assert.equal(body.results[0].value, null);
  assert.equal(body.results[0].status, "not_found");
  assert.ok(!("start" in body.results[0]) && !("end" in body.results[0]), "no offsets on ungrounded span");
});

await check("entities without sidecar throws the explicit error (no silent regex swap)", async () => {
  await assert.rejects(handleExtract(fakeClient({}), entityArgs()), /sidecar is not reachable/);
});

await check("entities empty document with no spans -> ESCALATE", async () => {
  const body = JSON.parse(
    await handleExtract(
      fakeClient({ extract_0_persona: { choice: "none", probabilities: { none: 1 } } }),
      { document: "", fields: [{ id: "persona", description: "Nombre" }], source: "entities" },
      fakeEntityCtx({}),
    ),
  );
  assert.equal(body.results[0].value, null);
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
});

console.log(`\nFase-4 T3 extract primitives: ${passed} checks passed (no server, no LLM involved).`);
