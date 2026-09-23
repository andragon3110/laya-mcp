# ODD Feature: fase-8-final

## Objective
Revisión final escéptica: hardening reproducibilidad, doctor extendido honesto, README/docs completos sin aspiracional, security review verificado, contrato re-verificado, matriz completa de tests, arquitectura PERCEPTION→VERIFICATION confirmada, sin CUA + FINAL_REPORT.md con X/Y/Z reales.

## Problem
Auditoría escéptica confirma base sólida pero con gaps: requirements sin pins + Docker/pyproject ausentes + revision siempre unpinned + tokenizer sin registrar; doctor sin --benchmark/--models/--policy/--mcp; README sin modes/observabilidad/eval/revision/seguridad + claims aspiracionales (33ms, jailbreaks live, inspect 11); MCP_CONTRACT.md stale (no menciona Fase 6); envs sin documentar (revision/mode/shadow/policy); header 11 tools vs 12. Fuente: código > docs > prompt.

## Why
Fase 8 lo exige; es la última fase y debe cerrar con estado real verificado.

## Scope
- `py/doctor.py` (+flags honestos) + `install.sh:doctor.sh` si aplica; `py/requirements*.txt` (pins solo si verificados seguros, si no documentar); `py/download_models.py` (revision param solo si seguro); `README.md`, `MCP_CONTRACT.md`, docs; `tests/` baterías que falten; `FINAL_REPORT.md`.
- Rama: `odd/fase-8-final` apilada sobre `odd/fase-7-eval` @ ccb9cf1 (herencia feature-branch-chain).

## Constraints
- No inventar resultados: cada flag/doc afirma solo lo probado o sondeado en vivo, con procedencia.
- No documentar aspiracional: corregir claims (33ms, jailbreaks live, inspect, install solo-$HOME).
- No CUA (verificar ausencia, no implementar).
- No tocar thresholds/semánticas/decisiones/robustez salvo bug real de seguridad o regresión.
- Pins de dependencias solo si se verifica instalación segura; si no, documentar versiones exactas + por qué no se pinea.

## Authorized scope
Lectura total + escritura en Scope. Prohibido: CUA, cambios funcionales fuera de doctor/pins-seguros, push/PR/merge.

## Acceptance criteria
- [ ] reproducibilidad revisada (pins o justificación + tokenizer + revision documentados).
- [ ] doctor --benchmark/--models/--policy/--mcp donde la arquitectura lo permite, con datos reales.
- [ ] README/docs describen lo real (lista §3) sin aspiracional.
- [ ] security review §4 verificado ítem por ítem + 4 confirmaciones.
- [ ] contrato re-verificado + breakings identificados.
- [ ] matriz tests ejecutada (unit/integration/contract/adversarial/e2e + lint/typecheck/build/doctor) sin eliminar fallidos.
- [ ] arquitectura final sin Model→Action; ejecución fuera; sin CUA.
- [ ] checklist §9 respondido; FINAL_REPORT.md con X/Y/Z exactos.

## Applicable checks
- typecheck, build, py 42/42, mjs 451+36, evals (80+score+bench+integration), smoke LAYA_SKIP, doctor --no-live + nuevos flags.
- TDD: no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Delivery strategy
- ask-on-risk + feature-branch-chain heredada. Slices por work-unit. Push/PR/merge usuario.

## Tasks
- [x] T1 (delegated, mapping): auditoría escéptica final — DONE (gaps listados arriba con archivo:línea; base sólida confirmada).
- [x] T2 (inline): feature doc + mirror + rama odd/fase-8-final apilada sobre ccb9cf1 — DONE.
- [ ] T3 (writer W1): reproducibilidad + doctor extendido — IN PROGRESS (W1).
- [x] T3 (writer W1): reproducibilidad + doctor — DONE (commit b6d6906; 4 flags honestos + --revision + locks de facto documentados sin == + tokenizer unknown; 14 tests py nuevos (56 total); evals bench en vivo vía doctor; hallazgo: dist instalada stale vs repo).
- Slice F8-1 (cerrado): T3 b6d6906.
- [ ] T4 (writer W2): README/docs/MCP_CONTRACT sin aspiracional — IN PROGRESS (W2).
- [x] T4 (writer W2): README/docs/MCP_CONTRACT — DONE (commit d0743b7 docs-only +248/-29; modes/observabilidad/eval/revisions/seguridad/envs/doctor; 9 claims aspiracionales corregidos; header 11→10+2; MCP_CONTRACT Fase 6 documentada).
- Slice F8-2 (cerrado): T4 d0743b7.
- [x] T5 (writer W3): security + contract + matriz — DONE (commit 913bc88 fix(doctor) +56/-1; redacción secretos doctor + test; seguridad §4 SEGURO; 4 igualdades; contrato 12 tools re-verificado; matriz X/Y/Z; NINGÚN breaking).
- Slice F8-3 (cerrado): T5 913bc88.
- [x] T6 (writer W4): FINAL_REPORT.md + no-regresión — DONE (commit a599da4 +558; 14 secciones + checklist §9 + CUA no-implementado; matriz sin deltas).
- [x] T6-fix (inline parent): 2 líneas stale README (calibrated claim + list-when-down) — DONE (commit 9186ac1 docs, 6+/4-).
- Slice F8-4 (cerrado): T6 a599da4 + fix 9186ac1.
- [ ] T7 (inline): readback + spot-check + verificación + reporte — IN PROGRESS.
- [x] T7 (inline): readback + spot-check + verificación + reporte — DONE. Spot-check parent: doctor-t3 15/15. FINAL_REPORT.md: 14+3 secciones. Assess REHUSADO → tier high → self-verify por slice + independent verifier: PASS (typecheck/build 0, py 57, mjs 487+1skip, evals 80+score+bench+integration, smoke ok, doctor exit 2 + 4 flags honestos). Outcome nativo: unavailable.
- Cadena F8 (feature-branch-chain, slices F8-1..4 + fix): b6d6906 T3, d0743b7 T4, 913bc88 T5, a599da4 T6, 9186ac1 fix. Push/PR/merge: decisión del usuario.

## Progress
- En odd/fase-7-eval @ ccb9cf1.

## Verification evidence
- (pendiente por work-unit)

## Next step
- Cerrar T2, crear rama, lanzar W1.

## TDD resolution
- no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Commits
- (pendiente; Conventional en odd/fase-8-final)
