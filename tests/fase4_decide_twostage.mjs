/**
 * Fase-4 T6 (decide two-stage): selection runs first as a lone `choice`;
 * each requirement is then evaluated AGAINST the resolved winner in a
 * second /predict call, with the selected id (+ description when known)
 * injected into every requirement instruction.
 *
 * No server, no LLM: the real handleDecide + builders run against a
 * scripted LayaClient that records every predict() call (state +
 * questions) and answers per stage. Every assertion runs the real
 * two-stage pipeline + the real decideEvidence + engine.evaluate
 * underneath it.
 *
 * Pinned contracts:
 *   - stage-1 builder asks ONLY `selected` (requirements are validated
 *     for the caps but never sent blind); stage-2 builder emits one
 *     `requirement_{i}` noul per requirement with the winner injected;
 *   - the dependency the simultaneous design could NOT express: a
 *     requirement that holds for option B but not for A MUST come back
 *     supported:false when the winner is A (the stub answers stage 2 by
 *     reading the injected id, so a blind judge could not pass);
 *   - call order is selection-first, requirements-second; zero
 *     requirements -> exactly 1 call (no extra cost);
 *   - null/abstained selection -> NO second stage by design (evaluating
 *     requirements with nothing selected is uninterpretable):
 *     requirements stay missing (signal/supported null), abstention
 *     "no option selected", ESCALATE decide_no_selection;
 *   - stage-2 silence (no noul) -> missing requirement -> ESCALATE
 *     decide_missing_signal;
 *   - flat distribution still runs stage 2 (a selection exists) and then
 *     abstains on the flat band as before;
 *   - post-P1 output shape intact (selected/distribution/
 *     winner_probability/requirements.{signal,supported}/decision/
 *     latency_ms/evidence/abstention); policy stays decide@1.0.0 (only
 *     signal sourcing changed, so no version bump); latency_ms is the
 *     SUM of both stages; evidence model comes from stage 1.
 *
 * Run after build from the repo root:  node tests/fase4_decide_twostage.mjs
 */
import assert from "node:assert";
import {
  decideTool,
  handleDecide,
  buildSelectionQuestions,
  buildRequirementQuestions,
} from "../dist/tools/decide.js";

const calls = [];
const scriptedClient = (stages, latencies = [5, 9]) => ({
  predict: async (state, questions) => {
    const i = calls.length;
    calls.push({ state, questions });
    return {
      answers: stages[i] ?? {},
      confidence: {},
      routing: {},
      model: "fase4-t6-test",
      latencyMs: latencies[i] ?? 7,
      usage: {},
    };
  },
});

let passed = 0;
function check(name, fn) {
  calls.length = 0;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}
function throwsInputTooLarge(fn, field) {
  assert.throws(fn, (err) => {
    assert.match(String(err?.message ?? err), /input_too_large/, "code vocabulary");
    assert.match(String(err?.message ?? err), new RegExp(`field="${field}"`), "field name");
    assert.equal(err?.detail?.code, "input_too_large", "structured detail");
    return true;
  });
}

const ARGS_AB = {
  decision: "pick a fruit",
  candidates: [
    { id: "a", description: "Green apple, sour" },
    { id: "b", description: "Ripe mango, sweet" },
  ],
  requirements: ["must be sweet"],
};

// ------------------------------------------------------- builders (no judge) ---
await check("stage-1 builder asks ONLY selected (caps still enforced, requirements never sent blind)", () => {
  const q = buildSelectionQuestions(ARGS_AB);
  assert.deepEqual(Object.keys(q), ["selected"], "one question: the pick");
  assert.equal(q.selected.type, "choice");
  assert.deepEqual(decideTool.buildQuestions(ARGS_AB), q, "declared builder IS stage 1");
  throwsInputTooLarge(
    () => buildSelectionQuestions({ decision: "d", candidates: [{ id: "a" }], requirements: [] }),
    "candidates",
  );
  throwsInputTooLarge(
    () =>
      buildSelectionQuestions({
        decision: "d",
        candidates: [{ id: "a" }, { id: "b" }],
        requirements: Array.from({ length: 33 }, (_, i) => `req ${i}`),
      }),
    "requirements",
  );
});

await check("stage-2 builder injects selected id + description into every requirement instruction", () => {
  const q = buildRequirementQuestions(ARGS_AB, "b");
  assert.deepEqual(Object.keys(q), ["requirement_0"]);
  const instr = q.requirement_0.instructions;
  assert.match(instr, /"b"/, "winner id in scope");
  assert.match(instr, /Ripe mango, sweet/, "winner description in scope");
  assert.match(instr, /must be sweet/, "requirement text kept");
  assert.deepEqual(q.requirement_0.criteria, {
    true: "Requirement is supported by the evidence.",
    false: "Requirement is contradicted or unsupported.",
  });
});

await check("stage-2 builder with unknown winner id still injects the id (no description to give)", () => {
  const q = buildRequirementQuestions(ARGS_AB, "zzz");
  assert.match(q.requirement_0.instructions, /"zzz"/);
  assert.doesNotMatch(q.requirement_0.instructions, /described as/);
});

// ------------------------------------------------------------- dependency ---
async function runConditional(winner, distribution) {
  // Stage 2 is answered by READING the injected winner id: sweet (0.95)
  // only when the instructions name "b", sour (0.05) otherwise. A blind
  // simultaneous judge -- requirements without the winner in scope --
  // could not condition on the pick at all.
  calls.length = 0;
  const client = {
    predict: async (state, questions) => {
      const i = calls.length;
      calls.push({ state, questions });
      if (i === 0) return { answers: { selected: { choice: winner, probabilities: distribution } }, confidence: {}, routing: {}, model: "fase4-t6-test", latencyMs: 5, usage: {} };
      const instr = questions.requirement_0.instructions;
      const sweet = instr.includes('"b"');
      return { answers: { requirement_0: { noul: sweet ? 0.95 : 0.05 } }, confidence: {}, routing: {}, model: "fase4-t6-test", latencyMs: 9, usage: {} };
    },
  };
  const body = JSON.parse(await handleDecide(client, ARGS_AB));
  return body;
}

await check("dependency: sweet-only-for-B + winner A -> supported:false + ESCALATE (the blind case)", async () => {
  const body = await runConditional("a", { a: 0.6, b: 0.4 });
  assert.equal(calls.length, 2, "two stages");
  assert.deepEqual(Object.keys(calls[0].questions), ["selected"], "stage 1: pick only");
  assert.deepEqual(Object.keys(calls[1].questions), ["requirement_0"], "stage 2: requirements only");
  assert.match(calls[1].questions.requirement_0.instructions, /"a"/, "stage 2 scoped to the A pick");
  assert.equal(body.selected, "a");
  assert.deepEqual(body.requirements, { requirement_0: { signal: 0.05, supported: false } });
  assert.equal(body.abstention.abstained, true);
  assert.equal(body.decision.decision, "ESCALATE");
});

await check("dependency mirror: same requirement + winner B -> supported:true + ALLOW", async () => {
  const body = await runConditional("b", { a: 0.4, b: 0.6 });
  assert.match(calls[1].questions.requirement_0.instructions, /"b"/, "stage 2 scoped to the B pick");
  assert.match(calls[1].questions.requirement_0.instructions, /Ripe mango, sweet/);
  assert.equal(body.selected, "b");
  assert.deepEqual(body.requirements, { requirement_0: { signal: 0.95, supported: true } });
  assert.equal(body.decision.decision, "ALLOW");
  assert.deepEqual(body.decision.reason_codes, ["decide_selected_allow"]);
  assert.deepEqual(body.decision.policy, { name: "decide", version: "1.0.0" }, "policy stays 1.0.0: no bump");
});

// ------------------------------------------------------------ call discipline ---
await check("zero requirements -> exactly 1 call (no extra cost), ALLOW on a firm pick", async () => {
  const args = { decision: "d", candidates: [{ id: "a" }, { id: "b" }] };
  const body = JSON.parse(
    await handleDecide(scriptedClient([{ selected: { choice: "a", probabilities: { a: 0.7, b: 0.3 } } }], [5]), args),
  );
  assert.equal(calls.length, 1, "single stage");
  assert.deepEqual(Object.keys(calls[0].questions), ["selected"]);
  assert.equal(body.selected, "a");
  assert.deepEqual(body.requirements, {});
  assert.equal(body.decision.decision, "ALLOW");
  assert.equal(body.latency_ms, 5, "single-stage latency passes through");
});

await check("null selection -> NO second stage (1 call); requirements missing; ESCALATE on abstention", async () => {
  const body = JSON.parse(await handleDecide(scriptedClient([{}], [5]), ARGS_AB));
  assert.equal(calls.length, 1, "no stage 2 without a selection, by design");
  assert.equal(body.selected, null);
  assert.deepEqual(body.requirements, { requirement_0: { signal: null, supported: null } });
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /no option selected/);
  assert.equal(body.decision.decision, "ESCALATE");
  // Engine global abstain rule wins over the policy code (same as the
  // rerank empty-pool path); the abstention reason still names the cause.
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

await check("stage-2 silence (no noul) -> missing requirement -> ESCALATE on abstention", async () => {
  const body = JSON.parse(
    await handleDecide(
      scriptedClient([{ selected: { choice: "a", probabilities: { a: 0.7, b: 0.3 } } }, {}]),
      ARGS_AB,
    ),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(body.requirements, { requirement_0: { signal: null, supported: null } });
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /missing requirement/);
  assert.equal(body.decision.decision, "ESCALATE");
  // Engine global abstain rule wins (authoritative ESCALATE either way).
  assert.deepEqual(body.decision.reason_codes, ["abstained_evidence"]);
});

await check("flat distribution still runs stage 2 (a pick exists) then abstains on the flat band", async () => {
  const body = JSON.parse(
    await handleDecide(
      scriptedClient([{ selected: { choice: "a", probabilities: { a: 0.5, b: 0.5 } } }, { requirement_0: { noul: 0.9 } }]),
      ARGS_AB,
    ),
  );
  assert.equal(calls.length, 2, "selection exists -> stage 2 runs");
  assert.deepEqual(body.requirements, { requirement_0: { signal: 0.9, supported: true } }, "requirement met, yet...");
  assert.equal(body.abstention.abstained, true);
  assert.match(body.abstention.reason ?? "", /flat distribution/);
  assert.equal(body.decision.decision, "ESCALATE");
});

// ------------------------------------------------------------------ shape ---
await check("post-P1 shape intact: latency is the stage SUM, evidence model from stage 1, no legacy keys", async () => {
  const body = JSON.parse(
    await handleDecide(
      scriptedClient(
        [{ selected: { choice: "b", probabilities: { a: 0.4, b: 0.6 } } }, { requirement_0: { noul: 0.95 } }],
        [5, 9],
      ),
      ARGS_AB,
    ),
  );
  assert.deepEqual(
    Object.keys(body),
    ["selected", "distribution", "winner_probability", "requirements", "decision", "latency_ms", "evidence", "abstention"],
    "key order + shape preserved",
  );
  assert.equal(body.latency_ms, 14, "5 + 9: latency documents the 2-call cost");
  assert.equal(body.evidence.model, "fase4-t6-test", "evidence attribution: stage 1 owns the pick");
  assert.equal(body.winner_probability, 0.6);
  assert.ok(!("confidence" in body) && !("probabilities" in body), "no legacy keys resurrected");
  assert.equal(body.evidence.signals.length, 2, "1 choice + 1 requirement signal");
});

await check("unknown winner id reaches stage 2 verbatim (judge sees the id the picker returned)", async () => {
  const body = JSON.parse(
    await handleDecide(
      scriptedClient([{ selected: { choice: "zzz", probabilities: { zzz: 0.9 } } }, { requirement_0: { noul: 0.9 } }]),
      ARGS_AB,
    ),
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1].questions.requirement_0.instructions, /"zzz"/);
  assert.equal(body.selected, "zzz");
});

console.log(`\nFase-4 T6 decide two-stage: ${passed} checks passed (no server, no LLM involved).`);

// ------------------------------------------------------------------ cost ---
// Documented 2-call cost (deterministic stub latencies, absolutes only):
// with requirements the tool pays selection + evaluation; without, the
// second stage does not exist.
console.log("\nFase-4 T6 decide cost (stubbed /predict, absolutes, no baseline claims):");
console.log("| requirements | /predict calls | stage-1 Qs | stage-2 Qs | stub latency_ms (sum) |");
console.log("|--------------|----------------|------------|------------|-------------------------|");
console.log("| 1            | 2              | 1          | 1          | 5 + 9 = 14              |");
console.log("| 0            | 1              | 1          | 0          | 5                       |");
console.log("(each stage gets the standard LAYA_TOOL_TIMEOUT_MS budget: worst case ~2x single-call).");
