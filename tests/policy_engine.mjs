/**
 * P1-T4 engine tests: truth tables per policy (exact threshold edges),
 * abstention -> ESCALATE precedence, unknown policy -> structured error,
 * double-evaluation determinism, versioning, and shared-table/env overrides.
 *
 * No mocks of the logic: evidence bundles are built with the real
 * constructors from dist/evidence.js (or plain signal literals as engine
 * INPUT data), and every assertion runs the real engine.evaluate.
 *
 * Run after build from the repo root:  node tests/policy_engine.mjs
 */
import assert from "node:assert";
import { evaluate } from "../dist/policy/engine.js";
import { listPolicies } from "../dist/policy/loader.js";
import { THRESHOLDS_V1, resolveThresholds } from "../dist/policy/thresholds.js";
import * as E from "../dist/evidence.js";

const RAW = { model: "t4-test", routing: {} };
const T1 = THRESHOLDS_V1;
const noAbs = () => E.notAbstained();

function inp(name, evidence, abstention, context) {
  const out = { evidence, policy: { name, version: "1.0.0" } };
  if (abstention !== undefined) out.abstention = abstention;
  if (context !== undefined) out.context = context;
  return out;
}
function ev(name, evidence, abstention, context, thresholds) {
  return evaluate(inp(name, evidence, abstention, context), thresholds ? { thresholds } : undefined);
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---------------------------------------------------------------- screen ---
function screenEv(injection, substance) {
  return E.screenEvidence(RAW, { injection, substance, relevance: 0.9, missing: [] });
}
check("screen block above 0.75 -> DENY", () => {
  const { evidence, abstention } = screenEv(0.9, 0.9);
  const d = ev("screen", evidence, abstention);
  assert.equal(d.decision, "DENY");
  assert.deepEqual(d.reason_codes, ["screen_injection_block"]);
  assert.deepEqual(d.policy, { name: "screen", version: "1.0.0" });
});
check("screen edge 0.75 -> REVIEW (strict >)", () => {
  const { evidence, abstention } = screenEv(0.75, 0.9);
  assert.equal(ev("screen", evidence, abstention).decision, "REVIEW");
});
check("screen edge 0.26/0.25 substance branch", () => {
  assert.deepEqual(ev("screen", ...(() => { const r = screenEv(0.26, 0.9); return [r.evidence, r.abstention]; })()).reason_codes, ["screen_injection_review"]);
  const r = screenEv(0.25, 0.9);
  assert.deepEqual(ev("screen", r.evidence, r.abstention).reason_codes, ["screen_pass"]);
});
check("screen substance 0.39 -> REVIEW skip; 0.4 -> ALLOW", () => {
  const low = screenEv(0.1, 0.39);
  assert.deepEqual(ev("screen", low.evidence, low.abstention).reason_codes, ["screen_skip_low_substance"]);
  const edge = screenEv(0.1, 0.4);
  assert.deepEqual(ev("screen", edge.evidence, edge.abstention).reason_codes, ["screen_pass"]);
});
check("screen null injection (abstention cleared) -> ESCALATE missing", () => {
  const { evidence } = E.screenEvidence(RAW, { injection: null, substance: 0.9, relevance: 0.9, missing: ["is_injection"] });
  assert.deepEqual(ev("screen", evidence, noAbs()).reason_codes, ["screen_missing_signal"]);
});
check("screen abstention wins over block-level signal", () => {
  const { evidence, abstention } = E.screenEvidence(RAW, { injection: 0.99, substance: null, relevance: null, missing: ["has_substance", "is_relevant"] });
  assert.equal(abstention.abstained, true);
  const d = ev("screen", evidence, abstention);
  assert.equal(d.decision, "ESCALATE");
  assert.deepEqual(d.reason_codes, ["abstained_evidence"]);
});

// ---------------------------------------------------------------- verify ---
function verifyEv(values) {
  const signals = values.map((v, i) =>
    E.noulSignal(RAW, `claim_${i}`, v, { candidate: `claim ${i}`, metadata: { verdict: "legacy" } }),
  );
  return E.makeEvidence(RAW, signals, "router");
}
check("verify 0.8 edge -> ALLOW; 0.79 -> REVIEW", () => {
  assert.deepEqual(ev("verify", verifyEv([0.8]), noAbs()).reason_codes, ["verify_all_verified"]);
  assert.deepEqual(ev("verify", verifyEv([0.79]), noAbs()).reason_codes, ["verify_unsupported_review"]);
});
check("verify 0.4 edge -> REVIEW unsupported; 0.39 -> DENY", () => {
  assert.deepEqual(ev("verify", verifyEv([0.4]), noAbs()).reason_codes, ["verify_unsupported_review"]);
  const d = ev("verify", verifyEv([0.39]), noAbs());
  assert.equal(d.decision, "DENY");
  assert.deepEqual(d.reason_codes, ["verify_contradicted_deny"]);
});
check("verify mixed verified+unsupported -> REVIEW; with contradicted -> DENY", () => {
  assert.equal(ev("verify", verifyEv([0.95, 0.5]), noAbs()).decision, "REVIEW");
  assert.equal(ev("verify", verifyEv([0.95, 0.5, 0.1]), noAbs()).decision, "DENY");
});
check("verify empty -> ESCALATE no_claims; null signal -> ESCALATE missing", () => {
  assert.deepEqual(ev("verify", E.makeEvidence(RAW, [], "router"), noAbs()).reason_codes, ["verify_no_claims"]);
  assert.deepEqual(ev("verify", verifyEv([null]), noAbs()).reason_codes, ["verify_missing_signal"]);
});
check("verify real low-signal abstention -> ESCALATE", () => {
  const { evidence, abstention } = E.verifyEvidence(RAW, { claims: [{ claim: "c", signal: 0.2, verdict: "contradicted" }] });
  assert.equal(abstention.abstained, true);
  assert.deepEqual(ev("verify", evidence, abstention).reason_codes, ["abstained_evidence"]);
});

// ----------------------------------------------------------------- review ---
function reviewEv(safe) {
  return E.reviewEvidence(RAW, { correctness: 2, spec_match: 2, test_gap: 0, blast_radius: 0, safe_to_apply: safe });
}
check("review 0.86 -> ALLOW; edge 0.85 -> REVIEW", () => {
  assert.deepEqual(ev("review", ...(() => { const r = reviewEv(0.86); return [r.evidence, r.abstention]; })()).reason_codes, ["review_auto_allow"]);
  const r = reviewEv(0.85);
  assert.deepEqual(ev("review", r.evidence, noAbs()).reason_codes, ["review_needs_review"]);
});
check("review 0.51 -> REVIEW; edge 0.5 -> ESCALATE", () => {
  const mid = reviewEv(0.51);
  assert.deepEqual(ev("review", mid.evidence, noAbs()).reason_codes, ["review_needs_review"]);
  const edge = reviewEv(0.5);
  assert.deepEqual(ev("review", edge.evidence, edge.abstention).reason_codes, ["review_escalate"]);
});
check("review null safe -> ESCALATE missing", () => {
  const { evidence } = reviewEv(null);
  assert.deepEqual(ev("review", evidence, noAbs()).reason_codes, ["review_missing_signal"]);
});
check("review real mid-band abstention -> ESCALATE (precedence)", () => {
  const { evidence, abstention } = reviewEv(0.7);
  assert.equal(abstention.abstained, true);
  assert.deepEqual(ev("review", evidence, abstention).reason_codes, ["abstained_evidence"]);
});

// ------------------------------------------------------------------- gate ---
function gateEv(safe, claimValues) {
  return E.gateEvidence(RAW, {
    correctness: 2,
    spec_match: 2,
    safe_to_apply: safe,
    claims: claimValues.map((signal, i) => ({ claim: `c${i}`, signal, verdict: "legacy" })),
  });
}
check("gate contradicted claim dominates high safety -> ESCALATE", () => {
  const { evidence, abstention } = gateEv(0.95, [0.9, 0.2]);
  const d = ev("gate", evidence, abstention);
  assert.equal(d.decision, "ESCALATE");
  assert.deepEqual(d.reason_codes, ["gate_contradicted_escalate"]);
});
check("gate safe 0.9 clean -> ALLOW; edge 0.85 -> REVIEW", () => {
  const hi = gateEv(0.9, [0.9]);
  assert.deepEqual(ev("gate", hi.evidence, hi.abstention).reason_codes, ["gate_auto_allow"]);
  const edge = gateEv(0.85, [0.9]);
  assert.deepEqual(ev("gate", edge.evidence, noAbs()).reason_codes, ["gate_review"]);
});
check("gate low safety alone REVIEWs (never escalates on safety)", () => {
  const { evidence, abstention } = gateEv(0.2, [0.9]);
  assert.deepEqual(ev("gate", evidence, abstention).reason_codes, ["gate_review"]);
});
check("gate unsupported-only claims REVIEW (no escalate without contradicted)", () => {
  const { evidence, abstention } = gateEv(0.9, [0.5]);
  assert.deepEqual(ev("gate", evidence, abstention).reason_codes, ["gate_auto_allow"]);
});
check("gate null safe -> ESCALATE missing", () => {
  const { evidence } = gateEv(null, [0.9]);
  assert.deepEqual(ev("gate", evidence, noAbs()).reason_codes, ["gate_missing_signal"]);
});

// -------------------------------------------------------------------- pii ---
function piiFinding(type, weak) {
  return { text: `x-${type}`, start: 0, end: 5, type, detectorScore: 0.9, weak_type: weak };
}
check("pii secret api_key -> DENY block", () => {
  const { evidence, abstention } = E.piiEvidence({ findings: [piiFinding("api_key", false)], weakTypes: [] });
  const d = ev("pii", evidence, abstention);
  assert.equal(d.decision, "DENY");
  assert.deepEqual(d.reason_codes, ["pii_secret_block"]);
});
check("pii non-secret firm finding -> REVIEW", () => {
  const { evidence, abstention } = E.piiEvidence({ findings: [piiFinding("email", false)], weakTypes: [] });
  assert.equal(abstention.abstained, false);
  assert.deepEqual(ev("pii", evidence, abstention).reason_codes, ["pii_findings_review"]);
});
check("pii clean -> ALLOW", () => {
  const { evidence, abstention } = E.piiEvidence({ findings: [], weakTypes: [] });
  assert.deepEqual(ev("pii", evidence, abstention).reason_codes, ["pii_clean_allow"]);
});
check("pii weak-only real abstention -> ESCALATE", () => {
  const { evidence, abstention } = E.piiEvidence({ findings: [piiFinding("email", true)], weakTypes: ["email"] });
  assert.equal(abstention.abstained, true);
  assert.deepEqual(ev("pii", evidence, abstention).reason_codes, ["abstained_evidence"]);
});

// ------------------------------------------------------------------- find ---
function findEv(choice, distribution, candidateCount) {
  return E.findEvidence(RAW, { choice, distribution, candidateCount });
}
check("find firm winner -> ALLOW", () => {
  const { evidence, abstention } = findEv("a", { a: 0.7, b: 0.2, none: 0.1 }, 2);
  assert.deepEqual(ev("find", evidence, abstention, { candidateCount: 2 }).reason_codes, ["find_winner_allow"]);
});
check("find none / empty dist -> ESCALATE no_winner", () => {
  const none = findEv("none", { a: 0.4, none: 0.6 }, 2);
  assert.deepEqual(ev("find", none.evidence, noAbs()).reason_codes, ["find_no_winner"]);
  const empty = findEv("a", {}, 2);
  assert.deepEqual(ev("find", empty.evidence, noAbs()).reason_codes, ["find_no_winner"]);
});
check("find tie (flag cleared) -> ESCALATE ambiguous_tie", () => {
  const { evidence } = findEv("a", { a: 0.5, b: 0.5 }, 2);
  assert.deepEqual(ev("find", evidence, noAbs()).reason_codes, ["find_ambiguous_tie"]);
});
check("find weak winner needs context count; without it ALLOWs", () => {
  const { evidence } = findEv("a", { a: 0.3, b: 0.25, c: 0.2, none: 0.25 }, 3);
  assert.deepEqual(ev("find", evidence, noAbs(), { candidateCount: 3 }).reason_codes, ["find_weak_winner"]);
  assert.deepEqual(ev("find", evidence, noAbs()).reason_codes, ["find_winner_allow"]);
});

// ----------------------------------------------------------------- rerank ---
check("rerank firm signals -> ALLOW; null relevance -> ESCALATE", () => {
  const ok = E.rerankEvidence(RAW, {
    items: [
      { id: "a", question: "relevance_0_a", relevance: 0.8, rank: 1, missing: false },
      { id: "b", question: "relevance_1_b", relevance: 0.2, rank: 2, missing: false },
    ],
  });
  assert.deepEqual(ev("rerank", ok.evidence, ok.abstention).reason_codes, ["rerank_ordered_allow"]);
  const miss = E.rerankEvidence(RAW, {
    items: [{ id: "a", question: "relevance_0_a", relevance: null, rank: 0, missing: true }],
  });
  assert.equal(miss.abstention.abstained, true);
  assert.deepEqual(ev("rerank", miss.evidence, miss.abstention).reason_codes, ["abstained_evidence"]);
  assert.deepEqual(ev("rerank", miss.evidence, noAbs()).reason_codes, ["rerank_missing_signal"]);
  assert.deepEqual(ev("rerank", E.makeEvidence(RAW, [], "router"), noAbs()).reason_codes, ["rerank_no_candidates"]);
});

// --------------------------------------------------------------- classify ---
check("classify firm items -> ALLOW; missing/empty -> ESCALATE", () => {
  const ok = E.classifyEvidence(RAW, {
    items: [{ id: "i", choice: "x", distribution: { x: 0.7, y: 0.3 }, missing: false }],
  });
  assert.deepEqual(ev("classify", ok.evidence, ok.abstention).reason_codes, ["classify_labeled_allow"]);
  const miss = E.classifyEvidence(RAW, { items: [{ id: "i", choice: "other", distribution: null, missing: true }] });
  assert.equal(miss.abstention.abstained, true);
  assert.deepEqual(ev("classify", miss.evidence, noAbs()).reason_codes, ["classify_missing_signal"]);
  const empty = E.classifyEvidence(RAW, { items: [{ id: "i", choice: "x", distribution: {}, missing: false }] });
  assert.deepEqual(ev("classify", empty.evidence, noAbs()).reason_codes, ["classify_empty_distribution"]);
});

// ----------------------------------------------------------------- decide ---
function decideEv(selected, distribution, requirements) {
  return E.decideEvidence(RAW, { selected, distribution, optionCount: 2, requirements });
}
check("decide firm + met requirement -> ALLOW; 0.8 edge met", () => {
  const { evidence, abstention } = decideEv("a", { a: 0.6, b: 0.4 }, [{ key: "requirement_0", signal: 0.8, missing: false }]);
  assert.deepEqual(ev("decide", evidence, abstention).reason_codes, ["decide_selected_allow"]);
});
check("decide requirement 0.79 (flag cleared) -> ESCALATE unsupported", () => {
  const { evidence } = decideEv("a", { a: 0.6, b: 0.4 }, [{ key: "requirement_0", signal: 0.79, missing: false }]);
  assert.deepEqual(ev("decide", evidence, noAbs()).reason_codes, ["decide_requirement_unsupported"]);
});
check("decide null selection / missing req -> ESCALATE", () => {
  const nosel = decideEv(null, { a: 0.5, b: 0.5 }, []);
  assert.deepEqual(ev("decide", nosel.evidence, noAbs()).reason_codes, ["decide_no_selection"]);
  const misreq = decideEv("a", { a: 0.6, b: 0.4 }, [{ key: "requirement_0", signal: null, missing: true }]);
  assert.deepEqual(ev("decide", misreq.evidence, noAbs()).reason_codes, ["decide_missing_signal"]);
});

// ---------------------------------------------------------------- compare ---
check("compare firm overall+aspect -> ALLOW; missing aspect -> ESCALATE", () => {
  const ok = E.compareEvidence(RAW, {
    overall: { choice: "same_fact", distribution: { same_fact: 0.8 }, missing: false },
    aspects: [{ key: "aspect_0_price", label: "price", choice: "contradicts", distribution: { contradicts: 0.7 }, missing: false }],
  });
  assert.deepEqual(ev("compare", ok.evidence, ok.abstention).reason_codes, ["compare_related_allow"]);
  const miss = E.compareEvidence(RAW, {
    overall: { choice: null, distribution: null, missing: true },
    aspects: [],
  });
  assert.equal(miss.abstention.abstained, true);
  assert.deepEqual(ev("compare", miss.evidence, miss.abstention).reason_codes, ["abstained_evidence"]);
  assert.deepEqual(ev("compare", miss.evidence, noAbs()).reason_codes, ["compare_missing_signal"]);
});

// ---------------------------------------------------------------- extract ---
function extractField(over) {
  return {
    fieldId: "f",
    question: "extract_0_f",
    choice: "m0",
    distribution: { m0: 0.8, none: 0.2 },
    candidateCount: 3,
    invalidPattern: false,
    source: "regex",
    ...over,
  };
}
check("extract firm field (incl. firm none) -> ALLOW", () => {
  const ok = E.extractEvidence(RAW, { fields: [extractField({})], source: "regex" });
  assert.deepEqual(ev("extract", ok.evidence, ok.abstention).reason_codes, ["extract_values_allow"]);
  const firmNone = E.extractEvidence(RAW, { fields: [extractField({ choice: "none" })], source: "regex" });
  assert.deepEqual(ev("extract", firmNone.evidence, firmNone.abstention).reason_codes, ["extract_values_allow"]);
});
check("extract zero candidates / invalid pattern -> ESCALATE", () => {
  const zero = E.extractEvidence(RAW, { fields: [extractField({ choice: "none", candidateCount: 0 })], source: "regex" });
  assert.equal(zero.abstention.abstained, true);
  assert.deepEqual(ev("extract", zero.evidence, zero.abstention).reason_codes, ["abstained_evidence"]);
  assert.deepEqual(ev("extract", zero.evidence, noAbs()).reason_codes, ["extract_no_candidates"]);
  const bad = E.extractEvidence(RAW, { fields: [extractField({ choice: "none", candidateCount: 0, invalidPattern: true })], source: "regex" });
  assert.deepEqual(ev("extract", bad.evidence, noAbs()).reason_codes, ["extract_invalid_pattern"]);
});

// ------------------------------------------------------------ code-review ---
check("code-review mirrors 0.85/0.5 edges", () => {
  const hi = reviewEv(0.9);
  assert.deepEqual(ev("code-review", hi.evidence, hi.abstention).reason_codes, ["code_review_auto_allow"]);
  const edgeAuto = reviewEv(0.85);
  assert.deepEqual(ev("code-review", edgeAuto.evidence, noAbs()).reason_codes, ["code_review_needs_review"]);
  const edgeMin = reviewEv(0.5);
  assert.deepEqual(ev("code-review", edgeMin.evidence, edgeMin.abstention).reason_codes, ["code_review_escalate"]);
});

// --------------------------------------------------------------- security ---
function secEvidence() {
  const signals = [
    E.noulSignal(RAW, "is_injection", 0.1),
    E.spanSignal("email", "a@b.c", 0, 5, 0.9, { weak_type: true }),
  ];
  return E.makeEvidence(RAW, signals, "router");
}
check("security injection 0.9 -> DENY; secret span -> DENY", () => {
  const inj = E.makeEvidence(RAW, [E.noulSignal(RAW, "is_injection", 0.9)], "router");
  assert.deepEqual(ev("security", inj, noAbs()).reason_codes, ["security_injection_deny"]);
  const sec = E.makeEvidence(RAW, [E.spanSignal("api_key", "sk-x", 0, 4, 0.9, { weak_type: false })], "gliner");
  assert.deepEqual(ev("security", sec, noAbs()).reason_codes, ["security_secret_deny"]);
});
check("security clean evidence REVIEWs (never ALLOWs)", () => {
  const clean = E.makeEvidence(RAW, [E.noulSignal(RAW, "is_injection", 0.1)], "router");
  const d = ev("security", clean, noAbs());
  assert.equal(d.decision, "REVIEW");
  assert.deepEqual(d.reason_codes, ["security_default_review"]);
  const d2 = ev("security", secEvidence(), noAbs());
  assert.deepEqual(d2.reason_codes, ["security_pii_review"]);
  const injLow = E.makeEvidence(RAW, [E.noulSignal(RAW, "is_injection", 0.3)], "router");
  assert.deepEqual(ev("security", injLow, noAbs()).reason_codes, ["security_injection_review"]);
});

// ----------------------------------------------------------------- normal ---
check("normal allows firm evidence; abstention still escalates", () => {
  const { evidence, abstention } = screenEv(0.1, 0.9);
  assert.deepEqual(ev("normal", evidence, abstention).reason_codes, ["normal_allow_default"]);
  assert.deepEqual(ev("normal", evidence, E.abstained("ambiguous")).reason_codes, ["abstained_evidence"]);
});

// ------------------------------------------------- unknown policy / input ---
check("unknown policy name -> structured policy_not_found", () => {
  const { evidence } = screenEv(0.1, 0.9);
  assert.throws(() => evaluate({ evidence, policy: { name: "nope", version: "1.0.0" } }), (err) => {
    assert.match(String(err?.message ?? err), /policy_not_found/);
    assert.equal(err?.code, "policy_not_found");
    assert.equal(err?.detail?.code, "policy_not_found");
    assert.deepEqual(err?.detail?.policy, { name: "nope", version: "1.0.0" });
    assert.ok(Array.isArray(err?.detail?.available) && err.detail.available.length === 14);
    return true;
  });
});
check("known name + unknown version -> policy_not_found", () => {
  const { evidence } = screenEv(0.1, 0.9);
  assert.throws(() => evaluate({ evidence, policy: { name: "screen", version: "9.9.9" } }), /policy_not_found/);
});
check("missing policy/evidence -> input error", () => {
  const { evidence } = screenEv(0.1, 0.9);
  assert.throws(() => evaluate({ evidence }), /policy.*required/);
  assert.throws(() => evaluate({ policy: { name: "screen", version: "1.0.0" } }), /evidence.*required/);
});

// ------------------------------------------------------------- versioning ---
check("registry holds 14 policies at 1.0.0 incl. families + 3 named", () => {
  const names = listPolicies().map((p) => `${p.name}@${p.version}`).sort();
  for (const fam of ["screen", "verify", "find", "rerank", "classify", "decide", "compare", "extract", "review", "gate", "pii"]) {
    assert.ok(names.includes(`${fam}@1.0.0`), `missing ${fam}@1.0.0`);
  }
  for (const named of ["code-review", "security", "normal"]) {
    assert.ok(names.includes(`${named}@1.0.0`), `missing ${named}@1.0.0`);
  }
  assert.equal(names.length, 14);
});

// ------------------------------------------------------------ determinism ---
check("double evaluation is byte-identical (determinism)", () => {
  const cases = [
    inp("screen", screenEv(0.6, 0.9).evidence, screenEv(0.6, 0.9).abstention),
    inp("review", reviewEv(0.7).evidence, noAbs()),
    inp("gate", gateEv(0.9, [0.5]).evidence, gateEv(0.9, [0.5]).abstention),
  ];
  for (const c of cases) {
    assert.deepEqual(evaluate(c, { thresholds: T1 }), evaluate(c, { thresholds: T1 }));
    assert.deepEqual(evaluate(c, { thresholds: T1 }), JSON.parse(JSON.stringify(evaluate(c, { thresholds: T1 }))));
  }
});
check("context/risk do not move v1 cuts (except documented find baseline)", () => {
  const { evidence, abstention } = screenEv(0.6, 0.9);
  const a = evaluate({ evidence, abstention, policy: { name: "screen", version: "1.0.0" } }, { thresholds: T1 });
  const b = evaluate({ evidence, abstention, context: { note: "x" }, risk: "high", policy: { name: "screen", version: "1.0.0" } }, { thresholds: T1 });
  assert.deepEqual(a, b);
});

// ------------------------------------------- shared table + env overrides ---
check("v1 defaults equal the preserved pre-P1 literals", () => {
  assert.deepEqual({ ...T1, secretTypes: [...T1.secretTypes] }, {
    screenInjectionBlock: 0.75,
    screenInjectionReview: 0.25,
    screenSubstanceSkip: 0.4,
    claimVerified: 0.8,
    claimContradicted: 0.4,
    reviewAuto: 0.85,
    reviewReview: 0.5,
    requireSupport: 0.8,
    secretTypes: ["api_key", "token_secreto", "password"],
  });
});
check("one shared claim table drives verify AND gate (no duplicated 0.8/0.4)", () => {
  const customHi = resolveThresholds({ LAYA_POLICY_CLAIM_VERIFIED: "0.9" });
  assert.equal(customHi.claimVerified, 0.9);
  assert.equal(ev("verify", verifyEv([0.85]), noAbs(), undefined, customHi).decision, "REVIEW");
  assert.equal(ev("verify", verifyEv([0.85]), noAbs(), undefined, T1).decision, "ALLOW");
  const customLo = resolveThresholds({ LAYA_POLICY_CLAIM_CONTRADICTED: "0.9" });
  const g = gateEv(0.95, [0.85]);
  assert.deepEqual(ev("gate", g.evidence, noAbs(), undefined, customLo).reason_codes, ["gate_contradicted_escalate"]);
  assert.deepEqual(ev("gate", g.evidence, noAbs(), undefined, T1).reason_codes, ["gate_auto_allow"]);
});
check("env override moves screen block cut; invalid env falls back", () => {
  const custom = resolveThresholds({ LAYA_POLICY_SCREEN_BLOCK: "0.5" });
  const { evidence } = screenEv(0.6, 0.9);
  assert.deepEqual(ev("screen", evidence, noAbs(), undefined, custom).reason_codes, ["screen_injection_block"]);
  assert.deepEqual(ev("screen", evidence, noAbs(), undefined, T1).reason_codes, ["screen_injection_review"]);
  const bad = resolveThresholds({ LAYA_POLICY_SCREEN_BLOCK: "abc", LAYA_POLICY_SECRET_TYPES: "" });
  assert.equal(bad.screenInjectionBlock, 0.75);
  assert.deepEqual(bad.secretTypes, ["api_key", "token_secreto", "password"]);
  assert.deepEqual(resolveThresholds({ LAYA_POLICY_SECRET_TYPES: "a,b" }).secretTypes, ["a", "b"]);
  assert.deepEqual(resolveThresholds({}), { ...T1, secretTypes: [...T1.secretTypes] });
});

console.log(`\nPolicy engine T4: ${passed} checks passed (no server, no LLM involved).`);
