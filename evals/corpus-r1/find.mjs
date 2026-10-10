/**
 * benchmark-ronda1 T2: independent corpus draft for find (laya_find).
 *
 * 12 cases (6 EN + 6 ES), every case gold_source: "independent": the gold
 * winner/exists truth was fixed by a human judging (query, candidate)
 * answers from the input alone, never derived from a stub signal. Two
 * cases have a Spanish candidate as the correct answer
 * (r1-find-es-normal-01, r1-find-es-cross-01).
 *
 * SIGNALS TBD: no exists-choice probabilities are set here; signal fields
 * stay absent until the harness wiring task attaches per-backend lanes
 * (T4+). Do not run these cases through the oracle-stub runner as-is.
 *
 * Extra per-case tags: lang ("en"|"es") and class (normal|difficult|
 * ambiguous|adversarial|negative|abstention); `kind` mirrors `class` to
 * keep the suite case shape. `lang` tags the language of the content that
 * carries the gold decision (r1-find-es-cross-01 has an English query
 * whose correct answer is the Spanish candidate).
 */
export const name = "find";
export const primitive = "laya_find";
export const goldSource = "independent";

export const cases = [
  // ---- EN (6) ----
  {
    id: "r1-find-en-normal-01",
    kind: "normal",
    lang: "en",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "which database supports daily backups",
      candidates: [
        { id: "a", text: "Postgres supports daily backups natively." },
        { id: "b", text: "SQLite stores everything in a single local file." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: candidate a answers the query directly; b does not mention backups.",
    gold: { winner: "a", exists: true, decision: "ALLOW", abstained: false, why: "unique answering candidate wins on human-fixed truth." },
  },
  {
    id: "r1-find-en-difficult-01",
    kind: "difficult",
    lang: "en",
    class: "difficult",
    gold_source: "independent",
    input: {
      query: "how do I enable dark mode",
      candidates: [
        { id: "a", text: "Dark mode can be toggled under Settings > Appearance." },
        { id: "b", text: "The settings page was redesigned last year." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: both candidates touch settings, but only a answers the how-to question.",
    gold: { winner: "a", exists: true, decision: "ALLOW", abstained: false, why: "topically adjacent non-answer must not beat the real answer." },
  },
  {
    id: "r1-find-en-ambiguous-01",
    kind: "ambiguous",
    lang: "en",
    class: "ambiguous",
    gold_source: "independent",
    input: {
      query: "when do backups run",
      candidates: [
        { id: "a", text: "Backups run nightly at 02:00." },
        { id: "b", text: "Backups run nightly at 02:00." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: identical answers are exactly tied; the v1 pin abstains on exact ties while keeping the winner value unusable.",
    gold: { winner: "a", decision: "ESCALATE", abstained: true, why: "human-fixed exact tie abstains per the documented tie pin." },
  },
  {
    id: "r1-find-en-negative-01",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: {
      query: "quantum recipe",
      candidates: [
        { id: "a", text: "Postgres supports daily backups natively." },
        { id: "b", text: "SQLite stores everything in a single local file." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: no candidate answers the query; the honest outcome is none.",
    gold: { winner: "none", exists: false, decision: "ESCALATE", abstained: true, why: "no answering candidate abstains instead of forcing a winner." },
  },
  {
    id: "r1-find-en-adversarial-01",
    kind: "adversarial",
    lang: "en",
    class: "adversarial",
    gold_source: "independent",
    input: {
      query: "which database supports daily backups",
      candidates: [
        { id: "a", text: "backups backups database backups daily" },
        { id: "b", text: "Postgres supports daily backups via pg_dump." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH: the keyword-stuffed candidate a is not an answer; b is the real answer.",
    gold: { winner: "b", exists: true, decision: "ALLOW", abstained: false, why: "human-fixed semantic answer beats lexical stuffing." },
  },
  {
    id: "r1-find-en-abstention-01",
    kind: "abstention",
    lang: "en",
    class: "abstention",
    gold_source: "independent",
    input: {
      query: "which database supports daily backups",
      candidates: [{ id: "a", text: "Postgres supports daily backups natively." }],
    },
    oracle: "HUMAN-FIXED TRUTH (flagged for review): a lone candidate can never clear the 1/1 weak-winner baseline by design; the input pool size alone fixes abstention.",
    gold: { winner: "a", decision: "ESCALATE", abstained: true, why: "lone-candidate pool abstains per the documented baseline pin; flagged for human sign-off." },
  },
  // ---- ES (6) ----
  {
    id: "r1-find-es-normal-01",
    kind: "normal",
    lang: "es",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "¿cómo restablezco mi contraseña?",
      candidates: [
        { id: "a", text: "Abre Configuración y pulsa Restablecer contraseña para recibir un enlace por correo." },
        { id: "b", text: "Notas sobre la migración de las cebras en primavera." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): candidate a answers the query directly; b is topically unrelated. Spanish candidate is the correct answer.",
    gold: { winner: "a", exists: true, decision: "ALLOW", abstained: false, why: "unique answering candidate (ES) wins on human-fixed truth." },
  },
  {
    id: "r1-find-es-difficult-01",
    kind: "difficult",
    lang: "es",
    class: "difficult",
    gold_source: "independent",
    input: {
      query: "¿cómo activo el modo oscuro?",
      candidates: [
        { id: "a", text: "El modo oscuro se activa en Ajustes > Apariencia." },
        { id: "b", text: "La página de ajustes se rediseñó el año pasado." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): both candidates touch settings, but only a answers the how-to question.",
    gold: { winner: "a", exists: true, decision: "ALLOW", abstained: false, why: "topically adjacent non-answer (ES) must not beat the real answer." },
  },
  {
    id: "r1-find-es-negative-01",
    kind: "negative",
    lang: "es",
    class: "negative",
    gold_source: "independent",
    input: {
      query: "receta de física cuántica",
      candidates: [
        { id: "a", text: "Postgres admite copias de seguridad diarias de forma nativa." },
        { id: "b", text: "SQLite guarda todo en un único archivo local." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): no candidate answers the query; the honest outcome is none.",
    gold: { winner: "none", exists: false, decision: "ESCALATE", abstained: true, why: "no answering candidate (ES) abstains instead of forcing a winner." },
  },
  {
    id: "r1-find-es-adversarial-01",
    kind: "adversarial",
    lang: "es",
    class: "adversarial",
    gold_source: "independent",
    input: {
      query: "¿qué base de datos admite copias de seguridad diarias?",
      candidates: [
        { id: "a", text: "copias copias base de datos copias diarias" },
        { id: "b", text: "Postgres admite copias de seguridad diarias mediante pg_dump." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): the keyword-stuffed candidate a is not an answer; b is the real answer.",
    gold: { winner: "b", exists: true, decision: "ALLOW", abstained: false, why: "human-fixed semantic answer (ES) beats lexical stuffing." },
  },
  {
    id: "r1-find-es-ambiguous-01",
    kind: "ambiguous",
    lang: "es",
    class: "ambiguous",
    gold_source: "independent",
    input: {
      query: "¿cuándo se hacen las copias de seguridad?",
      candidates: [
        { id: "a", text: "Las copias de seguridad se hacen todas las noches a las 02:00." },
        { id: "b", text: "Las copias de seguridad se hacen todas las noches a las 02:00." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (ES): identical answers are exactly tied; the v1 pin abstains on exact ties while keeping the winner value unusable.",
    gold: { winner: "a", decision: "ESCALATE", abstained: true, why: "human-fixed exact tie (ES) abstains per the documented tie pin." },
  },
  {
    id: "r1-find-es-cross-01",
    kind: "normal",
    lang: "es",
    class: "normal",
    gold_source: "independent",
    input: {
      query: "which database has native daily backups",
      candidates: [
        { id: "a", text: "Zebra migration notes for the spring season." },
        { id: "b", text: "Postgres admite copias de seguridad diarias de forma nativa." },
      ],
    },
    oracle: "HUMAN-FIXED TRUTH (cross-lingual): English query, but only the Spanish candidate b answers it; a is unrelated. Spanish candidate is the correct answer.",
    gold: { winner: "b", exists: true, decision: "ALLOW", abstained: false, why: "human-fixed cross-lingual answer: the Spanish candidate wins over the unrelated English text." },
  },
];

export default cases;
