/**
 * Fase-7 T3 eval suite: verify (laya_verify).
 *
 * STUB MODEL: each stub noul emulates the per-claim support AND refutation
 * signals a real backend would plausibly return against the evidence text:
 * a claim stated verbatim gets support ~0.9 with weak refutation, an edge
 * paraphrase gets exactly the 0.80 cut, a partial match gets mid-band ~0.6,
 * an unrelated claim gets low ~0.2 with weak refutation (silence is not
 * denial), a dropped answer is `{}` (missing, not zero). Contradictory
 * claim pairs each get high support signals because claims score
 * independently against the evidence (no cross-claim check); a positively
 * refuted claim gets firm refutation + weak support.
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Signals are
 * oracle-assigned, not measured: no claim about real support calibration or
 * real paraphrase sensitivity transfers. Pins: low support without firm
 * refutation is absence of evidence (never CONTRADICTED); mid/low bands
 * reach the policy REVIEW band (no band abstention since T3);
 * mutually-contradictory high claims both SUPPORT (no cross-claim check).
 */
import assert from "node:assert";
import { handleVerify } from "../../dist/tools/verify.js";

export const name = "verify";
export const primitive = "laya_verify";
export const stubModel =
  "Per-claim noul: verbatim ~0.9, edge paraphrase exactly 0.80, partial ~0.6, " +
  "unrelated ~0.2, dropped answer {}; contradictory pairs score independently high.";
export const stubLimits =
  "Signals are oracle-assigned: no support-calibration or paraphrase-sensitivity " +
  "claim transfers to the real backend.";

const EV = "The release passed all 120 tests on Linux and the price is $29.";

export const cases = [
  {
    id: "verify-normal-01",
    kind: "normal",
    input: { claims: ["the price is $29"], evidence: EV },
    oracle: "claim stated verbatim by the evidence; backend plausibly returns high support.",
    stub: { answers: { claim_0: { noul: 0.9 }, refute_0: { noul: 0.1 } } },
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "verbatim support clears the 0.80 verified cut." },
  },
  {
    id: "verify-difficult-01",
    kind: "difficult",
    input: { claims: ["the price is $29"], evidence: EV },
    oracle: "edge paraphrase support landing exactly on the shared cut.",
    stub: { answers: { claim_0: { noul: 0.8 }, refute_0: { noul: 0.1 } } },
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "0.80 is the inclusive verified edge (>= cut)." },
  },
  {
    id: "verify-ambiguous-01",
    kind: "ambiguous",
    input: { claims: ["the release passed most tests"], evidence: EV },
    oracle: "partial match (all 120 vs most); backend plausibly returns mid-band support.",
    stub: { answers: { claim_0: { noul: 0.6 }, refute_0: { noul: 0.1 } } },
    gold: { verdict: "INSUFFICIENT_EVIDENCE", decision: "REVIEW", abstained: false, why: "mid-band support without firm refutation REVIEWs; absence is never refutation." },
  },
  {
    id: "verify-adversarial-01",
    kind: "adversarial",
    input: { claims: ["the price is $29", "the price is $99"], evidence: EV },
    oracle: "mutually exclusive claims each scored alone against the evidence; both clear the cut.",
    stub: { answers: { claim_0: { noul: 0.95 }, claim_1: { noul: 0.92 }, refute_0: { noul: 0.1 }, refute_1: { noul: 0.1 } } },
    gold: { verdicts: ["SUPPORTED", "SUPPORTED"], decision: "ALLOW", abstained: false, why: "no cross-claim contradiction check and no firm denial per claim; both stay supported." },
  },
  {
    id: "verify-negative-01",
    kind: "negative",
    input: { claims: ["the release ships on Windows"], evidence: EV },
    oracle: "claim unaddressed by the evidence; backend plausibly returns low support.",
    stub: { answers: { claim_0: { noul: 0.2 }, refute_0: { noul: 0.1 } } },
    gold: { verdict: "INSUFFICIENT_EVIDENCE", decision: "REVIEW", abstained: false, why: "low support with weak refutation is insufficient evidence (silence is not denial), never a contradiction label." },
  },
  {
    id: "verify-abstention-01",
    kind: "abstention",
    input: { claims: ["the price is $29"], evidence: EV },
    oracle: "backend silence on the only claim; null coerces to the low-signal band.",
    stub: { answers: {} },
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "missing signal abstains; the null verdict never becomes a label." },
  },
  {
    id: "verify-abstention-02",
    kind: "abstention",
    input: { claims: [], evidence: EV },
    oracle: "nothing to verify; handler returns the structural abstain shape.",
    stub: { answers: {} },
    gold: { verdicts: [], decision: "ESCALATE", why: "empty claims yield no summary, only an abstained escalation." },
  },
  {
    id: "verify-negative-limit-01",
    kind: "negative",
    input: { claims: ["the price is $29"], evidence: "e".repeat(20001) },
    oracle: "evidence over the 20,000-char state cap; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "oversized evidence fails fast instead of truncating silently." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleVerify(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  if (gold.verdict !== undefined) {
    assert.equal(body.verdicts[0].verdict, gold.verdict, "verdict");
  }
  if (gold.verdicts !== undefined) {
    assert.deepEqual(body.verdicts.map((v) => v.verdict), gold.verdicts, "verdicts");
  }
  return { decision: body.decision.decision, verdicts: body.verdicts.map((v) => v.verdict) };
}
