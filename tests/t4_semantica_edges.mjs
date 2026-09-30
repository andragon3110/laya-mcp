/**
 * fut-b-semantica T4: gap-fill edges for T2 (risk) + T3 (refutation/bands).
 *
 * Gap mapping (verified by grep over tests/ -- no duplicates):
 *   - t2 pins risk movement at 0.87/0.83 (gate) and 0.72/0.22 (screen) but
 *     NOT the shifted strict edges documented in screen.ts ("0.70/0.80 ->
 *     REVIEW (not block) under high/low respectively").
 *   - t7 pins gate-high 0.9 -> REVIEW but not gate-normal 0.85 (strict >
 *     preserved) nor gate-low 0.80 (float edge: 0.85-0.05 is 0.7999..., so
 *     0.80 clears the low auto band -- deterministic IEEE 754, pinned here).
 *   - policy_engine pins risk-normal == unset for screen only; gate/pii
 *     equivalence was asserted nowhere.
 *   - claimContradicted is retained (defaults + env override + compat) but
 *     UNCONSULTED since T3 -- no test pinned that moving it changes nothing.
 *   - screen/pii inputSchema gained optional `risk` in T2 (MCP_CONTRACT rows)
 *     with no schema-shape pin.
 *
 * No server, no LLM: engine checks run the real evaluate with the real
 * evidence constructors. Run after build from the repo root:
 *     node tests/t4_semantica_edges.mjs
 */
import assert from "node:assert";
import { evaluate } from "../dist/policy/engine.js";
import { THRESHOLDS_V1, resolveThresholds } from "../dist/policy/thresholds.js";
import { screenTool } from "../dist/tools/screen.js";
import { piiTool } from "../dist/tools/pii.js";
import * as E from "../dist/evidence.js";

const RAW = { model: "t4-test", routing: {} };
const T1 = THRESHOLDS_V1;
const noAbs = () => E.notAbstained();

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function screenEv(injection, substance, risk) {
  const { evidence } = E.screenEvidence(RAW, { injection, substance, relevance: 0.9, missing: [] });
  return evaluate(
    { evidence, abstention: noAbs(), risk, policy: { name: "screen", version: "1.0.0" } },
    { thresholds: T1 },
  );
}

function gateEv(safe, support, refute, risk) {
  const { evidence } = E.gateEvidence(RAW, {
    correctness: 2,
    spec_match: 2,
    safe_to_apply: safe,
    claims: [{ claim: "c0", signal: support, verdict: "legacy", refute }],
  });
  return evaluate(
    { evidence, abstention: noAbs(), risk, policy: { name: "gate", version: "1.0.0" } },
    { thresholds: T1 },
  );
}

// ------------------------------------------------- screen shifted edges ---
check("screen high: 0.70 is the strict edge -> REVIEW (not block); 0.71 -> DENY", () => {
  // 0.75-0.05 === 0.7 exactly (verified); strict > keeps the edge in REVIEW.
  assert.deepEqual(screenEv(0.7, 0.9, "high").reason_codes, ["screen_injection_review"]);
  assert.deepEqual(screenEv(0.71, 0.9, "high").reason_codes, ["screen_injection_block"]);
  // Same 0.70 under normal is far from the v1 0.75 cut: REVIEW either way,
  // same code, different cut -- risk moved the band, not the contract.
  assert.deepEqual(screenEv(0.7, 0.9, "normal").reason_codes, ["screen_injection_review"]);
});

check("screen low: 0.80 is the strict edge -> REVIEW (not block); 0.81 -> DENY", () => {
  // 0.75+0.05 === 0.8 exactly (verified); strict > keeps the edge in REVIEW.
  assert.deepEqual(screenEv(0.8, 0.9, "low").reason_codes, ["screen_injection_review"]);
  assert.deepEqual(screenEv(0.81, 0.9, "low").reason_codes, ["screen_injection_block"]);
});

check("screen review-band shifted edges: 0.21 REVIEWs only on high; 0.30 passes on low", () => {
  // High review cut 0.25-0.05 === 0.2: 0.21 trips it, normal/low do not.
  assert.deepEqual(screenEv(0.21, 0.9, "high").reason_codes, ["screen_injection_review"]);
  assert.deepEqual(screenEv(0.21, 0.9, "normal").reason_codes, ["screen_pass"]);
  // Low review cut 0.25+0.05 === 0.3: 0.30 falls through to substance (firm
  // here, so ALLOW), 0.31 trips REVIEW.
  assert.deepEqual(screenEv(0.3, 0.9, "low").reason_codes, ["screen_pass"]);
  assert.deepEqual(screenEv(0.31, 0.9, "low").reason_codes, ["screen_injection_review"]);
});

// --------------------------------------------------- gate strict edges ---
check("gate normal 0.85 stays strict -> REVIEW; gate low 0.80 clears -> ALLOW", () => {
  // v1 strict > preserved under risk-normal (no bump justification).
  assert.deepEqual(gateEv(0.85, 0.9, 0.1, "normal").reason_codes, ["gate_review"]);
  // 0.85-0.05 is 0.7999... in IEEE 754 (verified: !== 0.8), so safe 0.80
  // strictly clears the low auto band -- deterministic, pinned honestly.
  assert.deepEqual(gateEv(0.8, 0.9, 0.1, "low").reason_codes, ["gate_auto_allow"]);
  assert.deepEqual(gateEv(0.8, 0.9, 0.1, "normal").reason_codes, ["gate_review"]);
});

// --------------------------------------- claimContradicted inert (T3) ---
check("LAYA_POLICY_CLAIM_CONTRADICTED moves nothing in verify/gate (retained, unconsulted)", () => {
  const moved = resolveThresholds({ LAYA_POLICY_CLAIM_CONTRADICTED: "0.9" });
  assert.equal(moved.claimContradicted, 0.9, "override still resolves (compat)");
  const evWith = (name, evidence) =>
    evaluate({ evidence, abstention: noAbs(), policy: { name, version: "1.0.0" } }, { thresholds: moved });
  const evBase = (name, evidence) =>
    evaluate({ evidence, abstention: noAbs(), policy: { name, version: "1.0.0" } }, { thresholds: T1 });
  // Low support + weak refutation: REVIEW under both tables (0.9 cut would
  // have DENYed pre-T3 -- absence is never refutation now).
  const vLow = E.verifyEvidence(RAW, { claims: [{ claim: "c", signal: 0.2, verdict: "x", refute: 0.1 }] });
  assert.deepEqual(evWith("verify", vLow.evidence).reason_codes, ["verify_unsupported_review"]);
  assert.deepEqual(evWith("verify", vLow.evidence), evBase("verify", vLow.evidence));
  // Firm refutation + weak support: DENY follows claimVerified (0.8), not
  // the moved 0.9 cut, in both tables.
  const vDeny = E.verifyEvidence(RAW, { claims: [{ claim: "c", signal: 0.2, verdict: "x", refute: 0.85 }] });
  assert.deepEqual(evWith("verify", vDeny.evidence).reason_codes, ["verify_contradicted_deny"]);
  const gLow = E.gateEvidence(RAW, {
    correctness: 2, spec_match: 2, safe_to_apply: 0.95,
    claims: [{ claim: "c", signal: 0.2, verdict: "x", refute: 0.1 }],
  });
  assert.deepEqual(evWith("gate", gLow.evidence).reason_codes, ["gate_auto_allow"]);
  assert.deepEqual(evWith("gate", gLow.evidence), evBase("gate", gLow.evidence));
});

// ------------------------------------------- normal == unset (gate/pii) ---
check("risk normal == unset byte-identical for gate and pii (no-bump lock)", () => {
  const g = gateEv(0.87, 0.9, 0.1, "normal");
  const { evidence } = E.gateEvidence(RAW, {
    correctness: 2, spec_match: 2, safe_to_apply: 0.87,
    claims: [{ claim: "c0", signal: 0.9, verdict: "legacy", refute: 0.1 }],
  });
  assert.deepEqual(
    g,
    evaluate({ evidence, abstention: noAbs(), policy: { name: "gate", version: "1.0.0" } }, { thresholds: T1 }),
    "gate normal == unset",
  );
  const piiFirm = (risk) => {
    const { evidence: pe, abstention } = E.piiEvidence({
      findings: [{ text: "a@b.c", start: 0, end: 5, type: "email", detectorScore: 0.9, weak_type: false }],
      weakTypes: [],
    });
    return evaluate({ evidence: pe, abstention, risk, policy: { name: "pii", version: "1.0.0" } }, { thresholds: T1 });
  };
  assert.deepEqual(piiFirm("normal"), piiFirm(undefined), "pii normal == unset");
});

// ------------------------------------------------- inputSchema shapes ---
check("screen/pii inputSchema carry optional risk low|normal|high (T2 surface)", () => {
  for (const [tool, name] of [[screenTool, "screen"], [piiTool, "pii"]]) {
    assert.deepEqual(tool.inputSchema.properties.risk, {
      type: "string",
      enum: ["low", "normal", "high"],
      description: tool.inputSchema.properties.risk.description,
    }, `${name} risk enum`);
    assert.ok(!tool.inputSchema.required.includes("risk"), `${name} risk optional`);
  }
});

console.log(`\nT4 semantica edges: ${passed} checks passed (no server, no LLM involved).`);
