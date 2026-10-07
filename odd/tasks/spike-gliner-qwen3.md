# ODD Feature: spike-gliner-qwen3

## Objective
Correr el spike A/B con backends reales: `fastino/GLiNER2.5-multi-Decide` (classify/gate/screen) y `Qwen/Qwen3-Reranker-0.6B` (rerank/find) en modo `--live` contra el corpus independiente, comparando con la baseline v2 del stub. Veredicto: ¿discriminan o no?

## Problem
El harness quedó spike-ready (PRs #18+#19 mergeados) pero nunca midió un backend real. Recon 2026-10-07 (explorer ses_ee874ccbcffeewLfY0LDK24RxW): torch/transformers/gliner2 ausentes en Python 3.14.8; `connectLiveBackend` solo conecta LayaClient+GlinerClient (Qwen3 necesita carril nuevo); rerank/find tienen 0 golds independientes; pins validados en Python 3.11.9 (riesgo de ruedas en 3.14).

## Why
Es el motivo de todo el trabajo previo: saber si existe un modelo local liviano que supere a Laya y justifique el unpause. Sin medición live, todo número vendor es hipótesis.

## Scope
Rama `odd/spike-gliner-qwen3` sobre `main@a2ce4f1`. Incluye: env (venv+pip+HG downloads, sin tocar pins todavía), 2 servidores nuevos (:8767 decide, :8768 rerank), carril RerankClient en live-client, golds independientes para rerank/find, runs live + results versionados por backend, análisis con ECE/AUROC/histogramas. Si hay discriminación: recalibrar thresholds como follow-up (S6). Modernización general de deps/TS: S7 acotada (auditoría + minors seguros con tests en verde).

## Constraints
- Taus siguen solo reporte; thresholds prod (`src/policy/thresholds.ts`) solo se tocan en S6 y solo con evidencia de discriminación.
- `evals/results/v1|v2` intactos; nuevos runs en `v3+` por backend.
- Pesos en caché HF (no en el repo). `package-lock.json` y pins Python no se ensucian sin decisión explícita.
- Test-first donde aplique; si no, excepción explícita.
- ~400 líneas/task es heurística de planning, no cap: los servidores nuevos la excederán por naturaleza (se explica, no se recorta).

## Checklist
- [x] S1 env: venv + torch CPU + transformers + gliner2 + descargas + smoke-load de ambos modelos — DONE venv `~/.venvs/s1-spike-gliner-qwen3` py3.14, torch 2.14.1+cpu, transformers 4.57.6, gliner2 2.0.0; snaps a35a0cd (1.1GB) + e61197e (1.2GB); smokes OK. Route: delegated direct.
- [x] S2 servidor decide :8767 (plantilla gliner_server) + checks doctor — DONE nuevo server + 3 checks doctor, classify ES OK (63ms caliente). Route: delegated direct.
- [x] S3 servidor rerank :8768 + carril RerankClient en live-client + probes — DONE server CausalLM yes/no + carril live + 3 checks doctor, rerank ES OK (178ms caliente CUDA). Nota: `RERANK_DEVICE=cpu` no verificado (solo path auto→cuda). Route: delegated direct.
- [x] S4 golds independientes rerank/find + runs live + results v3+ por backend — DONE 4 golds (rerank/find x2 EN+ES), censo 10/88/98, `v3` stub 98 + `v4` live Laya+Qwen (Qwen 4/4 independientes). Route: delegated direct.
- [x] S5 análisis: discriminación, ECE/AUROC/histogramas, veredicto por primitiva — DONE §7.8: Qwen discrimina fuerte (gaps ≥0.986); Decide 6/6 labels (n=2, sin scores); Laya sin discriminación probada salvo find. Decisión S6: NO. Route: delegated direct.
- [x] S6 (condicional: solo si S5 muestra discriminación) recalibrar thresholds + tests — SKIPPED por decisión S5 (NO: fallas de juez no las arregla ningún threshold; screen necesitaría ≥10 independientes). Thresholds intactos.
- [x] S7 modernización acotada Node/Python + verificación final + cierre — DONE lock-only (SDK 1.30→1.32.1 audit 1high→0, types 22.20.4→22.20.5), resto retenido con razón, §9.1 docs. Batería completa verde. Route: delegated direct.

## Authorized scope
py/gliner_decide_server.py
py/qwen_rerank_server.py
py/doctor.py
py/requirements.txt
evals/live-client.mjs
evals/suites/*.mjs
evals/manifest.mjs
evals/score.mjs
evals/bench.mjs
evals/results/
EVALUATION.md
odd/tasks/spike-gliner-qwen3.md
package.json
package-lock.json
tsconfig.json

## Acceptance criteria
- Ambos modelos cargan y responden en CPU con latencia/memoria medidas y registradas.
- Runs `--live` sobre el corpus independiente versionados en `v3+` por backend, comparables con v2.
- Veredicto de discriminación por primitiva con números (no adjetivos), más decisión S6 sí/no.
- `node evals/run.mjs` sigue 94/94+ en stub default; v1/v2 intactos; thresholds intactos salvo S6.
- Feature doc registra commit IDs por task.

## Applicable checks
- `node evals/run.mjs`, `node evals/bench.mjs`, `node --test tests/` o suites estructurales, `git diff --stat`, `git status --short`.
- Servidores: smoke `/ready`+`/models`+1 inferencia real por server.

## Progress
- 2026-10-07 rama odd/spike-gliner-qwen3 creada desde main@a2ce4f1. Recon completo (env + contratos + riesgos).
- 2026-10-07 S1 DONE (worker general ses_ee8519e4bffe12abUaHtP3SUgj): py3.14 venv, ambos modelos en CPU con smokes correctos. Qwen3 es CausalLM sin head (patrón logits yes/no para S3).
- 2026-10-07 S2 DONE (worker general ses_ee84dfed7ffeq4yIxnt6MNhKcA): server :8767 + doctor, classify ES OK. Nota: sirvió con `~/laya-mcp/.venv` (S1 venv sin fastapi); S3 usa mismo python o instala fastapi en S1.
- 2026-10-07 S3 DONE (worker general ses_ee849cca8ffeRpWwPtWHOGpa5N): server :8768 + carril RerankClient + doctor. Fix device: batch al device del modelo. :8768 queda corriendo para S4.
- 2026-10-07 S4 DONE (worker general ses_ee8446af1ffePTXrsMJ10PJR82): 4 golds rerank/find, v3 stub + v4 live. :8765/:8767/:8768 quedan encendidos. Nota: `score --live` reescribe `artifacts/evals-t4-metrics.json` (restaurar tras runs).
- 2026-10-07 S5 DONE (worker general ses_ee83accfcffeKcupqWIKdM9GVN): §7.8 con veredictos + S6 NO. S6 SKIPPED (criterio: ≥10 independientes + corte fuera del gap).
- 2026-10-07 S7 DONE (worker general ses_ee838171bffev6xQivGqES4VI1): modernización lock-only + verificación final. Feature completo (S6 skipped con criterio = DONE).
- 2026-10-07 push autorizado: `odd/spike-gliner-qwen3` → origin (6 commits hasta f956f84), in sync. PRs pendientes de autorización.
- Forecast: grande (~1200 líneas autoradas; servidores nuevos exceden la heurística por naturaleza). Estrategia: stacked-to-main (cacheada). Running: ~1200. Slice 1: 59da599+44c58cc+e293c66; slice 2: 32b448d+e01ca71+commit de cierre.

## Verification evidence
- S1: venv `~/.venvs/s1-spike-gliner-qwen3` py3.14.8, torch 2.14.1+cpu (cuda False), 9/9 + 14/14 archivos HF. GLiNER smoke 3/3 (ES 0.993) ~0.06s/texto RSS ~2931MB; Qwen3 smoke ranking correcto (0.9996 vs resto) batch 1.07s RSS ~3861MB. Repo intacto (`git status`: solo este tracking).
- S2: `node evals/run.mjs`: 94/94. Server :8767 `/ready` 200 cálido, `/models` loaded true, `POST /classify` ES → trabajo (63ms caliente, 8s con carga). Parent spot-check: diff solo superficies, 94/94 re-ejecutado OK.
- S3: `node evals/run.mjs`: 94/94 stub default. :8768 `/ready` 200 post-warm, `POST /rerank` ES top password 0.9996 (178ms caliente CUDA). Carril live e2e OK; `score --live` sigue exit 2 por laya :8765 caído (refusal intacto). Parent spot-check OK.
- S4: `node evals/run.mjs`: 98/98. `manifest --save` → v3; `manifest --save --live` → v4 (Qwen 4/4 independientes; Laya-live: classify 0.889, gate 0.222, etc.). Baterías 10+14+12 checks passed. Parent spot-check: v3/v4 presentes, v1/v2 intactos, 98/98 re-ejecutado OK.
- S5: `node evals/run.mjs`: 98/98. Solo `EVALUATION.md` +118 (§7.8). Parent spot-check OK. Thresholds intactos, v1-v4 intactos.
- S7: `npm audit`: 0 vulns (SDK 1.32.1). `npm run typecheck/build`: limpios. `node evals/run.mjs`: 98/98. Estructurales 10+14+12 passed. Solo `EVALUATION.md` +16 y `package-lock.json` lock-only. Parent spot-check: 98/98 + audit 0 re-ejecutados OK.
- Ningún check fallido, skipeado o pendiente salvo `node --test tests/` (preexistente: las suites corren como scripts directos, no vía runner).

## Next step
- Decisiones del usuario: (1) push de `odd/spike-gliner-qwen3` + PRs apilados (slice 1: env+servers; slice 2: runs+análisis+modernización); (2) RDD clone switch; (3) ramas remotas no mergeadas restantes; (4) banquillo si se quiere (gte/bge-m3, SmolLM2).

## Delivery
- Estrategia: stacked-to-main (cacheada del feature anterior). Slices se definen al cerrar (probable: env+servers / runs+análisis / modernización).
