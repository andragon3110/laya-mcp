# ronda2-models — plan de mejora para lo que falta + modelos nuevos a probar

## Why
Estado 2026-10-11 (rama `improve-all-functions`, commiteado hasta `531d5c3`):
harness 122/122 + 182/182, contrato hold, 14/14 WORKING en vivo con budget 60s,
score live decisión 62/89 (0.697). Lo que sigue flojo con evidencia:
- Gate: señales Laya overlap (support 0.9096 vs 0.8575), v2 task 0/22 tras
  r3f/r3g/r3h/r3i, live 0/18 a 8s (a 60s da REVIEW en canónica, correctness s/med).
- Screen: gap existe (0.456) pero cortes 0.75/0.25 misplacen (0/2 decisiones S5).
- Decide/review live 3/7. Latencia CPU 1.1–7.6s vs budget default 8s.
- Find aparcado en qwen (sin decisión de promoción). PII sin floors medidos.
  Compare sin bench. Revisions unpinned. Sin comparación ±Laya live.

## Ya probados (NO repetir sin motivo nuevo)
Ronda 1 (matriz v5–v10, r1 60 + v2): Laya english/multilingual/typed-decisions,
Qwen3-Reranker-0.6B (adoptado rerank/find), GLiClass-mini→r3a→r3i (campeón
56/60+56/60), PolicyLM-1.7B, PromptGuard-2-86M, GTE-multilingual-reranker-base,
D1-3B-GGUF (lento CPU ~2-3min/req, gate 9/12 threw). Spikes: Needle
(overconfident), mDeBERTa (peor/vacuo), bge-reranker (empate exacto),
Strands-Decider-2B (pierde gate/screen, gana v2-classify 23/26),
vllm-sr-d3-nano-2B (quiebra v2-gate 16/22 cero-shot pero pierde r1 28/36,
pide GPU). GLiNER-Decide :8767, GLiNER2.5 sidecar actual.
Dato clave heredado: d3-nano 16/22 en v2-gate donde r3h da 0/22 — avenida
abierta: destilar veredictos d3 en filas gate (mecanismo nuevo, requiere
aprobación; el STOP a same-dose sigue).

## Candidatos nuevos (ninguno probado acá todavía)

### A. Clasificación / NLI cero-shot (gap: classify márgenes, gate NLI, calibración)
1. **JevK5-Lite** (`alibiserikbay/JevK5-Lite`) — 437M DeBERTa-v3-large, multi-head
   en un solo forward, declara probabilidades CALIBRADAS por head, bf16 en CPU.
   Vs r3i: promete lo que más falta (calibración) + 10x menos llamadas que
   cross-encoder por item. Spike: lane classify + gate-NLI, medir ECE en los 30
   independientes nuevos además de accuracy.
2. **PrismNLI-0.4B** (`Jaehun/PrismNLI-0.4B`) — 0.4B NLI SOTA en 8 benchmarks,
   cero-shot por entailment. Vs r3i: nativo NLI para gate (support/refute) en
   vez de transfer de clasificador. Spike: lane gate + verify.
3. **EttinX-nli-xs** (`dleemiller/EttinX-nli-xs`) — 32M ModernBERT, MNLI 83.8 /
   SNLI 88.2, CPU mínimo. Vs r3i: apuesta tiny para screen/gate si el gap es
   separable con poco modelo. Spike barato primero.

### B. Rerank multilingüe chico (gap: dueño del rerank, hoy Qwen 0.6B CUDA 124ms)
4. **multilingual-reranker-base** (`Horizon-Labs/multilingual-reranker-base`) —
   308M mmBERT, 40+ lenguas, destilado de Qwen3-Reranker-4B (13x más chico),
   Apache-2.0, ONNX. Vs Qwen-0.6B: mismo linaje distilled-from-Qwen, CPU-able,
   ES de primera. Duelo directo en find/rerank EN+ES.
5. **Querit-Reranker-A0.4B** — 0.4B compacto multilingüe con adaptación sin
   labels. Vs Qwen: candidato si Horizon no separa. Solo si A pierde.
6. **KaLM-Reranker-V1-Small** — FBNL con pasajes pre-codificables. Vs Qwen:
   solo si importa throughput con corpus fijo. Tercera opción.

### C. Guard inyección (gap: screen decisiones 5/12 live)
7. **Llama-Prompt-Guard-2-22M** — hermano chico del 86M ya probado. Vs screen
   r3i: especialista puro inyección vs juez generalista; 22M ≈ gratis en CPU.
8. **protectai/deberta-v3-small-prompt-injection-v2** — DeBERTa-v3-small
   fine-tune inyección. Duelo contra 7 en los 20 independientes screen.
9. **ZeroLeaks/shield-small** — 118M, int8 ONNX, CPU local. Tercera opción.
   (VGE/vigil solo si hace falta bilingüe extra; no priorizar.)

### D. PII (gap: floors sin medir, 3 secret types)
10. **pii-redactor-small** (`Horizon-Labs/pii-redactor-small`) — 141M, 29 tipos,
    30+ lenguas, CPU-friendly. Vs GLiNER2.5 actual y vs GLiNER2-PII 300M/42
    (ya documentado en T7): triangular los 3 en ES+EN con P/R por tipo en
    benchmark REDACT (`guneeshvats/REDACT-PII-Benchmark`, 51 tipos, 25 lenguas)
    antes de tocar `secretTypes`.
11. **cee-pii** (`flowxai/cee-pii`) — ~300M, 34 tipos, peso CEE + US/UK IDs.
    Solo si el triangular muestra hueco en IDs con formato.

## Protocolo spike (igual que los 6 veredictos previos, no se negocia)
- Time-box setup >1h ⇒ registrar y frenar. Sin tunear nada con r1/v2/corpus
  nuevo (medición pura). Sin push. Sin reviews. Sin mover thresholds.
- S1 weights + adapter lane documentado. S2 smoke 1 caso/lane. S3 r1 (60) +
  v2 + 30 independientes nuevos con mismos oráculos y scoring desacoplado.
- S4 veredicto adoptar/empatar/descartar + criterio de promoción (gana claro
  Y encaja local/$0/CPU-salvo-Qwen). Rama `odd/benchmark-ronda1` como
  precedente de puertos/venvs (ronda 2 puede reusar `py/.venv-r1`).

## Orden propuesto (por impacto medido, no por hype)
1. A1 JevK5-Lite (classify+gate-NLI+calibración: ataca 3 gaps a la vez).
2. B4 Horizon-reranker vs Qwen (duelo por el lane con dueño).
3. C7+C8 duelo guards en los 20 screen (barato, CPU).
4. A2 PrismNLI si A1 no separa gate.
5. D10 triangular PII con REDACT (antes de cualquier floor).
6. A3 tiny solo si A1/A2 ganan pero sobran (opción CPU mínima).
7. Avenida d3-gate-distill (necesita tu aprobación explícita: reabre training).

## Mejoras sin modelo (hacer en paralelo, sin spike)
- M1: `LAYA_TOOL_TIMEOUT_MS` default 8s→ documentar budget 60s para CPU o
  subir el default con anuncio (cambia budgets efectivos = breaking menor).
  Evidencia: 4/4 timeouts a 8s responden a 60s.
- M2: decidir promoción find-qwen (12/12 + 124ms CUDA) con criterio escrito.
- M3: fila bench `compare` + re-record vN. M4: pinear
  `LAYA/GLINER/RERANK_MODEL_REVISION` antes de cualquier comparativa live.
- M5: comparativa ±Laya con operador externo (5 requisitos). M6: GPU-venv
  para laya-server si se quiere bajar de 1–7s CPU (hoy repo-venv es CPU-only;
  `~/laya-mcp/.venv` tiene CUDA) — con nota OOM (6GB ya vio 5795/6144).

## Acceptance
- Cada spike con S1–S4 + veredicto escrito en su `odd/tasks/spike-*.md`.
- Ningún threshold movido sin S6 (separación non-overlapping en 10+).
- Ninguna probabilidad declarada sin reliability diagram + ECE medido.
- Cero "mejora" sin brazo pareado versionado (`evals/results/vN/`, nunca
  sobrescribir).

## Alcance autorizado (si aprobás)
`odd/tasks/spike-*.md` (nuevos), `py/*_server.py` (sidecars nuevos),
`py/.venv-r1/`, `evals/results/vN/` (nuevos). Prohibido: push/PR/merge,
tocar train/finetune, mover thresholds, reescribir `v1`–`v20`.
