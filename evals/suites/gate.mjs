/**
 * Fase-7 T3 eval suite: gate (laya_gate, completion gate).
 *
 * STUB MODEL: the rubric + per-claim stubs emulate what a real backend would
 * plausibly return for each completion: firm rubric with supported claims
 * (weak refutation) for a truthful completion, edge-cut signals for a
 * barely-passing one, mid-band safety for an unverified one, contradictory
 * high claims scored independently (no cross-claim check, same as verify),
 * a firm refutation + low support pair for refuted work, low safety alone
 * for a risky-but-true completion, `{}` for a dropped claim answer.
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Safety and claim signals
 * are oracle-assigned: no completion-truthfulness claim transfers. Pins:
 * contradicted claims (firm refutation + weak support) dominate safety
 * (ESCALATE even when safe); low safety WITHOUT contradicted claims only
 * REVIEWs (deliberate difference from review@1.0.0, which escalates on
 * safety alone); mid-band safety reaches REVIEW (no band abstention since
 * T3); low support alone never contradicts; v1 never returns DENY (gate
 * refuses authority; worst case is ESCALATE).
 */
import assert from "node:assert";
import { handleGate } from "../../dist/tools/gate.js";

export const name = "gate";
export const primitive = "laya_gate";
export const stubModel =
  "Rubric scores + safe_to_apply noul + per-claim noul: firm/edge/mid/low per " +
  "oracle, contradictory pairs independently high, {} for dropped answers.";
export const stubLimits =
  "Safety and claim signals are oracle-assigned: no completion-truthfulness " +
  "claim transfers to the real backend.";

const BASE = { request: "ship fix", diff: "+ null check", evidence: "tests: 2 passed" };

export const cases = [
  {
    id: "gate-normal-01",
    kind: "normal",
    input: { ...BASE, claims: ["all tests pass"] },
    oracle: "truthful completion with evidence; backend plausibly returns firm rubric and support.",
    stub: {
      answers: {
        correctness: { score: 2 }, spec_match: { score: 2 }, safe_to_apply: { noul: 0.95 },
        claim_0: { noul: 0.9 }, refute_0: { noul: 0.1 },
      },
    },
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "firm safety plus a verified claim auto-allows." },
  },
  {
    id: "gate-difficult-01",
    kind: "difficult",
    input: { ...BASE, claims: ["all tests pass"] },
    oracle: "barely-passing completion landing just above both cuts.",
    stub: {
      answers: {
        correctness: { score: 1 }, spec_match: { score: 1 }, safe_to_apply: { noul: 0.86 },
        claim_0: { noul: 0.8 }, refute_0: { noul: 0.1 },
      },
    },
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "0.86 and 0.80 clear the strict auto and inclusive verified edges." },
  },
  {
    id: "gate-ambiguous-01",
    kind: "ambiguous",
    input: { ...BASE, claims: ["all tests pass"] },
    oracle: "supported claim but unverified safety; backend plausibly hedges safety to mid-band.",
    stub: {
      answers: {
        correctness: { score: 1 }, spec_match: { score: 1 }, safe_to_apply: { noul: 0.7 },
        claim_0: { noul: 0.9 }, refute_0: { noul: 0.1 },
      },
    },
    gold: { verdict: "SUPPORTED", decision: "REVIEW", abstained: false, why: "mid-band safety is firm REVIEW evidence even with a verified claim." },
  },
  {
    id: "gate-adversarial-01",
    kind: "adversarial",
    input: { ...BASE, claims: ["all tests pass", "no tests needed"] },
    oracle: "mutually exclusive completion claims scored independently; both clear the cut.",
    stub: {
      answers: {
        correctness: { score: 2 }, spec_match: { score: 2 }, safe_to_apply: { noul: 0.9 },
        claim_0: { noul: 0.95 }, claim_1: { noul: 0.92 }, refute_0: { noul: 0.1 }, refute_1: { noul: 0.1 },
      },
    },
    gold: { verdicts: ["SUPPORTED", "SUPPORTED"], decision: "ALLOW", abstained: false, why: "v1 has no cross-claim check; contradictory truths both pass." },
  },
  {
    id: "gate-negative-01",
    kind: "negative",
    input: { ...BASE, claims: ["all tests pass"] },
    oracle: "evidence refutes the claim; backend plausibly returns a contradicted-range signal.",
    stub: {
      answers: {
        correctness: { score: 1 }, spec_match: { score: 1 }, safe_to_apply: { noul: 0.9 },
        claim_0: { noul: 0.2 }, refute_0: { noul: 0.9 },
      },
    },
    gold: { verdict: "CONTRADICTED", decision: "ESCALATE", abstained: false, why: "firm refutation with weak support contradicts the claim; high safety never rescues it." },
  },
  {
    id: "gate-negative-02",
    kind: "negative",
    input: { ...BASE, claims: ["all tests pass"] },
    oracle: "true claim on a risky change; backend plausibly returns low safety with firm support.",
    stub: {
      answers: {
        correctness: { score: 1 }, spec_match: { score: 1 }, safe_to_apply: { noul: 0.4 },
        claim_0: { noul: 0.9 }, refute_0: { noul: 0.1 },
      },
    },
    gold: { verdict: "SUPPORTED", decision: "REVIEW", abstained: false, why: "low safety alone only reviews; gate never escalates on safety alone." },
  },
  {
    id: "gate-abstention-01",
    kind: "abstention",
    input: { ...BASE, claims: ["all tests pass"] },
    oracle: "backend drops the claim answer; an unverified claim cannot gate.",
    stub: {
      answers: {
        correctness: { score: 2 }, spec_match: { score: 2 }, safe_to_apply: { noul: 0.9 },
      },
    },
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", why: "missing claim signal escalates via the missing-signal path." },
  },
  {
    id: "gate-negative-limit-01",
    kind: "negative",
    input: { ...BASE, claims: Array.from({ length: 62 }, (_, i) => `claim ${i}`) },
    oracle: "62 claims exceed the 3 rubric + 2x30 question budget; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "over-budget claim lists fail fast instead of gating a subset." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleGate(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  if (gold.verdict !== undefined) {
    assert.equal(body.claims[0].verdict, gold.verdict, "verdict");
  }
  if (gold.verdicts !== undefined) {
    assert.deepEqual(body.claims.map((c) => c.verdict), gold.verdicts, "verdicts");
  }
  return { decision: body.decision.decision, verdicts: body.claims.map((c) => c.verdict) };
}
