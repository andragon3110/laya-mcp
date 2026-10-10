# phase2-r3i-distill — destilar abstención d3 → r3i (reapertura acotada)

## Why
Usuario aprobó reabrir training con mecanismo NUEVO (destilación d3),
mismas guardrails. d3 quiebra v2-gate 16/22 cero-shot; r3h da 0/22.
Stop original refería a más dosis de lo mismo — esto es otra avenida.

## Scope (frozen)
- T1: ~24 casos gate-silencio NUEVOS (sujetos no usados en lotes 1-3),
  EN+ES, gold ABSTAIN por construcción (evidencia sin datos sobre el claim).
- T2: d3 los etiqueta (bridge :8002); se conservan SOLO los que d3 veredicta
  ABSTAIN (control de ruido); se registra agreement rate como métrica de
  calidad de la destilación. Truth de filas = ABSTAIN (construcción).
- T3: `ft/train_r3i.py` (continuación r3h, misma receta): mix = destiladas
  (~24) + v2-80 + 200 gate replay + 400 anchors, peso 1, LR 2e-5, 2 epochs,
  ABORT 0.3, eval-ids excluidos.
- T4: validar v2 (criterio: gate task > 0) + piso r1 56/56. Si gate sigue
  en 0 ⇒ stop definitivo (ni r3j ni más destilación). Si piso cae ⇒ revert.
- PROHIBIDO: train/abstain/, weight >1, push, corpus sin firma (las
  destiladas son train-only, NO entran a corpus-v2 sin firma humana),
  reviews.
- :8002 d3 hasta validar; :8770 en r3h hasta el swap.

## Adopción r3i + STOP DEFINITIVO (2026-10-10)
- Train limpio (699 filas, 32s, sin ABORT; deltas negativos).
- v2-80: classify 18/26→22/26 (+4); gate/screen task 0 (dec arriba).
- r1 56/60 + 56/60 idéntico: sin revertir. v20 publicado. Batería verde.
- Gate en 0 tras mecanismo nuevo ⇒ STOP DEFINITIVO, no hay r3j.
- r3i adoptado (strictly no-worse). :8770 sirve r3i; r3h/r3g/r3f/r3a intactos.
