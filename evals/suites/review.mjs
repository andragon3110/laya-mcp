/**
 * Fase-7 T3 eval suite: review (laya_review).
 *
 * STUB MODEL: the rubric stubs emulate what a real backend would plausibly
 * return for each diff: top scores + high safety for a clean tested change,
 * just-above-auto safety for an edge change, mid-band safety for a change
 * with test gaps, low scores + low safety for a broken diff, `{}` (missing)
 * for a dropped safety answer. Scores are 0-2 audit evidence; only
 * safe_to_apply drives the decision.
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Rubric scores and safety
 * signals are oracle-assigned: no code-review quality claim transfers. v1
 * pins: mid-band safety (0.50, 0.85] abstains so the policy REVIEW path is
 * unreachable via the handler (only ALLOW/ESCALATE surface); edges are
 * strict > (0.85 -> REVIEW band edge, 0.50 -> escalate edge); missing safety
 * abstains; the tool never authorizes anything.
 */
import assert from "node:assert";
import { handleReview } from "../../dist/tools/review.js";

export const name = "review";
export const primitive = "laya_review";
export const stubModel =
  "Rubric 0-2 scores (audit) + safe_to_apply noul: high for clean diffs, edge " +
  "0.86, mid-band for gappy diffs, low for broken diffs, {} for silence.";
export const stubLimits =
  "Scores and safety are oracle-assigned: no review-quality claim transfers; " +
  "REVIEW is unreachable via the handler because mid-band safety abstains.";

export const cases = [
  {
    id: "review-normal-01",
    kind: "normal",
    input: { request: "fix login crash", diff: "+ null check\n+ test", tests: "2 passed" },
    oracle: "clean tested fix; backend plausibly scores top with high safety.",
    stub: {
      answers: {
        correctness: { score: 2 }, spec_match: { score: 2 }, test_gap: { score: 0 },
        blast_radius: { score: 0 }, safe_to_apply: { noul: 0.95 },
      },
    },
    gold: { decision: "ALLOW", abstained: false, why: "firm safe signal above the auto cut allows." },
  },
  {
    id: "review-difficult-01",
    kind: "difficult",
    input: { request: "fix login crash", diff: "+ null check" },
    oracle: "correct fix with thin evidence; backend plausibly lands just above the auto cut.",
    stub: {
      answers: {
        correctness: { score: 2 }, spec_match: { score: 2 }, test_gap: { score: 1 },
        blast_radius: { score: 0 }, safe_to_apply: { noul: 0.86 },
      },
    },
    gold: { decision: "ALLOW", abstained: false, why: "0.86 clears the strict > 0.85 auto cut." },
  },
  {
    id: "review-ambiguous-01",
    kind: "ambiguous",
    input: { request: "fix login crash", diff: "+ null check" },
    oracle: "plausible fix nobody verified; backend plausibly returns mid-band safety.",
    stub: {
      answers: {
        correctness: { score: 1 }, spec_match: { score: 1 }, test_gap: { score: 1 },
        blast_radius: { score: 1 }, safe_to_apply: { noul: 0.7 },
      },
    },
    gold: { decision: "ESCALATE", abstained: true, why: "mid-band safety abstains; neither firm auto nor firm escalate." },
  },
  {
    id: "review-adversarial-01",
    kind: "adversarial",
    input: { request: "fix login crash", diff: "+ null check // no tests, wide refactor" },
    oracle: "correct-looking but untested change; backend plausibly hedges safety to mid-band.",
    stub: {
      answers: {
        correctness: { score: 2 }, spec_match: { score: 2 }, test_gap: { score: 2 },
        blast_radius: { score: 2 }, safe_to_apply: { noul: 0.6 },
      },
    },
    gold: { decision: "ESCALATE", abstained: true, why: "surface correctness cannot rescue an untested blast radius." },
  },
  {
    id: "review-negative-01",
    kind: "negative",
    input: { request: "fix login crash", diff: "- auth check" },
    oracle: "diff breaks the spec and removes safety; backend plausibly scores bottom with low safety.",
    stub: {
      answers: {
        correctness: { score: 0 }, spec_match: { score: 0 }, test_gap: { score: 2 },
        blast_radius: { score: 2 }, safe_to_apply: { noul: 0.1 },
      },
    },
    gold: { decision: "ESCALATE", abstained: false, why: "firm low safety escalates on the safety floor." },
  },
  {
    id: "review-negative-02",
    kind: "negative",
    input: { request: "fix login crash", diff: "+ null check" },
    oracle: "safety landing exactly on the review floor edge.",
    stub: {
      answers: {
        correctness: { score: 1 }, spec_match: { score: 1 }, test_gap: { score: 1 },
        blast_radius: { score: 0 }, safe_to_apply: { noul: 0.5 },
      },
    },
    gold: { decision: "ESCALATE", abstained: false, why: "0.50 is not > 0.50, so the floor edge escalates." },
  },
  {
    id: "review-abstention-01",
    kind: "abstention",
    input: { request: "fix login crash", diff: "+ null check" },
    oracle: "backend drops the safety answer; rubric scores alone cannot decide.",
    stub: {
      answers: {
        correctness: { score: 2 }, spec_match: { score: 2 }, test_gap: { score: 0 },
        blast_radius: { score: 0 },
      },
    },
    gold: { decision: "ESCALATE", abstained: true, why: "missing safety signal abstains instead of inferring safety." },
  },
  {
    id: "review-negative-limit-01",
    kind: "negative",
    input: { request: "r", diff: "x".repeat(20001) },
    oracle: "diff over the 20,000-char cap; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "oversized diffs fail fast instead of reviewing a truncated patch." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleReview(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  return { decision: body.decision.decision, safe: body.rubric.safe_to_apply.signal };
}
