# ODD Feature: harness-spike-ready

## Objective
Dejar el harness de evals spike-ready para discriminar backends live (GLiNER2.5, Qwen3-Reranker, etc.), sin integrar modelos nuevos todavía.

## Problem
Mapeo 2026-10-07 (explorer ses_ee88f1dd4ffeN3jbK0GxSahXFv + spot-check parent): el harness valida plumbing bajo stubs oracle y transfiere cero calidad al backend real. Bloqueos concretos: INT-03 desalineado (integration.mjs REVIEW/REVIEW vs EVALUATION.md ESCALATE/ESCALATE), `compare` sin bench row + `capabilities` sin suite, cap de transporte 64 en rerank, sin adaptador live, golds atados al stub, `model_revision`/`device` en nulls.

## Why
Sin estos fixes, cualquier spike A/B con los candidatos nuevos pasaría/fallaría contra oráculos del stub, no contra verdad. Queremos algo de calidad antes de probar modelos.

## Scope
Rama `odd/harness-spike-ready` sobre `b90489c`. Solo harness + docs. Sin pesos nuevos, sin integrar GLiNER2.5/Qwen3, sin cambiar thresholds de producción. No push/PR/merge (decisión del usuario).

## Constraints
- Taus `WRONG_CONFIDENT_TAUS` siguen siendo solo reporte; nunca promover a cortes prod.
- `src/policy/thresholds.ts` no se toca (v1 + RISK_CUT_DELTA 0.05 intactos, solo lectura).
- No reescribir FINAL_REPORT histórico; solo addendum si hace falta.
- Heurística ~400 líneas por task solo para planificar; nunca recortar tests ni vaciar espacios para encajar.
- Test-first donde aplique: RED observable antes de GREEN solo si hay runner determinista + outcome claro; si no, excepción explícita con checks proporcionales.

## Checklist
- [x] T1 alinear INT-03 (gold REVIEW/REVIEW vs docs ESCALATE/ESCALATE) — DONE docs→código (EVALUATION.md:231 `untested-change-review` ALLOW,ALLOW,REVIEW,REVIEW; thresholds intactos). Route: delegated direct. Trigger evidence: lectura que prepara write (solo docs cambió).
- [x] T2 bench row `compare` + cobertura `capabilities` — DONE exclusión explícita justificada (compare rompería freeze 10 filas + re-record v1, pertenece a T5; capabilities es descubrimiento sin oráculo, cubierto en fase6). Route: delegated direct.
- [ ] T3 protocolo N>64 para rerankers — route: delegated direct. Trigger evidence: bench.mjs cap 64 + protocolo nuevo + docs.
- [ ] T4 adaptador LayaClient-live en score/bench (stub sigue default) — route: delegated direct. Trigger evidence: 2+ non-trivial files + broad research liviana.
- [ ] T5 corpus gold independiente del stub + results versionados por backend — route: delegated direct. Trigger evidence: suites + manifest + results/vN nuevos.
- [ ] T6 verificación + work-unit commits + docs de cierre — route: delegated direct (verificación con writer self-check + parent spot check). Trigger evidence: full suites delegadas.

## Authorized scope
evals/integration.mjs
evals/bench.mjs
evals/score.mjs
evals/manifest.mjs
evals/run.mjs
evals/calibration.md
evals/suites/*.mjs
EVALUATION.md
odd/tasks/harness-spike-ready.md
evals/results/
tests/*.mjs

## Acceptance criteria
- `node evals/run.mjs` 88/88 o el nuevo total documentado pasa; INT-03 alineado entre código y docs.
- `compare` tiene bench row o exclusión explícita justificada; `capabilities` tiene suite o exclusión explícita.
- Protocolo N>64 documentado y ejercitado en bench sin romper el cap actual por default.
- Adaptador live existe tras flag/env, stub sigue default, `model_revision`/`device` reales cuando hay backend (no inventados).
- Corpus independiente existe y un `results/vN` por backend es reproducible vía manifest.
- `git status` limpio salvo tracking; feature doc registra commit IDs por task.

## Applicable checks
- Estructura: `git diff --stat`, `git status --short`.
- Funcionales: `node evals/run.mjs`, `node evals/score.mjs`, `node evals/bench.mjs` (absolutos, sin afirmar calidad backend), `node --test tests/` o el runner que cada task declare.
- Sin tests funcionales solo con excepción explícita (docs-only o sin runner).

## Progress
- 2026-10-07 rama odd/harness-spike-ready creada desde b90489c. Alcance elegido por usuario: Harness spike-ready (sin modelos nuevos).
- Forecast: ~350 líneas autoradas (adds+deletes, generados excluidos), estrategia single-pr, sin chain.
- T2: `node evals/run.mjs`: 88/88. `node evals/bench.mjs`: exit 0 (10 primitivas + sweep + model-load). `node tests/fase7_t5_bench_manifest.mjs`: 14 checks passed. `git diff --stat`: 3 files +41/-2, solo comentarios/docs. Parent spot-check OK.
- 2026-10-07 T1 DONE (writer general ses_ee88bc018ffed0mw49exLbOYSt): docs→código, 88/88 + 4/4 + 12 checks. Commit df0f0bc (T1 work-unit).

## Verification evidence
- T1: `node evals/run.mjs`: 88/88 passed. `node evals/integration.mjs`: 4/4 pass (INT-03 `untested-change-review`). `node tests/fase7_t6_integration.mjs`: 12 checks passed. `git diff --stat`: EVALUATION.md 1+/1-. Parent spot-check: diff mínimo docs→código OK, sin refs a `untested-change-escalate` (grep vacío), thresholds intactos.

## Next step
- Ejecutar T3 con un writer acotado (protocolo N>64 para rerankers, sin romper el cap actual por default).

## Delivery
- Estrategia: ask-on-risk (default). Forecast ~350 < 400, sin chain por ahora. Running: 0 líneas. Slices: ninguno aún.
