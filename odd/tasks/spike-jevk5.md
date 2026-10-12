# spike-jevk5 — JevK5-Lite vs r3i (spike acotado)

## Why
Usuario aprobó 2026-10-11 (ronda2-models orden #1). JevK5-Lite
(`alibiserikbay/JevK5-Lite`): 437M DeBERTa-v3-large, clasificador CPU con
múltiples heads en un forward, declara probabilidades calibradas por head,
bf16 en CPU. Ataca 3 gaps a la vez: márgenes classify, NLI nativo para
gate/verify, y calibración (lo que más falta). Comparación contra r3i
(r1 56/60+56/60) + lanes Laya en los 30 independientes nuevos.

## Stages
- S1: bajar weights (~1.7GB) con `py/.venv-r1` (torch CPU + transformers
  5.19 ya listos) + adapter lane classify/gate-NLI según su doc/runtime
  jevk5 0.3.1; sidecar `py/jevk5_server.py` si el runtime lo justifica, o
  lane directo vía transformers. Smoke 1 caso por lane.
- S2: correr r1 (60) + 30 independientes nuevos + v2-classify/gate con
  mismos oráculos y scoring desacoplado. Medir ECE en independientes además
  de accuracy (primera medición de calibración real si el modelo la soporta).
- S3: veredicto adoptar/empatar/descartar + fine-tune-abilidad (¿admite SFT
  continuación estilo r3 con nuestros 699 signed rows? ¿cabe en 6GB?).
- Afinado: solo con veredicto + aprobación explícita posterior; este spike
  no entrena nada.

## Reglas
- Time-box: setup >1h ⇒ registrar y frenar. Sin tunear nada con evals
  (medición pura). Sin push. Sin mover thresholds. Sin probabilidades
  declaradas sin reliability diagram + ECE medido.
- Sin commits salvo work-units del flujo; superficies: `py/jevk5_server.py`,
  este doc. Pesos solo en HF cache, venv solo `py/.venv-r1`.

## Progress S1–S2 (2026-10-11, rama improve-all-functions, sin commit)

### S1 — setup + adapter lane (time-box: OK, ~5 min << 1h)
- Reloj: inicio 03:30:55Z. `pip install "jevk5[lite] @ git+https://github.com/allebee/jevk5@v0.3.1"` solo en `py/.venv-r1` (torch 2.14.1+cpu + transformers 5.19.0 ya estaban; ningún system python tocado). `snapshot_download("alibiserikbay/JevK5-Lite")` → solo HF cache (`~/.cache/huggingface/hub`, nada en el repo), 10/10 ficheros en 97.9s. Revisión: `315ee211f828a899161477c534cea23e84ba3568`, `revision_source: unpinned` honesto en `/models`.
- Sidecar nuevo `py/jevk5_server.py` (única superficie de código): espeja el contrato de `py/gliclass_server.py` (`GET /live`, `GET /ready` non-warming 200/503, `GET /models` siempre 200, `POST /predict {text, labels, threshold?, multi_label?}` → `{scores, flagged, latency_ms, model, count}`, stdlib `http.server`). Puerto **:8775** (`:8774` ocupado por el worker horizon-rerank, verificado antes de elegir). Lazy load: boot sin pesos, `/ready` 503 hasta el primer predict. Carga medida 5.9s directa / ~8.4s vía HTTP (incluye load), `device cpu, dtype bf16` (probe bf16 OK; CPU AVX2 sin AMX — ver nota latencia). Hilos: `JEVK5_THREADS=8`.
- Lanes congelados pre-medición (medición pura, ningún threshold movido, ninguna optimización contra evals):
  - classify: texto del item vs los class ids del caso, head single-label (softmax, `temperature_single` 1.87). Argmax = predicción.
  - gate-NLI: `premise: {evidence} hypothesis: {claim}` vs `[entailment, contradiction, neutral]` → `SUPPORTED/CONTRADICTED/ABSTAIN`. Una llamada por claim.
- Nota honesta S1: el runtime NO trae head NLI (es clasificador single-text multi-head). Se probaron 3 framings en 3 casos manuales pre-corpus (`supported/contradicted/unrelated`, `entailment/contradiction/neutral` con `Evidence:/Claim:`, `premise/hypothesis`): todos flojos (el mejor, premise/hypothesis, acertó el SUPPORTED y falló un CONTRADICTED claro y un ABSTAIN claro). Se congeló premise/hypothesis por ser el framing NLI estándar y se midió sin más iteración.
- Smoke 1 caso/lane vía sidecar: classify `r1-classify-en-normal-01` → `bug 0.9825` HIT; gate `r1-gate-en-normal-01` → `entailment 0.4807` top → SUPPORTED HIT (margen fino 0.13).

### S2 — medición (92 casos, scoring desacoplado argmax-vs-gold, sin handler, sin thresholds)
Corpora: r1-classify 12 + r1-gate 12 (`evals/corpus-r1/`) + nuevos `classify-independent-01..10` + `gate-independent-01..10` (screen excluido por instrucción) + v2-classify 26 + v2-gate 22 (`evals/corpus-v2/`). Oráculos idénticos a los del harness. Script medidor en `/tmp` (fuera del repo a propósito): `/tmp/jevk5_measure.py`, resultados crudos en `/tmp/jevk5_s2_results.json`. Servidor `:8775` vivo durante toda la corrida, log en `/tmp/jevk5-8775.log`.

| suite | acc | margen medio (top1−top2) | topconf media | ECE (10 bins, top-label) | EN | ES |
|---|---|---|---|---|---|---|
| r1-classify (12) | 10/12 = 0.833 | 0.764 | 0.870 | 0.133 | 5/6 | 5/6 |
| r1-gate (12) | 7/12 = 0.583 | 0.170 | 0.505 | 0.079 | 5/6 | 2/6 |
| new-classify (10) | 8/10 = 0.800 | 0.842 | 0.921 | 0.209 | (sin tag lang) | — |
| new-gate (10) | 3/10 = 0.300 | 0.189 | 0.521 | 0.236 | (sin tag lang) | — |
| v2-classify (26, todo `other`) | 4/26 = 0.154 | 0.530 | 0.720 | 0.661 | 2/13 | 2/13 |
| v2-gate (22, todo ABSTAIN) | 6/22 = 0.273 | 0.188 | 0.520 | 0.248 | 4/11 | 2/11 |
| **TOTAL** | **38/92 = 0.413** | — | — | **0.282** | — | — |

Per-case r1-classify: 10 HIT (bug/feature EN+ES, conf 0.62–0.99); 2 MISS = los dos `other` (`r1-classify-en-negative-01` → feature 0.83, `r1-classify-es-negative-01` → bug 0.53). Estructural: esos casos ofrecen solo labels `[bug, feature]`, así que `other` es impredecible por construcción — no es fallo del modelo.
Per-case new-classify: 8 HIT; 2 MISS = los dos `other` (misma causa estructural, labels `[bug, feature]`).
Per-case v2-classify: 4/26 HIT. 22 MISS casi todos → `feature` con confianza ALTA (0.73–0.98, márgenes hasta 0.97). El slice `other` que r3f arregló para r3i (12/12) quiebra JevK5 por completo.
Per-case r1-gate: 7/12. Los 2 adversariales multi-claim (`[SUPPORTED, CONTRADICTED]`) salieron exactos; los 3 SUPPORTED normales EN + 1 ES, ok; los 2 CONTRADICTED single-claim → predice SUPPORTED (MISS); abstenciones 1/2.
Per-case new-gate: 3/10. 7 MISS, 6 de ellos prediciendo SUPPORTED (incluidos los 4 CONTRADICTED y las 2 ABSTAIN por silencio de evidencia).
Per-case v2-gate: 6/22. 16 MISS → SUPPORTED; solo 6 ABSTAIN recuperados (conf ~0.43–0.51, márgenes ≤0.13).
Patrón gate: colapso a SUPPORTED/entailment. CONTRADICTED single-claim jamás predicho (0/8 entre r1+new+v2 excluyendo adversariales); ABSTAIN 7/34; márgenes medios 0.17–0.19 con topconf ~0.52 = head no-separante, no NLI real.
Calibración (el modelo SÍ expone probabilidades, así que se midió ECE): reliability por bins — independientes r1+new (n=44): bin 0.9–1.0 acc 1.000 (13/13, todo classify bug/feature); bin 0.5–0.6 acc 0.357; bin 0.8–0.9 acc 0.500. v2 (n=48): bins 0.6–1.0 con acc 0.000–0.200 y meanconf 0.64–0.95 = sobreconfianza severa bajo shift (coherente con el caveat de la propia model card: ECE 0.255 overconfident en fast-decisions dev). El ECE "bajo" de r1-gate (0.079) no es calibración real: la confianza ronda 0.5 cerca del base rate porque el head no separa.
Latencia medida: media 2290ms/llamada (min 1879, max 5579, n=94) en esta CPU (Ultra 9 185H, AVX2 sin AMX, CPU compartida con sidecars hermanos `:8765/:8766/:8768/:8770/:8774`). La card declara 54–92ms/item en 16 threads con AMX+bf16 — no replicable en este box; queda como nota, sin re-medir en fp32 (medición única, sin tuning).
ES vs EN: r1-classify 5/6 en ambos (el modelo es English-only según card, pero bug/feature transfiere); gate ES peor (2/6 vs 5/6).
Nada movido: thresholds intactos, `src/` intacto, sin `manifest --save`, sin versionados en `evals/results/`, sin tunear nada con los evals.

### Fine-tune-abilidad (nota, sin entrenar nada)
- SFT continuación estilo r3 con nuestras 699 signed rows: NO directa. JevK5-Lite es DeBERTa-v3-large + scorer MLP propio (`scorer.safetensors`) + formato `[TASK]/[LABEL]` + temperaturas; el entrenamiento vive en el repo `allebee/jevk5`, no es un flujo HF Trainer estándar. Las 699 rows son minúsculas frente a su mix (189k públicas + 20.8k sintéticas ×3) y habría que convertirlas a su formato multi-head — posible en principio, pero trabajo nuevo con scripts de terceros, fuera de este spike.
- Fit 6GB: inferencia sobrada (RSS medido 1.2GB en `:8775`). Full SFT fp32 con Adam (~4× params ≈ 7GB+ antes de activaciones) casi seguro OOM en 6GB; LoRA/PEFT o fp16 + gradient checkpointing plausibles pero no probados aquí.

### Recomendación (S3 queda pendiente de sign-off parent)
**Descartar** para gate/verify y para cualquier slice con `other`/ABSTAIN: quiebra exactamente lo que r3f arregló (v2-classify 4/26 con sobreconfianza 0.66 ECE, v2-gate 6/22) y su "NLI" colapsa a SUPPORTED. Classify bug/feature puro sí separa (r1+new 18/22 = 0.818, márgenes ~0.8) pero no supera al campeón r3i donde importa (v2), es ~18× más lento que su card en este box (2290ms vs 124ms de Qwen-CUDA como referencia de orden), y su calibración no sostiene bajo shift. No hay empate que valga: pierde v2 por paliza. Criterio de promoción no cumplido (no gana claro + no encaja mejor en CPU). No re-medir sin cambio de mecanismo (head NLI real o datos `other`).

## Veredicto S3 — DESCARTAR (parent sign-off 2026-10-11)
Classify separa (r1 10/12, nuevos 8/10) pero gate-NLI colapsa a SUPPORTED (r1 7/12, nuevos 3/10, v2 6/22; 0/8 CONTRADICTED single-claim) y la calibración declarada no sostiene bajo shift (v2-classify 4/26 sobreconfiado, ECE 0.661; global 0.282). El modelo no resuelve ningún gap abierto y quiebra lo que r3f arregló (other/ABSTAIN). Latencia 2290ms/llamada sin AMX tampoco ayuda. Se descarta como backend; la avenida calibración sigue abierta para otro candidato.
