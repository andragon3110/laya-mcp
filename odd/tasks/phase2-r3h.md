# phase2-r3h — batch 3 firmado (20/20) → corpus-v2 (80) → train r3h → validar

## Why
Lote 3 firmado tal cual el 2026-10-10. Último round de datos con regla de
parada: si r3h no mueve gate/screen task, training agotado (no hay r3i).

## Scope (frozen)
- T1: extender `evals/corpus-v2/{gate,screen}.mjs` con batch 3
  (classify 26, gate 22, screen 32 = 80). Golds idénticos a lo firmado.
- T2: `ft/gen_v2_r3f.mjs` → conteos 26/22/32 + rerun → 80 filas.
- T3: `ft/train_r3h.py` (continuación r3g, misma receta): mix 80 v2 +
  200 gate replay + 400 anchors = 680, peso 1, LR 2e-5, 2 epochs, ABORT 0.3.
- T4: validar v2-80 (criterio: gate/screen task > 0) + piso r1 56/56.
  Adopción: solo si piso held; si v2 no se mueve, se adopta igual solo si
  no hay regresión en ningún agregado (si hay regresión → revertir a r3g).
  Regla de parada: gate/screen task en 0 tras r3h ⇒ no hay r3i.
- PROHIBIDO: train/abstain/, weight >1, push, más golds, reviews.
- :8770 en r3g hasta el swap.

## Sin verificación intermedia (orden vigente); matrices al cierre.

## Adopción r3h + STOP (2026-10-10)
- Train limpio (680 filas, 34s, sin ABORT; deltas ~flat).
- v2-80: classify 16/26→18/26; gate/screen task 0 (dec arriba).
- r1 56/60 + 56/60 idéntico: sin revertir. v19 publicado. Batería verde.
- STOP RULE: gate/screen task inmóviles en 3 rounds ⇒ training agotado,
  no hay r3i. r3h adoptado como checkpoint final.
- :8770 sirve r3h; r3g/r3f/r3a intactos.

## RDD 1c908e7e (2026-10-10)
- Inspect: monolith + r3h promotion, start offered
  (lineage `review-244c6b1ba2d63423`). Human DECLINED (candidate-scoped).
- No review invoked, no authority created.

## Cierre training (2026-10-10, orden del usuario)
- Loop cerrado: r3h final sirviendo (recomendado), r3g/r3f/r3a intactos.
- venv-ft queda (torch cu128, reutilizable). artifacts-ft/ excluido de git
  (GBs, reproducible). Sidecars apagados; restart en OPERATOR.md.
- Sin r3i por regla de parada. Oro restante: lote 4+ solo si se pide.
