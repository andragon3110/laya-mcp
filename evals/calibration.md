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

## T2 live update (fut-a-calibracion, 2026-09-24) — Fase 7 CONFIRMADO con datos live

Scope revision: the "Brier/ECE anywhere" ban above covered STUB signals
(oracle-assigned, match by construction). T2 measured live (signal,
gold-agreement) pairs against real backends, so Brier/ECE are now
computed as miscalibration DIAGNOSTICS on live data only
(`evals/metrics.mjs` brierScore/ece, `evals/live-cal.mjs`, versioned run
`evals/results/v2/`). They still certify nothing: no signal below is a
probability, no tau is a production threshold, and the stub ban stands.

Live setup (venv temporal `%TEMP%/laya-cal-0924`, borrado al cierre):
laya==0.3.12 (0.3.8 yanked de PyPI el 2026-09-24; resto de pins ==;
`py/requirements*.txt` NO tocados), torch 2.14.0+cu130 CUDA True, GPU
RTX 5060 Ti 16GB. laya-server :8765 (3/3 ckpts, cold-start 90s
warming-call -> ready, PID VRAM-residente 5.7GB, /ready device "auto");
gliner-server :8766 (fastino/gliner2.5-multi-v1, ~15s, /ready device
"cuda" verbatim). N = 2 pasadas x 88 golds = 176 filas; pasadas
bit-identicas salvo latencias (Router determinista) -> N util = juicios
pooled con la SIGNAL_MAP de score.mjs (+ compare en winner_probability).

### Veredicto T2

**CONFIRMA Fase 7 con datos live.** Brier 0.280-0.707 y ECE(10)
0.286-0.829: ninguna senal se comporta como probabilidad.
wrong_confident live > 0 en 7/10 primitives aplicables (el 0.000 stub
era techo de stub, no calidad). Las abstenciones live son menores que
las stub (senales reales casi nunca faltan: verify 0.571->0.143, find
0.571->0.286, classify 0.143->0.000).

### N por primitive (juicios pooled, 2 pasadas)

| primitive | casos/pasada | pasadas | scored (N) | excluidos (throw/abst/null) |
|---|---|---|---|---|
| laya_classify | 8 | 2 | 16 | 0/0/0 |
| laya_decide | 8 | 2 | 12 | 0/2/0 |
| laya_verify | 8 | 2 | 14 | 0/0/0 |
| laya_screen | 8 | 2 | 14 | 0/0/0 |
| laya_pii | 8 | 2 | 6 | 0/2/6 |
| laya_extract | 8 | 2 | 10 | 0/4/0 |
| laya_find | 8 | 2 | 10 | 0/4/0 |
| laya_rerank | 8 | 2 | n/a (ranking n=12: MRR 0.917, nDCG 0.977) | 2 throws fuera |
| laya_review | 8 | 2 | 14 | 0/0/0 |
| laya_gate | 8 | 2 | 16 | 0/0/0 |
| laya_compare | 8 | 2 | 14 | 0/0/0 |

### ECE / Brier / wrong_confident LIVE (senal indicada)

| primitive | senal | Brier | ECE(10) | wc@0.70 | wc@0.80 | wc@0.90 | wc@0.95 |
|---|---|---|---|---|---|---|---|
| classify | winner_probability | 0.284 | 0.458 | 0.375 | 0.000 | 0.000 | 0.000 |
| decide | winner_probability | 0.308 | 0.295 | 0.333 | 0.333 | 0.333 | 0.333 |
| verify | per-claim support | 0.347 | 0.392 | 0.286 | 0.143 | 0.143 | 0.000 |
| screen | injection | 0.426 | 0.598 | 0.143 | 0.143 | 0.143 | 0.000 |
| pii | max detector_score | 0.291 | 0.286 | 0.333 | 0.333 | 0.333 | 0.000 |
| extract | winner_probability | 0.280 | 0.345 | 0.000 | 0.000 | 0.000 | 0.000 |
| find | winner_probability | 0.328 | 0.419 | 0.400 | 0.400 | 0.000 | 0.000 |
| rerank | — | no aplica | no aplica | no aplica | no aplica | no aplica | no aplica |
| review | safe_to_apply | 0.303 | 0.301 | 0.000 | 0.000 | 0.000 | 0.000 |
| gate | per-claim support | 0.707 | 0.829 | 0.750 | 0.750 | 0.750 | 0.000 |
| compare | winner_probability | 0.384 | 0.499 | 0.286 | 0.286 | 0.143 | 0.143 |

(wc = joint rate P(wrong AND signal >= tau); rerank/distribuciones
crudas: no aplica justificado en `evals/live-cal.mjs` — relevance_score
es within-call y las distribuciones son shares crudos.)

### Lectura honesta del acuerdo-vs-gold (dos niveles, no confundir)

1. `accuracyVsGold` (check() con pines EXACTOS de senal: winner share
   0.85, judge signals oraculo) es bajo por construccion live
   (classify/gate 0.000, decide/compare/pii 0.143): mide
   especificidad stub-gold, NO calidad backend.
2. Task accuracy (nivel etiqueta/decision) es el acuerdo significativo:
   extract 1.000, pii 0.857, verify/screen 0.714, decide/compare
   0.667, find 0.571, classify/review 0.429, gate 0.000.
3. Gate es desacuerdo sistematico (task 0.000, wc cond=1.0 hasta 0.90,
   Brier 0.707/ECE 0.829): los golds T3 (refutacion+bandas) se
   escribieron contra senales stub; el backend live discrepa en bloque.
   Dato, no tuning (CERO cambios en src/).

### Limites para la decision calibrador (T3)

- El outcome medido es ACUERDO CON GOLDS DE ERA-STUB (sobre-pineados en
  valores exactos), no etiquetas humanas independientes. Un calibrador
  futuro exige golds de outcome independientes del stub.
- pii N=6 (senal nula sin findings -> excluida): intervalos anchos, no
  concluyente solo.
- Mas pasadas no sumarian: backend determinista (0 diffs); N lo acota
  el diseno de golds, no el tiempo.
