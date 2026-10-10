/**
 * Phase-2 validation split, batch 1 (human-signed 2026-10-10).
 *
 * 4 gate dissimilarity-silence ABSTAINs (2 EN + 2 ES): evidence with no data
 * on the claim subject. Same gold shape as the r1 abstention cases.
 */
export const name = "gate";
export const primitive = "laya_gate";
export const goldSource = "independent";

export const cases = [
  {
    id: "v2-gate-en-abstention-01",
    kind: "abstention",
    lang: "en",
    class: "abstention",
    gold_source: "independent",
    input: { request: "merge PR", diff: "+ rename variable", evidence: "ci: lint passed", claims: ["the change improves startup time"] },
    oracle: "SIGNED (human 2026-10-10): lint evidence carries no timing data; startup claim unverifiable.",
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "evidence silence on performance abstains to escalate." },
  },
  {
    id: "v2-gate-en-abstention-02",
    kind: "abstention",
    lang: "en",
    class: "abstention",
    gold_source: "independent",
    input: { request: "ship fix", diff: "+ typo in comment", evidence: "tests: 3 passed", claims: ["the change fixes the auth vulnerability"] },
    oracle: "SIGNED (human 2026-10-10): passing functional tests say nothing about a security claim.",
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "evidence silence on security abstains to escalate." },
  },
  {
    id: "v2-gate-es-abstention-01",
    kind: "abstention",
    lang: "es",
    class: "abstention",
    gold_source: "independent",
    input: { request: "desplegar", diff: "+ comentario", evidence: "tests: 5 passed", claims: ["el cambio reduce el consumo de memoria"] },
    oracle: "SIGNED (human 2026-10-10): tests funcionales sin datos de memoria; claim inverificable.",
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "evidence silence on memory abstains to escalate." },
  },
  {
    id: "v2-gate-es-abstention-02",
    kind: "abstention",
    lang: "es",
    class: "abstention",
    gold_source: "independent",
    input: { request: "merge PR", diff: "+ formato", evidence: "revisión de docs aprobada", claims: ["la corrección elimina la condición de carrera"] },
    oracle: "SIGNED (human 2026-10-10): una revisión de docs no evidencia nada sobre concurrencia.",
    gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true, why: "evidence silence on concurrency abstains to escalate." },
  },
];
