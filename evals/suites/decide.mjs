/**
 * Fase-7 T3 eval suite: decide (laya_decide, two-stage).
 *
 * STUB MODEL: stage-1 stub emulates the selection distribution a real backend
 * would plausibly return (firm pick for a clearly better option, near split
 * for close options, exact 1/N tie for indistinguishable options, rogue id
 * for a misbehaving judge, `{}` for silence). Stage-2 stubs emulate per-
 * requirement support signals against the RESOLVED winner (high when the
 * winner text satisfies the requirement, low when it does not). One dict
 * serves both stages because the harness fakeClient answers every /predict
 * call with the full oracle dict (same pattern as the T7 batteries).
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Stage-2 signals are
 * oracle-assigned, not measured against real requirement understanding; the
 * suite cannot prove the backend scopes requirements to the winner correctly.
 * v1 pins: 1/N flat-band abstention, unknown winner ids echo verbatim,
 * unsupported requirements abstain, null selection skips stage 2.
 */
import assert from "node:assert";
import { handleDecide } from "../../dist/tools/decide.js";

export const name = "decide";
export const primitive = "laya_decide";
export const stubModel =
  "Stage-1 choice dict (firm/close/tied/rogue/silent) + stage-2 noul per " +
  "requirement scoped to the resolved winner; one oracle dict serves both calls.";
export const stubLimits =
  "Requirement signals are oracle-assigned: no proof the backend really scopes " +
  "each requirement to the winner option.";

const AB = [
  { id: "a", description: "Postgres with daily backups" },
  { id: "b", description: "SQLite file on disk" },
];

export const cases = [
  {
    id: "decide-normal-01",
    kind: "normal",
    input: { decision: "pick a database", candidates: AB },
    oracle: "option a is clearly safer; backend plausibly picks it firmly.",
    stub: { answers: { selected: { choice: "a", probabilities: { a: 0.8, b: 0.2 } } } },
    gold: { selected: "a", winner_probability: 0.8, decision: "ALLOW", abstained: false, why: "firm unique pick clears the 1/2 baseline." },
  },
  {
    id: "decide-difficult-01",
    kind: "difficult",
    input: { decision: "pick a database", candidates: AB },
    oracle: "close trade-off; backend plausibly splits just above the uniform baseline.",
    stub: { answers: { selected: { choice: "a", probabilities: { a: 0.55, b: 0.45 } } } },
    gold: { selected: "a", decision: "ALLOW", abstained: false, why: "0.55 clears 1/2, so near-boundary still allows." },
  },
  {
    id: "decide-ambiguous-01",
    kind: "ambiguous",
    input: { decision: "pick a database", candidates: AB },
    oracle: "indistinguishable options; backend plausibly returns the exact uniform split.",
    stub: { answers: { selected: { choice: "a", probabilities: { a: 0.5, b: 0.5 } } } },
    gold: { selected: "a", decision: "ESCALATE", abstained: true, why: "flat 1/N distribution abstains; the kept pick is unusable." },
  },
  {
    id: "decide-adversarial-01",
    kind: "adversarial",
    input: {
      decision: "pick a vendor",
      candidates: [{ id: "a", description: "same" }, { id: "b", description: "same" }],
      requirements: ["must hold"],
    },
    oracle: "identical descriptions cannot disambiguate; a coherent backend resolves by id and judges the requirement on the picked id.",
    stub: {
      answers: {
        selected: { choice: "b", probabilities: { a: 0.3, b: 0.7 } },
        requirement_0: { noul: 0.9 },
      },
    },
    gold: { selected: "b", decision: "ALLOW", abstained: false, why: "identical text cannot disambiguate: the id does, stage 2 scopes to it." },
  },
  {
    id: "decide-negative-01",
    kind: "negative",
    input: { decision: "pick a database", candidates: AB },
    oracle: "rogue backend token outside the option set; handler echoes without validation.",
    stub: { answers: { selected: { choice: "zzz", probabilities: { zzz: 0.7, a: 0.2, b: 0.1 } } } },
    gold: { selected: "zzz", decision: "ALLOW", abstained: false, why: "no winner allow-list: the judge token reaches stage output verbatim." },
  },
  {
    id: "decide-abstention-01",
    kind: "abstention",
    input: { decision: "pick a database", candidates: AB },
    oracle: "backend silence on stage 1; there is no winner to evaluate requirements against.",
    stub: { answers: {} },
    gold: { selected: null, decision: "ESCALATE", abstained: true, why: "no selection means no stage 2; requirements stay missing." },
  },
  {
    id: "decide-abstention-02",
    kind: "abstention",
    input: { decision: "pick a database", candidates: AB, requirements: ["must back up daily"] },
    oracle: "firm pick whose description does not satisfy the requirement; backend plausibly returns low support.",
    stub: {
      answers: {
        selected: { choice: "a", probabilities: { a: 0.8, b: 0.2 } },
        requirement_0: { noul: 0.5 },
      },
    },
    gold: { selected: "a", decision: "ESCALATE", abstained: true, why: "requirement support below 0.80 abstains despite the firm pick." },
  },
  {
    id: "decide-negative-limit-01",
    kind: "negative",
    input: {
      decision: "pick one",
      candidates: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, description: `Option ${i}` })),
    },
    oracle: "7 options exceed the 2-6 bound; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "over-ceiling option lists fail fast, never silently cut." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleDecide(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  if (gold.selected !== undefined) {
    assert.equal(body.selected, gold.selected, "selected");
  }
  if (gold.winner_probability !== undefined) {
    assert.equal(body.winner_probability, gold.winner_probability, "winner share");
  }
  return { decision: body.decision.decision, selected: body.selected };
}
