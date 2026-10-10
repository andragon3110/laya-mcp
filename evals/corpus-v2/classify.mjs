/**
 * Phase-2 validation split, batch 1 (human-signed 2026-10-10).
 *
 * 10 `other` negatives (5 EN + 5 ES). Every case gold_source:
 * "independent": classification truth fixed by a human reading the input
 * alone. Oracles signed as drafted (status prefix only).
 */
export const name = "classify";
export const primitive = "laya_classify";
export const goldSource = "independent";

const BUG_FEATURE_OTHER = [
  { id: "bug", description: "A software defect report." },
  { id: "feature", description: "A request for new functionality." },
  { id: "other", description: "Anything that is neither a defect report nor a functionality request." },
];

export const cases = [
  {
    id: "v2-classify-en-other-01",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "I forgot my password, how do I reset it?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): account-recovery how-to is neither defect nor feature request.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "support how-to routes to other." },
  },
  {
    id: "v2-classify-en-other-02",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "How much does the team plan cost per seat?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): pricing question, neither defect nor functionality request.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "billing question routes to other." },
  },
  {
    id: "v2-classify-en-other-03",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "Is the API currently down? My dashboard shows stale data." }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): status inquiry about an outage, not a defect report of the repo.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "status question routes to other." },
  },
  {
    id: "v2-classify-en-other-04",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "Please delete my account and all associated data." }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): account-deletion request, administrative, not bug/feature.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "admin request routes to other." },
  },
  {
    id: "v2-classify-en-other-05",
    kind: "negative",
    lang: "en",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "Can I export my invoices as CSV for accounting?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10, borderline kept as other): usage how-to about existing export, not a new-functionality ask.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "how-to routes to other." },
  },
  {
    id: "v2-classify-es-other-01",
    kind: "negative",
    lang: "es",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "¿Cómo cambio mi plan al anual?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): billing/plan change, neither defect nor feature.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "plan question routes to other." },
  },
  {
    id: "v2-classify-es-other-02",
    kind: "negative",
    lang: "es",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "¿Dónde descargo mi factura del mes pasado?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): invoice download how-to, administrative.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "admin how-to routes to other." },
  },
  {
    id: "v2-classify-es-other-03",
    kind: "negative",
    lang: "es",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "¿Cómo pido un reembolso del último cargo?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): refund request, administrative, not bug/feature.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "refund request routes to other." },
  },
  {
    id: "v2-classify-es-other-04",
    kind: "negative",
    lang: "es",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "¿Cómo agrego a un compañero a mi equipo?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10, borderline kept as other): team-management how-to about existing function.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "how-to routes to other." },
  },
  {
    id: "v2-classify-es-other-05",
    kind: "negative",
    lang: "es",
    class: "negative",
    gold_source: "independent",
    input: { purpose: "triage", items: [{ id: "i1", text: "¿Cómo cambio el idioma de la aplicación?" }], classes: BUG_FEATURE_OTHER },
    oracle: "SIGNED (human 2026-10-10): settings how-to, neither defect nor feature.",
    gold: { classification: "other", decision: "ALLOW", abstained: false, why: "settings how-to routes to other." },
  },
];
