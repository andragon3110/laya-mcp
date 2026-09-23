# ODD Feature: cierre-pendientes

## Objective
Resolver los pendientes de las Fases 1-8: commitear untracked (AUDIT.md, artifacts/, odd/), ejecutar .sh si hay bash, dataset laya_compare, verificar pins ==, levantar backends live si es viable, y actualizar docs. Push/PR/merge quedan fuera (decisión del usuario).

## Scope
- Rama `odd/cierre-pendientes` sobre `odd/fase-8-final` @ 9186ac1.
- Commits work-unit por resolución; sin cambiar semánticas/thresholds/decisiones.

## Tasks
- [x] T1 (inline): tracking + rama — DONE.
- [x] T2 (inline): commit untracked — DONE (1b72bad docs: AUDIT.md + artifacts/ + odd/, 17 ficheros).
- [x] T3 (delegated): bash + .sh + fixture — DONE sin commit (bash Git 5.2.37 funcional; test_tools_offline.sh exit 0 PASS; test_health.sh exit 0 no-op sin .venv; policy.sh matriz completa en fixture sintética TEMP; hallazgo: test_health.sh texto stale 0/10 → corrección T7).
- [x] T4 (delegated): dataset laya_compare + wiring — DONE (W2 commit 59108f3; evals/suites/compare.mjs 8 casos + run/score; 88/88; CERO src/; bench.mjs sigue con 10 suites — nota T7 docs).
- [x] T5 (delegated): pins verificados — DONE (commit 51eee28; 8 pins == verificados en venv2 limpio + imports + pip check; huggingface_hub 0.36.2 por interacción gliner2; venvs borrados; py 57 intacto).
- [x] T6 (delegated): backends live — DONE sin commit (venv TEMP CPU-only; :8765 3 checkpoints + :8766 gliner vivos; doctor live 16/0/0; smoke+gliner live OK; juicios live registrados; integration live 2/5 gate externo; 2 bugs tests: mcp_smoke race+deepEqual, smoke.py puerto 8766; limpieza total).
- [x] T7 (delegated): fixes + stale + no-regresión — DONE (commit b99f8ed +93/-21; mcp_smoke race+deepEqual; smoke.py LAYA_PORT; test_health.sh; EVALUATION compare; todo verde offline).
- [x] T7b (delegated): re-verificación live — DONE sin commit (mcp_smoke live ALL PASSED 12 tools; smoke.py :8767 OK; doctor live 16/0/0 EXIT=0; 3 fixes CONFIRMADOS; limpieza total verificada).
- [x] T8 (inline): readback + spot-check + reporte + pregunta push/PR/merge — DONE (árbol limpio e9ddf3c; todo verificado).
- Cadena cierre: 1b72bad T2, 59108f3 T4, 51eee28 T5, b99f8ed T7, e9ddf3c T8 (+T3/T6 sin commit por diseño). Push 8 ramas OK; PRs apilados #2-#9 OPEN (base correcta cada uno); merge NO hecho (decisión del usuario).
- [ ] T6 (delegated): backends live (pip laya, boot, doctor/smoke/mcp_smoke live, registro honesto).
- [ ] T7 (delegated): no-regresión + actualizar FINAL_REPORT limitaciones.
- [ ] T8 (inline): readback + spot-check + reporte + pregunta push/PR/merge.

## Progress
- En odd/fase-8-final @ 9186ac1.

## Commits
- (pendiente)
