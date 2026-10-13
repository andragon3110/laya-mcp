/**
 * WS-C F2 objective spike: IDK-loss synthetic math check (validation-only).
 *
 * Spawns `py/.venv-ft` python to run `ft/idk_loss.py --demo --json` (tiny
 * synthetic tensors, CPU, seconds, no model weights, no training) and
 * asserts the three spike legs:
 *   (a) abstaining on the ambiguous row beats forcing a verdict;
 *   (b) a forced confident-wrong verdict costs MORE than abstaining;
 *   (c) a confident-correct row still prefers force (no abstain-collapse).
 * Plus a fourth check: the cost parameter resolves CLI > env > default.
 *
 * Run from the repo root: node tests/idk_loss_spike.mjs
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const PY = process.platform === "win32"
  ? path.join(ROOT, "py", ".venv-ft", "Scripts", "python.exe")
  : path.join(ROOT, "py", ".venv-ft", "bin", "python");

function demo(extraEnv = {}, extraArgs = []) {
  const out = execFileSync(
    PY,
    [path.join(ROOT, "ft", "idk_loss.py"), "--demo", "--json", ...extraArgs],
    { env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 120000 }
  );
  return JSON.parse(out);
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// Default run: spike default C=0.3 on the BCE scale.
const d = demo();
check("demo exits with all three legs passing", () => {
  assert.equal(d.all_pass, true, JSON.stringify(d.checks));
});
check(`default cost is the spike default (C=${d.abstention_cost})`, () => {
  assert.equal(d.abstention_cost, 0.3);
});
check(
  `ambiguous: abstain ${d.rows.ambiguous.abstain} < force ${d.rows.ambiguous.force}`,
  () => {
    assert.ok(d.rows.ambiguous.abstain < d.rows.ambiguous.force);
  }
);
check(
  `confident-wrong: force ${d.rows.wrong.force} > abstain ${d.rows.wrong.abstain}`,
  () => {
    assert.ok(d.rows.wrong.force > d.rows.wrong.abstain);
  }
);
check(
  `confident-correct: force ${d.rows.correct.force} < abstain ${d.rows.correct.abstain}`,
  () => {
    assert.ok(d.rows.correct.force < d.rows.correct.abstain);
  }
);

// Cost parameter: env override is honoured, legs still hold at C=0.5
// (0.0486 < 0.5 < 0.6444 << 4.0181 on the BCE scale).
const e = demo({ REGULUS_ABSTAIN_COST: "0.5" });
check("env REGULUS_ABSTAIN_COST=0.5 resolves as C", () => {
  assert.equal(e.abstention_cost, 0.5);
  assert.equal(e.all_pass, true, JSON.stringify(e.checks));
});

// CLI beats env (C=0.6: still inside the (0.049, 0.644) working band).
const c = demo({ REGULUS_ABSTAIN_COST: "0.5" }, ["--abstain-cost", "0.6"]);
check("CLI --abstain-cost beats env (C=0.6, legs still hold)", () => {
  assert.equal(c.abstention_cost, 0.6);
  assert.equal(c.all_pass, true, JSON.stringify(c.checks));
});

console.log(`\n${passed} checks passed (idk-loss spike green)`);
