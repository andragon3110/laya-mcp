# T3a MANIFEST — verifier conditions + Kaggle-ready package (LOCAL only)

Branch `odd/ft-pilot-data` from `2c6a932` (tracked tree clean; only known `??`:
`.atl/` + `odd/tasks/*.md`). Scope: 1 dropped exam row + 3 NEW files under
`ft-sft-laya/`. No `src/`, `py/`, suites, harness, golds, or other T2 rows touched.
No training, no uploads, no pushes.

## Verifier-condition decisions

1. `t2b-dec-ex-0007` → DROPPED (not repaired). Both candidates carried the identical
   description ("Nube Diaria, respaldo automatico cada noche, $47 por mes") with the
   winner resolved by id (`disco_semanal`, one-hot) — an unlearnable arbitrary
   preference. Repair is NOT obvious: inventing the "intended" distinct description
   and price would convert an adversarial row into a normal row by guesswork.
   Change surface: one line removed from `exam-decide.jsonl` (held-out exam only;
   train untouched). Exam decide 20→19; exam total 200→199.
2. T2b accents → DOCUMENTED MIXTO, files untouched. All 180 T2b ES rows
   (150 train + 30 exam) are ASCII (`vendria`, `manana`, `deposito`); every other
   lot is UTF-8. Criterion: no in-repo gate or test reads `ft-sft-laya` bytes at
   all, but the frozen QC evidence (MANIFEST-T2b gate counts) was computed on these
   exact bytes and there is no committed validator to re-run; a scripted rewrite of
   180 rows risks silent meaning changes worse than the cosmetic gain. T2b is
   internally consistent (train ASCII == exam ASCII per tool), and plain-ASCII ES
   is realistic input — the base model card documents that mail/ticket systems
   strip accents before text reaches this checkpoint.
3. 20 limit rows → NO MATERIALIZATION (already resolved). Per frozen protocol §1
   they live as fail-fast `input_too_large` cases in `evals/suites/*.mjs`, never as
   T2 files. Effective eval: 199 file rows + 20 suite limit rows.

## Base checkpoint — VERIFIED (not assumption)

- id: `convaiinnovations/laya-multilingual` — public, `gated:false`, apache-2.0,
  readable without login (model page + `api/models/` fetched 2026-10-03).
- revision (main): `e4e9ddf21a7b1903b7acffd8814ad4307bf63a67` (2026-09-24).
  Manual re-verify: model page → "Files and versions" must list this commit; if
  main moved, pin the new sha in `train.py` before launching (never train unpinned).
- params 321,908,998 ≈ 322M ("multilingual-322M" confirmed); backbone mmBERT-base
  307M + decision head (2 transformer layers + option-marker scorer + act/escalate).
- Upstream `rl_agent_config.json` (fetched): encoder `jhu-clsp/mmBERT-base`,
  `max_len` 1024, `head_max_len` 256, `temperature` [1,1,1],
  `temperature_by_options` {} (empty at base — T3 strips-then-refits fresh).
  Local cache state (all three checkpoints) is `revision:null/unpinned` — the
  Kaggle run pins explicitly per above.

## Package (`ft-sft-laya/kaggle/`, NEW)

- `train.py` — head-only SFT (freeze `encoder*`, train rest; A2 abort outside
  5M–40M trainable); 3 epochs, eff-batch 64 (8×4×2), AdamW LR 1e-4 cosine, fp16 +
  grad-checkpoint + clip 1.0; calib fit 1 temp/(qtype, nopts) (stdlib grid search);
  export `adapter-head.pt` + `rl_agent_config.json` + `PIN.json`; `--push` only
  with `HF_TOKEN` secret (placeholder `TU_TOKEN_AQUI`, never hardcoded).
  Open item A3: `build_batch()` raises until the collate is completed against the
  installed `laya` SDK version in-Kaggle.
- `README-KAGGLE.md` — click-by-click: local smoke gate → dataset zip (12 files) →
  private Kaggle dataset → notebook GPU 2xT4 → run (~47 steps, <15 min) → download
  3 export files → optional private-Hub push.

## Final counts (post-conditions)

train 1000 (500 ES / 500 EN) · exam 199 (decide 19, rest 20/tool) · calib 200.
Schema intact (11 keys, 1399 rows, ids unique); calib 0 `null` labels; dropped id
absent. Dedup spot (decide state spans vs train): 19/19 share ≥40ch spans even
digit-stripped — template sharing, same diagnostic nature as T2a (2530 spans) /
T2c (313 rows), NOT a binding gate; deletion-only change cannot create new overlap.

## Verification (foreground)

- `python -c counts/schema/dedup/calib` (above): PASS
- `python -m py_compile ft-sft-laya/kaggle/train.py`: PASS (no output)
- `python ft-sft-laya/kaggle/train.py --smoke --data ft-sft-laya`: `smoke OK: 20 exam rows`
- `git show --stat HEAD`: (recorded at commit time)

## Gaps / T3b needs

Credentials + manual steps only: Kaggle account, private dataset upload, 2xT4
notebook, optional `HF_TOKEN` + private Hub repo id for `--push`. No code gaps
except completing `build_batch()` (A3) against the in-Kaggle `laya` SDK version.
