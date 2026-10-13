# Objective spike (WS-C F2) — abstention-aware loss for Regulus

## Chosen: Controlled Abstention Network (CAN)-style IDK loss
- Module: `ft/idk_loss.py`. Per row: `L = (1-q)*base + C*q` with
  `q = sigmoid(AbstentionHead([max_prob, mean_entropy, top1_top2_margin]))`,
  `base` = mean BCE-with-logits (spike scale) or focal (train scale) over
  the row's labels. Head is `Linear(3,1)`, zero-init (starts q=0.5,
  neutral), consumes K-agnostic summaries over *detached* logits (stable
  head, no scorer<->head feedback loop; the scorer still gets the
  `(1-q)`-weighted base gradient — that down-weighting of uncertain rows
  is the mechanism that teaches abstention).
- Why it fits GLiClass multi-label best: no scorer surgery, variable-K
  safe (features are label-count summaries, so variable-`all_labels`
  zero-shot rows keep working), and maps directly onto the lineage ABSTAIN
  convention (empty `true_labels` = all-zero targets → low scores → handler
  abstains). Gradient direction is the desired policy: dL/dq = C − base,
  so base>C rows learn q→1, base<C rows learn q→0.
- Synthetic proof (CPU, `py/.venv-ft/Scripts/python ft/idk_loss.py --demo`,
  BCE scale, C=0.3): correct (logit +3, t=1) force 0.0486 < abstain 0.3;
  ambiguous ([+0.1,−0.1], t=[1,0]) abstain 0.3 < force 0.6444;
  confident-wrong (logit −4, t=1) force 4.0181 > abstain 0.3. Learned-head
  gradients agree: ambiguous dL/dbias −0.086 (q rises), correct +0.063
  (q falls). Harness: `node tests/idk_loss_spike.mjs` → 7 checks green.

## Deferred alternatives (with reasons)
- Deep Abstaining Classifier (extra abstention logit in the scorer):
  needs scorer-architecture surgery plus a fixed (K+1) output, breaking the
  variable-`all_labels` zero-shot conditioning. Revisit only if the CAN
  head proves unexpressive on validation.
- Selective prediction + error regularization: reference implementation in
  `ft/selective_loss.py` (DEFERRED header, validation-comparison baseline
  only). Needs coverage target + 2 penalty weights (3 knobs vs 1 price C),
  and its learned selection `g(x)` is invisible to the handler (which only
  reads label scores) — no mapping to the empty-`true_labels` convention.
  Our gap is the missing abstention decision itself, not confidence quality.

## Abstention-cost parameter (never hardcoded silently)
- Precedence: CLI `--abstain-cost` > env `REGULUS_ABSTAIN_COST` > default.
  `resolve_abstention_cost()` rejects non-finite / ≤0 values.
- Default C=0.3 comes from THIS spike's BCE-scale comparison (working band
  0.049–0.644; C above ln2≈0.693 means even uniform rows never abstain).
- Scale warning (measured, not assumed): focal base (γ=2, the GLiClass
  multi-label path) compresses the band to correct 0.00003 / ambiguous
  0.0727 / wrong 0.9687, so C=0.3 does NOT make ambiguous rows abstain
  there — suggested focal start is C≈0.02 (all three legs hold). WS-E MUST
  re-select C on the batch-4 validation split with the SAME base the F3 run
  uses (never on r1); the user may override at run time.

## Wiring note for WS-E (exact, no edits made to the train script)
- In `ft/train_regulus_v1.py::run_train`, after the `model = ...` line:
  `from ft.idk_loss import build_idk_trainer` (repo-root import; spike
  plugs in as an importable module), then replace the `Trainer(...)`
  construction with `IdkTrainer = build_idk_trainer(abstention_cost=<C>,
  base="focal"); trainer = IdkTrainer(model=model, args=targs, ...)`.
  Add CLI `--abstain-cost` (default None → env → 0.3) and record the
  resolved C in `config.json`. `IdkTrainer.compute_loss` forwards the model
  for logits, prices rows via `idk_loss`, keeps the EWC passthrough, and
  falls back to `super().compute_loss` when inputs carry no `labels`.
- Validation-only comparison before F3: `compare_objectives(val_logits,
  val_targets, C)` per candidate C on the batch-4 validation split; pick
  the C whose abstain-wins rows match the human-signed ABSTAIN rows.
- Forbidden (unchanged): full train here, tuning on r1/v2, weight >1,
  touching `ft/batch4/` / `evals/corpus-batch4/` (WS-B), push/PR/merge.
