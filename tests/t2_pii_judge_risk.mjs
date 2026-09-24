/**
 * fut-b-semantica T2: pii Laya-judge + risk efectivo.
 *
 * No server, no LLM: handlers run against a stub LayaClient whose predict()
 * returns canned noul answers per span (and a stub GLiNER sidecar), and the
 * risk bands run against the real engine.evaluate with the real evidence
 * constructors. Every assertion documents the T2 authority split: GLiNER
 * proposes, Laya judges each span (signal only), the Policy decides.
 *
 * Covered:
 *   - judge confirma (high noul) / duda (low noul) / se abstiene (sin
 *     respuesta) por span; laya_signal real; finding_status stays candidate.
 *   - backend caido -> null honesto + motivo + laya_judged:false; el scan
 *     sigue decidiendo desde GLiNER (el outage nunca falla el scan).
 *   - cero spans -> judged:true vacuo SIN llamar a Laya.
 *   - cap de 64 preguntas (un span = una question); extras en null.
 *   - risk mueve gate (banda auto 0.80/0.85/0.90), screen (inyeccion
 *     0.70/0.75/0.80 y 0.20/0.25/0.30) y pii (rama no-secreta
 *     DENY/REVIEW/ALLOW); fixed points intactos en los tres.
 *   - risk nunca rescata abstencion (regla global) ni mueve missing-signal,
 *     contradicted, secretos, clean, substance ni el resto de policies.
 *
 * Run after build from the repo root:  node tests/t2_pii_judge_risk.mjs
 */
import assert from "node:assert";
import { handlePii, judgePiiSpans, piiJudgeQuestions } from "../dist/tools/pii.js";
import { handleScreen } from "../dist/tools/screen.js";
import { handleGate } from "../dist/tools/gate.js";
import { evaluate } from "../dist/policy/engine.js";
import { THRESHOLDS_V1, RISK_CUT_DELTA, riskCutDelta } from "../dist/policy/thresholds.js";
import { BackendUnavailableError } from "../dist/client.js";
import * as E from "../dist/evidence.js";

const RAW = { model: "t2-test", routing: {} };
const T1 = THRESHOLDS_V1;
const noAbs = () => E.notAbstained();

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}

// ------------------------------------------------------------------ stubs ---
const span = (type, text = `x-${type}`, confidence = 0.9) => ({
  text,
  start: 0,
  end: text.length,
  type,
  confidence,
});

const fakePiiCtx = (findings) => ({
  glinerReady: () => true,
  gliner: {
    piiScan: async () => ({
      findings,
      counts: Object.fromEntries(
        [...new Set(findings.map((f) => f.type))].map((t) => [t, findings.filter((f) => f.type === t).length]),
      ),
      latencyMs: 5,
    }),
    extractEntities: async () => ({ spansByType: {}, latencyMs: 5 }),
  },
});

/** Stub Laya: canned noul per judge index; records state+questions. */
const judgeClient = (noulByIndex, { latencyMs = 3, onCall } = {}) => {
  const seen = { calls: 0, lastState: null, lastQuestions: null };
  return {
    seen,
    predict: async (state, questions) => {
      seen.calls++;
      seen.lastState = state;
      seen.lastQuestions = questions;
      if (onCall) onCall(state, questions);
      const answers = {};
      for (const [i, v] of Object.entries(noulByIndex)) {
        answers[`pii_judge_${i}`] = v === null ? {} : { noul: v };
      }
      return { answers, confidence: {}, routing: {}, model: "t2-judge", latencyMs, usage: {} };
    },
  };
};

const downClient = (message = "laya-server unreachable at http://127.0.0.1:9") => ({
  predict: async () => {
    throw new BackendUnavailableError(message, "unreachable");
  },
});

const screenAnswers = ({ injection = 0.1, substance = 0.9, relevance = 0.9 } = {}) => ({
  ...(injection === null ? {} : { is_injection: { noul: injection } }),
  ...(substance === null ? {} : { has_substance: { noul: substance } }),
  ...(relevance === null ? {} : { is_relevant: { noul: relevance } }),
});

const gateAnswers = ({ safe = 0.9, claims = [] } = {}) => ({
  correctness: { score: 2 },
  spec_match: { score: 2 },
  ...(safe === null ? {} : { safe_to_apply: { noul: safe } }),
  ...Object.fromEntries(claims.map((v, i) => [`claim_${i}`, v === null ? {} : { noul: v }])),
});

// ------------------------------------------------------------ judge Bess ---
await check("judge confirma: high noul por span -> laya_signal real + judged:true, decision de GLiNER", async () => {
  const client = judgeClient({ 0: 0.92 });
  const body = JSON.parse(
    await handlePii(client, { text: "key sk-123" }, fakePiiCtx([span("api_key", "sk-123")])),
  );
  assert.equal(body.pipeline.laya_judged, true);
  assert.deepEqual(body.pipeline.stages, ["gliner", "laya_risk", "policy"]);
  assert.deepEqual(body.pipeline.policy, { name: "pii", version: "1.0.0" });
  assert.equal(body.findings.length, 1);
  const f = body.findings[0];
  assert.equal(f.laya_signal, 0.92);
  assert.equal(f.finding_status, "candidate", "el judge informa, nunca confirma el label");
  assert.equal(f.detector_score, 0.9);
  // Autoridad intacta: el DENY viene del conteo GLiNER (secreto), no del judge.
  assert.equal(body.decision.decision, "DENY");
  assert.deepEqual(body.decision.reason_codes, ["pii_secret_block"]);
  // El judge pregunto exactamente un noul por span, con el texto como estado.
  assert.deepEqual(Object.keys(client.seen.lastQuestions), ["pii_judge_0"]);
  assert.equal(client.seen.lastQuestions.pii_judge_0.type, "noul");
  assert.ok(String(client.seen.lastQuestions.pii_judge_0.instructions).includes("api_key"));
  assert.equal(client.seen.lastState.text, "key sk-123");
});

await check("judge duda: low noul se porta como senal baja; la policy sigue contando GLiNER", async () => {
  const body = JSON.parse(
    await handlePii(judgeClient({ 0: 0.12 }), { text: "key sk-123" }, fakePiiCtx([span("api_key", "sk-123")])),
  );
  assert.equal(body.findings[0].laya_signal, 0.12);
  assert.equal(body.findings[0].finding_status, "candidate", "dudar no es refutar ni re-etiquetar");
  assert.equal(body.pipeline.laya_judged, true);
  // La duda del judge no rescata el secreto: DENY del conteo.
  assert.equal(body.decision.decision, "DENY");
  assert.deepEqual(body.decision.reason_codes, ["pii_secret_block"]);
});

await check("judge se abstiene por span: sin respuesta -> null + judged:false + motivo honesto", async () => {
  const body = JSON.parse(
    await handlePii(
      judgeClient({ 0: 0.88 }),
      { text: "a b" },
      fakePiiCtx([span("email", "a@b.c"), span("phone", "555")]),
    ),
  );
  assert.deepEqual(
    body.findings.map((f) => f.laya_signal),
    [0.88, null],
  );
  assert.equal(body.pipeline.laya_judged, false, "parcial: un span sin juzgar");
  assert.match(body.pipeline.laya_note, /1\/2/, "el motivo cuenta lo juzgado");
  assert.ok(
    body.findings.every((f) => f.finding_status === "candidate"),
    "abstencion del judge no toca labels",
  );
});

await check("backend caido: null honesto + motivo + judged:false; el scan decide desde GLiNER", async () => {
  const body = JSON.parse(
    await handlePii(downClient(), { text: "key sk-123" }, fakePiiCtx([span("api_key", "sk-123")])),
  );
  assert.deepEqual(
    body.findings.map((f) => f.laya_signal),
    [null],
  );
  assert.equal(body.pipeline.laya_judged, false);
  assert.match(body.pipeline.laya_note, /unreachable/, "motivo honesto del outage");
  assert.ok(!JSON.stringify(body).includes("sk-123 sk-123"), "el motivo no duplica contenido");
  // El outage no falla el scan: el secreto GLiNER sigue DENY.
  assert.equal(body.decision.decision, "DENY");
  assert.deepEqual(body.decision.reason_codes, ["pii_secret_block"]);
});

await check("cero spans: judged:true vacuo sin llamar a Laya (cliente que lanza igual sirve)", async () => {
  const never = { predict: async () => { throw new Error("must not be called"); } };
  const body = JSON.parse(await handlePii(never, { text: "hello" }, fakePiiCtx([])));
  assert.equal(body.pipeline.laya_judged, true);
  assert.match(body.pipeline.laya_note, /vacuous/, "nota vacua honesta");
  assert.deepEqual(body.findings, []);
  assert.equal(body.decision.decision, "ALLOW");
});

await check("cap 64: un span = una question; el 65 en null con truncado nombrado", async () => {
  const findings = Array.from({ length: 65 }, (_, i) => span("email", `e${i}@x.y`));
  const { questions, judgedCount } = piiJudgeQuestions(findings);
  assert.equal(judgedCount, 64);
  assert.equal(Object.keys(questions).length, 64);
  const body = JSON.parse(await handlePii(judgeClient({}), { text: "many" }, fakePiiCtx(findings)));
  assert.equal(body.findings.length, 65);
  assert.ok(body.findings.every((f) => f.laya_signal === null), "sin respuestas todo null");
  assert.equal(body.pipeline.laya_judged, false);
  assert.match(body.pipeline.laya_note, /64-question budget/, "truncado nombrado");
});

await check("error no-backend propaga (nunca se disfraza de outage)", async () => {
  const broken = { predict: async () => { throw new Error("boom-programming"); } };
  await assert.rejects(
    handlePii(broken, { text: "k" }, fakePiiCtx([span("api_key", "k")])),
    /boom-programming/,
  );
});

await check("judgePiiSpans unit: timeout tambien degrada honesto (BackendUnavailableError)", async () => {
  const slow = {
    predict: async () => {
      throw new BackendUnavailableError("laya-server /predict timed out after 8000ms", "timeout");
    },
  };
  const out = await judgePiiSpans(slow, "k", [span("api_key", "k")]);
  assert.deepEqual(out.signals, [null]);
  assert.equal(out.judged, false);
  assert.match(out.note, /timed out/);
  assert.equal(out.latencyMs, 0);
});

await check("pii risk invalido se rechaza con vocabulario", async () => {
  await assert.rejects(
    handlePii(judgeClient({}), { text: "hi", risk: "extreme" }, fakePiiCtx([])),
    /laya_pii: risk must be one of/,
  );
});

// ------------------------------------------------------------- risk gates ---
function gateEv(safe, claimValues, risk, refutes = []) {
  const { evidence } = E.gateEvidence(RAW, {
    correctness: 2,
    spec_match: 2,
    safe_to_apply: safe,
    // T3: refute entries are optional -- absent means legacy support-only
    // evidence (contradicted unreachable: absence != refutation); explicit
    // values (incl. null) emit refute_N signals.
    claims: claimValues.map((signal, i) => ({
      claim: `c${i}`,
      signal,
      verdict: "legacy",
      ...(i < refutes.length ? { refute: refutes[i] } : {}),
    })),
  });
  // Abstencion limpiada a proposito: el T2 mueve bandas, no la regla global
  // (la precedencia se pinea aparte abajo).
  return evaluate(
    { evidence, abstention: noAbs(), risk, policy: { name: "gate", version: "1.0.0" } },
    { thresholds: T1 },
  );
}

await check("risk mueve gate: safe 0.87 ALLOW en low/normal, REVIEW en high", () => {
  assert.deepEqual(gateEv(0.87, [0.9], "low").reason_codes, ["gate_auto_allow"]);
  assert.deepEqual(gateEv(0.87, [0.9], "normal").reason_codes, ["gate_auto_allow"]);
  assert.deepEqual(gateEv(0.87, [0.9], "high").reason_codes, ["gate_review"]);
});

await check("risk mueve gate: safe 0.83 ALLOW solo en low", () => {
  assert.deepEqual(gateEv(0.83, [0.9], "low").reason_codes, ["gate_auto_allow"]);
  assert.deepEqual(gateEv(0.83, [0.9], "normal").reason_codes, ["gate_review"]);
  assert.deepEqual(gateEv(0.83, [0.9], "high").reason_codes, ["gate_review"]);
});

await check("gate fixed points: contradicted/missing no se mueven con risk", () => {
  // T3: contradicted necesita refutacion positiva (probe firme + soporte
  // debil); el soporte bajo solo ya no contradice (absence != refutation).
  assert.deepEqual(gateEv(0.95, [0.2], "high", [0.9]).reason_codes, ["gate_contradicted_escalate"]);
  assert.deepEqual(gateEv(0.95, [0.2], "low", [0.9]).reason_codes, ["gate_contradicted_escalate"]);
  assert.deepEqual(gateEv(0.95, [null], "high").reason_codes, ["gate_missing_signal"]);
  assert.deepEqual(gateEv(0.2, [0.9], "low").reason_codes, ["gate_review"]);
});

function screenEv(injection, substance, risk) {
  const { evidence } = E.screenEvidence(RAW, { injection, substance, relevance: 0.9, missing: [] });
  return evaluate(
    { evidence, abstention: noAbs(), risk, policy: { name: "screen", version: "1.0.0" } },
    { thresholds: T1 },
  );
}

await check("risk mueve screen: inyeccion 0.72 DENY en high, REVIEW en normal/low", () => {
  assert.deepEqual(screenEv(0.72, 0.9, "high").reason_codes, ["screen_injection_block"]);
  assert.deepEqual(screenEv(0.72, 0.9, "normal").reason_codes, ["screen_injection_review"]);
  assert.deepEqual(screenEv(0.72, 0.9, "low").reason_codes, ["screen_injection_review"]);
});

await check("risk mueve screen: inyeccion 0.22 REVIEW solo en high", () => {
  assert.deepEqual(screenEv(0.22, 0.9, "high").reason_codes, ["screen_injection_review"]);
  assert.deepEqual(screenEv(0.22, 0.9, "normal").reason_codes, ["screen_pass"]);
  assert.deepEqual(screenEv(0.22, 0.9, "low").reason_codes, ["screen_pass"]);
});

await check("screen fixed points: substance y missing no se mueven con risk", () => {
  for (const risk of ["low", "normal", "high"]) {
    assert.deepEqual(screenEv(0.1, 0.39, risk).reason_codes, ["screen_skip_low_substance"]);
    assert.deepEqual(screenEv(0.1, 0.9, risk).reason_codes, ["screen_pass"]);
  }
  const { evidence } = E.screenEvidence(RAW, { injection: null, substance: 0.9, relevance: 0.9, missing: ["is_injection"] });
  for (const risk of ["low", "normal", "high"]) {
    assert.deepEqual(
      evaluate({ evidence, abstention: noAbs(), risk, policy: { name: "screen", version: "1.0.0" } }, { thresholds: T1 }).reason_codes,
      ["screen_missing_signal"],
    );
  }
});

function piiEv(findings, weakTypes, risk, abstention) {
  const { evidence, abstention: real } = E.piiEvidence({ findings, weakTypes });
  return evaluate(
    { evidence, abstention: abstention ?? real, risk, policy: { name: "pii", version: "1.0.0" } },
    { thresholds: T1 },
  );
}
const firm = (type) => ({ text: `x-${type}`, start: 0, end: 5, type, detectorScore: 0.9, weak_type: false });

await check("risk mueve pii: no-secreto firme REVIEW/DENY/ALLOW segun tier", () => {
  assert.deepEqual(piiEv([firm("email")], [], "normal").reason_codes, ["pii_findings_review"]);
  assert.deepEqual(piiEv([firm("email")], [], "high").reason_codes, ["pii_high_risk_deny"]);
  assert.deepEqual(piiEv([firm("email")], [], "low").reason_codes, ["pii_low_risk_allow"]);
  assert.equal(piiEv([firm("email")], [], "high").decision, "DENY");
  assert.equal(piiEv([firm("email")], [], "low").decision, "ALLOW");
});

await check("pii fixed points: secreto DENY y clean ALLOW en todo risk", () => {
  for (const risk of ["low", "normal", "high"]) {
    assert.deepEqual(piiEv([firm("api_key")], [], risk).reason_codes, ["pii_secret_block"]);
    assert.deepEqual(piiEv([], [], risk).reason_codes, ["pii_clean_allow"]);
  }
});

await check("risk nunca rescata abstencion: ESCALATE abstained en gate/screen/pii con high", () => {
  // T3: el caso gate usa una senal REALMENTE ausente (safe null). La banda
  // media (safe 0.7) ya no abstiene desde T3 -- es evidencia REVIEW firme,
  // no ambiguedad -- asi que no serviria para pinear la precedencia global.
  const g = E.gateEvidence(RAW, { correctness: 2, spec_match: 2, safe_to_apply: null, claims: [] });
  assert.equal(g.abstention.abstained, true);
  assert.deepEqual(
    evaluate({ evidence: g.evidence, abstention: g.abstention, risk: "high", policy: { name: "gate", version: "1.0.0" } }, { thresholds: T1 }).reason_codes,
    ["abstained_evidence"],
  );
  const s = E.screenEvidence(RAW, { injection: 0.99, substance: null, relevance: null, missing: ["has_substance"] });
  assert.deepEqual(
    evaluate({ evidence: s.evidence, abstention: s.abstention, risk: "high", policy: { name: "screen", version: "1.0.0" } }, { thresholds: T1 }).reason_codes,
    ["abstained_evidence"],
  );
  const p = E.piiEvidence({ findings: [{ ...firm("email"), weak_type: true }], weakTypes: ["email"] });
  assert.equal(p.abstention.abstained, true);
  assert.deepEqual(
    evaluate({ evidence: p.evidence, abstention: p.abstention, risk: "high", policy: { name: "pii", version: "1.0.0" } }, { thresholds: T1 }).reason_codes,
    ["abstained_evidence"],
  );
});

await check("riskCutDelta unit + resto de policies ignoran risk", () => {
  assert.equal(RISK_CUT_DELTA, 0.05);
  assert.equal(riskCutDelta("high"), 0.05);
  assert.equal(riskCutDelta("low"), -0.05);
  assert.equal(riskCutDelta("normal"), 0);
  assert.equal(riskCutDelta(undefined), 0);
  assert.equal(riskCutDelta("extreme"), 0);
  const review = (safe, risk) => {
    const { evidence, abstention } = E.reviewEvidence(RAW, { correctness: 2, spec_match: 2, test_gap: 0, blast_radius: 0, safe_to_apply: safe });
    return evaluate({ evidence, abstention, risk, policy: { name: "review", version: "1.0.0" } }, { thresholds: T1 });
  };
  for (const risk of ["low", "normal", "high"]) {
    assert.deepEqual(review(0.86, risk).reason_codes, ["review_auto_allow"], `review ignora ${risk}`);
  }
  const verify = (risk) =>
    evaluate(
      {
        evidence: E.makeEvidence(RAW, [E.noulSignal(RAW, "claim_0", 0.95, { candidate: "c" })], "router"),
        abstention: noAbs(),
        risk,
        policy: { name: "verify", version: "1.0.0" },
      },
      { thresholds: T1 },
    );
  for (const risk of ["low", "normal", "high"]) {
    assert.deepEqual(verify(risk).reason_codes, ["verify_all_verified"], `verify ignora ${risk}`);
  }
  const find = (risk) => {
    const { evidence, abstention } = E.findEvidence(RAW, { choice: "a", distribution: { a: 0.7, b: 0.2, none: 0.1 }, candidateCount: 2 });
    return evaluate({ evidence, abstention, risk, policy: { name: "find", version: "1.0.0" } }, { thresholds: T1 });
  };
  for (const risk of ["low", "normal", "high"]) {
    assert.deepEqual(find(risk).reason_codes, ["find_winner_allow"], `find ignora ${risk}`);
  }
});

// ---------------------------------------------------------- tool-level -----
await check("tool screen: risk high estrecha el corte (0.72 DENY) y default REVIEW", async () => {
  const args = { text: "hello world", purpose: "test" };
  const def = JSON.parse(
    await handleScreen({ predict: async () => ({ answers: screenAnswers({ injection: 0.72 }), confidence: {}, routing: {}, model: "t", latencyMs: 1, usage: {} }) }, args),
  );
  assert.deepEqual(def.decision.reason_codes, ["screen_injection_review"]);
  const hi = JSON.parse(
    await handleScreen({ predict: async () => ({ answers: screenAnswers({ injection: 0.72 }), confidence: {}, routing: {}, model: "t", latencyMs: 1, usage: {} }) }, { ...args, risk: "high" }),
  );
  assert.deepEqual(hi.decision.reason_codes, ["screen_injection_block"]);
  assert.equal(hi.decision.decision, "DENY");
});

await check("tool screen: risk invalido se rechaza", async () => {
  const client = { predict: async () => ({ answers: screenAnswers(), confidence: {}, routing: {}, model: "t", latencyMs: 1, usage: {} }) };
  await assert.rejects(
    handleScreen(client, { text: "hi", purpose: "t", risk: "extreme" }),
    /laya_screen: risk must be one of/,
  );
});

await check("tool pii: secreto DENY en todo risk; weak-only ESCALATE precede a risk high", async () => {
  const secret = JSON.parse(
    await handlePii(judgeClient({ 0: 0.9 }), { text: "k", risk: "high" }, fakePiiCtx([span("api_key", "k")])),
  );
  assert.deepEqual(secret.decision.reason_codes, ["pii_secret_block"]);
  // Weak-only abstiene antes de la policy: risk high no lo rescata ni lo endurece.
  const weak = JSON.parse(
    await handlePii(judgeClient({ 0: 0.9 }), { text: "a@b.c", risk: "high" }, fakePiiCtx([span("email", "a@b.c")])),
  );
  assert.equal(weak.abstention.abstained, true);
  assert.deepEqual(weak.decision.reason_codes, ["abstained_evidence"]);
  assert.equal(weak.findings[0].laya_signal, 0.9, "el judge informa aunque la policy no corra");
});

console.log(`\nT2 pii-judge + risk: ${passed} checks passed (no server, no LLM involved).`);
