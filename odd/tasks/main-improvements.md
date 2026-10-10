# main-improvements — npm test + auditoría de conteos (sin verificación intermedia)

## Why
Usuario: continuar sin verificar por tarea; una sola batería final de tests.
`main` está consolidado y verde. Hallazgos de la exploración (2026-10-10):
- No hay script `npm test`: las baterías offline se corren a mano una por
  una. Mejora: agregador `npm test` con el set probado offline hoy.
- Conteos inconsistentes en prosa (no en código): README dice "Fourteen,
  twelve backed" (backed reales: 10 laya + pii = 11 máx); comentarios
  viejos en `src/index.ts` (header "10 tools + pii + capabilities") y
  `src/tools/capabilities.ts` ("10 laya tools") ignoran escalations/redact.
  Código y tests (T3 13 con stub, T5) son verdad; la prosa no.
- v16 NO se publica: la evidencia cruda vivía en /tmp (borrado); publicar
  desde memoria sería fabricar evidencia. §13 ya dice lo honesto
  (55/60 medido, 54/60 publicado en v12). Sin acción.

## Scope (frozen)
- T1: `npm test` = build + typecheck + set offline verificado hoy
  (fase5_t3/t4/t5/t6, redact, escalations, policy_engine, evals/run stub
  98/98, evals/run --corpus r1 158/158, test_tools_offline.sh).
  Excluidos con motivo: mcp_smoke (falla offline by design), tests live
  (sidecars), python (no corridos hoy).
- T2: prosa de conteos a la verdad del código (comentarios + README +
  MCP_CONTRACT + OPERATOR donde aplique). Cero cambios funcionales.
- T3: batería final `npm test` + fixes del fallout. Única verificación.
- Prohibido: push, cambios funcionales, tocar train/finetune, revisor RDD
  (cadena pausada, lineage S1a abierto en otro contexto).
- Commits work-unit en `main` (alcance explícito del usuario a esa rama).

## No test-first (motivo)
T1 es infra de tests, T2 es prosa pasiva: sin behavior nuevo, sin RED
significativo. La verificación es la batería final T3.

## Batería final (2026-10-10, `npm test`, exit 0)
- typecheck ok, build ok, T3 64, T4 23, T5 15, T6 55, redact 7/7,
  escalations 5/5, policy 49, stub 98/98, r1 158/158, offline sh OK.
- Sin fallout. Commits: 303d999 (npm test), c44c1d4 (conteos).

## RDD d7d2e2d4 (2026-10-10)
- Inspect: monolith + improvements (82 files), start offered
  (lineage `review-47d866aad098b2d1`). Human DECLINED (candidate-scoped).
- No review invoked, no authority created. Main stays tested-unreviewed.
