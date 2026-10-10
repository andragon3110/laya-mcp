# Distillation gate cases (24, CONSTRUCTED train-only — NOT corpus, NO firma)

Construction gold: ABSTAIN (evidence carries no data on the claim subject).
New subjects only (batches 1–3 covered timing/security-impossibility/cost/
throughput/latency/portability/battery/memory/concurrency/universality/
i18n/restore/a11y/rollback/uptime/data-loss/PII/platforms). d3 labels each;
kept iff d3 verdicts ABSTAIN. Agreement rate = distillation quality metric.

## EN (12)

- id: dist-gate-en-01 | lang: en
  request: "merge PR", diff: "+ translated docs", evidence: "docs: es translation added", claims: ["the change fixes the login bug"]
- id: dist-gate-en-02 | lang: en
  request: "ship release", diff: "+ removed dead code", evidence: "coverage: unchanged at 82%", claims: ["the change frees 200MB of RAM"]
- id: dist-gate-en-03 | lang: en
  request: "merge PR", diff: "+ code comments", evidence: "review: comments look clear", claims: ["onboarding time drops by half"]
- id: dist-gate-en-04 | lang: en
  request: "deploy", diff: "+ copyright year", evidence: "diff: one line changed", claims: ["the build is reproducible"]
- id: dist-gate-en-05 | lang: en
  request: "merge PR", diff: "+ bump lodash", evidence: "lockfile: version updated", claims: ["prototype pollution is gone"]
- id: dist-gate-en-06 | lang: en
  request: "ship fix", diff: "+ reformat", evidence: "lint: clean", claims: ["screen-reader order is correct"]
- id: dist-gate-en-07 | lang: en
  request: "merge PR", diff: "+ rename vars", evidence: "tests: same 90 passed", claims: ["the API is backward compatible"]
- id: dist-gate-en-08 | lang: en
  request: "deploy", diff: "+ log level", evidence: "logs: readable", claims: ["p99 latency improved"]
- id: dist-gate-en-09 | lang: en
  request: "merge PR", diff: "+ whitespace", evidence: "CI: green", claims: ["cold start is faster"]
- id: dist-gate-en-10 | lang: en
  request: "ship release", diff: "+ license header", evidence: "legal: header present", claims: ["the binary is smaller"]
- id: dist-gate-en-11 | lang: en
  request: "merge PR", diff: "+ sort imports", evidence: "tests: 60 passed", claims: ["race conditions are fixed"]
- id: dist-gate-en-12 | lang: en
  request: "deploy", diff: "+ docker tag", evidence: "registry: tag pushed", claims: ["rollout canary metrics improved"]

## ES (12)

- id: dist-gate-es-01 | lang: es
  request: "merge PR", diff: "+ emojis en docs", evidence: "docs: emojis agregados", claims: ["el bug de login está corregido"]
- id: dist-gate-es-02 | lang: es
  request: "publicar", diff: "+ badge readme", evidence: "readme: badge visible", claims: ["la cobertura subió al 95%"]
- id: dist-gate-es-03 | lang: es
  request: "merge PR", diff: "+ fecha changelog", evidence: "changelog: fecha actualizada", claims: ["el throughput se duplicó"]
- id: dist-gate-es-04 | lang: es
  request: "desplegar", diff: "+ idioma comentarios", evidence: "revisión: comentarios claros", claims: ["el onboarding tarda la mitad"]
- id: dist-gate-es-05 | lang: es
  request: "merge PR", diff: "+ nombres de tests", evidence: "tests: mismos 40 passed", claims: ["la API es compatible hacia atrás"]
- id: dist-gate-es-06 | lang: es
  request: "ship fix", diff: "+ fixture nueva", evidence: "fixture: agregada", claims: ["los flaky tests desaparecieron"]
- id: dist-gate-es-07 | lang: es
  request: "merge PR", diff: "+ ejemplo en docs", evidence: "docs: ejemplo visible", claims: ["los usuarios cometen menos errores"]
- id: dist-gate-es-08 | lang: es
  request: "publicar", diff: "+ unidades métricas", evidence: "texto: unidades cambiadas", claims: ["la facturación es correcta"]
- id: dist-gate-es-09 | lang: es
  request: "merge PR", diff: "+ timezone", evidence: "config: zona horaria seteada", claims: ["los reportes salen más rápido"]
- id: dist-gate-es-10 | lang: es
  request: "desplegar", diff: "+ encoding utf-8", evidence: "archivos: recodificados", claims: ["se eliminó la deuda técnica"]
- id: dist-gate-es-11 | lang: es
  request: "merge PR", diff: "+ paginación por defecto", evidence: "default: 20 items", claims: ["el servidor aguanta el doble de carga"]
- id: dist-gate-es-12 | lang: es
  request: "ship fix", diff: "+ longitud de línea", evidence: "lint: verde", claims: ["el consumo de memoria bajó"]
