/**
 * Fase-7 T6 integration tests: evals/integration.mjs protocol shape.
 *
 * STRUCTURAL ONLY: task-set shape, stub-run pass-through, null-slot
 * honesty, halt behavior, live-gate refusal. No timings asserted, no live
 * backend, no models, no network reliance (the laya-server probe is
 * expected DOWN here; the test asserts the gate shape, not the outcome).
 * Never writes to evals/results/.
 *
 * Run from the repo root: node tests/fase7_t6_integration.mjs
 */
import assert from "node:assert";
import {
  INTEGRATION_METRICS,
  INTEGRATION_TASKS,
  checkLiveRequirements,
  liveRequirements,
  runIntegrationStub,
} from "../evals/integration.mjs";

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}

await check("metric columns are the eight protocol columns", () => {
  assert.deepEqual(INTEGRATION_METRICS, [
    "task_success",
    "tokens",
    "latency_wall_ms",
    "llm_calls",
    "retries",
    "test_failures",
    "human_intervention",
    "cost_usd",
  ]);
});

await check("task set is the 4-task minimum with hook chains", () => {
  assert.equal(INTEGRATION_TASKS.length, 4);
  assert.deepEqual(INTEGRATION_TASKS.map((t) => t.id), ["INT-01", "INT-02", "INT-03", "INT-04"]);
  for (const t of INTEGRATION_TASKS) {
    assert.ok(t.chain.includes("screen") && t.chain.includes("review") && t.chain.includes("gate"), `${t.id} walks the hook lifecycle`);
    assert.ok(t.inputs && t.stubs && t.gold, `${t.id} carries inputs + stubs + gold`);
  }
});

await check("INT-02 is the early-halt task (screen DENY, downstream skipped)", () => {
  const t = INTEGRATION_TASKS.find((x) => x.id === "INT-02");
  assert.equal(t.haltOn, "screen");
  assert.equal(t.gold.screen.decision, "DENY");
  assert.equal(t.gold.gate.skipped, true);
});

await check("INT-04 pins the no-cross-claim-check limitation in gold", () => {
  const t = INTEGRATION_TASKS.find((x) => x.id === "INT-04");
  assert.deepEqual(t.gold.gate.verdicts, ["SUPPORTED", "SUPPORTED"]);
  assert.ok(typeof t.limitNote === "string" && t.limitNote.length > 0, "limitation stated on the task");
});

await check("stub run passes all 4 tasks (harness plumbing vs oracle golds)", async () => {
  const rep = await runIntegrationStub();
  assert.equal(rep.summary.total, 4);
  assert.equal(rep.summary.passed, 4);
  assert.equal(rep.summary.failed, 0);
  for (const t of rep.tasks) assert.equal(t.task_success, true, t.task);
});

await check("stub run honors the INT-02 halt (1 hook run, 3 skipped)", async () => {
  const rep = await runIntegrationStub();
  const t = rep.tasks.find((x) => x.task === "INT-02");
  assert.equal(t.hooks.filter((h) => !h.skipped).length, 1);
  assert.equal(t.hooks.filter((h) => h.skipped).length, 3);
  assert.equal(t.human_intervention, true);
});

await check("LLM-slot metrics are explicit nulls (tokens, llm_calls, cost)", async () => {
  const rep = await runIntegrationStub();
  for (const t of rep.tasks) {
    assert.equal(t.tokens, null, `${t.task} tokens`);
    assert.equal(t.llm_calls, null, `${t.task} llm_calls`);
    assert.equal(t.cost_usd, null, `${t.task} cost`);
    assert.ok(t.tokens_note && t.llm_calls_note && t.cost_note, `${t.task} null reasons present`);
  }
});

await check("stub retries are 0 with the no-retry note", async () => {
  const rep = await runIntegrationStub();
  for (const t of rep.tasks) {
    assert.equal(t.retries, 0, t.task);
    assert.ok(t.retries_note, `${t.task} retries note`);
  }
});

await check("stub walls are measured overhead (non-negative numbers)", async () => {
  const rep = await runIntegrationStub();
  for (const t of rep.tasks) {
    assert.ok(typeof t.latency_wall_ms.total === "number" && t.latency_wall_ms.total >= 0, t.task);
    for (const h of t.hooks.filter((x) => !x.skipped)) {
      assert.ok(typeof h.wall_ms === "number" && h.wall_ms >= 0, `${t.task}/${h.hook}`);
      assert.equal(h.reported_latency_ms, 0, "stub-reported latency stays 0, never conflated with wall");
    }
  }
});

await check("report carries the no-improvement honesty block", async () => {
  const rep = await runIntegrationStub();
  assert.ok(Array.isArray(rep.honesty) && rep.honesty.length >= 3, "honesty notes present");
  assert.ok(/no improvement/i.test(rep.honesty.join(" ")) || /no paired comparison/i.test(rep.honesty.join(" ")), "no-claim pinned");
});

await check("live requirements are the five documented gates", () => {
  const reqs = liveRequirements();
  assert.deepEqual(reqs.map((r) => r.id), ["opencode-host", "gentle-orchestrator", "laya-server", "models-pinned", "llm-credentials"]);
  for (const r of reqs) assert.ok(r.need && r.how, r.id);
});

await check("live probe refuses a live run here (shape: present flags, no values leaked)", async () => {
  const probes = await checkLiveRequirements({ fetchTimeoutMs: 300 });
  assert.equal(probes.length, 5);
  for (const p of probes) assert.equal(typeof p.present, "boolean", p.id);
  const blob = JSON.stringify(probes);
  assert.ok(!/ghp_|sk-ant-|sk-proj-/i.test(blob), "no credential-shaped value in probe output");
  assert.ok(probes.some((p) => !p.present), "at least one requirement is absent in this tree (Fase 6 verified)");
});

console.log(`\nT6 integration: ${passed} checks passed (structural only, no live run).`);
