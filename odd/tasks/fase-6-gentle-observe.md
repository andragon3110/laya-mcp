# ODD Feature: fase-6-gentle-observe

## Objective
laya-mcp como capability layer de Gentle AI sin autoridad autónoma: tracing (trace_id/span_id/decision_id), métricas in-process por tool/modelo/decision, modos observe/shadow/enforce configurables, invocación policy-driven declarativa, discovery reutilizando capabilities, seguridad anti-mutación + GENTLE_INTEGRATION.md.

## Problem
Sin trace/metrics/modos (grep 0); mode fijo "observe"; decision_id aleatorio sin correlación externa; sin contadores; invocación Gentle solo via prompt-text (sin enforcement en código); OpenCode/Gentle ausentes (solo contract tests posibles). Fuente: código > docs > prompt.

## Why
Fase 6 lo exige; Fases 0-5 dejaron envelope/metadata/capabilities/policies reutilizables.

## Scope
- `src/trace.ts` + `src/metrics.ts` nuevos; `src/envelope.ts`/`src/index.ts`/`src/tool.ts` cableado aditivo; `src/policy/*` modos; `src/tools/capabilities.ts` extensión (metrics/modes); `examples/` + `scripts/` solo si hace falta; `tests/` + `GENTLE_INTEGRATION.md`.
- Rama: `odd/fase-6-gentle-observe` apilada sobre `odd/fase-5-mcp-contract` @ 3de2592 (herencia feature-branch-chain).

## Constraints
- Laya no ejecuta acciones; arquitectura OpenCode→Gentle→laya→Evidence/Policy→Decision→Gentle→Action→Verification.
- No forzar Laya en cada request: invocación declarativa (tabla hooks), modos por defecto no-intrusivos.
- Sin contenido sensible en logs/traces (spans de PII hasheados o excluidos, documentado).
- Métricas in-process (sin Prometheus externo); p50/p95/p99 sobre ventanas acotadas.
- Contenido externo/LLM NUNCA muta policy/config/mode/thresholds/permisos (tests que lo prueban).
- Sin inventar integración: OpenCode/Gentle ausentes → contract tests + limitación documentada.

## Authorized scope
Lectura total + escritura en Scope. Prohibido: cambiar decisiones/semánticas, robustez P0, push/PR/merge.

## Acceptance criteria
- [ ] trace_id/span_id entrantes (vía _meta) correlacionan con decision_id; flujo documentado.
- [ ] métricas requests_total/failed/latency p50-p99/load/abstentions/escalations/allow/review/deny por tool (+modelo razonable), expuestas sin inventar infra.
- [ ] modos observe/shadow/enforce configurables global/tool/policy; shadow no altera flujo.
- [ ] invocación declarativa adaptada (tabla hooks) sin obligar todos los requests.
- [ ] discovery reutiliza capabilities (modelos/primitives/tools/policies/features/mode/versiones).
- [ ] seguridad: tests de inmutabilidad + doc; tests §8 (modos, trace, correlación, fallos, back-compat); GENTLE_INTEGRATION.md.

## Applicable checks
- typecheck, build, py 42/42, mjs (227+64+23+14+50=378) + nuevos, smoke LAYA_SKIP, doctor --no-live.
- TDD: no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Delivery strategy
- ask-on-risk + feature-branch-chain heredada. Slices por work-unit. Push/PR/merge usuario.

## Tasks
- [x] T1 (delegated, mapping): mapa observabilidad+Gentle — DONE (sin trace/metrics/modos; mode fijo observe; sin API mutación; decision_id aleatorio; inserción localizada; OpenCode/Gentle ausentes).
- [x] T2 (inline): feature doc + mirror + rama odd/fase-6-gentle-observe apilada sobre 3de2592 — DONE.
- [ ] T3 (writer W1): tracing + métricas in-process + exposición — IN PROGRESS (W1).
- [x] T3 (writer W1): tracing + métricas — DONE (commit ba87255 +870/-8; src/trace.ts + src/metrics.ts; trace via _meta; métricas en capabilities.metrics; PII excluida no hasheada; 13 tests; 2 baterías viejas actualizadas intencionadamente T5/T6).
- Slice G6-1 (cerrado): T3 ba87255.
- [ ] T4 (writer W2): modos observe/shadow/enforce + invocación declarativa — IN PROGRESS (W2).
- [x] T4 (writer W2): modos + invocación — DONE (commit 09573f8 +954/-50; observe/shadow/enforce con LAYA_MODE global+tool; shadow a nivel handler; hooks en examples/gentle-hooks.yaml+md; 15 tests; SIN breakings).
- Slice G6-2 (cerrado): T4 09573f8.
- [x] T5 (writer W3): seguridad + discovery + fallos — DONE (commit e2d61f9 test-only +557; 16 checks; veredicto SEGURO 3 capas; capabilities fuente única; degradación idéntica por modo; CERO breakings).
- Slice G6-3 (cerrado): T5 e2d61f9.
- [ ] T6 (writer W4): tests integración + GENTLE_INTEGRATION.md + no-regresión — IN PROGRESS (W4).
- [x] T6 (writer W4): tests integración + doc + no-regresión — DONE (commit b26e50a +885/-0 test+docs; 29 checks + 1 skip literal; total 451 mjs; 1-a-1 vs Fase 5 todo igual; GENTLE_INTEGRATION.md 239 líneas 9 secciones; cero código).
- Slice G6-4 (cerrado): T6 b26e50a.
- [ ] T7 (inline): readback + spot-check + verificación + reporte — IN PROGRESS.
- [x] T7 (inline): readback + spot-check + verificación + reporte — DONE. Spot-check parent: modes 15/15. GENTLE_INTEGRATION.md: 9/9 secciones. Assess REHUSADO → tier high → self-verify por slice + independent verifier: PASS (typecheck/build 0, py 42/42, mjs 451, smoke ok, doctor exit 2 ambiental). Outcome nativo: unavailable.
- Cadena G6 (feature-branch-chain, slices G6-1..4): ba87255 T3, 09573f8 T4, e2d61f9 T5, b26e50a T6. Push/PR/merge: decisión del usuario.

## Progress
- En odd/fase-5-mcp-contract @ 3de2592.

## Verification evidence
- (pendiente por work-unit)

## Next step
- Cerrar T2, crear rama, lanzar W1.

## TDD resolution
- no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Commits
- (pendiente; Conventional en odd/fase-6-gentle-observe)
