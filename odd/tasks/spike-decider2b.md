# spike-decider2b — Strands Decider 2B vs r3h (spike acotado)

## Why
Usuario aprobó benchmark local del Decider 2B contra nuestro track (r3h:
r1 56/60+56/60, v2-80 classify 18/26). Misma clase (decision scoring),
open (Apache-2.0), local, gratis. Resultado informativo (5º veredicto);
promoción solo si gana claro Y encaja local/$0.

## Stages
- S1: instalar `strands-decider` (pip, en venv-ft que ya tiene torch
  CUDA) + bajar weights hobson (v21 si vigente, ~4GB).
- S2: adapter lanes → typed questions (noul/choice/score) según
  docs/inference.md; smoke 1 caso por lane.
- S3: correr r1 (60) + v2 (80) con mismos oráculos y scoring.
- S4: comparar vs r3h + veredicto (adoptar / empatar / descartar).
- Alcance: classify/gate/screen primero (choice-like); rerank/find solo
  si el tipo `score`/orden mapea limpio, si no se marcan no-aplicables.

## Reglas
- Time-box: si el setup traba >1h, se registra y se frena.
- Sin tunear nada con r1/v2 (medición pura). Sin push. Sin reviews.

## Veredicto S4 (2026-10-10) — NO se adopta, r3h sigue
Metodología idéntica (mismas suites + scoreIndependentDecision; subclase
conserva adjudicación; bare-name options = lower bound para Decider).

| | r3h (nuestro) | Decider 2B cero-shot |
|---|---|---|
| r1 classify | 12/12 | 12/12 |
| r1 gate | 10/12 | 7/12 |
| r1 screen | 10/12 | 4/12 |
| v2 classify | 18/26 | **23/26** |
| v2 gate | 0/22 | 0/22 |
| v2 screen | 0/32 | 0/32 |

Decider gana v2-classify CERO-SHOT (+5, mejor manejo de `other` sin
entrenar) pero pierde r1 gate/screen donde r3h lleva training + routing.
Gate/screen ABSTAIN-REVIEW duros para ambos (0/0). Rerank/find no
aplicables (orden no es choice). Criterio de promoción (gana claro Y
encaja local/$0): NO se cumple → 5º veredicto, sin adopción.
Avenida futura (no ejecutada, training cerrado): destilar sus
other-aciertos como teacher. Restart: `strands-decider serve
StrandsAgents/strands-decider-2B-hobson-v21 --port 8001` (venv-ft).

## RDD 12013924 (2026-10-10)
- Inspect: monolith + spike, start offered
  (lineage `review-1d225de08203e9f9`). Human granted; START blocked in
  preflight: `lens_context_budget_exceeded`, no authority, stop.
- Expected: monolith never fits; slice chain remains the only review path.
