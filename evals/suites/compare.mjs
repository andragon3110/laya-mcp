/**
 * Fase-7 T3 eval suite: compare (laya_compare).
 *
 * STUB MODEL: each stub choice dict emulates the relation judgment a real
 * backend would plausibly return for the passage pair: a firm same_fact for
 * a restatement, a near-boundary contradicts split for a numeric edge, a
 * firm different_facts for non-comparable assertions, an overall-vs-aspect
 * split for changelog-vs-doc drift, a rogue token for a misbehaving judge,
 * `{}` (missing) for backend silence. No top_k concept exists in compare;
 * the judge always sees both passages.
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Relation plausibility
 * and share magnitudes are oracle-assigned: no reconciliation-quality claim
 * transfers. v1 pins: the relation VALUE never gates (same_fact,
 * contradicts, and different_facts are all reportable, so every firm
 * judgment set -> ALLOW); any missing overall/aspect answer abstains to
 * ESCALATE; unknown relation tokens echo verbatim.
 */
import assert from "node:assert";
import { handleCompare } from "../../dist/tools/compare.js";

export const name = "compare";
export const primitive = "laya_compare";
export const stubModel =
  "Overall choice dict (firm, near-boundary, rogue, or {} silence) plus one " +
  "choice dict per aspect; the judge always sees both passages.";
export const stubLimits =
  "Relation plausibility and share magnitudes are oracle-assigned: no " +
  "reconciliation-quality claim transfers to the real backend.";

const PA = "The release passed all 120 tests on Linux and the price is $29.";

export const cases = [
  {
    id: "compare-normal-01",
    kind: "normal",
    input: { passage_a: PA, passage_b: "All 120 tests passed on Linux; the price is $29." },
    oracle: "passage B restates passage A; backend plausibly judges same_fact firmly.",
    stub: { answers: { overall: { choice: "same_fact", probabilities: { same_fact: 0.85, contradicts: 0.1, different_facts: 0.05 } } } },
    gold: { relation: "same_fact", winner_probability: 0.85, decision: "ALLOW", abstained: false, why: "firm same_fact allows: the relation VALUE never gates." },
  },
  {
    id: "compare-difficult-01",
    kind: "difficult",
    input: { passage_a: PA, passage_b: "The release passed all 120 tests on Linux and the price is $29 per month." },
    oracle: "one-word price-scope edge ($29 vs $29 per month); backend plausibly splits near-boundary toward contradicts.",
    stub: { answers: { overall: { choice: "contradicts", probabilities: { contradicts: 0.55, same_fact: 0.3, different_facts: 0.15 } } } },
    gold: { relation: "contradicts", decision: "ALLOW", abstained: false, why: "near-boundary still allows: v1 has no cut point on the distribution." },
  },
  {
    id: "compare-ambiguous-01",
    kind: "ambiguous",
    input: { passage_a: PA, passage_b: "SQLite is a single local file with no server process." },
    oracle: "passages make non-comparable assertions; backend plausibly judges different_facts firmly.",
    stub: { answers: { overall: { choice: "different_facts", probabilities: { different_facts: 0.7, same_fact: 0.2, contradicts: 0.1 } } } },
    gold: { relation: "different_facts", decision: "ALLOW", abstained: false, why: "different_facts is reportable, not an abstention: incomparability still allows." },
  },
  {
    id: "compare-adversarial-01",
    kind: "adversarial",
    input: { passage_a: PA, passage_b: "The release passed all 120 tests on Linux and the price is $99.", aspects: ["price"] },
    oracle: "passages agree overall except the price (changelog-vs-doc drift); backend plausibly splits overall vs aspect.",
    stub: {
      answers: {
        overall: { choice: "same_fact", probabilities: { same_fact: 0.7, contradicts: 0.2, different_facts: 0.1 } },
        aspect_0_price: { choice: "contradicts", probabilities: { contradicts: 0.8, same_fact: 0.2 } },
      },
    },
    gold: { relation: "same_fact", aspects: { price: "contradicts" }, decision: "ALLOW", abstained: false, why: "per-aspect judgments stay independent: overall agreement coexists with an aspect contradiction; both report." },
  },
  {
    id: "compare-negative-01",
    kind: "negative",
    input: { passage_a: PA, passage_b: "All 120 tests passed on Linux; the price is $29." },
    oracle: "rogue backend token outside the relation enum; handler echoes without validation.",
    stub: { answers: { overall: { choice: "unrelated", probabilities: { unrelated: 0.8, same_fact: 0.2 } } } },
    gold: { relation: "unrelated", decision: "ALLOW", abstained: false, why: "no relation allow-list: the judge token is echoed verbatim." },
  },
  {
    id: "compare-abstention-01",
    kind: "abstention",
    input: { passage_a: PA, passage_b: "All 120 tests passed on Linux; the price is $29." },
    oracle: "backend silence on the overall judgment; there is no relation to report.",
    stub: { answers: {} },
    gold: { decision: "ESCALATE", abstained: true, why: "missing overall answer abstains; the null judgment never becomes a relation." },
  },
  {
    id: "compare-abstention-02",
    kind: "abstention",
    input: { passage_a: PA, passage_b: "The release passed all 120 tests in June and the price is $29.", aspects: ["date"] },
    oracle: "firm overall answer but backend silence on the aspect; one missing judgment escalates the call.",
    stub: {
      answers: {
        overall: { choice: "same_fact", probabilities: { same_fact: 0.8, contradicts: 0.1, different_facts: 0.1 } },
      },
    },
    gold: { relation: "same_fact", decision: "ESCALATE", abstained: true, why: "one missing aspect escalates the whole call; the firm overall stays reported but unusable." },
  },
  {
    id: "compare-negative-limit-01",
    kind: "negative",
    input: { passage_a: "e".repeat(20001), passage_b: "All 120 tests passed on Linux." },
    oracle: "passage_a over the 20,000-char state cap; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "oversized passages fail fast instead of truncating silently." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleCompare(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  if (gold.relation !== undefined) {
    assert.equal(body.overall.relation, gold.relation, "relation");
  }
  if (gold.winner_probability !== undefined) {
    assert.equal(body.overall.winner_probability, gold.winner_probability, "winner share");
  }
  if (gold.aspects !== undefined) {
    for (const [label, relation] of Object.entries(gold.aspects)) {
      assert.equal(body[label]?.relation, relation, `aspect ${label}`);
    }
  }
  return { decision: body.decision.decision, relation: body.overall.relation };
}
