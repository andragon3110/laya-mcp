/**
 * P1-T5 reshape tests: laya_review / laya_gate / laya_verify produce
 * evidence-only outputs plus the engine decision (breaking vs the legacy
 * action/probability/verified-contradicted shapes).
 *
 * No server, no LLM: handlers run against a stub LayaClient whose predict()
 * returns canned answers. Every assertion runs the real handler + the real
 * engine.evaluate underneath it.
 *
 * Covered: supported / insufficient / positive-refutation CONTRADICTED /
 * abstention / band reachability (T3: REVIEW/DENY via handlers) /
 * structured ABSTAIN on empty claims (no zero summary), context+risk
 * wiring on gate, invalid-risk rejection, legacy-vocabulary absence,
 * and double-call determinism.
 *
 * Run after build from the repo root:  node tests/t5_review_gate_verify.mjs
 */
import assert from "node:assert";
import { handleReview } from "../dist/tools/review.js";
import { handleGate } from "../dist/tools/gate.js";
import { handleVerify } from "../dist/tools/verify.js";

const fakeClient = (answers, latencyMs = 7) => ({
  predict: async () => ({ answers, confidence: {}, routing: {}, model: "t5-test", latencyMs, usage: {} }),
});

const reviewAnswers = ({ correctness = 2, spec_match = 2, test_gap = 0, blast_radius = 0, safe = 0.9 } = {}) => ({
  correctness: { score: correctness },
  spec_match: { score: spec_match },
  test_gap: { score: test_gap },
  blast_radius: { score: blast_radius },
  ...(safe === null ? {} : { safe_to_apply: { noul: safe } }),
});

const gateAnswers = ({ correctness = 2, spec_match = 2, safe = 0.9, claims = [], refutes = [] } = {}) => ({
  correctness: { score: correctness },
  spec_match: { score: spec_match },
  ...(safe === null ? {} : { safe_to_apply: { noul: safe } }),
  ...Object.fromEntries(claims.map((v, i) => [`claim_${i}`, v === null ? {} : { noul: v }])),
  // fut-b-semantica T3: every claim also gets a refutation answer. Default
  // is weak (no denial); cases about refutation pin explicit firm values.
  ...Object.fromEntries(
    claims.map((_, i) => {
      const r = i < refutes.length ? refutes[i] : 0.1;
      return [`refute_${i}`, r === null ? {} : { noul: r }];
    }),
  ),
});

const verifyAnswers = (signals, refutes = []) =>
  Object.fromEntries(
    signals.flatMap((v, i) => {
      const r = i < refutes.length ? refutes[i] : 0.1;
      return [
        [`claim_${i}`, v === null ? {} : { noul: v }],
        [`refute_${i}`, r === null ? {} : { noul: r }],
      ];
    }),
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
const noLegacyKeys = (body, tool) => {
  assert.ok(!("action" in body), `${tool}: legacy action must be gone`);
  assert.ok(!("probability" in body), `${tool}: legacy probability must be gone`);
  assert.ok(!("safe_to_apply" in body), `${tool}: top-level safe_to_apply number must be gone`);
  assert.ok(!("scores" in body), `${tool}: legacy scores must be gone`);
  assert.ok(!JSON.stringify(body).includes('"confidence"'), `${tool}: confidence vocabulary must be gone`);
};

// ------------------------------------------------------------------ review ---
await check("review high safe -> ALLOW + rubric objects, no legacy shape", async () => {
  const body = JSON.parse(await handleReview(fakeClient(reviewAnswers({ safe: 0.9 })), { request: "r", diff: "d" }));
  assert.deepEqual(body.rubric.correctness, { score: 2 });
  assert.deepEqual(body.rubric.test_gap, { score: 0 });
  assert.deepEqual(body.rubric.safe_to_apply, { signal: 0.9 });
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["review_auto_allow"]);
  assert.deepEqual(body.decision.policy, { name: "review", version: "1.0.0" });
  assert.equal(body.abstention.abstained, false);
  noLegacyKeys(body, "review");
});

await check("review low safe 0.2 -> ESCALATE review_escalate (no abstention)", async () => {
  const body = JSON.parse(await handleReview(fakeClient(reviewAnswers({ safe: 0.2 })), { request: "r", diff: "d" }));
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["review_escalate"]);
});

await check("review mid-band safe 0.7 -> REVIEW needs_review, no abstention (T3 band reachable)", async () => {
  const body = JSON.parse(await handleReview(fakeClient(reviewAnswers({ safe: 0.7 })), { request: "r", diff: "d" }));
  // T3 breaking: mid-band safety is firm REVIEW evidence, not ambiguity --
  // the policy REVIEW band is reachable via the handler (was ESCALATE via
  // abstained_evidence before T3 removed band abstention).
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["review_needs_review"]);
});

await check("review missing safe signal -> null signal + ESCALATE", async () => {
  const body = JSON.parse(await handleReview(fakeClient(reviewAnswers({ safe: null })), { request: "r", diff: "d" }));
  assert.deepEqual(body.rubric.safe_to_apply, { signal: null });
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
});

await check("review double call is byte-identical (determinism)", async () => {
  const args = { request: "r", diff: "d" };
  const a = await handleReview(fakeClient(reviewAnswers({ safe: 0.9 })), args);
  const b = await handleReview(fakeClient(reviewAnswers({ safe: 0.9 })), args);
  assert.equal(a, b);
});

// -------------------------------------------------------------------- gate ---
const gateArgs = (claims, extra = {}) => ({ request: "r", diff: "d", claims, evidence: "log", ...extra });

await check("gate clean high -> ALLOW + SUPPORTED claim, context+risk echoed", async () => {
  const body = JSON.parse(
    await handleGate(fakeClient(gateAnswers({ safe: 0.9, claims: [0.9] })), gateArgs(["tests pass"])),
  );
  assert.deepEqual(body.review.safe_to_apply, { signal: 0.9 });
  assert.deepEqual(body.review.correctness, { score: 2 });
  assert.deepEqual(body.claims, [{ claim: "tests pass", signal: 0.9, verdict: "SUPPORTED" }]);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["gate_auto_allow"]);
  assert.deepEqual(body.decision.policy, { name: "gate", version: "1.0.0" });
  assert.equal(body.risk, "normal");
  assert.equal(body.context.claim_count, 1);
  noLegacyKeys(body, "gate");
});

await check("gate positively-refuted claim dominates: ESCALATE engine-side, CONTRADICTED display-side", async () => {
  const body = JSON.parse(
    await handleGate(
      fakeClient(gateAnswers({ safe: 0.95, claims: [0.9, 0.2], refutes: [0.1, 0.9] })),
      gateArgs(["a", "b"]),
    ),
  );
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["gate_contradicted_escalate"]);
  // T3 honesty: CONTRADICTED comes from the firm refutation probe (0.9)
  // paired with weak support (0.2) -- never from the low support alone
  // (claim "a": firm support + weak refutation stays SUPPORTED).
  assert.deepEqual(body.claims.map((c) => c.verdict), ["SUPPORTED", "CONTRADICTED"]);
});

await check("gate low safety alone REVIEWs; unsupported-only allows with high safe", async () => {
  const low = JSON.parse(
    await handleGate(fakeClient(gateAnswers({ safe: 0.2, claims: [0.9] })), gateArgs(["a"])),
  );
  assert.deepEqual(low.decision.reason_codes, ["gate_review"]);
  const unsup = JSON.parse(
    await handleGate(fakeClient(gateAnswers({ safe: 0.9, claims: [0.5] })), gateArgs(["a"])),
  );
  assert.deepEqual(unsup.decision.reason_codes, ["gate_auto_allow"]);
  assert.equal(unsup.claims[0].verdict, "INSUFFICIENT_EVIDENCE");
});

await check("gate missing claim signal -> ABSTAIN claim + ESCALATE missing", async () => {
  const body = JSON.parse(
    await handleGate(fakeClient(gateAnswers({ safe: 0.9, claims: [null] })), gateArgs(["a"])),
  );
  assert.deepEqual(body.claims, [{ claim: "a", signal: null, verdict: "ABSTAIN" }]);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["gate_missing_signal"]);
});

await check("gate caller context+risk forwarded; risk high tightens the auto band (T2)", async () => {
  const hi = JSON.parse(
    await handleGate(
      fakeClient(gateAnswers({ safe: 0.9, claims: [0.9] })),
      gateArgs(["a"], { context: { ci: true }, risk: "high" }),
    ),
  );
  assert.equal(hi.risk, "high");
  assert.equal(hi.context.ci, true);
  // safe 0.9 clears normal (0.85) but not high (0.90): the band moved.
  assert.equal(hi.decision.decision, "REVIEW");
  assert.deepEqual(hi.decision.reason_codes, ["gate_review"]);
  const normal = JSON.parse(
    await handleGate(fakeClient(gateAnswers({ safe: 0.9, claims: [0.9] })), gateArgs(["a"])),
  );
  assert.equal(normal.decision.decision, "ALLOW");
});

await check("gate invalid risk rejected", async () => {
  await assert.rejects(
    handleGate(fakeClient(gateAnswers({ safe: 0.9, claims: [0.9] })), gateArgs(["a"], { risk: "extreme" })),
    /risk must be one of/,
  );
});

await check("gate double call is byte-identical (determinism)", async () => {
  const mk = () => handleGate(fakeClient(gateAnswers({ safe: 0.9, claims: [0.9] })), gateArgs(["a"]));
  assert.equal(await mk(), await mk());
});

// ------------------------------------------------------------------ verify ---
const verifyArgs = (claims) => ({ claims, evidence: "log" });

await check("verify supported -> SUPPORTED + ALLOW", async () => {
  const body = JSON.parse(await handleVerify(fakeClient(verifyAnswers([0.95])), verifyArgs(["sky is blue"])));
  assert.deepEqual(body.verdicts, [{ claim: "sky is blue", signal: 0.95, verdict: "SUPPORTED" }]);
  assert.deepEqual(body.summary, { supported: 1, insufficient_evidence: 0, contradicted: 0, abstain: 0 });
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["verify_all_verified"]);
  assert.deepEqual(body.decision.policy, { name: "verify", version: "1.0.0" });
  assert.ok(!("probability" in body.verdicts[0]), "per-claim probability must be gone");
});

await check("verify mid signal -> INSUFFICIENT_EVIDENCE + REVIEW (T3 band reachable, no abstention)", async () => {
  const body = JSON.parse(await handleVerify(fakeClient(verifyAnswers([0.6])), verifyArgs(["a"])));
  assert.equal(body.verdicts[0].verdict, "INSUFFICIENT_EVIDENCE");
  // T3 breaking: mid-band support flows to the policy REVIEW band (was
  // ESCALATE via abstained_evidence before T3 removed band abstention).
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["verify_unsupported_review"]);
});

await check("verify low signal is absence, not refutation (INSUFFICIENT + REVIEW; DENY needs a probe)", async () => {
  const body = JSON.parse(await handleVerify(fakeClient(verifyAnswers([0.1])), verifyArgs(["a"])));
  assert.equal(body.verdicts[0].verdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(!body.verdicts.some((v) => v.verdict === "CONTRADICTED"), "weak support never labels a contradiction");
  // T3 breaking: low support without firm refutation REVIEWs as
  // unsupported (was ESCALATE via abstained_evidence; the engine DENY band
  // now needs the refute probe -- covered in t3_refute_bands.mjs).
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["verify_unsupported_review"]);
});

await check("verify null signal -> ABSTAIN claim + ESCALATE", async () => {
  const body = JSON.parse(await handleVerify(fakeClient(verifyAnswers([null])), verifyArgs(["a"])));
  assert.deepEqual(body.verdicts, [{ claim: "a", signal: null, verdict: "ABSTAIN" }]);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.summary.abstain, 1);
});

await check("verify empty claims -> structured ABSTAIN, no zero summary", async () => {
  const body = JSON.parse(await handleVerify(fakeClient({}), verifyArgs([])));
  assert.deepEqual(body.verdicts, []);
  assert.ok(!("summary" in body), "empty claims must not return a zero summary");
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
});

await check("verify mixed summary uses honest keys; legacy verdict strings absent", async () => {
  const body = JSON.parse(await handleVerify(fakeClient(verifyAnswers([0.95, 0.6])), verifyArgs(["a", "b"])));
  assert.deepEqual(body.summary, { supported: 1, insufficient_evidence: 1, contradicted: 0, abstain: 0 });
  // T3: the weak claim reaches REVIEW (no band abstention).
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["verify_unsupported_review"]);
  const words = body.verdicts.map((v) => v.verdict);
  for (const legacy of ["verified", "unsupported", "contradicted"]) {
    assert.ok(!words.includes(legacy), `legacy verdict ${legacy} must be gone`);
  }
});

await check("verify double call is byte-identical (determinism)", async () => {
  const mk = () => handleVerify(fakeClient(verifyAnswers([0.95, 0.6])), verifyArgs(["a", "b"]));
  assert.equal(await mk(), await mk());
});

await check("verify T3-regression: firm denial plus weak support contradicts (positive refutation only)", async () => {
  const body = JSON.parse(await handleVerify(fakeClient(verifyAnswers([0.18], [0.93])), verifyArgs(["a"])));
  assert.equal(body.verdicts[0].verdict, "CONTRADICTED");
  assert.deepEqual(body.summary, { supported: 0, insufficient_evidence: 0, contradicted: 1, abstain: 0 });
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "DENY");
  assert.deepEqual(body.decision.reason_codes, ["verify_contradicted_deny"]);
});

await check("verify T3-regression: weak support alone stays INSUFFICIENT, never CONTRADICTED", async () => {
  const body = JSON.parse(await handleVerify(fakeClient(verifyAnswers([0.12])), verifyArgs(["a"])));
  assert.equal(body.verdicts[0].verdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(!body.verdicts.some((v) => v.verdict === "CONTRADICTED"), "absence must never label a contradiction");
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["verify_unsupported_review"]);
});

await check("gate T3-regression: both-firm conflicting probes stay INSUFFICIENT (safety band decides)", async () => {
  const body = JSON.parse(
    await handleGate(fakeClient(gateAnswers({ safe: 0.93, claims: [0.95], refutes: [0.92] })), gateArgs(["a"])),
  );
  assert.deepEqual(body.claims, [{ claim: "a", signal: 0.95, verdict: "INSUFFICIENT_EVIDENCE" }]);
  assert.equal(body.abstention.abstained, false);
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["gate_auto_allow"]);
});

await check("verify T3-regression: empty claims abstain structurally regardless of evidence text", async () => {
  const body = JSON.parse(await handleVerify(fakeClient({}), { claims: [], evidence: "unrelated text" }));
  assert.deepEqual(body.verdicts, []);
  assert.ok(!("summary" in body), "empty claims must not return a zero summary");
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

await check("gate/verify T3-regression: evidence-missing claims escalate via policy, never SUPPORTED", async () => {
  const missingSupport = JSON.parse(await handleVerify(fakeClient(verifyAnswers([null])), verifyArgs(["a"])));
  assert.equal(missingSupport.verdicts[0].verdict, "ABSTAIN");
  assert.equal(missingSupport.decision.decision, "ESCALATE");
  const missingRefute = JSON.parse(
    await handleGate(fakeClient(gateAnswers({ safe: 0.93, claims: [0.95], refutes: [null] })), gateArgs(["a"])),
  );
  assert.equal(missingRefute.claims[0].verdict, "ABSTAIN");
  assert.equal(missingRefute.decision.decision, "ESCALATE");
  assert.deepEqual(missingRefute.decision.reason_codes, ["gate_missing_signal"]);
  for (const body of [missingSupport, missingRefute]) {
    const verdicts = body.verdicts ?? body.claims;
    assert.ok(!verdicts.some((v) => v.verdict === "SUPPORTED"), "missing evidence must never confirm");
    assert.ok(body.decision.decision === "REVIEW" || body.decision.decision === "ESCALATE", "missing evidence routes to REVIEW or ESCALATE");
  }
});

// ------------------------------------------- T6 review grounding (append-only) ---
// T6 pins review as rubric evidence-only plus the engine decision: the four
// 0-2 scores are advisory ({score} objects), safe_to_apply is a raw signal
// ({signal}, never a probability, never an authorization), and the
// ALLOW/REVIEW/ESCALATE exit is policy-owned. No threshold moved, no schema
// or cap changed, no grounding semantic touched.
await check("T6 review: missing safe_to_apply abstains -> ESCALATE, never ALLOW", async () => {
  const body = JSON.parse(await handleReview(fakeClient(reviewAnswers({ safe: null })), { request: "r", diff: "d" }));
  assert.deepEqual(body.rubric.safe_to_apply, { signal: null });
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /missing safe_to_apply signal/);
  assert.equal(body.decision.decision, "ESCALATE");
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
  assert.deepEqual(body.decision.policy, { name: "review", version: "1.0.0" });
});

await check("T6 review: mid-band safe flows to REVIEW via policy, never forced ESCALATE by evidence", async () => {
  const body = JSON.parse(await handleReview(fakeClient(reviewAnswers({ safe: 0.7 })), { request: "r", diff: "d" }));
  assert.equal(body.abstention.abstained, false, "mid-band safety is firm REVIEW evidence, not ambiguity");
  assert.equal(body.decision.decision, "REVIEW");
  assert.deepEqual(body.decision.reason_codes, ["review_needs_review"]);
  assert.deepEqual(body.decision.policy, { name: "review", version: "1.0.0" });
});

await check("T6 review: rubric scores stay audit-only (same band whatever the scores)", async () => {
  const mk = (correctness) =>
    handleReview(
      fakeClient(reviewAnswers({ correctness, safe: 0.7 })),
      { request: "r", diff: "d" },
    ).then((s) => JSON.parse(s));
  const low = await mk(0);
  const high = await mk(2);
  for (const body of [low, high]) {
    assert.deepEqual(body.rubric.correctness, { score: body.rubric.correctness.score });
    assert.deepEqual(body.rubric.safe_to_apply, { signal: 0.7 }, "safe_to_apply is a {signal} object, never a bare number");
    assert.equal(body.decision.decision, "REVIEW", "scores advise; only the safety signal moves the band");
    assert.deepEqual(body.decision.reason_codes, ["review_needs_review"]);
  }
  const dumped = JSON.stringify(high);
  assert.ok(!("action" in high), "no authorization: legacy action must stay gone");
  assert.ok(!("probability" in high), "signal is never a probability");
  assert.ok(!dumped.includes("authoriz"), "review never authorizes anything by itself");
  noLegacyKeys(high, "review");
});

console.log(`\nT5 review/gate/verify: ${passed} checks passed (no server, no LLM involved).`);
