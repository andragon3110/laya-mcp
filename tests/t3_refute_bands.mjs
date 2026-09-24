/**
 * fut-b-semantica T3: positive-refutation CONTRADICTED + reachable
 * REVIEW/DENY bands (verify / gate-claims / review).
 *
 * No server, no LLM: handlers run against a stub LayaClient whose predict()
 * returns canned support + refutation answers, and the engine checks run
 * against the real evaluate with the real evidence constructors.
 *
 * Design pinned here (see verify@1.0.0 / gate@1.0.0 / evidence.ts):
 *   - CONTRADICTED needs POSITIVE refutation: refute probe firm (>= shared
 *     claimVerified cut) PLUS support weak (< cut). Never by absence.
 *   - Both probes firm = conflicting evidence -> INSUFFICIENT (REVIEW),
 *     never a silent confirm and never a contradiction.
 *   - Band abstention is gone: present mid/low signals reach the policy
 *     REVIEW/DENY bands. Real missing signals (null probe, empty claims,
 *     missing safe_to_apply) still abstain -> ESCALATE.
 *
 * Run after build from the repo root:  node tests/t3_refute_bands.mjs
 */
import assert from "node:assert";
import { handleReview } from "../dist/tools/review.js";
import { handleGate } from "../dist/tools/gate.js";
import { handleVerify } from "../dist/tools/verify.js";
import { verifyTool } from "../dist/tools/verify.js";
import { gateTool } from "../dist/tools/gate.js";
import { evaluate } from "../dist/policy/engine.js";
import { THRESHOLDS_V1 } from "../dist/policy/thresholds.js";
import * as E from "../dist/evidence.js";

const RAW = { model: "t3-test", routing: {} };
const T1 = THRESHOLDS_V1;
const noAbs = () => E.notAbstained();

const fakeClient = (answers, latencyMs = 7) => ({
  predict: async () => ({ answers, confidence: {}, routing: {}, model: "t3-test", latencyMs, usage: {} }),
});

// Claims as [support, refute] pairs; null = dropped answer ({}).
const pairAnswers = (pairs) =>
  Object.fromEntries(
    pairs.flatMap(([s, r], i) => [
      [`claim_${i}`, s === null ? {} : { noul: s }],
      [`refute_${i}`, r === null ? {} : { noul: r }],
    ]),
  );

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}

// ------------------------------------------------------------------ verify ---
await check("verify: firm refutation + weak support -> CONTRADICTED + DENY (positive refutation)", async () => {
  const body = JSON.parse(
    await handleVerify(fakeClient(pairAnswers([[0.2, 0.9]])), { claims: ["price is $99"], evidence: "price is $29" }),
  );
  assert.equal(body.verdicts[0].verdict, "CONTRADICTED");
  assert.deepEqual(body.summary, { supported: 0, insufficient_evidence: 0, contradicted: 1, abstain: 0 });
  assert.equal(body.abstention.abstained, false, "firm refutation is evidence, not ambiguity");
  assert.equal(body.decision.decision, "DENY");
  assert.deepEqual(body.decision.reason_codes, ["verify_contradicted_deny"]);
  assert.deepEqual(body.decision.policy, { name: "verify", version: "1.0.0" });
});

await check("verify: refutation edge 0.80 is firm (inclusive) -> CONTRADICTED", async () => {
  const body = JSON.parse(
    await handleVerify(fakeClient(pairAnswers([[0.79, 0.8]])), { claims: ["a"], evidence: "e" }),
  );
  assert.equal(body.verdicts[0].verdict, "CONTRADICTED");
  assert.equal(body.decision.decision, "DENY");
});

await check("verify: firm support without refutation -> SUPPORTED + ALLOW", async () => {
  const body = JSON.parse(
    await handleVerify(fakeClient(pairAnswers([[0.95, 0.1]])), { claims: ["price is $29"], evidence: "price is $29" }),
  );
  assert.equal(body.verdicts[0].verdict, "SUPPORTED");
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["verify_all_verified"]);
});

await check("verify: weak support + weak refutation -> INSUFFICIENT + REVIEW (band reachable)", async () => {
  const body = JSON.parse(
    await handleVerify(fakeClient(pairAnswers([[0.5, 0.2]])), { claims: ["a"], evidence: "e" }),
  );
  assert.equal(body.verdicts[0].verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(body.abstention.abstained, false, "T3: mid-band no longer abstains");
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["verify_unsupported_review"]);
});

await check("verify: low support without refutation is absence, not DENY -> INSUFFICIENT + REVIEW", async () => {
  const body = JSON.parse(
    await handleVerify(fakeClient(pairAnswers([[0.1, 0.05]])), { claims: ["a"], evidence: "e" }),
  );
  assert.equal(body.verdicts[0].verdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(!body.verdicts.some((v) => v.verdict === "CONTRADICTED"), "absence must never label a contradiction");
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["verify_unsupported_review"]);
});

await check("verify: both probes firm -> INSUFFICIENT + REVIEW (conflict cannot confirm)", async () => {
  const body = JSON.parse(
    await handleVerify(fakeClient(pairAnswers([[0.95, 0.9]])), { claims: ["a"], evidence: "e" }),
  );
  assert.equal(body.verdicts[0].verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(body.decision.decision, "REVIEW");
});

await check("verify: missing refutation probe -> ABSTAIN claim + ESCALATE (missing preserved)", async () => {
  const body = JSON.parse(
    await handleVerify(fakeClient({ claim_0: { noul: 0.9 } }), { claims: ["a"], evidence: "e" }),
  );
  assert.equal(body.verdicts[0].verdict, "ABSTAIN");
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

// -------------------------------------------------------------------- gate ---
const gateArgs = (claims, extra = {}) => ({ request: "r", diff: "d", claims, evidence: "log", ...extra });
const gateStub = ({ correctness = 2, spec_match = 2, safe = 0.9, pairs = [] } = {}) => ({
  correctness: { score: correctness },
  spec_match: { score: spec_match },
  ...(safe === null ? {} : { safe_to_apply: { noul: safe } }),
  ...pairAnswers(pairs),
});

await check("gate: positively-refuted claim -> CONTRADICTED display + ESCALATE contradicted (safety cannot rescue)", async () => {
  const body = JSON.parse(
    await handleGate(fakeClient(gateStub({ safe: 0.95, pairs: [[0.9, 0.1], [0.2, 0.9]] })), gateArgs(["a", "b"])),
  );
  assert.deepEqual(body.claims.map((c) => c.verdict), ["SUPPORTED", "CONTRADICTED"]);
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["gate_contradicted_escalate"]);
});

await check("gate: mid-band safety + supported claim -> REVIEW (band reachable, no abstention)", async () => {
  const body = JSON.parse(
    await handleGate(fakeClient(gateStub({ safe: 0.7, pairs: [[0.9, 0.1]] })), gateArgs(["a"])),
  );
  assert.equal(body.abstention.abstained, false, "T3: mid-band safety no longer abstains");
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["gate_review"]);
});

await check("gate: weak support without refutation follows the safety band (no contradicted inference)", async () => {
  const body = JSON.parse(
    await handleGate(fakeClient(gateStub({ safe: 0.95, pairs: [[0.2, 0.1]] })), gateArgs(["a"])),
  );
  assert.equal(body.claims[0].verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["gate_auto_allow"]);
});

await check("gate: real abstention preserved (missing safe -> ESCALATE; null claim -> missing-signal ESCALATE)", async () => {
  const noSafe = JSON.parse(
    await handleGate(fakeClient(gateStub({ safe: null, pairs: [[0.9, 0.1]] })), gateArgs(["a"])),
  );
  assert.equal(noSafe.abstention.abstained, true);
  assert.equal(noSafe.decision.decision, "ESCALATE");
  const nullClaim = JSON.parse(
    await handleGate(fakeClient(gateStub({ safe: 0.9, pairs: [[null, 0.1]] })), gateArgs(["a"])),
  );
  assert.deepEqual(nullClaim.claims, [{ claim: "a", signal: null, verdict: "ABSTAIN" }]);
  assert.equal(nullClaim.decision.decision, "ESCALATE");
  assert.deepEqual(nullClaim.decision.reason_codes, ["gate_missing_signal"]);
});

// ------------------------------------------------------------------ review ---
await check("review: mid-band safety 0.7 -> REVIEW needs_review (band reachable, no abstention)", async () => {
  const body = JSON.parse(
    await handleReview(
      fakeClient({
        correctness: { score: 1 }, spec_match: { score: 1 }, test_gap: { score: 1 },
        blast_radius: { score: 1 }, safe_to_apply: { noul: 0.7 },
      }),
      { request: "r", diff: "d" },
    ),
  );
  assert.equal(body.abstention.abstained, false, "T3: mid-band safety no longer abstains");
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["review_needs_review"]);
});

await check("review: missing safety still abstains -> ESCALATE", async () => {
  const body = JSON.parse(
    await handleReview(
      fakeClient({ correctness: { score: 2 }, spec_match: { score: 2 }, test_gap: { score: 0 }, blast_radius: { score: 0 } }),
      { request: "r", diff: "d" },
    ),
  );
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

// ------------------------------------------------------------ engine-level ---
function policyEv(name, evidence, abstention) {
  return evaluate({ evidence, abstention, policy: { name, version: "1.0.0" } }, { thresholds: T1 });
}

await check("engine: legacy support-only verify evidence -> REVIEW on low support (DENY unreachable without a probe)", () => {
  const legacy = E.makeEvidence(RAW, [E.noulSignal(RAW, "claim_0", 0.2, { candidate: "c" })], "router");
  const d = policyEv("verify", legacy, noAbs());
  assert.equal(d.decision, "REVIEW");
  assert.deepEqual(d.reason_codes, ["verify_unsupported_review"]);
});

await check("engine: verify refute edge 0.80 firm + support 0.79 weak -> DENY", () => {
  const { evidence } = E.verifyEvidence(RAW, { claims: [{ claim: "c", signal: 0.79, verdict: "x", refute: 0.8 }] });
  const d = policyEv("verify", evidence, noAbs());
  assert.equal(d.decision, "DENY");
  assert.deepEqual(d.reason_codes, ["verify_contradicted_deny"]);
});

await check("engine: verify both-firm conflict -> REVIEW (unsupported), not ALLOW", () => {
  const { evidence } = E.verifyEvidence(RAW, { claims: [{ claim: "c", signal: 0.95, verdict: "x", refute: 0.9 }] });
  const d = policyEv("verify", evidence, noAbs());
  assert.equal(d.decision, "REVIEW");
  assert.deepEqual(d.reason_codes, ["verify_unsupported_review"]);
});

await check("engine: verify explicit-null refute -> ESCALATE missing", () => {
  const { evidence } = E.verifyEvidence(RAW, { claims: [{ claim: "c", signal: 0.9, verdict: "x", refute: null }] });
  const d = policyEv("verify", evidence, noAbs());
  assert.equal(d.decision, "ESCALATE");
  assert.deepEqual(d.reason_codes, ["verify_missing_signal"]);
});

await check("engine: gate legacy support-only evidence follows safety (contradicted unreachable)", () => {
  const { evidence } = E.gateEvidence(RAW, {
    correctness: 2, spec_match: 2, safe_to_apply: 0.95,
    claims: [{ claim: "c", signal: 0.2, verdict: "x" }],
  });
  const d = policyEv("gate", evidence, noAbs());
  assert.equal(d.decision, "ALLOW");
  assert.deepEqual(d.reason_codes, ["gate_auto_allow"]);
});

await check("engine: gate firm refute + weak support -> ESCALATE contradicted", () => {
  const { evidence } = E.gateEvidence(RAW, {
    correctness: 2, spec_match: 2, safe_to_apply: 0.95,
    claims: [{ claim: "c", signal: 0.2, verdict: "x", refute: 0.9 }],
  });
  const d = policyEv("gate", evidence, noAbs());
  assert.equal(d.decision, "ESCALATE");
  assert.deepEqual(d.reason_codes, ["gate_contradicted_escalate"]);
});

// ------------------------------------------------------------------ limits ---
await check("builders: verify 32 claims -> 64 questions ok, 33 throws; gate 30 -> 63 ok, 31 throws", () => {
  const v32 = Array.from({ length: 32 }, (_, i) => `claim ${i}`);
  assert.equal(Object.keys(verifyTool.buildQuestions({ claims: v32, evidence: "e" })).length, 64);
  assert.throws(
    () => verifyTool.buildQuestions({ claims: [...v32, "one more"], evidence: "e" }),
    (err) => {
      assert.match(String(err?.message ?? err), /input_too_large/);
      assert.equal(err?.detail?.limit, 32);
      return true;
    },
  );
  const g30 = Array.from({ length: 30 }, (_, i) => `claim ${i}`);
  assert.equal(Object.keys(gateTool.buildQuestions({ request: "r", diff: "d", claims: g30 })).length, 63);
  assert.throws(
    () => gateTool.buildQuestions({ request: "r", diff: "d", claims: [...g30, "one more"] }),
    (err) => {
      assert.match(String(err?.message ?? err), /input_too_large/);
      assert.equal(err?.detail?.limit, 30);
      return true;
    },
  );
});

console.log(`\nT3 refutation + bands: ${passed} checks passed (no server, no LLM involved).`);
