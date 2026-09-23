# ODD Feature: fase-4-search-primitives

## Objective
Mejorar extract/find/rerank/decide (top_k, min_gliner_score, pruning, two-stage en decide, abstención NONE/ABSTAIN, benchmarks) sin romper sus contratos evidence/decision existentes salvo lo estrictamente necesario + SEARCH_IMPLEMENTATION.md.

## Problem
Sin top_k/min_gliner_score/pre-filter/pruning/two-stage (grep 0); extract con slice(0,20) literal en vía entities; find envía hasta 250 candidatos a Laya; rerank 1 noul por candidato (hasta 64); decide selection+requirements simultáneos en un /predict (requirements no ven el selected). Fuente: código > docs > prompt.

## Why
Fase 4 lo exige; P1 dejó evidence+decision+policies que reutilizar sin redefinir.

## Scope
- `src/tools/{extract,find,rerank,decide}.ts` + `src/policy/policies/{extract,find,rerank,decide}.ts` (solo si el comportamiento cambia y lo exige) + `src/limits.ts` (nuevos límites configurables) + `tests/` + docs + `SEARCH_IMPLEMENTATION.md`.
- Rama: `odd/fase-4-search` apilada sobre `odd/fase-3-p1-policy` @ 10cb870 (herencia feature-branch-chain).

## Constraints
- Contratos evidence/decision intactos en forma (pruning cambia conteos, no forma; `candidateCount` real preservado para baseline 1/N de find).
- Nuevos parámetros opcionales (top_k, min_gliner_score...) con defaults = comportamiento actual (cero breaking por defecto).
- Valor extract SIEMPRE substring del original con source[start:end]; nunca generar.
- Decide two-stage: requirements evalúan el selected resuelto (2 llamadas /predict); documenta coste/latencia.
- Benchmarks con datos reales (stub-client/fakes, sin modelos); sin claims sin datos. `ranking score != calibrated probability` documentado.

## Authorized scope
Lectura total + escritura en Scope. Prohibido: tocar otras tools, robustez P0, engine core (solo policies de las 4 si hace falta), calibración, push/PR/merge.

## Acceptance criteria
- [ ] extract: top_k/min_gliner_score/max_candidates configurables; slice 20 justificado o sustituido; grounded source[start:end] siempre.
- [ ] find: pruning cheap pre-filter → top-K → Laya → winner/NONE/ABSTAIN; 0/fuerte/similares/ambiguos manejados.
- [ ] rerank: max_candidates/top_k/min_probability donde corresponda; doc score≠probability; eval 10/50/100/500/1000.
- [ ] decide: two-stage selection→evaluate selected; tests de dependencia.
- [ ] NONE/ABSTAIN sin winners forzados; tests §7 (cero/uno/muchos/idénticos/similares/incorrecto/ambigüedad/vacío/enorme/límites); perf (count/pruning/latencia/memoria/throughput); SEARCH_IMPLEMENTATION.md.

## Applicable checks
- typecheck, build, py 42/42, mjs (16+49+19+25+17) + nuevos, smoke LAYA_SKIP, doctor --no-live.
- TDD: no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Delivery strategy
- ask-on-risk + feature-branch-chain heredada. Slices por work-unit. Push/PR/merge usuario.

## Tasks
- [x] T1 (delegated, mapping): mapa primitives actual — DONE (sin top_k/min_score/pruning/two-stage; slices y puntos de inserción localizados; contratos y tests a preservar citados).
- [x] T2 (inline): feature doc + mirror + rama odd/fase-4-search apilada sobre 10cb870 — DONE.
- [ ] T3 (writer W1): extract top_k/min_gliner_score/max_candidates + grounded — IN PROGRESS (W1).
- [x] T3 (writer W1): extract — DONE (commit fb4ac51; top_k/min_gliner_score/max_candidates opcionales defaults 20/20/0; slice literal sustituido; grounded con offsets en ambas vías; policy extract sigue 1.0.0; 22 tests nuevos; SIN breakings).
- Slice F4-1 (cerrado): T3 fb4ac51.
- [ ] T4 (writer W2): find pruning pipeline + configs — IN PROGRESS (W2).
- [x] T4 (writer W2): find pruning — DONE (commit 0a97878; token-overlap+dedup determinista, top_k/min_score defaults 250/0 = legacy; candidateCount real + pruned reportado; policy find 1.0.0; 26 tests; SIN breakings).
- Slice F4-2 (cerrado): T4 0a97878.
- [ ] T5 (writer W3): rerank caps + doc + eval 10-1000 — IN PROGRESS (W3).
- [x] T5 (writer W3): rerank — DONE (commit c1e0d3d; top_k default 64 = legacy; min_relevance rechazado y pineado; score≠probability en tool+README; eval 10/50/100/500/1000 con pruning ratio; 26 tests; SIN breakings).
- Slice F4-3 (cerrado): T5 c1e0d3d.
- [ ] T6 (writer W4): decide two-stage + tests dependencia — IN PROGRESS (W4).
- [x] T6 (writer W4): decide two-stage — DONE (commit 447d56c; etapa1 selection + etapa2 requirements con selected inyectado; sin selected no hay etapa2; coste 2 llamadas documentado; policy decide 1.0.0; 11 tests; SIN breakings).
- Slice F4-4 (cerrado): T6 447d56c.
- [ ] T7 (writer W5): tests §7 restantes + benchmarks — IN PROGRESS (W5).
- [x] T7 (writer W5): tests §7 + benchmarks — DONE (commit 196e85f; tests/fase4_t7_gaps_benchmarks.mjs 16/16; mapeo §7 completo sin duplicar; bench absolutos por primitive; cero código funcional).
- Slice F4-5 (cerrado): T7 196e85f.
- [x] T8 (writer W6): no-regresión + docs — DONE (commit 1bbf684 +400 docs-only; 1-a-1 vs Fase 3 todo igual salvo doctor memory WARN ambiental; SEARCH_IMPLEMENTATION.md 394 líneas 9 secciones + README +7/-4; cero código, cero tests tocados).
- Slice F4-6 (cerrado): T8 1bbf684.
- [ ] T9 (inline): readback + spot-check + verificación + reporte — IN PROGRESS.
- [ ] T8 (writer W6): no-regresión + SEARCH_IMPLEMENTATION.md. Commit 6.
- [x] T9 (inline): readback + spot-check + verificación + reporte — DONE. Spot-check parent: fase4_find 26/26. SEARCH_IMPLEMENTATION.md: 9 secciones + 4 sub. Assess REHUSADO (untracked-declaration; runtime no elegible) → tier high → self-verify por slice + independent verifier: PASS (typecheck/build 0, py 42/42, mjs 227 total, smoke ok, doctor exit 2 ambiental). Outcome nativo: unavailable.
- Cadena F4 (feature-branch-chain, slices F4-1..6): fb4ac51 T3, 0a97878 T4, c1e0d3d T5, 447d56c T6, 196e85f T7, 1bbf684 T8. Push/PR/merge: decisión del usuario.

## Progress
- En odd/fase-3-p1-policy @ 10cb870.

## Verification evidence
- (pendiente por work-unit)

## Next step
- Cerrar T2, crear rama, lanzar W1.

## TDD resolution
- no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Commits
- (pendiente; Conventional en odd/fase-4-search)
