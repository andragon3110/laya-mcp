# ODD Feature: fase-7-eval

## Objective
Infraestructura reproducible de evaluación: evals/ con harness común + 10 suites con datasets honestos, métricas semánticamente válidas por primitive, wrong_confident_rate, veredicto de calibración, benchmarks, reproducibilidad versionada + EVALUATION.md. Sin optimizar para métricas, sin tocar thresholds.

## Problem
Sin evals/ ni harness ni datasets ni oráculos (verificado); stubs usan respuestas enlatadas arbitrarias; scores no calibrados llamados señales honestas pero sin veredicto formal; benchmark vivo ±Laya imposible aquí. Fuente: código > docs > prompt.

## Why
Fase 7 lo exige; tests/stubs/metrics/capabilities reutilizables sin redefinir.

## Scope
- `evals/` nuevo (harness + 10 suites + datasets + oráculos + runner + results versionados), `tests/` baterías que lo ejerciten, docs + `EVALUATION.md`.
- Rama: `odd/fase-7-eval` apilada sobre `odd/fase-6-gentle-observe` @ b26e50a (herencia feature-branch-chain).

## Constraints
- Cero cambios funcionales en src/ (solo evals+tests+docs); thresholds intactos (probar que no se tocan).
- Datasets honestos: normales/ambiguos/difíciles/adversariales/negativos/abstención; nada de solo-favorables.
- Métricas solo donde válidas (rerank: ranking no thresholds; Brier/ECE: no aplica sin probabilidad — documentarlo, no calcularlo indebidamente).
- wrong_confident por primitive con su señal (excluir nulls/abstenciones del denominador donde corresponda).
- Benchmarks absolutos + método; sin claims sin datos comparables; integración ±Laya: harness comparable + requisitos futuros, sin inventar resultados.
- Resultados versionados, nunca sobrescritos sin versión.

## Authorized scope
Lectura total + escritura en Scope. Prohibido: tocar src thresholds/semánticas/robustez, push/PR/merge.

## Acceptance criteria
- [ ] evals/{10 suites} con harness común sin lógica duplicada.
- [ ] datasets 6 clases por suite.
- [ ] métricas válidas por primitive + Brier/ECE/veredicto calibración honestos.
- [ ] wrong_confident_rate τ=0.70/0.80/0.90/0.95 por primitive (o "no aplica" justificado), nunca como threshold prod.
- [ ] benchmarks primitives + rerank 10-1000 + manifest reproducibilidad.
- [ ] integration benchmark comparable (o imposibilidad documentada con requisitos).
- [ ] EVALUATION.md + evals/results/ versionados; criterio §11 respondible por corrida.

## Applicable checks
- typecheck, build, py 42/42, mjs (378+73=451) + nuevos, smoke LAYA_SKIP, doctor --no-live.
- TDD: no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Delivery strategy
- ask-on-risk + feature-branch-chain heredada. Slices por work-unit. Push/PR/merge usuario.

## Tasks
- [x] T1 (delegated, mapping): mapa eval-readiness — DONE (sin evals; stubs reutilizables; métricas válidas por primitive; wrong_confident por señal; rerank inválido; integración no ejecutable).
- [x] T2 (inline): feature doc + mirror + rama odd/fase-7-eval apilada sobre b26e50a — DONE.
- [ ] T3 (writer W1): harness común + 10 datasets + oráculos — IN PROGRESS (W1).
- [x] T3 (writer W1): harness + datasets — DONE (commit 0b98c04; evals/run.mjs + 10 suites × 8 casos = 80 con gold; stubs derivados del oráculo con límites documentados; CERO cambios src/; 80/80 smoke).
- Slice E7-1 (cerrado): T3 0b98c04.
- [x] T4 (writer W2): métricas + wrong_confident + calibración — DONE (commit e6c0b98 +699; evals/metrics.mjs + score.mjs + calibration.md; wrong_confident 0.000 stub en todos τ; Brier/ECE no aplican documentado; 10 tests; CERO src/).
- Slice E7-2 (cerrado): T4 e6c0b98.
- [x] T5 (writer W3): benchmarks + reproducibilidad + results — DONE (commit 3284eaa +2338; evals/bench.mjs + manifest.mjs + results/v1/; tablas absolutas sin claims; 14 tests; CERO src/).
- Slice E7-3 (cerrado): T5 3284eaa.
- [ ] T6 (writer W4): integration comparable + EVALUATION.md + no-regresión — IN PROGRESS (W4).
- [x] T6 (writer W4): integration + doc + no-regresión — DONE (commit ccb9cf1 +925; evals/integration.mjs protocolo ±Laya stub+live-gate; EVALUATION.md 330 líneas; 12 tests; 1-a-1 vs Fase 6 todo igual; src/+dist/ vacíos; compare sin dataset documentado).
- Slice E7-4 (cerrado): T6 ccb9cf1.
- [ ] T7 (inline): readback + spot-check + verificación + reporte — IN PROGRESS.
- [x] T7 (inline): readback + spot-check + verificación + reporte — DONE. Spot-check parent: evals/run 80/80. EVALUATION.md: 12 secciones (§1-11 + evidencia). Assess REHUSADO → tier high → self-verify por slice + independent verifier: PASS (typecheck/build 0, py 42/42, mjs 487, evals 80+score+bench+integration, smoke ok, doctor exit 2 ambiental). Outcome nativo: unavailable.
- Cadena E7 (feature-branch-chain, slices E7-1..4): 0b98c04 T3, e6c0b98 T4, 3284eaa T5, ccb9cf1 T6. Push/PR/merge: decisión del usuario.

## Progress
- En odd/fase-6-gentle-observe @ b26e50a.

## Verification evidence
- (pendiente por work-unit)

## Next step
- Cerrar T2, crear rama, lanzar W1.

## TDD resolution
- no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Commits
- (pendiente; Conventional en odd/fase-7-eval)
