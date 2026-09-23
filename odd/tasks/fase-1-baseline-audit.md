# ODD Feature: fase-1-baseline-audit

## Objective
Ejecutar FASE 1 LAYA-MCP: baseline reproducible + architectural audit completo sin implementar arquitectura objetivo.

## Problem
Se necesita fuente de verdad técnica (baseline + contratos + arquitectura real + problemas verificados) antes de fases siguientes.

## Why
El prompt de Fase 1 lo exige y prohíbe implementar; hacerlo sin baseline inventaría problemas/funcionalidades.

## Scope
- Repo C:\Users\Andragon\Documents\Github\laya-mcp (v0.4.0 observado).
- Crear `artifacts/baseline/` (tests.txt, typecheck.txt, lint.txt, build.txt, doctor.txt, mcp.txt).
- Crear `AUDIT.md` con las 17 secciones exigidas.
- Solo modificaciones mínimas para poder ejecutar baseline/diagnóstico, documentadas.

## Constraints
- NO implementar: Policy Engine, policies, shadow mode, métricas nuevas, schemas nuevos (salvo inspección), tools MCP nuevas, CUA-MCP, grandes refactors.
- NO asumir afirmaciones del prompt; verificar contra código/tests/config/comportamiento.
- Documentar discrepancias explícitamente.
- ODD: commits work-unit en feature branch, TDD resuelto, checks por tarea.

## Authorized scope
- Lectura total del repo.
- Ejecución de: npm install/build/typecheck, tests offline (test_opencode_v2, smoke con LAYA_SKIP, mcp_smoke, test_tools_offline, test_health informativo), doctor --no-live, inspección MCP.
- Escritura de: `odd/tasks/fase-1-baseline-audit.md`, `artifacts/baseline/*`, `AUDIT.md`.
- Rama: crear `odd/fase-1-baseline-audit` si se está en default branch antes del primer commit work-unit.

## Acceptance criteria
- [ ] Baseline ejecutado con comando/resultado/duración/errores/warnings registrados.
- [ ] Contratos públicos inventariados (MCP/HTTP/CLI/config).
- [ ] Arquitectura real documentada (no asumida).
- [ ] 10 tools laya_* analizadas + laya_pii extra.
- [ ] Problemas propuestos verificados con formato exigido + severidad P0-P3.
- [ ] AUDIT.md con las 17 secciones.
- [ ] Discrepancias prompt-vs-código documentadas.
- [ ] Orden de implementación recomendado + breaking changes + riesgos + open questions.

## Applicable checks
- `npm run typecheck`, `npm run build`, `python -m unittest` / `pytest` según repo, `tests/test_tools_offline.sh`, `tests/mcp_smoke.mjs`, `py/doctor.py --no-live`.
- TDD mode: por resolver desde config del proyecto (tests presentes NO habilitan TDD por sí solos). Registrar modo/fuente/runner aquí una vez resuelto.
- Native review candidate: work-unit commit o PR slice, solo bajo switch RDD del usuario.

## Delivery strategy
- `ask-on-risk` (default ODD). Forecast: AUDIT.md + ~6 baseline txt, muy por debajo de 400 líneas autoradas por slice salvo que AUDIT sea extenso; si supera, un solo slice documental no requiere chained-pr (no es código). Registrar conteo real.

## Tasks
- [ ] T1 (delegated-direct, mapping trigger 4+ files ya ejecutado): exploración/mapa inicial — DONE (handoff mapper 2026-09-22).
- [ ] T2 (inline): crear feature document + mirror Engram — IN PROGRESS.
- [x] T3 (delegated-direct, per-action): baseline reproducible — DONE 2026-09-22 (worker general ses_f33be16b). Evidencia: artifacts/baseline/{tests,typecheck,lint,build,doctor,mcp}.txt. typecheck ok, build ok, unittest 9 OK, smoke LAYA_SKIP ok, mcp_smoke EXPECT_PII=0 FAIL por diseño (tools:[] offline), test_*.sh skipped (sin bash), doctor --no-live exit 2 (laya pip ausente), lint no-aplicable (sin script/config), inferencia no levantada por coste.
- [x] T4 (delegated-direct, preparation trigger): análisis profundo — DONE 2026-09-22 (worker general ses_f33bb32c). 11 tools inventariadas, 27 problemas verificados con archivo:línea, 5 discrepancias prompt-vs-código, mapa real 10 líneas, orden P0→P3. Mirror Engram id 2396.
- [x] T5 (delegated-direct, writer trigger): redactar AUDIT.md — DONE 2026-09-22 (writer general ses_f33b6b66). AUDIT.md 678 líneas, 19 headings ## verificados por grep, 27 problemas V-01…V-27 (P0:5, P1:11, P2:7, P3:4) + 4 no-reproducidos + discrepancias D-1…D-6 + completion criteria. Solo tocó AUDIT.md (1 fix four→five). Readback completo + ls baseline 6 txt + greps respaldo (policy/structuredContent/ask_user 0 hits; snapshot sin revision).
- [x] T6 (inline): verificación estructural — DONE. Spot-checks parent: src/index.ts:104-109 tools:[] OK, src/tool.ts:46 timeout undefined OK, py/laya_server.py:_load_error líneas 62/68-69/96 OK; AUDIT.md 19 ## OK (grep), líneas 1-80 leídas. Sin review ceremony (edit documental pasivo) y RDD off por defecto → sin assess nativo. Desviación ODD declarada: sin branch ni work-unit commits en esta fase (regla Fase-1 §8 minimal-mutation prevalece; commits/push/PR quedan a decisión del usuario bajo ordinary repository policy).
- [ ] T5 (delegated-direct, writer trigger 2+ files): redactar AUDIT.md (17 secciones) + artifacts/baseline/* finales, sintetizando T3+T4.
- [ ] T6 (inline): verificación estructural (readback AUDIT + baseline), reporte de outcome + checks fallidos/omitidos + next step. Sin review ceremony para edit documental pasivo trivial; en otro caso, assess nativo solo si RDD enabled.

## Progress
- 2026-09-22: mapper completado (11 tools, stdio-only, sin Dockerfile/pyproject, sin lint script).
- Route declaration: T1=delegated (mapping trigger), T2=inline, T3/T4/T5=delegated (per-action/preparation/writer triggers), T6=inline spot-check.

## Verification evidence
- (pendiente T3: comando → resultado observado por worker)

## Next step
- Cerrar T2 (mirror Engram), lanzar T3 baseline worker.

## TDD resolution
- Modo: pendiente de resolución explícita (no inferir de presencia de tests). Fuente: —. Runner: —.

## Commits
- (pendiente; registrar identidad Conventional Commit por work-unit en feature branch)
