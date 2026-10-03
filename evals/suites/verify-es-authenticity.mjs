/**
 * Doubt-gate-es T1 eval suite: verify-es-authenticity (laya_verify).
 *
 * Article reference (JEV-vs-Laya, weak slice: autenticidad ES): short ES
 * review-style claims in the article's style. Exaggerated reviews whose
 * claims are VERIFIABLE against the evidence (room counts, pool size,
 * opening month) versus subjective superlatives the evidence cannot settle
 * ("el mejor hotel del mundo") and claims the evidence is silent about.
 *
 * DOUBT REFERENCE (article bands, documentation ONLY -- no logic here reads
 * them; calibration is T2/T3's job): below ~80% model confidence the article
 * observes doubt (escalate/review territory); at >=90% it observes
 * overconfidence (~49% hit). Each case carries a `doubt` marker
 * (dudoso=true / no-dudoso=false) plus a `doubtNote` so T2 can slice
 * pass-rate and confidence distributions by it.
 *
 * STUB MODEL: same convention as evals/suites/verify.mjs -- each stub noul
 * emulates the per-claim support AND refutation signals a real backend would
 * plausibly return against the evidence text: a claim stated verbatim gets
 * support ~0.9 with weak refutation, an edge paraphrase gets exactly the 0.80
 * cut, a partial/silent claim gets low-mid support, a contradicted
 * exaggerated claim gets firm refutation + weak support, a dropped answer is
 * `{}` (missing, not zero). Contradictory pairs score independently high
 * (no cross-claim check), which pins the overconfidence-relevant behavior.
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Signals are
 * oracle-assigned, not measured: no claim about real support calibration or
 * real review-authenticity detection transfers. Low support without firm
 * refutation is absence of evidence (never CONTRADICTED).
 */
import assert from "node:assert";
import { handleVerify } from "../../dist/tools/verify.js";

export const name = "verify-es-authenticity";
export const primitive = "laya_verify";
export const stubModel =
  "Per-claim noul: verbatim ~0.9, edge paraphrase exactly 0.80, subjective/silent " +
  "claims low-mid, exaggerated refuted claims firm refutation + weak support, " +
  "dropped answer {}; contradictory pairs score independently high.";
export const stubLimits =
  "Signals are oracle-assigned: no support-calibration or review-authenticity " +
  "claim transfers to the real backend.";

const EV_HOTEL = "El Hotel Miramar tiene 120 habitaciones, piscina climatizada de 12 metros y abre sus puertas en junio.";

export const cases = [
  {
    id: "vaut-es-01",
    kind: "normal",
    doubt: false,
    doubtNote: "no-dudoso: afirmacion literal de la evidencia; soporte alto y claro.",
    input: { claims: ["el hotel tiene piscina climatizada"], evidence: EV_HOTEL },
    oracle: "claim stated verbatim by the evidence; backend plausibly returns high support.",
    stub: { answers: { claim_0: { noul: 0.9 }, refute_0: { noul: 0.1 } } },
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "verbatim support clears the 0.80 verified cut." },
  },
  {
    id: "vaut-es-02",
    kind: "negative",
    doubt: false,
    doubtNote: "no-dudoso: exageracion refutable con numero concreto (500 frente a 120); refutacion firme.",
    input: { claims: ["el hotel tiene mas de 500 habitaciones, es gigante"], evidence: EV_HOTEL },
    oracle: "exaggerated room count contradicted by the evidence figure; backend plausibly returns firm refutation.",
    stub: { answers: { claim_0: { noul: 0.15 }, refute_0: { noul: 0.9 } } },
    gold: { verdict: "CONTRADICTED", decision: "DENY", abstained: false, why: "firm refutation with weak support contradicts the exaggerated claim (verify_contradicted_deny)." },
  },
  {
    id: "vaut-es-03",
    kind: "ambiguous",
    doubt: true,
    doubtNote: "dudoso: superlativo subjetivo que la evidencia no puede confirmar ni refutar; ausencia de evidencia.",
    input: { claims: ["es el mejor hotel del mundo, sin comparacion"], evidence: EV_HOTEL },
    oracle: "subjective superlative the evidence can neither confirm nor deny; backend plausibly returns low-mid support.",
    stub: { answers: { claim_0: { noul: 0.35 }, refute_0: { noul: 0.15 } } },
    gold: { verdict: "INSUFFICIENT_EVIDENCE", decision: "REVIEW", abstained: false, why: "low-mid support without firm refutation REVIEWs; absence is never refutation." },
  },
  {
    id: "vaut-es-04",
    kind: "ambiguous",
    doubt: true,
    doubtNote: "dudoso: afirmacion sobre la que la evidencia guarda silencio (vistas); no es negacion.",
    input: { claims: ["todas las habitaciones tienen vista al mar"], evidence: EV_HOTEL },
    oracle: "claim unaddressed by the evidence; backend plausibly returns low support.",
    stub: { answers: { claim_0: { noul: 0.25 }, refute_0: { noul: 0.1 } } },
    gold: { verdict: "INSUFFICIENT_EVIDENCE", decision: "REVIEW", abstained: false, why: "low support with weak refutation is insufficient evidence (silence is not denial), never a contradiction label." },
  },
  {
    id: "vaut-es-05",
    kind: "difficult",
    doubt: true,
    doubtNote: "dudoso: parafrasis justo en el corte 0.80; caso borde calibracion-relevante.",
    input: { claims: ["el hotel abre en junio"], evidence: EV_HOTEL },
    oracle: "edge paraphrase support landing exactly on the shared cut.",
    stub: { answers: { claim_0: { noul: 0.8 }, refute_0: { noul: 0.1 } } },
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "0.80 is the inclusive verified edge (>= cut)." },
  },
  {
    id: "vaut-es-06",
    kind: "adversarial",
    doubt: true,
    doubtNote: "dudoso: resenas contradictorias que puntuan alto por separado, sin chequeo cruzado; relevante para sobreconfianza.",
    input: { claims: ["el hotel abre en junio", "el hotel abre en diciembre"], evidence: EV_HOTEL },
    oracle: "mutually exclusive review claims each scored alone against the evidence; both clear the cut.",
    stub: { answers: { claim_0: { noul: 0.95 }, claim_1: { noul: 0.92 }, refute_0: { noul: 0.1 }, refute_1: { noul: 0.1 } } },
    gold: { verdicts: ["SUPPORTED", "SUPPORTED"], decision: "ALLOW", abstained: false, why: "no cross-claim contradiction check and no firm denial per claim; both stay supported." },
  },
  {
    id: "vaut-es-07",
    kind: "negative",
    doubt: false,
    doubtNote: "no-dudoso: medida exagerada refutada por la evidencia (50m frente a 12m); refutacion firme.",
    input: { claims: ["la piscina olimpica de 50 metros es excelente"], evidence: EV_HOTEL },
    oracle: "exaggerated pool size contradicted by the stated 12 metres; backend plausibly returns firm refutation.",
    stub: { answers: { claim_0: { noul: 0.2 }, refute_0: { noul: 0.88 } } },
    gold: { verdict: "CONTRADICTED", decision: "DENY", abstained: false, why: "firm refutation with weak support contradicts the exaggerated measure (verify_contradicted_deny)." },
  },
  {
    id: "vaut-es-08",
    kind: "abstention",
    doubt: true,
    doubtNote: "dudoso: silencio del backend sobre la unica afirmacion; la abstencion es el comportamiento esperado.",
    input: { claims: ["el hotel tiene piscina climatizada"], evidence: EV_HOTEL },
    oracle: "backend silence on the only claim; null coerces to the low-signal band.",
    stub: { answers: {} },
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "missing signal abstains; the null verdict never becomes a label." },
  },
  {
    id: "vaut-es-09",
    kind: "negative",
    doubt: false,
    doubtNote: "no-dudoso: caso limite de tamano, no un juicio de duda; falla rapido.",
    input: { claims: ["el hotel tiene piscina climatizada"], evidence: "e".repeat(20001) },
    oracle: "evidence over the 20,000-char state cap; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "oversized evidence fails fast instead of truncating silently." },
  },
];

export async function invoke(deps, input, stub, capture) {
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleVerify(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  if (gold.verdict !== undefined) {
    assert.equal(body.verdicts[0].verdict, gold.verdict, "verdict");
  }
  if (gold.verdicts !== undefined) {
    assert.deepEqual(body.verdicts.map((v) => v.verdict), gold.verdicts, "verdicts");
  }
  return { decision: body.decision.decision, verdicts: body.verdicts.map((v) => v.verdict) };
}
