/**
 * Fase-7 T3 eval suite: extract (laya_extract, regex path).
 *
 * STUB MODEL: each stub choice emulates which regex candidate a real backend
 * would plausibly pick for the field: the single match for a unique value,
 * the third offset for repeated text (judge sees m0/m1/m2 distinctly), the
 * stated key on an exact tie, a hallucinated m99 for a misbehaving judge, a
 * firm "none" only where authored, `{}` (missing) for backend silence. All
 * cases use source "regex" so no sidecar is involved.
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Pick plausibility is
 * oracle-assigned: nothing here measures real span-selection quality. v1
 * pins: returned values are always grounded verbatim substrings (hallucinated
 * keys resolve to null/not_found, never synthesized); ties do NOT abstain; a
 * firm "none" with candidates still ALLOWs; missing answers, zero-candidate
 * fields, and invalid patterns ESCALATE.
 */
import assert from "node:assert";
import { handleExtract } from "../../dist/tools/extract.js";

export const name = "extract";
export const primitive = "laya_extract";
export const stubModel =
  "Regex-path choice per field: unique match, distinct offset among repeats, " +
  "stated key on ties, hallucinated key for rogue judges, {} for silence.";
export const stubLimits =
  "Pick plausibility is oracle-assigned: no span-selection quality claim " +
  "transfers; grounding guarantees come from the handler, not the stub.";

const FIELD = [{ id: "f", description: "Code", pattern: "[A-Z]{2}\\d{2}" }];

export const cases = [
  {
    id: "extract-normal-01",
    kind: "normal",
    input: { document: "only AB12 here", fields: FIELD, source: "regex" },
    oracle: "single regex match; backend plausibly picks the only candidate firmly.",
    stub: { answers: { extract_0_f: { choice: "m0", probabilities: { m0: 0.9, none: 0.1 } } } },
    gold: { value: "AB12", span: [5, 9], decision: "ALLOW", abstained: false, why: "unique grounded match extracts with verbatim offsets." },
  },
  {
    id: "extract-difficult-01",
    kind: "difficult",
    input: { document: "AB12 AB12 AB12", fields: FIELD, source: "regex" },
    oracle: "three identical surfaces at distinct offsets; backend plausibly picks the third.",
    stub: { answers: { extract_0_f: { choice: "m2", probabilities: { m2: 0.8, none: 0.2 } } } },
    gold: { value: "AB12", span: [10, 14], decision: "ALLOW", abstained: false, why: "identical text resolves by offset, not by surface." },
  },
  {
    id: "extract-ambiguous-01",
    kind: "ambiguous",
    input: { document: "AB12 CD34", fields: FIELD, source: "regex" },
    oracle: "exact 0.5/0.5 tie between two matches; the judge still states one key.",
    stub: { answers: { extract_0_f: { choice: "m0", probabilities: { m0: 0.5, m1: 0.5 } } } },
    gold: { value: "AB12", decision: "ALLOW", abstained: false, why: "extract has no tie detection: the stated choice is authoritative." },
  },
  {
    id: "extract-adversarial-01",
    kind: "adversarial",
    input: { document: "AB12 CD34", fields: FIELD, source: "regex" },
    oracle: "rogue judge returns a key outside the shown set; grounding must refuse it.",
    stub: { answers: { extract_0_f: { choice: "m99", probabilities: { m99: 0.9, none: 0.1 } } } },
    gold: { value: null, status: "not_found", decision: "ALLOW", abstained: false, why: "unmapped keys resolve to null, never a synthesized string." },
  },
  {
    id: "extract-negative-01",
    kind: "negative",
    input: { document: "AB12 here", fields: [{ id: "f", description: "Code", pattern: "[" }], source: "regex" },
    oracle: "unparseable regex proposes zero candidates; the field is invalid by construction.",
    stub: { answers: { extract_0_f: { choice: "none", probabilities: { none: 1.0 } } } },
    gold: { value: null, decision: "ESCALATE", abstained: true, why: "invalid patterns escalate instead of guessing." },
  },
  {
    id: "extract-abstention-01",
    kind: "abstention",
    input: { document: "AB12 here", fields: FIELD, source: "regex" },
    oracle: "backend silence despite an existing candidate; no choice means no value.",
    stub: { answers: {} },
    gold: { value: null, decision: "ESCALATE", why: "missing judge answer escalates via the missing-signal path." },
  },
  {
    id: "extract-negative-02",
    kind: "negative",
    input: { document: "", fields: FIELD, source: "regex" },
    oracle: "empty document proposes zero candidates; the judge sees only none.",
    stub: { answers: { extract_0_f: { choice: "none", probabilities: { none: 1.0 } } } },
    gold: { value: null, decision: "ESCALATE", abstained: true, why: "zero-candidate fields abstain; nothing to pick from." },
  },
  {
    id: "extract-negative-limit-01",
    kind: "negative",
    input: {
      document: "x",
      fields: Array.from({ length: 65 }, (_, i) => ({ id: `f${i}`, description: "F", pattern: "x+" })),
      source: "regex",
    },
    oracle: "65 fields exceed the 64-question budget; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "over-budget field lists fail fast, never silently dropped." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleExtract(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  if (gold.value !== undefined) {
    assert.equal(body.results[0].value, gold.value, "value");
  }
  if (gold.status !== undefined) {
    assert.equal(body.results[0].status, gold.status, "status");
  }
  if (gold.span !== undefined) {
    assert.deepEqual([body.results[0].start, body.results[0].end], gold.span, "offsets");
  }
  return { decision: body.decision.decision, value: body.results[0]?.value ?? null };
}
