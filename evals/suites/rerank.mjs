/**
 * Fase-7 T3 eval suite: rerank (laya_rerank).
 *
 * STUB MODEL: each stub noul emulates the per-candidate relevance a real
 * backend would plausibly return for the query: clearly ordered scores for a
 * clean ranking, a near tie for close candidates, an exact tie for
 * duplicates, an inverted order when semantic relevance disagrees with
 * lexical overlap (the judge, not the pre-filter, owns the final order), a
 * dropped answer `{}` for a silent candidate. Legacy path (no top_k).
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Relevance magnitudes are
 * oracle-assigned and within-call only by contract: no cross-call score
 * comparison is meaningful, and nothing here measures real ranking quality.
 * v1 pins: scores are never probabilities and no cutoff on them is
 * meaningful; ties keep input order without abstaining; missing signals and
 * empty pools ESCALATE; a single candidate ranks first with ALLOW.
 */
import assert from "node:assert";
import { handleRerank } from "../../dist/tools/rerank.js";

export const name = "rerank";
export const primitive = "laya_rerank";
export const stubModel =
  "Per-candidate noul: ordered, near-tied, exactly tied, lexically inverted, " +
  "or {} silence; scores are within-call only, never probabilities.";
export const stubLimits =
  "Relevance magnitudes are oracle-assigned: no ranking-quality claim " +
  "transfers; score comparisons across calls are meaningless by contract.";

const PAIR = [
  { id: "a", text: "apple harvest report" },
  { id: "b", text: "zebra migration notes" },
];

export const cases = [
  {
    id: "rerank-normal-01",
    kind: "normal",
    input: { query: "apple", candidates: PAIR },
    oracle: "candidate a is topically relevant, b is not; backend plausibly scores them apart.",
    stub: { answers: { relevance_0_a: { noul: 0.8 }, relevance_1_b: { noul: 0.2 } } },
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "clear relevance gap orders without abstention." },
  },
  {
    id: "rerank-normal-02",
    kind: "normal",
    input: { query: "q", candidates: [{ id: "a", text: "A" }] },
    oracle: "single candidate; no 1/N baseline exists in rerank by design.",
    stub: { answers: { relevance_0_a: { noul: 0.8 } } },
    gold: { order: ["a"], decision: "ALLOW", abstained: false, why: "one candidate ranks first; rerank never applies a uniform baseline." },
  },
  {
    id: "rerank-difficult-01",
    kind: "difficult",
    input: { query: "apple", candidates: PAIR },
    oracle: "both candidates mention the query area; backend plausibly scores them nearly tied.",
    stub: { answers: { relevance_0_a: { noul: 0.51 }, relevance_1_b: { noul: 0.5 } } },
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "near ties still order; the gap size carries no meaning." },
  },
  {
    id: "rerank-ambiguous-01",
    kind: "ambiguous",
    input: { query: "doc", candidates: [{ id: "a", text: "same body" }, { id: "b", text: "same body" }] },
    oracle: "duplicate bodies; backend plausibly returns the exact tie.",
    stub: { answers: { relevance_0_a: { noul: 0.5 }, relevance_1_b: { noul: 0.5 } } },
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "exact ties keep input order; rerank never abstains on ties." },
  },
  {
    id: "rerank-adversarial-01",
    kind: "adversarial",
    input: { query: "apple", candidates: [{ id: "a", text: "apple apple apple" }, { id: "b", text: "orchard economics" }] },
    oracle: "lexical overlap favours a but semantic relevance favours b; the judge owns the final order.",
    stub: { answers: { relevance_0_a: { noul: 0.2 }, relevance_1_b: { noul: 0.8 } } },
    gold: { order: ["b", "a"], decision: "ALLOW", abstained: false, why: "final order is the judge's; lexical overlap never leaks into scores." },
  },
  {
    id: "rerank-negative-01",
    kind: "negative",
    input: { query: "apple", candidates: PAIR },
    oracle: "backend drops one candidate answer; a partial ordering is uninterpretable.",
    stub: { answers: { relevance_0_a: { noul: 0.8 } } },
    gold: { order: ["a", "b"], decision: "ESCALATE", abstained: true, why: "missing candidate signals escalate; nulls sort last." },
  },
  {
    id: "rerank-abstention-01",
    kind: "abstention",
    input: { query: "apple", candidates: [] },
    oracle: "nothing to rank; the ordering is vacuous by construction.",
    stub: { answers: {} },
    gold: { order: [], decision: "ESCALATE", abstained: true, why: "zero candidates abstain; no order is produced." },
  },
  {
    id: "rerank-negative-limit-01",
    kind: "negative",
    input: {
      query: "q",
      candidates: Array.from({ length: 65 }, (_, i) => ({ id: `r${i}`, text: `candidate ${i}` })),
    },
    oracle: "65 candidates exceed the 64 ceiling; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "over-ceiling pools fail fast, never silently cut." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleRerank(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.order !== undefined) {
    assert.deepEqual(body.ranked.map((r) => r.id), gold.order, "order");
  }
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  return { decision: body.decision.decision, order: body.ranked.map((r) => r.id) };
}
