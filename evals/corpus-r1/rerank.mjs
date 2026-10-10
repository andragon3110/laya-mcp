/**
 * benchmark-ronda1 T2: independent corpus draft for rerank (laya_rerank).
 *
 * 12 cases (6 EN + 6 ES), every case gold_source: "independent": the gold
 * order was fixed by a human judging (query, candidate) relevance from the
 * input alone, never derived from a stub signal. Three cases have a
 * Spanish candidate as the correct top answer (r1-rerank-es-normal-01,
 * r1-rerank-es-adversarial-01, r1-rerank-es-cross-01).
 *
 * SIGNALS TBD: no relevance_score values are set here; signal fields stay
 * absent until the harness wiring task attaches per-backend lanes (T4+).
 * Do not run these cases through the oracle-stub runner as-is.
 *
 * Extra per-case tags: lang ("en"|"es") and class (normal|difficult|
 * ambiguous|adversarial|negative|abstention); `kind` mirrors `class` to
 * keep the suite case shape. `lang` tags the language of the content that
 * carries the gold decision (r1-rerank-es-cross-01 has an English query
 * whose correct answer is the Spanish candidate).
 */
export const name = "rerank";
export const primitive = "laya_rerank";
export const goldSource = "independent";

export const cases = [
  // ---- EN (6) ----
  {
    id: "r1-rerank-en-normal-01",
    kind: "normal",
    lang: "en",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "how do I reset my password",
      candidates: [
        { id: "a", text: "Open Settings, click Reset password, and follow the emailed link to choose a new one." },
        { id: "b", text: "Zebra migration notes for the spring season." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: candidate a answers the query directly; b is topically unrelated.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "clear human-fixed relevance gap orders a first." },
  },
  {
    id: "r1-rerank-en-normal-02",
    kind: "normal",
    lang: "en",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "quarterly revenue growth",
      candidates: [
        { id: "a", text: "Quarterly revenue grew 5% on cloud sales." },
        { id: "b", text: "The cafeteria menu changes on Fridays." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: candidate a is on-topic; b is unrelated.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "clear human-fixed relevance gap orders a first." },
  },
  {
    id: "r1-rerank-en-difficult-01",
    kind: "difficult",
    lang: "en",
    class: "difficult",
    gold_source: "independent",
    input: {
      query: "slow database queries",
      candidates: [
        { id: "a", text: "Guide to tuning indexes for faster queries." },
        { id: "b", text: "Nightly backup schedule for the database." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: both candidates are database-adjacent, but only a addresses query speed.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "topical adjacency resolved by a human: index tuning answers slow queries." },
  },
  {
    id: "r1-rerank-en-ambiguous-01",
    kind: "ambiguous",
    lang: "en",
    class: "ambiguous",
    gold_source: "independent",
    input: {
      query: "onboarding doc",
      candidates: [
        { id: "a", text: "New hires start with the onboarding checklist." },
        { id: "b", text: "New hires start with the onboarding checklist." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: identical bodies are exactly equally relevant; the v1 pin resolves exact ties to input order without abstaining.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "equal relevance keeps input order per the documented tie pin." },
  },
  {
    id: "r1-rerank-en-adversarial-01",
    kind: "adversarial",
    lang: "en",
    class: "adversarial",
    gold_source: "independent",
    input: {
      query: "apple pie recipe",
      candidates: [
        { id: "a", text: "apple apple apple pie pie recipe recipe" },
        { id: "b", text: "Step-by-step apple pie recipe with ingredients and baking times." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: keyword stuffing maximizes lexical overlap but carries no answer; b is the semantically relevant candidate.",
    gold: { order: ["b", "a"], decision: "ALLOW", abstained: false, why: "human-fixed semantic relevance beats lexical stuffing." },
  },
  {
    id: "r1-rerank-en-negative-01",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: {
      query: "quantum entanglement lecture notes",
      candidates: [
        { id: "a", text: "Open Settings, click Reset password, and follow the emailed link." },
        { id: "b", text: "Zebra migration notes for the spring season." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (flagged for review): neither candidate is relevant, so relevance is exactly tied at irrelevant; the v1 tie pin keeps input order and does not abstain.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "tie-by-equal-irrelevance keeps input order; flagged for human sign-off." },
  },
  // ---- ES (6) ----
  {
    id: "r1-rerank-es-normal-01",
    kind: "normal",
    lang: "es",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "¿cómo restablezco mi contraseña?",
      candidates: [
        { id: "a", text: "Abre Configuración, pulsa Restablecer contraseña y sigue el enlace que recibes por correo." },
        { id: "b", text: "Notas sobre la migración de las cebras en primavera." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): candidate a answers the query directly; b is topically unrelated. Spanish candidate is the correct top answer.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "clear human-fixed relevance gap (ES) orders a first." },
  },
  {
    id: "r1-rerank-es-normal-02",
    kind: "normal",
    lang: "es",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "facturación del último trimestre",
      candidates: [
        { id: "a", text: "La facturación creció un 5 % impulsada por las ventas en la nube." },
        { id: "b", text: "El menú del comedor cambia los viernes." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): candidate a is on-topic; b is unrelated.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "clear human-fixed relevance gap (ES) orders a first." },
  },
  {
    id: "r1-rerank-es-difficult-01",
    kind: "difficult",
    lang: "es",
    class: "difficult",
    gold_source: "independent",
    input: {
      query: "consultas lentas en la base de datos",
      candidates: [
        { id: "a", text: "Guía para ajustar índices y acelerar las consultas." },
        { id: "b", text: "Calendario de copias de seguridad nocturnas de la base de datos." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): both candidates are database-adjacent, but only a addresses query speed.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "topical adjacency resolved by a human (ES): index tuning answers slow queries." },
  },
  {
    id: "r1-rerank-es-adversarial-01",
    kind: "adversarial",
    lang: "es",
    class: "adversarial",
    gold_source: "independent",
    input: {
      query: "receta de tarta de manzana",
      candidates: [
        { id: "a", text: "manzana manzana manzana tarta tarta receta receta" },
        { id: "b", text: "Receta paso a paso de tarta de manzana con ingredientes y tiempos de horneado." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): keyword stuffing maximizes lexical overlap but carries no answer; b is the semantically relevant candidate. Spanish candidate is the correct top answer.",
    gold: { order: ["b", "a"], decision: "ALLOW", abstained: false, why: "human-fixed semantic relevance (ES) beats lexical stuffing." },
  },
  {
    id: "r1-rerank-es-ambiguous-01",
    kind: "ambiguous",
    lang: "es",
    class: "ambiguous",
    gold_source: "independent",
    input: {
      query: "documento de incorporación",
      candidates: [
        { id: "a", text: "Las personas nuevas empiezan con la lista de incorporación." },
        { id: "b", text: "Las personas nuevas empiezan con la lista de incorporación." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): identical bodies are exactly equally relevant; the v1 pin resolves exact ties to input order without abstaining.",
    gold: { order: ["a", "b"], decision: "ALLOW", abstained: false, why: "equal relevance (ES) keeps input order per the documented tie pin." },
  },
  {
    id: "r1-rerank-es-cross-01",
    kind: "normal",
    lang: "es",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "how do I change my email address",
      candidates: [
        { id: "a", text: "Quarterly revenue grew 5% on cloud sales." },
        { id: "b", text: "Abre Configuración, selecciona Cuenta y pulsa Cambiar correo electrónico." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (cross-lingual): English query, but only the Spanish candidate b answers it; a is unrelated. Spanish candidate is the correct top answer.",
    gold: { order: ["b", "a"], decision: "ALLOW", abstained: false, why: "human-fixed cross-lingual relevance: the Spanish answer outranks the unrelated English text." },
  },
];

export default cases;
