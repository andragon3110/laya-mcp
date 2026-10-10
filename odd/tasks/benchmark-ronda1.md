# ODD Feature: benchmark-ronda1

## Objective
Benchmark interno ronda 1: 6 backends descargables + Laya baseline sobre las 5 primitivas de decisión (classify/screen/gate/rerank/find), con corpus independiente ≥10 EN+ES por primitiva, lanes documentados y manifiestos versionados, para declarar qué modelo es mejor para laya-mcp.

## Problem
EVALUATION.md §7.8 + S6: el corpus independiente (10 casos, n=2 por celda, 6 suites en 0) no puede rankear backends; `check()` acopla señales al stub; no hay lanes para los nuevos modelos ni slice por idioma. Medir sin ronda 0 da números, no un ganador.

## Why
Decidir con evidencia el backend de la reanudación (d1-3B vs componer-por-primitiva), cumpliendo el requisito EN+ES del proyecto.

## Scope (decisiones del usuario 2026-10-09)
- Ronda 1: d1-3B (GGUF CPU) + Qwen3-Reranker-0.6B + GLiClass-multilang-mini + PolicyLM-1.7B + Prompt Guard 2 86M + gte-multilingual-reranker-base + Laya baseline. Ronda 2: d1-omni-600M-exp + head NLI mmBERT (requiere entrenar).
- Corpus primero (criterio S6), CPU para todo (RTX 3050 6GB: d1-3B bf16 no entra), decisión-primero (classify/screen/gate/rerank/find; resto ronda 2).
- Rama `odd/benchmark-ronda1`. Sin commits salvo work-unit explícitos del flujo ODD; sin push/PR/merge (decisión del usuario pendiente).

## Constraints
- Entorno: Python 3.14 (verificar compat torch/transformers), venv nuevo `py/.venv-r1` (no tocar venvs ajenos), sin descargas de pesos hasta T5.
- Cero texto generado como juicio: los backends nuevos entran por lanes documentados (precedente Qwen `liveRerankPredictFactory`).
- Golds independientes fijados desde el input, sin inventar señales (`winner_probability` TBD hasta T3).
- Español rioplatense-neutro para casos ES.

## Backends y puertos (ronda 1)
| Backend | Sidecar | Puerto | Revisión env |
|---|---|---|---|
| laya (baseline) | py/laya_server.py | :8765 | LAYA_MODEL_REVISION |
| qwen-rerank | py/qwen_rerank_server.py | :8768 | RERANK_MODEL_REVISION |
| d1-3B (GGUF) | py/d1_server.py (nuevo) | :8769 | D1_MODEL_REVISION |
| gliclass-mini | py/gliclass_server.py (nuevo) | :8770 | GLICLASS_MODEL_REVISION |
| policylm-1.7b | py/policylm_server.py (nuevo) | :8771 | POLICYLM_MODEL_REVISION |
| prompt-guard-2-86m | py/promptguard_server.py (nuevo) | :8772 | PROMPTGUARD_MODEL_REVISION |
| gte-multi-reranker | py/gte_server.py (nuevo, o lane compartido :8768) | :8773 | GTE_MODEL_REVISION |

## Checklist
- [ ] T1 (worker): venv `py/.venv-r1` + torch CPU + transformers≥5.14 + probes (versiones, cuda visible, GGUF soportado). Sin pesos.
- [ ] T2 (worker): draft corpus `evals/corpus-r1/` — 12 casos (6 EN + 6 ES) × 5 primitivas, truth humana, señales TBD. Sin tocar suites.
- [ ] T3 (parent): revisar golds del draft (truth humana requiere sign-off).
- [ ] T4 (worker): harness — desacoplar `check()` (decisión vs señal) + slice EN/ES en métricas + pins de revisión por backend.
- [ ] T5 (worker): sidecars + lanes CPU para los 6 backends + smoke `--live` por lane.
- [ ] T6 (worker/verifier): corridas live + manifiestos `evals/results/vN/` + tabla de ranking por primitiva e idioma.
- [ ] T7 (parent): informe ganador + plan ronda 2. Sin push/PR.

## Authorized scope
odd/tasks/benchmark-ronda1.md, evals/corpus-r1/, evals/*.mjs (lanes+scoring+métricas), py/*_server.py (nuevos sidecars), py/.venv-r1/, evals/results/vN/ (nuevos).

## Acceptance criteria
- `node evals/run.mjs` 98/98 intacto (stub default sin cambios); cada lane `--live` con backend caído sale exit 2 (no fallback silencioso); ranking por primitiva×idioma con n≥10 publicado en `evals/results/vN/`.

## Applicable checks
- Estructura + harness existente (run/score/bench/manifest) en verde tras T4; probes live documentados en el feature doc.

## Progress
- 2026-10-09 creado desde decisiones del usuario (alcance 6+Laya, corpus-primero, CPU, decisión-primero). T1 task-mode + T2 background lanzados en paralelo.
- T1 DONE: `py/.venv-r1` (Python 3.14.8, torch 2.14.1+cpu, transformers 5.19.0, safetensors 0.8.0, hub 1.33.0, numpy 2.5.3). transformers importa limpio en 3.14; GGUF nativo vía `from_pretrained(gguf_file=...)`, sin llama-cpp. Veredicto: READY. T2 background en curso (corpus 60 casos).
- T2 sigue corriendo (última actividad: write). T5a (gliclass :8770, policylm :8771 rev v1.2, promptguard :8772 con posible gate) y T5b (d1-GGUF Q4 :8769, gte :8773, smoke qwen :8768) lanzados en background en paralelo — superficies disjuntas de T2. Lanes de evals quedan para T4/T6 tras revisar corpus.
- T3 DONE (sign-off parent): 60/60 golds aprobados. Flaggeados resueltos KEEP: classify-en-ambiguous-01 (perf-wish→feature), classify-es-ambiguous-01 (clipped-button→bug), rerank-en-negative-01 (tie-by-irrelevance→input order ALLOW, preserva asimetría v1 vs find ESCALATE), find-en-abstention-01 (lone-candidate→ESCALATE). S6: 12 independientes/primitiva (6 EN+6 ES) + 2 v3 = 14 ≥ 10. Notas T4: screen `abstained` ausente→false; gate `verdicts` array vs singular; ties find se scorean por decision+abstained, nunca winner; sin señales en golds (verificado mecánico + lectura). T4 DONE (verificado parent: `run.mjs` 98/98 default y 158/158 con `--corpus r1`; superficies limpias). Loader r1 opt-in + scoring desacoplado + slices EN/ES + pins D1/GLICLASS/POLICYLM/PROMPTGUARD/GTE + gate-ABSTAIN normalizado (RED→GREEN registrado por worker). S6 estructuralmente evaluable (14 independientes/primitiva en las 5 foco). Queda T5a-fix/T5b (sidecars) para T6 corridas live.
- T5b DONE: d1-3B-GGUF Q4 infiere vía legacy dequant path (arch lfm2 sin entrada nativa en GGUF_ARCHS pero funciona; `ValueError` directo documentado). GTE OK tras repair de buffers meta-device (corrección caller-side, RED→GREEN). Qwen lane intacto. HALLAZGO: d1 lento en CPU (~2-3 min/req, posible modo generate en vez de single-pass) y respuestas con loop repetitivo — veredicto de latencia d1 queda para medición T6b con el sidecar tal cual + nota de optimización pendiente. venv sumó gguf/accelerate/fastapi/uvicorn/pydantic (deps declaradas).
- T6 dividido: T6a lanes (background, wiring + smoke 1 caso/lane, sin matriz) para sign-off parent del mapeo antes de medir; T6b matriz completa después (incluye setup Laya :8765 con pesos).
- T6b DONE: matriz 6 backends × 5 primitivas sobre r1 (60 independientes), manifests v5(laya) v6(gliclass) v7(policylm) v8(qwen) v9(gte) v10(d1). Laya venv propio (laya 0.3.29, english 804MB + multilingual 615MB). Timeout lane 120s→600s uniforme (adjudicación congelada). Anomalías: d1 gate 9/12 THREW (techo undici 300s < budget 600s, dato no falla); bench --live crashea en rerank e2e (budget 8s vs CPU); laya gate task 0/12 (todo INSUFFICIENT_EVIDENCE con support 0.83-0.98). T7: análisis parent + informe.
- T6a DONE: lanes r1 para las 5 primitivas (classify←laya/d1/gliclass; screen←laya/d1/policylm; gate←laya/d1; rerank←laya/qwen/gte; find←laya/qwen/gte/d1-choice), adjudicación documentada (argmax→winner, noul verbatim, ties en handlers, abstentions por omisión de keys). Smoke 1 caso/lane OK (d1 bug@1.0, gliclass bug@0.969, qwen/gte órdenes correctos).
- Sign-off parent pre-matriz: (1) d1 ~4min/caso → subir timeout UNA vez, uniforme para todos, registrado; MAX_NEW_TOKENS intacto; TIMEOUT como dato, no como falla. (2) policylm screen corre as-is (ESCALATEs esperados); accuracy por-leg en T7 desde rows crudos, sin tocar scoring. (3) loader d1 (legacy dequant, snap bb1e436e) va en notas del manifest. (4) setup Laya en T6b (venv nuevo, english+multilingual). T6b lanzado en background (rápidos primero, d1 último, un manifest por backend).
- T5a DONE con 3 bloqueadores honestos: gliclass sin paquete `gliclass` (BLOCKED-dep), policylm helper exige transformers<5.0 vs 5.19 del venv (BLOCKED-env), promptguard 401 gated sin token (BLOCKED-gated, no se piden credenciales). Servidores compilan y responden /live//ready//models con la forma del template. T5a-fix lanzado (pip gliclass en .venv-r1 + venv nuevo .venv-r1-policylm con requirements 4.x; promptguard fuera de scope por decisión del usuario 2026-10-09: PG2 sale de ronda 1 (gateado). Ronda 1 = 5 modelos + Laya; screen-binario vacante, PolicyLM cubre safety/custom-policy).
- T5a-fix DONE: GLiClass infiere EN+ES (load 3.3s, ~3s/msg CPU, scores discriminativos 0.996 vs 0.0002, sin parches al server). PolicyLM infiere EN+ES en venv nuevo (transformers 4.57.6 OK en py3.14) pero LENTO en CPU laptop: load 73s, 19-25s/msg — hallazgo para el veredicto calidad-vs-latencia y T6 bench. Servidores detenidos; nada persistente.

## Commits (2026-10-10, work-unit split per gentle-ai-work-unit-commits)
- `264b0ef` feat(evals): r1 corpus 60 golds (T2/T3) — inert data.
- `99964ec` feat(evals): live-lane harness + abstention scoring (T4/T6a) — 98/98 stub, 158/158 r1.
- `8968691` feat(py): CPU sidecars :8769-:8773 (T5a/T5a-fix) — py_compile OK.
- (this commit) docs(evals): matrix manifests v5-v10 (T6b) + this record.
Local branch only; no push/PR/merge (user decision pending).
