// V5 held-out silence scoring (same lane pipeline as the v25 matrix methodology).
// Scores the 20 v5-silence-heldout rows (train-shaped) through the gate lane
// via the served backend, emitting reliability-feed entries
// {id, predicted_label, confidence, correct, abstained} with correct=taskOk.
import fs from "node:fs";
const R = "C:/Users/Andragon/Documents/Github/laya-mcp";
const { probeLane, lanePredictFactory, GliclassClient } = await import(`file:///${R}/evals/lanes-r1.mjs`);
const { scoreIndependentDecision } = await import(`file:///${R}/evals/metrics.mjs`);
const suite = await import(`file:///${R}/evals/suites/gate.mjs`);
const held = fs.readFileSync(`${R}/artifacts-ft/mix-regulus-v5/v5-silence-heldout.jsonl`, "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const probe = await probeLane("gate", "gliclass");
if (!probe.reachable) { console.error(`REFUSED (exit 2): ${probe.error}`); process.exit(2); }
const client = new GliclassClient(probe.baseUrl);
const deps = { fakeClient: lanePredictFactory(client) };
const out = [];
for (const r of held) {
  const [evidence, claim] = r.text.split(" || ");
  const input = { request: "v5 heldout silence probe", diff: "+ heldout probe row",
    evidence: (evidence ?? "").trim(), claims: [(claim ?? "").trim()] };
  const gold = { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true };
  client.callLog = [];
  const body = await suite.invoke(deps, input, { answers: {} }, {});
  const s = scoreIndependentDecision(suite.name, body, gold);
  const g = (client.callLog ?? [])[0] ?? {};
  out.push({ id: r.id, lang: r.lang ?? "en", predicted_label: g.top ?? null,
    confidence: typeof g.top_score === "number" ? g.top_score : null,
    correct: s.taskOk === true, abstained: body?.abstention?.abstained === true,
    taskActual: s.taskActual ?? null });
  console.log(`${r.id}: top ${g.top}@${typeof g.top_score === "number" ? g.top_score.toFixed(3) : g.top_score} taskOk=${s.taskOk} abst=${body?.abstention?.abstained === true}`);
}
const dest = process.argv[2] ?? `${R}/evals/results/v28-regulus-v5/heldout-scores.json`;
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`saved ${out.length} heldout scores -> ${dest}`);
