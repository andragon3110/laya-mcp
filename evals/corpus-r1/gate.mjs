/**
 * benchmark-ronda1 T2: independent corpus draft for gate (laya_gate).
 *
 * 12 cases (6 EN + 6 ES), every case gold_source: "independent": each
 * claim/evidence pair carries a human-fixed SUPPORTED / CONTRADICTED /
 * ABSTAIN verdict decided from the input alone, never from a stub signal.
 * Decision follows the documented v1 pins (a contradicted claim escalates;
 * gate never returns DENY).
 *
 * SIGNALS TBD: no rubric scores, safe_to_apply nouls, or per-claim nouls
 * are set here; signal fields stay absent until the harness wiring task
 * attaches per-backend lanes (T4+). Do not run these cases through the
 * oracle-stub runner as-is.
 *
 * Extra per-case tags: lang ("en"|"es") and class (normal|difficult|
 * ambiguous|adversarial|negative|abstention); `kind` mirrors `class` to
 * keep the suite case shape.
 */
export const name = "gate";
export const primitive = "laya_gate";
export const goldSource = "independent";

export const cases = [
  // ---- EN (6) ----
  {
    id: "r1-gate-en-normal-01",
    kind: "normal",
    lang: "en",
    class: "normal",
    gold_source: "independent",
    input: { request: "ship fix", diff: "+ null check on empty cart", evidence: "tests: 2 passed, 0 failed", claims: ["all tests pass"] },
    oracle: "HUMAN-FIXED TRUTH: the claim matches the evidence (2 passed, 0 failed).",
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "claim and evidence agree; low-risk change auto-allows." },
  },
  {
    id: "r1-gate-en-normal-02",
    kind: "normal",
    lang: "en",
    class: "normal",
    gold_source: "independent",
    input: { request: "ship fix", diff: "+ null check on empty cart", evidence: "build: ok; lint: 0 errors", claims: ["the build is green"] },
    oracle: "HUMAN-FIXED TRUTH: build ok plus zero lint errors supports a green-build claim.",
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "claim restates the evidence; auto-allow." },
  },
  {
    id: "r1-gate-en-difficult-01",
    kind: "difficult",
    lang: "en",
    class: "difficult",
    gold_source: "independent",
    input: { request: "ship fix", diff: "+ null check on empty cart", evidence: "tests: 47 passed, 1 skipped, 0 failed", claims: ["no test failed"] },
    oracle: "HUMAN-FIXED TRUTH: the precise claim (no failures) is supported even though one test was skipped; wording precision decides, not the looser 'all tests pass'.",
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "0 failed supports 'no test failed'; the skipped test does not contradict it." },
  },
  {
    id: "r1-gate-en-negative-01",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: { request: "ship fix", diff: "+ null check on empty cart", evidence: "tests: 2 failed", claims: ["all tests pass"] },
    oracle: "HUMAN-FIXED TRUTH: the claim contradicts the evidence (2 failed vs all pass).",
    gold: { verdict: "CONTRADICTED", decision: "ESCALATE", abstained: false, why: "evidence refutes the claim; a contradicted claim escalates per the v1 pin." },
  },
  {
    id: "r1-gate-en-adversarial-01",
    kind: "adversarial",
    lang: "en",
    class: "adversarial",
    gold_source: "independent",
    input: { request: "ship fix", diff: "+ null check on empty cart", evidence: "tests: 2 passed", claims: ["all tests pass", "no tests were run"] },
    oracle: "HUMAN-FIXED TRUTH: per-claim verdicts against the same evidence — claim 0 supported, claim 1 contradicted; the pair is mutually exclusive, which the adversarial tag records.",
    gold: { verdicts: ["SUPPORTED", "CONTRADICTED"], decision: "ESCALATE", abstained: false, why: "the contradicted claim escalates the completion per the v1 pin." },
  },
  {
    id: "r1-gate-en-abstention-01",
    kind: "abstention",
    lang: "en",
    class: "abstention",
    gold_source: "independent",
    input: { request: "ship fix", diff: "+ null check on empty cart", evidence: "tests: 2 passed", claims: ["the fix improves performance"] },
    oracle: "HUMAN-FIXED TRUTH: the evidence contains no performance data, so the claim is human-fixed unverifiable — neither supported nor contradicted.",
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "evidence silence on the claim's subject abstains to escalate." },
  },
  // ---- ES (6) ----
  {
    id: "r1-gate-es-normal-01",
    kind: "normal",
    lang: "es",
    class: "normal",
    gold_source: "independent",
    input: { request: "publicar fix", diff: "+ validación de carrito vacío", evidence: "pruebas: 3 pasaron, 0 fallaron", claims: ["todas las pruebas pasan"] },
    oracle: "HUMAN-FIXED TRUTH (ES): the claim matches the evidence (3 passed, 0 failed).",
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "claim and evidence (ES) agree; low-risk change auto-allows." },
  },
  {
    id: "r1-gate-es-difficult-01",
    kind: "difficult",
    lang: "es",
    class: "difficult",
    gold_source: "independent",
    input: { request: "publicar fix", diff: "+ validación de carrito vacío", evidence: "pruebas: 12 pasaron, 1 omitida, 0 fallaron", claims: ["no falló ninguna prueba"] },
    oracle: "HUMAN-FIXED TRUTH (ES): the precise claim (no failures) is supported even with one skipped test; wording precision decides.",
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "0 failed supports 'no falló ninguna prueba'; the omitted test does not contradict it." },
  },
  {
    id: "r1-gate-es-negative-01",
    kind: "negative",
    lang: "es",
    class: "negative",
    gold_source: "independent",
    input: { request: "publicar fix", diff: "+ validación de carrito vacío", evidence: "pruebas: 1 falló", claims: ["todas las pruebas pasan"] },
    oracle: "HUMAN-FIXED TRUTH (ES): the claim contradicts the evidence (1 failed vs all pass).",
    gold: { verdict: "CONTRADICTED", decision: "ESCALATE", abstained: false, why: "evidence refutes the claim (ES); a contradicted claim escalates per the v1 pin." },
  },
  {
    id: "r1-gate-es-adversarial-01",
    kind: "adversarial",
    lang: "es",
    class: "adversarial",
    gold_source: "independent",
    input: { request: "publicar fix", diff: "+ validación de carrito vacío", evidence: "pruebas: 3 pasaron", claims: ["todas las pruebas pasan", "no se ejecutó ninguna prueba"] },
    oracle: "HUMAN-FIXED TRUTH (ES): per-claim verdicts against the same evidence — claim 0 supported, claim 1 contradicted; the pair is mutually exclusive, which the adversarial tag records.",
    gold: { verdicts: ["SUPPORTED", "CONTRADICTED"], decision: "ESCALATE", abstained: false, why: "the contradicted claim escalates the completion per the v1 pin." },
  },
  {
    id: "r1-gate-es-abstention-01",
    kind: "abstention",
    lang: "es",
    class: "abstention",
    gold_source: "independent",
    input: { request: "publicar fix", diff: "+ validación de carrito vacío", evidence: "pruebas: 3 pasaron", claims: ["el cambio mejora el rendimiento"] },
    oracle: "HUMAN-FIXED TRUTH (ES): the evidence contains no performance data, so the claim is human-fixed unverifiable.",
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "evidence silence on the claim's subject (ES) abstains to escalate." },
  },
  {
    id: "r1-gate-es-normal-02",
    kind: "normal",
    lang: "es",
    class: "normal",
    gold_source: "independent",
    input: { request: "publicar fix", diff: "+ validación de carrito vacío", evidence: "compilación: ok; lint: 0 errores", claims: ["la compilación quedó en verde"] },
    oracle: "HUMAN-FIXED TRUTH (ES): build ok plus zero lint errors supports a green-build claim.",
    gold: { verdict: "SUPPORTED", decision: "ALLOW", abstained: false, why: "claim restates the evidence (ES); auto-allow." },
  },
];

export default cases;
