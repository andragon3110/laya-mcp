/**
 * T6 limit tests for the TS side: every builder rejects/flags WITHOUT a
 * server (builders are pure functions over args; runTool/client are never
 * touched here). Run after build from the repo root:
 *     node tests/t6_limits.mjs
 */
import assert from "node:assert";
import { LIMITS } from "../dist/limits.js";
import { findTool } from "../dist/tools/find.js";
import { decideTool } from "../dist/tools/decide.js";
import { rerankTool, truncateRerankCandidates } from "../dist/tools/rerank.js";
import { classifyTool } from "../dist/tools/classify.js";
import { extractTool, buildRegexQuestionsWithInfo } from "../dist/tools/extract.js";
import { verifyTool } from "../dist/tools/verify.js";
import { screenTool } from "../dist/tools/screen.js";
import { reviewTool } from "../dist/tools/review.js";
import { gateTool } from "../dist/tools/gate.js";
import { compareTool } from "../dist/tools/compare.js";
import { piiTool } from "../dist/tools/pii.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}
function throwsInputTooLarge(fn, field) {
  assert.throws(fn, (err) => {
    assert.match(String(err?.message ?? err), /input_too_large/, "code vocabulary");
    assert.match(String(err?.message ?? err), new RegExp(`field="${field}"`), "field name");
    assert.equal(err?.detail?.code, "input_too_large", "structured detail");
    assert.equal(err?.detail?.field, field, "detail field");
    assert.ok(typeof err?.detail?.limit === "number", "detail limit");
    assert.ok(typeof err?.detail?.actual === "number", "detail actual");
    assert.ok(typeof err?.detail?.hint === "string" && err.detail.hint.length > 0, "detail hint");
    return true;
  });
}
const cands = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `body ${i}` }));

// find: 250 passes (251 criteria incl. none), 251 throws, no silent slice.
check("find 250 ok", () => {
  const q = findTool.buildQuestions({ query: "q", candidates: cands(250) });
  assert.equal(Object.keys(q.exists.criteria).length, 251);
});
check("find 251 throws input_too_large", () => {
  throwsInputTooLarge(() => findTool.buildQuestions({ query: "q", candidates: cands(251) }), "candidates");
});

// decide: min 2 / max 6 enforced in builder, requirements capped.
check("decide 2 and 6 ok", () => {
  findDecideOk(2);
  findDecideOk(6);
  function findDecideOk(n) {
    const q = decideTool.buildQuestions({ decision: "d", candidates: cands(n) });
    assert.ok(q.selected, "selected question built");
  }
});
check("decide 1 and 7 throw", () => {
  throwsInputTooLarge(() => decideTool.buildQuestions({ decision: "d", candidates: cands(1) }), "candidates");
  throwsInputTooLarge(() => decideTool.buildQuestions({ decision: "d", candidates: cands(7) }), "candidates");
});
check("decide 33 requirements throw", () => {
  const reqs = Array.from({ length: 33 }, (_, i) => `req ${i}`);
  throwsInputTooLarge(
    () => decideTool.buildQuestions({ decision: "d", candidates: cands(2), requirements: reqs }),
    "requirements",
  );
});

// rerank: 2000-char truncation is real + flagged; 64 candidates max.
check("rerank truncation real with flag", () => {
  const under = truncateRerankCandidates([{ id: "a", text: "x".repeat(2000) }]);
  assert.equal(under.truncated, false);
  const over = truncateRerankCandidates([
    { id: "a", text: "x".repeat(2000) },
    { id: "b", text: "y".repeat(2001) },
  ]);
  assert.equal(over.truncated, true);
  assert.deepEqual(over.truncatedIds, ["b"]);
  assert.equal(over.candidates[1].text.length, 2000);
  assert.equal(over.candidates[1].id, "b", "ids untouched");
});
check("rerank 65 candidates throw", () => {
  throwsInputTooLarge(() => rerankTool.buildQuestions({ query: "q", candidates: cands(65) }), "candidates");
});

// classify: 64 items ok (one question each), 65 throws.
check("classify 64 ok, 65 throws", () => {
  const items = cands(64).map((c) => ({ id: c.id, text: c.text }));
  const q = classifyTool.buildQuestions({ purpose: "p", items, classes: [{ id: "x", description: "X" }] });
  assert.equal(Object.keys(q).length, 64);
  throwsInputTooLarge(
    () =>
      classifyTool.buildQuestions({
        purpose: "p",
        items: [...items, { id: "extra", text: "t" }],
        classes: [{ id: "x", description: "X" }],
      }),
    "items",
  );
});

// extract: 20-cap kept but reported; doc/fields caps enforced.
check("extract 25 matches -> 20 criteria + truncated/dropped", () => {
  const doc = Array.from({ length: 25 }, (_, i) => `val${i}`).join(" ");
  const built = buildRegexQuestionsWithInfo({
    document: doc,
    fields: [{ id: "f", description: "F", pattern: "val\\d+" }],
  });
  const keys = Object.keys(built.questions.extract_0_f.criteria);
  assert.equal(keys.filter((k) => k !== "none").length, 20);
  assert.equal(built.truncated, true);
  assert.equal(built.dropped, 5);
});
check("extract tool builder exposes budget errors", () => {
  throwsInputTooLarge(
    () => extractTool.buildQuestions({ document: "x".repeat(LIMITS.maxStateChars + 1), fields: [] }),
    "document",
  );
  throwsInputTooLarge(
    () =>
      extractTool.buildQuestions({
        document: "d",
        fields: Array.from({ length: 65 }, (_, i) => ({ id: `f${i}`, description: "x" })),
      }),
    "fields",
  );
});

// verify / screen / review / gate / compare / pii text+count caps.
check("verify 64 claims ok, 65 throws; long evidence throws", () => {
  const claims = Array.from({ length: 64 }, (_, i) => `claim ${i}`);
  assert.equal(Object.keys(verifyTool.buildQuestions({ claims, evidence: "e" })).length, 64);
  throwsInputTooLarge(
    () => verifyTool.buildQuestions({ claims: [...claims, "one more"], evidence: "e" }),
    "claims",
  );
  throwsInputTooLarge(() => verifyTool.buildQuestions({ claims: ["c"], evidence: "e".repeat(20001) }), "evidence");
});
check("screen long text throws", () => {
  throwsInputTooLarge(() => screenTool.buildQuestions({ text: "t".repeat(20001), purpose: "p" }), "text");
});
check("review long diff throws", () => {
  throwsInputTooLarge(() => reviewTool.buildQuestions({ request: "r", diff: "d".repeat(20001) }), "diff");
});
check("gate 61 claims ok, 62 throws", () => {
  const claims = Array.from({ length: 61 }, (_, i) => `claim ${i}`);
  assert.ok(gateTool.buildQuestions({ request: "r", diff: "d", claims }).correctness);
  throwsInputTooLarge(() => gateTool.buildQuestions({ request: "r", diff: "d", claims: [...claims, "x"] }), "claims");
});
check("compare 33 aspects throw; long passage throws", () => {
  const aspects = Array.from({ length: 33 }, (_, i) => `a${i}`);
  throwsInputTooLarge(() => compareTool.buildQuestions({ passage_a: "a", passage_b: "b", aspects }), "aspects");
  throwsInputTooLarge(
    () => compareTool.buildQuestions({ passage_a: "a".repeat(20001), passage_b: "b" }),
    "passage_a",
  );
});
check("pii long text / many extra_types throw", () => {
  throwsInputTooLarge(() => piiTool.buildQuestions({ text: "t".repeat(50001) }), "text");
  throwsInputTooLarge(
    () => piiTool.buildQuestions({ text: "t", extra_types: Array.from({ length: 33 }, (_, i) => `e${i}`) }),
    "extra_types",
  );
});

console.log(`\nT6 TS limits: ${passed} checks passed (no server involved).`);
