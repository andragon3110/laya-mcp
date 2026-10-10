# spike-d3nano — vllm-sr d3-nano 2B vs r3h (spike acotado)

## Why
Usuario aprobó. d3-nano: 2B multimodal, Apache-2.0, misma interfaz tipada
(choice/noul/score + criteria CON descripciones), Jev 35.8 vs Decider
25.8. Local, gratis, entra en 6GB.

## Stages
- S1: bajar weights (AutoModel trust_remote_code, ~4-5GB) + smoke
  (transformers 5.19 del venv-ft; si pide 5.17 se evalúa).
- S2: adapter: MISMO bench que Decider (subclase conserva adjudicación)
  pero pasando descriptions reales en criteria (cases las traen) —
  full-strength, documentado. Importa r1CasesFor + corpus-v2 + scoring.
- S3: r1 (36 choice-lanes) + v2 (80) vs r3h. Rerank/find N/A (orden).
- S4: veredicto (adoptar / empatar / descartar) + fine-tune-abilidad
  (receta d3 por confirmar en su repo).
- Time-box: setup >1h ⇒ registrar y frenar. Sin tunear con r1/v2.
  Sin push. Sin reviews.

## Veredicto S4 (2026-10-10) — NO se adopta como backend, r3h sigue
Misma metodología (adjudicación heredada; criteria CON descripciones =
full-strength para d3).

| | r3h | Decider 2B | d3-nano |
|---|---|---|---|
| r1 classify | 12/12 | 12/12 | 12/12 |
| r1 gate | 10/12 | 7/12 | 8/12 task (9 dec) |
| r1 screen | 10/12 | 4/12 | 8/12 |
| v2 classify | 18/26 | 23/26 | 24/26 |
| v2 gate | 0/22 | 0/22 | **16/22** |
| v2 screen | 0/32 | 0/32 | 0/32 |

d3-nano QUIEBRA v2-gate (16/22 cero-shot, el gap que dimos por
estructural) y lidera v2-classify, pero r1 compuesto pierde (28/36 vs
32/36 en lanes choice; find/rerank N/A). Fortalezas complementarias:
d3 abstiene mejor, r3h veredicta mejor en r1.
Criterio de promoción (gana claro Y encaja): NO se cumple como backend
(compuesto regresa, 2B pide GPU vs CPU). 6º veredicto, sin adopción.
Avenida concreta propuesta: destilar veredictos d3 en filas gate para
un r3i acotado (reabriría training con mecanismo nuevo, requiere
aprobación — el stop sigue vigente si no).
Restart: D3_PORT=8002 venv-ft/bin/python ft/d3_serve.py (venv-ft).
