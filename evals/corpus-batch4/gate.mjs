/**
 * Batch-4 validation split (human-signed 2026-10-12, proceed-as-is incl. 13 borderlines).
 *
 * 20 gate dissimilarity-silence ABSTAINs (10 EN + 10 ES) from ft/batch4/gate-silence.jsonl.
 * Every case gold_source: "independent". Same gold shape as the r1 abstention cases.
 */
export const name = "gate";
export const primitive = "laya_gate";
export const goldSource = "independent";

export const cases = [
  {
    "id": "v2d-gate-en-abstention-01",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "ship release",
        "diff": "+ log message wording",
        "evidence": "tests: 45 passed",
        "claims": [
            "the change shrinks disk usage by 40%"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): passing functional tests carry no disk-usage data; storage claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on disk usage abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-02",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "deploy",
        "diff": "+ meta description tags",
        "evidence": "deploy log: rollout completed",
        "claims": [
            "the change improves search-engine ranking"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): a rollout log says nothing about ranking; SEO claim unverifiable though plausible.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on SEO abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-03",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ export field mapping",
        "evidence": "lint: clean",
        "claims": [
            "user exports are now GDPR-compliant"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): lint says nothing about regulatory compliance; GDPR claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on compliance abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-04",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "ship release",
        "diff": "+ cached dashboard queries",
        "evidence": "unit tests: 80 passed",
        "claims": [
            "the app now works fully offline"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): unit tests say nothing about offline behavior; offline claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on offline support abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-05",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ user table migration",
        "evidence": "review: two approvals",
        "claims": [
            "stored user data is now encrypted at rest"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): review approvals carry no cryptography evidence; encryption claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on encryption abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-06",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "deploy",
        "diff": "+ secondary region config",
        "evidence": "staging deploy: succeeded",
        "claims": [
            "failover to the secondary region is now automatic"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): a staging deploy says nothing about failover automation; claim unverifiable though plausible.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on failover abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-07",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ admin action logging",
        "evidence": "CI: green",
        "claims": [
            "every admin action is now recorded in the audit trail"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): CI green evidences nothing about audit completeness; universality claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on audit completeness abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-08",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "ship fix",
        "diff": "+ email template copy",
        "evidence": "tests: 12 passed",
        "claims": [
            "notification emails no longer land in spam"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): functional tests measure nothing about deliverability; spam-folder claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on deliverability abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-09",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ password policy text",
        "evidence": "tests: 20 passed",
        "claims": [
            "passwords are now hashed with argon2"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): passing tests plus policy copy prove nothing about the hashing algorithm; claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on password hashing abstains to escalate."
    }
},
  {
    "id": "v2d-gate-en-abstention-10",
    "kind": "abstention",
    "lang": "en",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "deploy",
        "diff": "+ region config flag",
        "evidence": "deploy log: rollout completed",
        "claims": [
            "EU customer data now stays in the EU region"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): a rollout log carries no data-residency evidence; residency claim unverifiable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): evidence silence on data residency abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-01",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "desplegar",
        "diff": "+ compresión de respuestas",
        "evidence": "tests: 30 passed",
        "claims": [
            "el cambio reduce a la mitad el tamaño de las respuestas"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): tests funcionales sin datos de tamaño; claim de compresión inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre tamaño de respuesta abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-02",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ modo oscuro",
        "evidence": "CI: pipeline verde",
        "claims": [
            "el modo oscuro ya respeta el contraste mínimo"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): CI verde no audita contraste visual; claim inverificable aunque plausible.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre contraste visual abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-03",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "publicar",
        "diff": "+ política de retención",
        "evidence": "revisión: aprobada por dos revisores",
        "claims": [
            "el cambio cumple con la norma ISO 27001"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): aprobaciones de revisión no evidencian cumplimiento normativo; claim inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre cumplimiento normativo abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-04",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "desplegar",
        "diff": "+ cron de backup",
        "evidence": "deploy: exitoso",
        "claims": [
            "los backups ahora son automáticos cada hora"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): un deploy exitoso no evidencia la cadencia de backups; claim inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre cadencia de backups abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-05",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ flag de TLS",
        "evidence": "tests: 18 passed",
        "claims": [
            "todo el tráfico ahora usa TLS 1.3"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): tests funcionales sin datos de protocolo; claim de cifrado inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre versión de TLS abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-06",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "ship fix",
        "diff": "+ middleware de límite",
        "evidence": "lint: verde",
        "claims": [
            "la API ahora limita a 100 req/s por cliente"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): lint verde no mide rate limiting; claim inverificable aunque plausible.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre rate limiting abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-07",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ rotación de logs",
        "evidence": "changelog: entrada agregada",
        "claims": [
            "los logs se retienen 90 días"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): una entrada de changelog no evidencia política de retención; claim inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre retención de logs abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-08",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "desplegar",
        "diff": "+ formato de fecha",
        "evidence": "tests en inglés: 25 passed",
        "claims": [
            "los reportes ya salen en la zona horaria del usuario"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): tests en un idioma sin datos de zona horaria; claim inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre zona horaria abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-09",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "merge PR",
        "diff": "+ firma de webhooks",
        "evidence": "revisión de docs aprobada",
        "claims": [
            "los webhooks ahora viajan firmados"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): una revisión de docs no evidencia firma criptográfica; claim inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre firma de webhooks abstains to escalate."
    }
},
  {
    "id": "v2d-gate-es-abstention-10",
    "kind": "abstention",
    "lang": "es",
    "class": "abstention",
    "gold_source": "independent",
    "input": {
        "request": "publicar",
        "diff": "+ plantilla de exportador",
        "evidence": "tests: 22 passed",
        "claims": [
            "los PDFs exportados son idénticos al documento original"
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): tests funcionales sin diff visual; claim de fidelidad inverificable.",
    "gold": {
        "verdict": "ABSTAIN",
        "decision": "ESCALATE",
        "abstained": true,
        "why": "SIGNED (human 2026-10-12): silencio sobre fidelidad de exportación abstains to escalate."
    }
}
];
