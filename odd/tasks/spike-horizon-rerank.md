# spike-horizon-rerank — Horizon multilingual-reranker-base vs Qwen (spike acotado)

## Why
Usuario aprobó 2026-10-11 (ronda2-models orden #2). Horizon
(`Horizon-Labs/multilingual-reranker-base`): 308M mmBERT, 40+ lenguas,
destilado de Qwen3-Reranker-4B (13x más chico), Apache-2.0, ONNX, ES de
primera. Duelo directo por el lane con dueño: Qwen3-0.6B CUDA 123.9ms
vs Horizon en CPU. Gana quien separe mejor EN+ES en find/rerank con
mismo protocolo (lane `liveRerankPredictFactory`, scores within-call).

## Stages
- S1: bajar weights (~1.2GB) con `py/.venv-r1` + adapter lane rerank/find
  (cross-encoder query+candidate, mismo shape que `py/qwen_rerank_server.py`);
  sidecar `py/horizon_rerank_server.py` en puerto libre (sugerido :8774).
  Smoke 1 caso por lane (EN+ES).
- S2: correr r1 find/rerank (20) + independientes find/rerank + v2-find con
  mismos oráculos; medir latencia warm CPU vs Qwen CUDA + gaps de score.
- S3: veredicto adoptar/empatar/descartar + fine-tune-abilidad (¿destilable
  con nuestras filas duras? ¿entra SFT en 6GB?).
- Afinado: solo con veredicto + aprobación explícita posterior; este spike
  no entrena nada.

## Reglas
- Time-box: setup >1h ⇒ registrar y frenar. Sin tunear con evals. Sin push.
  Sin tocar `:8768` (Qwen sigue UP para el duelo). Puertos/venvs según
  `odd/tasks/benchmark-ronda1.md`. Superficies: `py/horizon_rerank_server.py`,
  este doc.

## Veredicto S3 — ADOPTAR como lane default con fallback Qwen (parent sign-off 2026-10-11, promoción pendiente OK usuario)
Duelo 28 casos, oráculos idénticos: r1-rerank Horizon 11/12 vs Qwen 10/12 (Horizon acierta el adversarial que Qwen miss), r1-find 10/10 ambos en orden (misses estructurales compartidos en golds `none`), independientes 4/4 ambos. Latencia warm CPU 48-150ms a la par/mejor que Qwen CUDA ~117ms — libera ~2.5GB VRAM. Gana estrecho pero consistente + robustez adversarial 3/3 + encaje perfecto (Apache-2.0, ONNX, CPU, SFT cabe con LoRA). Riesgos asumidos: gaps ES-normales más estrechos, find-ES-adversarial 0.0173 fila dura para destilar. Promoción = cambio de comportamiento: requiere OK explícito. Qwen :8768 queda como fallback en cualquier caso.

## Progress
- 2026-10-11 S1+S2 DONE (worker, medición solamente; sin tuning/entrenar/umbrales/push; `:8768` Qwen intacto, `manifest --save` no corrido, sin commits).
  - Setup wall time: ~3 min (dentro del time-box 1h). `snapshot_download(Horizon-Labs/multilingual-reranker-base)` con `py/.venv-r1` python → solo HF cache (`~/.cache/huggingface/hub/models--Horizon-Labs--multilingual-reranker-base/`, 3.0G con ONNX+fp32; nada en el repo). Arquitectura real: `ModernBertForSequenceClassification` (1 logit, `sigmoid`), no CausalLM yes/no — scoring = `tok([query]*N, docs)` + `logits[:,0].sigmoid()`, `HORIZON_MAX_LENGTH=384` (ventana de entrenamiento según la card). transformers 5.19 la carga limpio en CPU (138 tensores, fp32 ~1.2GB).
  - S1: `py/horizon_rerank_server.py` (nuevo) espeja el shape de `py/qwen_rerank_server.py` (mismo contrato `/rerank`, mismos 413/503+Retry-After, `instruction` aceptada pero IGNORADA y eco `""`, envs `HORIZON_*`), sidecar en :8774 (libre; :8770 ocupado). Smoke 4/4: rerank EN a>b gap 0.7617, rerank ES a>b gap 0.9873, find EN a gap 0.9938, find ES-adversarial b>a gap 0.0173 (correcto pero estrecho) — warm CPU 115-200ms.
  - S2: duelo `/tmp/duel.mjs` (fuera del repo) con oráculos idénticos, ambos warm (2 descartes), latencia = `latency_ms` del server. 28 casos: r1-rerank 12 + r1-find 12 + suite-independents 4. v2-find: N/A (no existe corpus v2-find; `corpus-v2/` = classify/gate/screen y `validate-v2.mjs` confirma "no rerank lane").
    - r1-rerank (12): Horizon 11/12 (avg_gap 0.3532, min 0.0000, avg_srv 90.3ms) vs Qwen 10/12 (avg_gap 0.5082, min 0.0000, avg_srv 123.4ms). Miss Horizon: `en-negative-01` (tie-epsilon b,a gap 0.0001; Qwen también lo miss con gap 0.0000 — empate por irrelevancia, no señal). Horizon ACIERTA `en-adversarial-01` (b>a gap 0.0150) que Qwen miss (elige stuffing, gap 0.0016).
    - r1-find (12, winner=top-1): 10/12 ambos (avg_gap 0.4562 vs 0.4551; avg_srv 94.0 vs 109.8ms). Los 2 misses de cada lado son `en/es-negative-01` (gold `none`): el lane rerank→find siempre elige (force-pick estructural, no fallo de orden). Adversarial: Horizon gaps más anchos (EN 0.0722 vs 0.0214; ES 0.0173 vs 0.0007).
    - suite-independents (4/4 ambos): rerank avg_gap 0.9203 vs 0.9923; find avg_gap 0.7126 vs 0.9563 (find-independent-01: Horizon a=0.4515 vs Qwen a=0.9162 — mismo orden, menos decisión).
    - Latencia warm CPU (Horizon, pares de 2 cands): 48-150ms server-side, a la par o mejor que Qwen CUDA (medido 98-138ms, avg ~117ms; referencia 123.9ms). ES tiende alto en ambos (~125-150ms).
    - Patrón: Horizon separa MEJOR el stuffing adverso (3/3 adversarial correctos, gaps 4-25x los de Qwen) pero con gaps ES-normales/cross más estrechos (difficult-ES 0.2654 vs 0.9650; cross-ES 0.3391 vs 0.9737; `en-difficult` ambos flojos ~0.26-0.33).
  - Fine-tune-abilidad (nota, sin entrenar): SÍ destilable — cabeza seq-cls estándar (1 logit) + pares (query, passage, label); target ideal = Qwen3-Reranker-4B (su propio teacher) o Qwen-0.6B + nuestras filas duras (adversariales ES, difficult-ES). SFT en 6GB: SÍ con LoRA o bf16+Adam8bit (fp32 full-finetune ~5GB solo en estados ≈ justo; 384 tokens ayuda); int8 ONNX de 641MB ya incluido para deploy CPU. Sidecar Horizon :8774 corriendo (pid 3002965, `py/.venv-r1`) para verificación del parent; bajarlo con `kill 3002965`.
