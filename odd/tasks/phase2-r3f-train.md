# phase2-r3f-train — venv CUDA + micro-train r3f + validación (train-now con 20)

## Why
Humano: armar CUDA y entrenar (2026-10-10). Prep cerrada: piso 56/60+55/60
(v16), 20 filas v2 verificadas. Falta el train en sí. venv-ft no existe;
venvs actuales son torch CPU; smoke_train exige CUDA.

## Scope (frozen)
- T1: venv-ft (python3.14? mirroring .venv-r1) + torch cu128 + transformers
  + gliclass + deps de ft/train_r*.py. Descarga de GBs, log a archivo.
- T2: `ft/train_r3f.py` espejando `train_r3e.py`: init SOLO desde r3a
  (nunca base), mix 20 v2 + replay/anchors ~600 peso 1 con
  eval-ids excluidos (R1.load_split), LR 2e-5, 2 epochs, ABORT bar 0.3,
  run-dir `artifacts-ft/run-<stamp>-r3f`.
- T3: correr el train (fondo con log; RTX 3050 6GB).
- T4: validación post-train con swap de sidecar (:8770 → r3f): v2 debe
  subir desde 2/10+0/4+0/6; piso r1 56/55. Si falla: REVERSIÓN (r3a
  sigue servido/intacto), sin tunear en r1, un solo pase final.
- PROHIBIDO: tocar train/abstain/ (cuarentena), init desde base/r3c/r3d,
  weight >1, push, firmar golds, reintentar reviews.
- Sidecar r3a (:8770, PID 2972169) se mantiene hasta la validación.

## Sin verificación intermedia (orden vigente); batería + matriz al cierre.

## Adopción r3f (2026-10-10)
- Validación: v2 classify 2/10→3/10 (gate/screen iguales); r1 56/60 dec,
  56/60 task (classify 12/12, resto idéntico). Sin regresiones.
- Promovido a checkpoint recomendado + track anunciado (r3f, 56/60+56/60):
  MEASURED_TRACK, pins T5, CONTRACT, OPERATOR, README, §13. v17 publicado.
- :8770 queda sirviendo r3f; r3a intacto (reversión disponible).
