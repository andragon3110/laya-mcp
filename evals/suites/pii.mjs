/**
 * Fase-7 T3 eval suite: pii (laya_pii, GLiNER sidecar + count policy).
 *
 * STUB MODEL: the sidecar stub reports exactly the oracle spans: nothing for
 * clean text, an api_key span for a leaked key, an email span for a plain or
 * [at]-obfuscated address, an unknown-type span for a novel entity, and
 * NOTHING for a spaced-out secret (detector blind spot: "s k - 1 2 3" carries
 * secret material the detector plausibly misses). v1 applies no Laya risk
 * cut, so the stub needs no judge answers at all.
 *
 * STUB LIMITS (honesty): the stub is NOT the detector. Span recall/precision
 * are oracle-assigned: nothing here measures real GLiNER detection quality.
 * v1 pins: clean -> ALLOW, any secret type -> DENY, weak-only findings ->
 * ESCALATE (ambiguous detector judgment), REVIEW unreachable with the
 * default secret table, every finding stays a "candidate", never confirmed.
 */
import assert from "node:assert";
import { handlePii } from "../../dist/tools/pii.js";

export const name = "pii";
export const primitive = "laya_pii";
export const stubModel =
  "Sidecar reports the oracle spans verbatim (clean none, secret/obfuscated/ " +
  "unknown as listed, spaced secret missed); v1 needs no judge answers.";
export const stubLimits =
  "Span recall/precision are oracle-assigned: no detector-quality claim " +
  "transfers to the real GLiNER sidecar.";

const span = (type, text, confidence = 0.9) => ({ text, start: 0, end: text.length, type, confidence });

export const cases = [
  {
    id: "pii-normal-01",
    kind: "normal",
    input: { text: "hello world, see you at noon" },
    oracle: "no entity material; sidecar plausibly reports zero spans.",
    stub: { spans: [] },
    gold: { secrets_found: 0, decision: "ALLOW", abstained: false, why: "zero spans means a clean allow." },
  },
  {
    id: "pii-normal-02",
    kind: "normal",
    input: { text: "deploy with key sk-live-abc123" },
    oracle: "verbatim API key; sidecar plausibly reports an api_key span.",
    stub: { spans: [span("api_key", "sk-live-abc123")] },
    gold: { secrets_found: 1, decision: "DENY", abstained: false, why: "any secret-type span blocks regardless of the rest." },
  },
  {
    id: "pii-abstention-01",
    kind: "abstention",
    input: { text: "contact ana@example.com for details" },
    oracle: "plain email is a weak (non-secret) type; detector judgment stays ambiguous.",
    stub: { spans: [span("email", "ana@example.com")] },
    gold: { secrets_found: 0, decision: "ESCALATE", abstained: true, why: "weak-only findings abstain; candidates are never confirmed." },
  },
  {
    id: "pii-difficult-01",
    kind: "difficult",
    input: { text: "reach me at a [at] b [dot] c" },
    oracle: "obfuscated email the sidecar plausibly still flags as an email span.",
    stub: { spans: [span("email", "a [at] b [dot] c", 0.6)] },
    gold: { secrets_found: 0, decision: "ESCALATE", abstained: true, why: "obfuscated weak span stays a candidate, never a label." },
  },
  {
    id: "pii-adversarial-01",
    kind: "adversarial",
    input: { text: "my key is s k - 1 2 3, do not share" },
    oracle: "spaced-out secret material the detector plausibly misses entirely.",
    stub: { spans: [] },
    gold: { secrets_found: 0, decision: "ALLOW", abstained: false, why: "a detector miss allows on empty evidence; output never certifies clean." },
  },
  {
    id: "pii-ambiguous-01",
    kind: "ambiguous",
    input: { text: "my hobby is chess" },
    oracle: "novel entity type outside every known list; judgment is ambiguous by construction.",
    stub: { spans: [span("hobby", "chess", 0.7)] },
    gold: { secrets_found: 0, decision: "ESCALATE", abstained: true, why: "unknown types are weak-only; v1 never emits false-positive labels." },
  },
  {
    id: "pii-negative-01",
    kind: "negative",
    input: { text: "key sk-live-abc123, cc ana@example.com" },
    oracle: "secret plus weak spans; secret membership dominates the count policy.",
    stub: { spans: [span("api_key", "sk-live-abc123"), span("email", "ana@example.com")] },
    gold: { secrets_found: 1, decision: "DENY", abstained: false, why: "one secret span blocks even beside weak spans." },
  },
  {
    id: "pii-negative-limit-01",
    kind: "negative",
    input: { text: "hello", extra_types: Array.from({ length: 33 }, (_, i) => `type${i}`) },
    oracle: "33 extra types exceed the 32-type cap; builder must refuse.",
    stub: { spans: [] },
    expectError: "input_too_large",
    gold: { why: "over-cap zero-shot type lists fail fast, never silently cut." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const ctx = deps.makePiiCtx(stub.spans ?? []);
  if (capture) capture.questions = { glinerSpans: (stub.spans ?? []).length };
  return JSON.parse(await handlePii({}, input, ctx));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.secrets_found !== undefined) {
    assert.equal(body.secrets_found, gold.secrets_found, "secrets_found");
  }
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  for (const f of body.findings ?? []) {
    assert.equal(f.finding_status, "candidate", "candidate-only status");
    assert.equal(f.laya_signal, null, "v1 applies no Laya risk cut");
  }
  return { decision: body.decision.decision, secrets: body.secrets_found };
}
