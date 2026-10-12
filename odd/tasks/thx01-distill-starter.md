# thx01-distill-starter — destilar 3 teachers a THX-01 + benchmark r1+v2

## Why
Usuario aprobó destilación a modelo principal THX-01 (322M mmBERT System-1)
con starter de 3 teachers, multilingüe 20 lenguas, benchmark vivo r1+v2-80,
ejecución local en RTX 3050 6GB. Decisión questionnaire 2026-10-11:
teachers=starter, benchmark=r1+v2-80, lenguas=multilingüe-20, ejecución=local-completo.

## Máquina objetivo
- Entrenamiento en segunda PC con **RTX 5060 Ti 16GB** (decisión 2026-10-11).
  6GB-constraints levantados: `gliclass-multilang-ultra` corre nativo sin
  cuantización obligatoria, batches más grandes, teachers en paralelo.
  Los shas de T1 valen igual (reproducibles); el venv se recrea allá.

## Principal
- `doofz/THX-01` — 322M (307M mmBERT-base + 15M head), choice/noul/score +
  number/excerpt/cite, ECE 0.066, Apache-2.0. Embeddings congelados en entreno.

## Teachers (starter, todos <4B, Apache-2.0/MIT)
1. `convaiinnovations/laya-typed-decisions` — 421M. Workflows typed-decisions
   (invoice/security/customer/agent-trace). Destilación directa mismo protocolo.
2. `knowledgator/gliclass-multilang-ultra` — 1.7B. Generalista multilingüe 20
   lenguas (sv,no,cs,pl,lt,et,lv,es,fi,de,fr,ro,it,pt,nl,uk,hi,zh,ar,he),
   jerárquicos, few-shot, rerank. Teacher de intent/topic.
3. `MoritzLaurer/ModernBERT-large-zeroshot-v2.0` — 396M. NLI/sentiment/
   Banking77/emotion barato y rápido. Teacher de debilidades THX-01
   (Banking77 65.9%, DAIR-Emotion 44.6%).

## Lenguas (20)
Unión operativa: es,en,de,fr,it,pt,nl,sv,no,fi,pl,cs,ro,uk,ru,tr,ar,he,hi,zh.
(az/ge/ka/kk/uz de THX-01 se agregan solo si hay datos teacher; no se inventan.)

## Benchmark (vivo, NO stub)
- r1 gold 60 casos (48 lanes + 12 find) — decisión + task.
- v2-80 (classify 26, gate 22, screen 32).
- Métricas: accuracy/task, ECE/Brier/NLL donde haya probs, coverage,
  latencia CPU, throughput. NO usar evals/run.mjs stub-98 para calidad
  (solo plumbing). Piso: r3i 56/60+56/60, v2 classify 22/26.

## Scope (frozen)
- T1: env `py/.venv-thx01` (recrear en máquina objetivo) + downloads
  (shas ya pineados en `scripts/thx01/pins.json`, ver Evidencia T1) + smoke
  1 caso por modelo. En 16GB los 4 modelos van nativos en paralelo.
- T2: sintético label-first multilingüe desde los 3 teachers + filtro
  segundo pase ciego; excluir r1/v2 golds + near-duplicates; truth por
  construcción. Train-only, NO entra a corpus sin firma humana.
- T3: entreno THX-01: freeze embeddings, head + (opcional LoRA encoder),
  loss proper-scoring (log+esférica+RPS ordinales), target uniforme si
  ninguna opción aplica, orden/subsets aleatorios, 8-bit AdamW bf16,
  gradient-checkpointing, batch chico + acumulación. Refit temperatura
  por (tipo, nº opciones) en held-out.
- T4: eval vivo r1+v2-80 + calibración + reporte en evals/results/v21/.
  Criterio adopt: supera/equal piso r1 sin romper v2 classify; gate/screen
  en 0 NO bloquea (STOP previo solo era GLiClass-track, se reporta).
- PROHIBIDO: push, PR, merge, push a corpus sin firma, tunear con golds
  (medición pura en T4), inventar revisiones.

## Tasks
- [ ] T1 env + downloads + smoke
- [ ] T2 data sintética multilingüe filtrada
- [ ] T3 entreno + refit temperatura
- [ ] T4 eval r1+v2-80 + reporte v21

## Evidencia
- Commits work-unit por tarea en esta rama (no push salvo pedido explícito).
- `evals/results/v21/` + este doc actualizado por transición.

## Evidencia T1 (2026-10-11, máquina RTX 3050)
- Downloads OK los 4 (shas en `scripts/thx01/pins.json`):
  THX-01 `bef2e2478be7`, laya-typed `e929ae5cf69b`, ModernBERT-zeroshot
  `a51e07b52429`, gliclass-ultra `33c3ffec6405`.
- Script portable: `scripts/thx01/download_T1.py` (resume + pin).
- Venv local `py/.venv-thx01` eliminado a propósito (6.6GB, machine-specific).
- Smoke pendiente → corre en máquina objetivo 16GB.
