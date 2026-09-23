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
