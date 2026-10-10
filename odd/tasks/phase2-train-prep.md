# phase2-train-prep — r3f hacia adelante: re-medir + filas v2 (sin verificación intermedia)

## Why
Usuario: mejorar el MCP de verdad (puntajes). Palanca real = training +
datos, no tweaks de código. Estado del terreno (2026-10-10):
- GPU RTX 3050 6GB libre (5.8GB), 22GB RAM. Checkpoints r3a completos.
- Stock: en 3400 + es 3400 + refnear 200 + hardneg 700 + boilerplate 200.
- venv-ft (torch CUDA) NO existe; venvs actuales son torch CPU.
  Micro-train r3f exige setup CUDA (descarga GB) o correr en CPU.
- v2 firmado (20 casos) sin convertir a filas de train.

## Scope (frozen)
- T1: factibilidad de servir r3a en CPU (deps con .venv-r1) para re-medir
  la matriz r1 y regenerar evidencia v13/v16 honestamente.
- T2: script `ft/gen_v2_r3f.py` (o .mjs según convenga): corpus-v2
  firmado → filas train r3f (20) + manifiesto de replay/anchors (~600).
  Sin entrenar (el train espera la decisión humana).
- T3: re-medición r1 con r3a servido local (si T1 viable) → evidencia
  para publicar v16 sin fabricar.
- PROHIBIDO: entrenar sin la decisión, firmar golds, push, tocar
  train/abstain/ (cuarentena), inventar evidencia, reintentar reviews.
- Sin verificación intermedia por orden; batería al final de cada pieza
  que la admita (gen script: conteo 20 + schema check; re-medición:
  matriz determinista v12==v13 como piso).

## Pregunta humana pendiente (bloquea el train, no la prep)
- ¿Micro-train r3f ya con 20, o lote 2 (~40) primero?

## Piso + v16 (2026-10-10)
- r3a servido en CPU (:8770, checkpoint run-20261009T055724Z-r3a).
- Matriz r1 live: classify 12/12+11/12, gate 10/12+10/12,
  screen 10/12+10/12, rerank 12/12+12/12 → compuesto 56/60 dec,
  55/60 task. Determinista con lo medido antes.
- Publicado `evals/results/v16/` (manifest+metrics+composed del run,
  commit 128129c). §13 actualizado sin fabricar nada.
- T2: `ft/gen_v2_r3f.mjs` → `train/r3f/v2.jsonl` (20 filas, asserts OK).
