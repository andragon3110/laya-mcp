# T3b MANIFEST — local head-only SFT run (peft-free, SDK-backed)

Branch `odd/ft-pilot-data` @ `4332e3a`. Scope: full T3b-ii run + 1 manifest +
minimal `train.py` adaptation. No `src/`, `py/`, suites, harness, or T2 rows
touched. No push. Weights NEVER committed (export lives outside the repo).

## Pre-flight

- Base `convaiinnovations/laya-multilingual` @
  `e4e9ddf21a7b1903b7acffd8814ad4307bf63a67`: public, gated:false, apache-2.0,
  downloaded to HF cache, no login. Loaded revision asserted equal at runtime.
- Gap A3 RESOLVED: no `laya` SDK was installed. Installed `laya==0.3.23`
  (repo-pinned in `py/requirements.txt`) OFFLINE from the local pip-cache wheel
  (`--no-index --no-deps`, zero network). All runtime deps already present.
- Kaggle draft's `AutoModel.from_pretrained(..., trust_remote_code=False)`
  fails empirically (`ValueError: Unrecognized model ... no model_type key` —
  the repo has no root config.json). Replaced with the SDK's own
  `laya.agent.Agent` (pinned rev) + `DecisionModel` + `_to_internal` /
  `build_sequence` / `collate_items` (verified shapes + backward in pre-flight).
- A2 gate on the real trainable set: total 321,908,995 / trainable 14,770,945
  (4.6%) ∈ [5M, 40M] → PASS.
- `python train.py --smoke --data ./ft-sft-laya`: `smoke OK: 20 exam rows`.

## Deviations from the Kaggle draft (design hyperparams unchanged)

1. Precision bf16 (not fp16): checkpoint `amp_dtype=bf16`, RTX 5060 Ti sm_120
   has native bf16, upstream trains bf16. No GradScaler under bf16.
2. Freeze = `encoder*` AND `act_head*`. The act/escalate head has NO
   supervision signal in T2 rows; leaving it trainable lets AdamW weight-decay
   corrupt it. Trainable = head + scorer + type_emb (31 tensors).
3. Targets: choice → one-hot at criteria-key index; score → one-hot at level;
   noul scalar s → [1-s, s] over [false, true] (SDK decode: answer = p[1]).
   SKIPPED, never trained: null labels (`None` AND `{"k": None}` = abstention
   silence, 191 total) and choice golds outside the rendered options
   (negative/adversarial, unrepresentable targets).
4. Batching by ROW: 8 rows × 8 accum × 1 GPU = eff-batch 64 (recipe value).
5. Calibration fit from the TRAINED model's own logits (NLL grid per SDK
   `temp_bucket(qtype, k)`, clamped to SDK [0.5, 5.0]) — the draft's
   label-only fit with non-SDK bucket keys could never take effect at decode.

## Run (actual)

- 3 epochs, AdamW LR head 1e-4, cosine (T_max=48), clip 1.0, bf16 autocast,
  SDK non-reentrant head checkpointing + `detach_encoder=True`.
- Train census: 1000 rows → 2113 supervised questions; skipped 176 null +
  15 dict-null + 62 unrepresentable-gold; 146 fully-empty rows (no gradient).
- 45 optimizer steps (15/epoch; nominal 48 minus all-empty micro-batches).
- Loss (per-step mean, file-ordered micro-batches → noisy by tool mix):
  step1 0.8217 → step44 0.6731, best 0.3595 (step35). No NaN; best < initial →
  no abort. Wall 39.6 s. Full per-step log: `%TEMP%\ft-t3b-loss.log`.
- Abort rule armed (NaN / >10 steps w/o beating initial / >90 min wall):
  never triggered. No partial export. No stray processes (8 running pythons
  are the user's BravoGuard servers, untouched; GPU back to ~1.1 GiB idle).

## Calibration (200 pre-split calib rows)

- Supervised: 458 questions (noul:2 239, score:3-5 120, choice:3-5 68,
  choice:2 31); 4 unrepresentable-gold skipped; 0 nulls.
- Fitted temps: `choice:2=0.5` (SDK clamp floor — model stays over-sharp on
  2-way choice), `choice:3-5=0.6`, `noul:2=3.05`, `score:3-5=1.55`.
- Base `temperature_by_options` (`{}`) stripped, fresh 4-bucket map exported.

## Export (LOCAL ONLY, outside repo)

- Dir `%TEMP%\ft-t3b-out`: `adapter-head.pt` (59,093,887 B, 31 tensors,
  sha256 `5e2320a586f01b6a85a721aa8be539c115ec514bb`) + `rl_agent_config.json`
  + `PIN.json` (base rev, 10 train shas, calib sha, adapter sha, 45 steps,
  eff-batch 64, bf16, wall 39.6 s). Reload: fresh pinned `Agent` +
  `load_state_dict(adapter, strict=False)` (139 missing = frozen parts) +
  exported config temps.
- `git status` shows only `train.py` (M) + this manifest (??→committed);
  weights/`__pycache__` not tracked, never `git add -A`.

## CPU smoke (NOT the T4 A/B; preregistered rule)

- 20 exam rows (first-20, classify slice) via base+adapter on CPU with fitted
  temps. Rule: choice argmax==gold; score |E−gold|≤0.5; noul |p−gold|≤0.2.
- Result: 8/14 PASS, 6 skipped (null/unrepresentable, unscored).

## Gaps for T4

- Formal A/B base-vs-FT in the fixed harness (220-file + 20 limit rows,
  anchor, keep rule) still pending; smoke slice is classify-only and weak.
- Per-step loss is tool-composition noise (file-ordered rows); any future run
  should consider shuffled/stratified micro-batches (deviation, not applied).
- `choice:2` temp sits at the SDK clamp floor — SFT did not soften 2-way
  choice overconfidence; T4 sure/doubt bands must confirm.
- `act_head` unchanged from base (frozen, no labels); escalate behavior is
  base behavior.
- CSV Jungla external set + license check still T4 business per protocol.
