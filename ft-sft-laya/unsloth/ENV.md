# T3b-i ENV — local Unsloth readiness (inspection only, no training)

Date: 2026-10-03 · Branch `odd/ft-pilot-data` @ `7e91c02` · Scope: T3b-i step 1 + §3 report.
Step 2 adaptation (`train_unsloth.py` + `README-UNSLOTH.md`) NOT written: unverifiable
without an importable `unsloth` (per task: BLOCKED → commit only this report).

## Environment (measured)

- OS/shell: Windows (PowerShell), no conda, single `python` on PATH.
- python: 3.11.9 (MSC v.1938 64-bit).
- torch: 2.13.0+cu130 · `cuda_available=True` · `torch.version.cuda=13.0`.
- GPU: 1× NVIDIA GeForce RTX 5060 Ti · 16311 MiB (≈15.93 GiB usable) · driver 591.74.
- transformers 5.17.0 · peft 0.21.0 · accelerate 1.12.0 (present).
- trl / bitsandbytes / xformers: NOT installed (absent from `pip list`).
- unsloth: NOT installed → `python -c "import unsloth"` fails with exact error:

  ```text
  ModuleNotFoundError: No module named 'unsloth'
  ```

## Verdict: NO-PUEDE (BLOCKED) — cannot run the full Unsloth run on this machine today

1. `unsloth` is not importable in the active Python; nothing Unsloth-based (script,
   `--smoke`, full run) can execute here.
2. Upstream `unsloth` targets Linux (Windows-native is unsupported; WSL2 is the
   documented path) and decoder-style causal LMs. Our base
   (`convaiinnovations/laya-multilingual` @ `e4e9ddf21a7b1903b7acffd8814ad4307bf63a67`,
   mmBERT-base encoder 307M + 2-layer decision head ≈ 322M) is an encoder + head
   checkpoint, NOT a confirmed Unsloth-supported architecture — LoRA-via-Unsloth
   applicability is unproven even after install.
3. No smoke was forced: per task, smoke requiring GPU-unavailable deps is reported
   blocked, not faked on CPU.

## Estimated full-run time (estimate, NOT measured)

Recipe unchanged from T1/T3a: 1000 train rows, 3 epochs, eff-batch 64 → ~47 optimizer
steps on a ~322M-parameter model. Reference: <15 min on Kaggle 2×T4. Single RTX 5060 Ti
(16 GB) is in the same class → rough estimate <15 min wall-clock for the equivalent
head/LoRA run, PLUS unquantified time for: installing the Unsloth stack, resolving
Windows-vs-WSL, and confirming `build_batch()`/collate against the installed `laya` SDK
(open item A3, unchanged from MANIFEST-T3a).

## What T3b-ii needs (go explícito + GPU del usuario)

- A Python env (Linux or WSL2 recommended) with `unsloth` + `trl` importable, OR an
  explicit decision to drop Unsloth and use installed `peft` 0.21.0 LoRA / head-only
  per `ft-sft-laya/kaggle/train.py`.
- Proof that the base checkpoint loads under the chosen trainer (encoder+head vs
  causal-LM assumption) and a completed `build_batch()` collate (A3).
- Then: write `ft-sft-laya/unsloth/train_unsloth.py` + `README-UNSLOTH.md`, `--smoke`
  (1 micro-batch, saves nothing), full run, export adapter + config + PIN (same
  resume/export contract as Kaggle design).
