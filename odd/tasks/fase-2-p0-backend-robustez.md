# ODD Feature: fase-2-p0-backend-robustez

## Objective
Implementar solo P0 robustez del backend de inferencia (liveness/readiness, carga con retry/backoff/recovery, concurrencia, límites configurables) + tests reales + P0_IMPLEMENTATION.md. Sin Policy Engine, shadow mode, evaluación, Gentle policy-driven invocation, CUA ni nuevas semánticas verify/screen/PII salvo lo estrictamente necesario.

## Problem
AUDIT.md (a re-verificar contra código) describe: /live y /models inexistentes; /health carga modelos en caliente; /ready sin consumidores TS; _load_error permanente hasta restart; sin retry/backoff/circuit breaker; sin guards de concurrencia (doble carga posible, to_thread unbounded); límites de entrada ausentes o fantasma ("up to 250", "truncated 2000"); LAYA_TOOL_TIMEOUT_MS sin enforcement. Fuente de verdad: código real > tests > AUDIT.md > prompt Fase 2.

## Why
Fase 2 lo exige; Fase 1 dejó baseline y 27 problemas verificados (P0:5). No refactors innecesarios.

## Scope
- `py/laya_server.py`, `py/gliner_server.py` (endpoints, carga, concurrencia, límites, errores estructurados).
- `src/client.ts`, `src/gliner.ts`, `src/health.ts`, `src/index.ts`, `src/tool.ts` solo lo mínimo para consumir lo nuevo (p.ej. usar /ready o /live, timeout real, errores).
- `src/tools/*.ts` solo caps/validación donde el código real lo necesite (sin cambiar semánticas de decisión).
- `tests/` nuevos + existentes intactos (no borrar para conseguir green).
- Docs solo relacionadas + `P0_IMPLEMENTATION.md`.
- Rama: `odd/fase-2-p0-backend` (crear desde main antes del primer commit; estamos en main @ cb70301).

## Constraints
- No asumir AUDIT.md correcto; cada cambio cita comportamiento real.
- Sin locks globales sin justificar; sin loops agresivos de retry; no bloquear proceso completo por un modelo.
- Límites configurables vía env, validados contra sistema real (no copiar ejemplo sin validar); errores estructurados.
- Tests demuestran comportamiento real; no mockear toda la lógica bajo prueba.
- Perf: comparar cold/warm/baja/alta concurrencia si es posible; sin optimización prematura ni claims sin datos.

## Authorized scope
Lectura total + escritura acotada a los archivos de Scope. Prohibido: Policy Engine, shadow mode, eval harness, CUA, cambios semánticos verify/screen/PII, grandes refactors, push/PR/merge (decisión del usuario).

## Acceptance criteria
- [ ] GET /live rápido sin cargar modelos (ambos servidores o el que aplique, adaptado a arquitectura real).
- [ ] GET /ready informa servidor/modelos cargados/fallidos/dispositivo/versión; no oculta backend no preparado.
- [ ] GET /models expone info verificable (nombre, loaded, revision si resoluble, device) adaptada a arquitectura real.
- [ ] Flujo load→failure→record→backoff→retry→success→clear implementado sin loops agresivos y sin bloquear todo por un modelo.
- [ ] Sin doble carga del mismo modelo; sin carreras; concurrencia peligrosa limitada; throughput preservado.
- [ ] Límites configurables (texto/candidatos/longitudes/entidades/opciones/body) con errores estructurados.
- [ ] Tests nuevos pasan y cubren la lista §5 del prompt con comportamiento real.
- [ ] No-regresión: typecheck, build, tests Python, tests MCP relevantes vs baseline Fase 1 (registrar comparativa).
- [ ] `P0_IMPLEMENTATION.md` con problemas/cambios/archivos/tests/benchmark/breakings/riesgos/decisiones.

## Applicable checks
- `npm run typecheck`, `npm run build`, `python -m unittest tests.test_opencode_v2 -v`, `LAYA_SKIP=1 python tests/smoke.py`, `node tests/mcp_smoke.mjs` según modo viable, `python py/doctor.py --no-live`, tests nuevos (nombrar runner exacto en cada delegación).
- TDD resolution: sin config TDD de proyecto/sesión encontrada y sin elección explícita del usuario → modo NO-STRICT; se exigen checks funcionales ordinarios + en el writer los tests nuevos deben observarse fail-before/pass-after donde aplique, sin ceremonia RED-GREEN-REFACTOR estricta. Fuente: ninguna encontrada (tests presentes no habilitan TDD). Runner: `python -m unittest` / scripts de tests del repo (el writer fija el exacto).

## Delivery strategy
- `ask-on-risk` (default). Chain strategy elegida por el usuario 2026-09-23: **`feature-branch-chain`** (cacheada, no volver a preguntar salvo cambio de scope).
- Slice 1 (cerrado): T3 endpoints, commit b241568, +442/-12. Tracker/integración: la rama odd/fase-2-p0-backend acumula; PRs y merge a decisión del usuario.

## Tasks
- [x] T1 (delegated, mapping trigger): re-verificar P0 contra código actual — DONE (handoff: /live y /models no existen; /ready sin consumidores; _load_error permanente; sin retry/backoff/locks; límites parciales/fantasma; TOOL_TIMEOUT sin enforcement).
- [x] T2 (inline): feature doc + mirror — DONE (rama odd/fase-2-p0-backend creada desde main).
- [x] T3 (delegated writer): endpoints — DONE (W1, commit b241568 feat(backend): /live+/models+/ready estructurado en ambos servidores + métodos TS; typecheck/build/py_compile/TestClient PASS). Líneas autoradas T3: +442/-12 = 454 → supera heurística ~400 (advisory-only, sin podar).
- DECISIÓN PENDIENTE (ask-on-risk): chain strategy antes del próximo commit — STOP, preguntado al usuario.
- [x] T4+T5 (delegated writer): carga + concurrencia — DONE (W2, commits cfed3ef T4 retry/backoff/circuit/reload+watcher, b7d20b3 T5 single-flight/semáforo/tool-timeout; tests/test_p0_t4t5_robustness.py 14/14 PASS; test_opencode_v2 9/9; smoke LAYA_SKIP ok; smoke live 503 ambiental idéntico a baseline + Retry-After; mcp_smoke skipped motivo literal).
- Slice 2 (cerrado): T4 cfed3ef +595/-86. Slice 3 (cerrado): T5 b7d20b3 +746/-27 (incluye tests nuevos).
- [x] T6 (delegated writer): límites — DONE (W3, commit 5f8dd23 feat(backend) +1120/-48; 413 input_too_large py+TS; tests/test_p0_t6_limits.py 11/11 + tests/t6_limits.mjs 16/16; no-regresión 23/23; breakings listados en handoff).
- Slice 4 (cerrado): T6 5f8dd23.
- [x] T7 (delegated writer): cobertura+perf — DONE (W4, commit 80b33a6 test(backend) +337; tests/test_p0_t7_gaps.py 8/8; total 42/42; perf absolutos cold ~0.6s, warm p50 ~2ms, sin claims; descubrimiento single-loop-only documentado).
- Slice 5 (cerrado): T7 80b33a6.
- [x] T8 (delegated writer): no-regresión+docs — DONE (W5, commit 519d3f0 docs(backend) +320/-1; comparativa 1-a-1 vs baseline: todo igual o mejor-ambiental; P0_IMPLEMENTATION.md 281 líneas + README +39/-1; cero código funcional, cero tests debilitados).
- Slice 6 (cerrado): T8 519d3f0.
- [x] T9 (inline): readback + spot-check + verificación + reporte — DONE. Parent spot-check: test_p0_t7_gaps 8/8 ok (1.6s). P0_IMPLEMENTATION.md readback: 9 secciones + non-facts, rutas existen. RDD: assess con --base-ref/--committed-only REHUSADO (runtime no elegible: solo claude-code/codex; switch NO tocado); assess plano REHUSADO (untracked-declaration). Tier aplicado: high/unassessable → writer self-verify (por slice, PASS) + independent verifier: PASS (typecheck/build 0, 42/42, 16/16, smoke ok, doctor exit 2 mismo fail ambiental laya-sdk). Outcome nativo por work-unit: unavailable (runtime), verificado por vía off-path.
- Commits (feature-branch-chain, slices 1-6): b241568 T3, cfed3ef T4, b7d20b3 T5, 5f8dd23 T6, 80b33a6 T7, 519d3f0 T8. Push/PR/merge: decisión del usuario.
- [ ] T3 (delegated writer): endpoints /live, /ready (reparar semántica/uso), /models en ambos servidores + cableado TS mínimo. Route: delegated-direct (writer trigger). Commit work-unit 1.
- [ ] T4 (delegated writer, mismo hilo tras T3): carga con retry/backoff/failure-tracking/recovery/circuit-breaker/reset. Commit work-unit 2.
- [ ] T5 (mismo hilo): concurrencia (single-flight carga, bound inferencia, sin lock global injustificado). Commit work-unit 3.
- [ ] T6 (mismo hilo): límites configurables + errores estructurados (py validators + ts caps donde aplique). Commit work-unit 4.
- [ ] T7 (mismo hilo): tests nuevos §5 con comportamiento real + perf cold/warm/baja/alta (datos, sin claims). Commit work-unit 5.
- [ ] T8 (mismo hilo o inline): no-regresión completa vs baseline + docs mínimas + P0_IMPLEMENTATION.md. Commit work-unit 6.
- [ ] T9 (inline): readback + spot-check + assess nativo solo si RDD enabled + reporte final.

## Progress
- 2026-09-23: T1 done. En main @ cb70301, package-lock.json modificado (Fase 1), AUDIT.md/artifacts/odd/ untracked.
- Route declaration: T1=delegated (mapping), T2=inline, T3-T8=delegated single-writer secuencial (writer/preparation triggers), T9=inline spot-check.

## Verification evidence
- (pendiente; por work-unit: comando → resultado observado por writer; parent spot-check de 1 comando por tier)

## Next step
- Cerrar T2 (mirror), crear rama, lanzar W1 (T3).

## TDD resolution
- Modo: no-strict (sin ceremonia). Fuente: ninguna encontrada. Runner: `python -m unittest` + scripts repo (fijar exacto por delegación).

## Commits
- (pendiente; Conventional Commits en odd/fase-2-p0-backend, 1 por work-unit, registrar identidad)
