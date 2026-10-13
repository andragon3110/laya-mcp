# Fase-7 T4 — Calibration verdict

## Verdict

**No numeric output of this repo is a probability. No signal is calibrated.
Brier score and ECE do not apply to any primitive — they are documented
here and never calculated.**

Every Router `noul`, every choice-dict share (`winner_probability`), every
GLiNER span score (`detector_score`), every rerank `relevance_score`, and
every review/gate 0-2 rubric `score` is a raw, uncalibrated signal (see
`src/evidence.ts`). A value of 0.9 does NOT mean "90% likely correct"; it
means "the backend returned 0.9". Any reading beyond that is unfounded.

## What NOT to call `confidence`

- `winner_probability` (classify/decide/find/compare/extract): top raw
  choice share. Never "confidence", never a probability.
- Per-claim/per-question `signal` (verify/gate/screen/review-safe): raw
  Router output. Never "confidence".
- `detector_score` (pii/extract-spans): raw GLiNER span score with no
  server-side threshold. Never "confidence".
- `relevance_score` (rerank): within-call only by contract; not comparable
  across calls, not a probability, and no cutoff on it is meaningful.
- 0-2 rubric `score` (review/gate): audit evidence, not a probability.

The words `confidence` / `probability` MUST NOT appear for uncalibrated
signals (same rule as `src/evidence.ts`). Legacy handler fields keep old
names; only new analysis uses this vocabulary.

## Forbidden conclusions (do NOT do these)

1. **Brier/ECE anywhere.** Both require calibrated probabilities with
   ground-truth outcome frequencies. We have neither. Not calculated,
   not approximated, not "for reference".
2. **wrong_confident taus as prod thresholds.** The τ = 0.70/0.80/0.90/0.95
   slices in `evals/score.mjs` are descriptive reporting cuts over
   oracle-stub runs. Promoting any τ to a production cut is a category
   error (unvalidated on real traffic, circular on stub data).
3. **Cross-call score comparison (rerank).** `relevance_score` magnitudes
   are oracle-assigned and within-call only; ranking quality across calls
   is meaningless by contract. Hence wrong_confident is "no aplica" for
   rerank, with justification in the runner output.
4. **Stub numbers as backend claims.** T4 metrics run under the T3 oracle
   stub (stub ceiling): they validate harness + handler plumbing, never
   backend quality, calibration, tie rates, or robustness. No transfer.
5. **Accuracy on rerank scores.** Rerank quality is MRR/nDCG/MAP/top-k
   over orders, never accuracy over score values, never thresholds.
6. **Reading abstention as error.** Abstention (mid-band, missing-signal,
   tie, weak-winner) is the honest output, excluded from quality
   denominators and measured separately as `abstention_rate`.
7. **Optimizing for these metrics.** Per fase-7-eval constraints: no tuning
   against eval numbers, no threshold changes (thresholds intact, proven
   by the untouched `src/` tree and the T6 no-regression batteries).

## Per-primitive metric validity (summary)

| Primitive(s) | Valid | Invalid here |
|---|---|---|
| classify/decide/verify/screen/pii/extract/find (+compare, future) | accuracy, P/R/F1 on ALLOW polarity, FPR/FNR, abstention_rate, wrong_confident on the primitive signal | Brier/ECE |
| review/gate | decision accuracy, abstention_rate, wrong_confident (safe / per-claim signal); rubric-score agreement only with future score oracles | Brier/ECE, score agreement on T3 golds (no score oracle) |
| rerank | MRR/nDCG/MAP/top-k | accuracy, any threshold, wrong_confident, cross-call comparison |

## T8 pin (2026-10-11) — calibration honesty, no math added

No calibration was invented in T8. No probability exists, so none was
measured. This section pins the verdict above against six concrete
guarantees (each with a regression test in `tests/fase7_t4_metrics.mjs`):

1. **Exclusions are counted.** `wrongConfident` scores only non-throw,
   non-abstained, numeric-signal judgments; every exclusion is reported in
   `excluded` (`threw`, `abstained`, `null_signal`). Denominators never
   silently shrink.
2. **Joint vs conditional rates stay distinct.** Each tau slice reports the
   JOINT rate P(wrong AND signal >= tau) over scored items AND the
   conditional P(wrong | signal >= tau) over confident items. The two
   denominators differ on purpose; conflating them is an error.
3. **Rerank stays "no aplica".** The runner (`evals/score.mjs`) emits
   `wrong_confident: { status: "no aplica", ... }` for rerank with the
   within-call-only justification, and its judgments are `[]`. Empty input
   yields null rates (honest absence), never a number.
4. **Brier and ECE are absent by verdict, not by omission.** They require
   calibrated probabilities with ground-truth outcome frequencies; we have
   neither. `evals/metrics.mjs` exports no `brier`/`ece` symbol, pinned by
   test — the absence is the verdict, not a gap.
5. **Promoting any tau to a production cutoff is a category error.**
   `WRONG_CONFIDENT_TAUS` (0.70/0.80/0.90/0.95) are descriptive reporting
   slices over oracle-stub runs, unvalidated on real traffic and circular
   on stub data. Custom taus in calls never mutate the constant.
6. **Decide argmax-only is unmeasurable for calibration through its API.**
   A null selection yields `winner_probability` null, which is EXCLUDED
   (counted as `null_signal`), never scored as 0. No distribution, no
   calibration slice.

## WS-D tooling (Regulus, 2026-10-12) — `evals/reliability.mjs`

The verdict above still stands for all stub corpora and for r1: no
probability, no Brier/ECE there, ever. The ONE exception is the Regulus
validation split, measured with `node evals/reliability.mjs <scores.json>`:
from per-row `{ predicted_label, confidence, correct }` JSON score files
(NEVER live model calls) it emits 10-bin reliability diagrams + ECE +
max-calibration-error + Brier + per-bin counts, with abstained/null-signal
rows counted in `excluded` (same honesty as `wrongConfident`) and refusal
(exit 2) on empty or all-excluded input instead of zeros. Self-test proves
discrimination: synthetic calibrated ECE 0.000 vs overconfident 0.400 vs
underconfident 0.300 (`--self-test`). ECE/Brier may be claimed on the
validation split ONLY (never r1, never stub runs), fed by WS-E with r3i and
regulus-v1 validation scores for the WS-C objective comparison. Single
temperature T (correctness-logit scaling, NLL fit) is fit on validation via
`--fit-temperature --fit-data-id <id> [--save-temp <file>]` producing
`{ T, fit_data_id }`, and applied via `--apply-temperature <temp.json>`;
every calibrated number is reported with its fit data id. No model is
certified as calibrated by this plumbing — it only makes miscalibration
measurable.
