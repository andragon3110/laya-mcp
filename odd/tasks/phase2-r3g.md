# phase2-r3g — batch 2 firmado (40/40) → corpus-v2 (60) → train r3g → validar

## Why
Lote 2 firmado tal cual el 2026-10-10. El salto grande vive acá: 60 filas
nuevas (vs 20 de r3f) atacando los 3 gaps medidos.

## Scope (frozen)
- T1: extender `evals/corpus-v2/{classify,gate,screen}.mjs` con batch 2
  (26/12/22 = 60). Golds idénticos a lo firmado (solo cambia el prefijo
  del oracle a SIGNED); r1 intacto.
- T2: `ft/gen_v2_r3f.mjs` → conteos 26/12/22 + rerun → `train/r3f/v2.jsonl`
  (60 filas). Renombrar artefactos a r3g donde aplique sin romper r3f.
- T3: `ft/train_r3g.py` espejando r3f: init SOLO r3f?? NO — init desde r3a
  adjudicado (base estable) o continuación r3f? DECISIÓN: continuar desde
  r3f (SFT continuation, misma receta; r3f adoptado y sano) — mix 60 v2 +
  200 gate replay + 400 anchors = 660, peso 1, LR 2e-5, 2 epochs, ABORT 0.3.
- T4: validar v2-60 (piso: superar 3/10+0/4+0/6) + piso r1 56/56.
  Reversión a r3f si falla, sin tunear en r1.
- PROHIBIDO: tocar train/abstain/, weight >1, push, firmar más golds,
  reintentar reviews.
- :8770 sigue en r3f hasta el swap de validación.

## Sin verificación intermedia (orden vigente); batería + matrices al cierre.

## Adopción r3g (2026-10-10)
- Train limpio (660 filas, 46s, sin ABORT; deltas mínimos, gate +0.013).
- v2-60: classify 16/26 (batch-1 3/10→5/10, batch-2 11/16); gate/screen
  task 0 pero 3 ABSTAIN colapsaron a zona de abstención (señal).
- r1 56/60 + 56/60 idéntico a r3f: sin reversión. v18 publicado.
- Promovido (track r3g, OPERATOR, README, §13). Batería verde.
- :8770 sirve r3g; r3f y r3a intactos.

## RDD fc6a0d33 (2026-10-10)
- Inspect: monolith + r3g promotion, start offered
  (lineage `review-5be5171415bb636f`). Human DECLINED (candidate-scoped).
- No review invoked, no authority created.
