/**
 * Batch-4 validation split (human-signed 2026-10-12, proceed-as-is incl. 13 borderlines).
 *
 * 20 `other` negatives (10 EN + 10 ES) from ft/batch4/classify-other.jsonl.
 * Every case gold_source: "independent". d3-distill rows are train-only, NOT here.
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
    "id": "v2d-classify-en-other-01",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "How do I enable SSO for my organization?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): SSO setup how-to about an existing capability, neither defect nor feature request.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): admin how-to routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-02",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "Where do I configure webhooks for deploy events?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): pointer question about existing webhook settings, not a defect and not a new-functionality ask.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): usage how-to routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-03",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "What are the API rate limits on the starter plan?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): limits question about plan terms, neither defect report nor feature request.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): policy question routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-04",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "How do I download a copy of all my personal data?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): data-access request, administrative, not a defect and not a functionality ask.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): admin request routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-05",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "Can I extend my 14-day trial by another week?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): trial-extension request, commercial/administrative, neither defect nor feature.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): commercial request routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-06",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "Do you offer discounts for nonprofits?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): discount-policy question, commercial, not a defect report of the repo.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): pricing-policy question routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-07",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "How do I turn off email notifications for mentions?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): notification-preference how-to about existing settings, neither defect nor feature.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): settings how-to routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-08",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "How do I point my custom domain at the hosted docs?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): custom-domain setup how-to about existing function, not a new-functionality ask.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): how-to routes to other (borderline: reviewer confirm not a feature request)."
    }
},
  {
    "id": "v2d-classify-en-other-09",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "Where can I view the audit log of workspace changes?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): pointer question about an existing admin surface, administrative, not bug/feature.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): admin pointer routes to other."
    }
},
  {
    "id": "v2d-classify-en-other-10",
    "kind": "negative",
    "lang": "en",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "How often are workspace backups taken?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12): backup-schedule policy question, not a defect report of the repo.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): policy question routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-01",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cómo activo la verificación en dos pasos en mi cuenta?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): cómo de seguridad sobre función existente, ni defecto ni pedido de funcionalidad.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): how-to de uso routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-02",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cómo cancelo mi suscripción al plan mensual?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): pedido administrativo de cancelación, no es bug ni feature.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): pedido administrativo routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-03",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cómo actualizo los datos de facturación de mi empresa?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): cómo administrativo de facturación, ni defecto ni funcionalidad nueva.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): admin how-to routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-04",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cómo agrego más asientos a mi suscripción actual?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): gestión de asientos sobre función existente; revisor confirma que no es pedido de feature.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): how-to routes to other (borderline: reviewer confirm not a feature request)."
    }
},
  {
    "id": "v2d-classify-es-other-05",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cómo cambio la zona horaria de mis reportes programados?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): cómo de configuración existente, ni defecto ni pedido.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): settings how-to routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-06",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cómo silencio las notificaciones durante el fin de semana?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): preferencia de notificaciones sobre función existente, ni defecto ni feature.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): preference how-to routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-07",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cuánto almacenamiento incluye mi plan actual?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): pregunta de límites del plan, no reporta defecto ni pide funcionalidad.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): limits question routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-08",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Ofrecen un período de prueba del plan enterprise?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): pregunta comercial sobre prueba, administrativa, no es bug ni feature.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): commercial question routes to other."
    }
},
  {
    "id": "v2d-classify-es-other-09",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Cómo conecto mi calendario con la aplicación?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): cómo de integración existente; revisor confirma que no es pedido de feature nueva.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): how-to routes to other (borderline: reviewer confirm not a feature request)."
    }
},
  {
    "id": "v2d-classify-es-other-10",
    "kind": "negative",
    "lang": "es",
    "class": "negative",
    "gold_source": "independent",
    "input": { classes: BUG_FEATURE_OTHER,
        "purpose": "triage",
        "items": [
            {
                "id": "i1",
                "text": "¿Dónde puedo leer el registro de cambios de la última versión?"
            }
        ]
    },
    "oracle": "SIGNED (human 2026-10-12) (ES): pedido de puntero a documento existente, administrativo.",
    "gold": {
        "classification": "other",
        "decision": "ALLOW",
        "abstained": false,
        "why": "SIGNED (human 2026-10-12): doc pointer routes to other."
    }
}
];
