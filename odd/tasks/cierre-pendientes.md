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
- [x] T4 (delegated): dataset laya_compare + wiring — DONE (W2: evals/suites/compare.mjs 8 casos + run/score; 88/88).
- [ ] T5 (delegated): verificación pins == en venv temporal (aplicar solo si seguro).
- [ ] T6 (delegated): backends live (pip laya, boot, doctor/smoke/mcp_smoke live, registro honesto).
- [ ] T7 (delegated): no-regresión + actualizar FINAL_REPORT limitaciones.
- [ ] T8 (inline): readback + spot-check + reporte + pregunta push/PR/merge.

## Progress
- En odd/fase-8-final @ 9186ac1.

## Commits
- (pendiente)
