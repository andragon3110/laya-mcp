# ft-pilot T3 — Kaggle runbook (click-by-click)

Base: `convaiinnovations/laya-multilingual` @ `e4e9ddf21a7b1903b7acffd8814ad4307bf63a67`
(public, apache-2.0, verified 2026-10-03 — no login needed to read).
Recipe: head/decision-only SFT, 3 epochs, eff-batch 64, AdamW LR head 1e-4 cosine,
fp16 + grad-checkpoint + clip 1.0, max_len 1024 / head 256, calib 200 (1 temp per
question-type x option-count, base `temperature_by_options` stripped), export adapter
+ `rl_agent_config.json` + PIN. No training happens locally (no GPU); this machine
only runs the `--smoke` gate (stdlib only).

## 0. Local pre-gate (this machine, no GPU, no credentials)

```powershell
python ft-sft-laya/kaggle/train.py --smoke --data ft-sft-laya
```

Expected: `smoke OK: 20 exam rows, schema valid ...`. If it fails, STOP — do not upload.

## 1. Pack the dataset (local)

Zip exactly these 12 files (train 1000 + calib 200 + exam 199 post-T3a):

`train-*.jsonl` (10), `calib.jsonl` (1), `exam-*.jsonl` (10, decide has 19 rows —
`t2b-dec-ex-0007` dropped per MANIFEST-T3a).

## 2. Create the Kaggle dataset

1. kaggle.com → Create → New Dataset → title `ft-pilot-data` → upload the zip (or the
   12 files) → Create (private).
2. Note the dataset slug: `/kaggle/input/ft-pilot-data`.

## 3. Create the notebook

1. Create → New Notebook → language Python.
2. Accelerator: **GPU T4 x2** (Settings → Accelerator).
3. Add input: + Add Input → My Datasets → `ft-pilot-data`.
4. Internet: ON (only to pull the public base checkpoint + `laya` pip package).
5. Paste/upload `train.py` (Upload → `ft-sft-laya/kaggle/train.py`, or paste cells).

## 4. Secrets (only if pushing the adapter; training needs none)

- To upload the adapter to a **private** Hub repo: User Settings → Secrets →
  Add Secret name `HF_TOKEN`, value your token (write access). Never paste tokens
  into notebook code — the script reads `os.getenv("HF_TOKEN")` and the placeholder
  is `TU_TOKEN_AQUI`. Training + download work WITHOUT any secret.

## 5. Launch

```python
!pip install -q laya transformers torch --upgrade
!python train.py --data /kaggle/input/ft-pilot-data --out /kaggle/working/ft-out
```

Watch for these loud gates (they ABORT instead of training garbage):

- `expected 1000 train rows` — dataset mispacked.
- `ABORT (A2)` — encoder/head split mismatch; do NOT bypass, record the param tree.
- `build_batch() must be completed (A3)` — **expected on first run**: complete the
  collate against the installed `laya` SDK version (step 7), then re-run.

Expected math: ~16 steps/epoch x 3 = **~47 steps**, <15 min on 2xT4.

## 6. Finish + download

1. `ls /kaggle/working/ft-out` must show `adapter-head.pt`, `rl_agent_config.json`, `PIN.json`.
2. Save output: File → Save Version (or download the three files directly).
3. Optional push to private Hub: add `--push --push-repo TU_USUARIO_AQUI/ft-pilot-laya-sft`
   (replace with your private repo id) with the `HF_TOKEN` secret set.

## 7. Open item before first launch (A3)

`build_batch()` in `train.py` is an explicit `NotImplementedError`: the row →
tensor encoding must mirror the installed `laya` SDK predict path
(state + typed questions → input ids; hard labels → targets; max_len 1024 with
256 reserved for question+options). Confirm against `laya --version` output in the
notebook and paste the SDK function names into `train.py` before launching.
