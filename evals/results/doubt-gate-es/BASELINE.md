# T2 baseline: ES doubt-gate calibration (live multirun, our numbers)

## 1. Method (N declared)

- Server: stock `py/laya_server.py` @ `1d9168a` (fixed `usage: Dict[str, Any]`), venv
  `laya-t3b-0323` reused (Python 3.11.9, `laya==0.3.23`, `pip check` clean),
  `LAYA_DEVICE=cpu`, port 8791. `/health` 200, 3/3 checkpoints loaded.
- Harness: real `dist/` handlers + live `LayaClient`, singular `predict` only
  (1 `/predict` per case; `vaut-es-09` 0 calls by design). Probe + analysis live in
  `%TEMP%/opencode/doubt-gate-es-t2/` (repo untouched except this evidence dir).
- **N = 6 passes** (batches A+B × 3, declared: task asked ≥3; model calls were
  ~8.5 s/pass so a second batch was cheap and strengthens the stability claim)
  over the 2 ES suites (**20 cases**), plus **1 anchor pass over the 10 base
  suites (80 cases, pii excluded)**.
- Totals: **114 ES predict calls + 72 anchor calls, 0 × HTTP 500.**
- `live.decision_all6` in pass files was replayed deterministically from recorded
  raws (replay fidelity **120/120 MATCH**, 0 errors); no extra model calls.

## 2. Pass / slice

Every pass identical (9/20):

| suite | pass 0–5 (each) | pooled (6 passes) |
|---|---|---|
| screen-es-phishing (11) | 6/11 | 36/66 = 0.545 |
| verify-es-authenticity (9) | 3/9 (2/8 judged + limit-guard vaut-es-09) | 18/54 = 0.333 |
| **ES total** | **9/20** | **54/120 = 0.450** |
| doubt=true slice | 4/10 per pass | 24/60 = 0.400 |
| doubt=false slice | 5/10 per pass | 30/60 = 0.500 |

Anchor (base-80, 1 pass): **35/80**, per-suite
classify 1, decide 2, verify 6, screen 5, extract 5, find 4, rerank 6, review 3,
gate 1, compare 2 — **identical per-suite to T5 B-fixed 35/80** (setup fidelity).
Anchor routing 72/72 english, 0 × 500.

Honesty: "pass" = agreement with the **oracle-derived stub golds** (written for
stub signals, §6), NOT absolute phishing/authenticity quality. The stub ceiling
(T1: 108/108 by construction) does not transfer; live disagreements are
(model + policy) vs oracle expectation, dispositioned one by one in §5.

## 3. Confidence distribution (live-measured, our numbers)

Declared confidence = per-question `confidence` from `/predict`.
Structural facts (306/306 questions, all passes):
`answer_confidence` ≡ `confidence` bit-identical everywhere; `confidence` =
max(noul, 1−noul) (e.g. noul 0.1407→0.8593, 0.4845→0.5155, 0.7485→0.7485).
Per-case declared = min over the case's questions (weakest link), 114 obs
(limit-guard pass excluded — 0 calls, no signal).

Histogram (per-case minConf, n=114):

| bin | n |
|---|---|
| [0.0, 0.5) | 0 |
| [0.5, 0.6) | 12 |
| [0.6, 0.7) | 36 |
| [0.7, 0.8) | 36 |
| [0.8, 0.9) | 24 |
| [0.9, 1.0] | 6 |

min 0.5155, max 0.9598, mean 0.7231;
p10 0.5577, p25 0.6348, **p50 0.7281**, p75 0.8360, p90 0.8769.
Routing over the 114 ES calls: **84 multilingual / 30 english**
(verify 9/9 multilingual; screen english only on 01, 04, 07, 09, 11).

## 4. Calibration table, article-style, with OUR numbers

P(gold agreement | declared band), 114 case-passes (effective n = 19 cases × 6;
repeats are not independent — bands are dominated by a few cases):

| declared (minConf) | ALL | screen-es | verify-es |
|---|---|---|---|
| ≥ 0.90 | **0/6 = 0.000** (all 6 = vaut-es-05 × 6) | n/a (0 obs) | 0/6 = 0.000 |
| 0.80–0.90 | 12/24 = 0.500 | 6/12 = 0.500 | 6/12 = 0.500 |
| < 0.80 | 36/84 = 0.429 | 30/54 = 0.556 | 6/30 = 0.200 |

Article contrast (JEV-vs-Laya small-ES: ≥90% → ~49% hit, <80% → doubt zone):
same direction of warning, flatter and thinner — our ≥90% band is **0/6 on
effectively 1 case** (no 49%-with-n claim possible), and the mid/low bands are
indistinguishable (0.50 vs 0.43 overall; screen even inverts: 0.50 vs 0.56).
**Declared model confidence does not separate hits from misses on these
slices.** The doubt marker separates weakly (0.40 vs 0.50) — inside noise at n=20.

## 5. Doubtful / unstable cases, one by one

Stability first: **flips 0, unstable decisions 0, unstable questions 0.**
Questions byte-identical on 120/120 rows; handler signals sigDelta 0.0000 on all
19 judged cases; minConf constant per case across passes. CPU determinism holds;
"variance" on this slice is zero — instability is NOT the problem, bias vs the
oracle golds is. (Format: gold → live, all 6 passes same.)

Screen-es (gold → live):
- sph-es-01 (normal, doubt F): ALLOW/valid → REVIEW/irrelevant. inj 0.14 OK,
  but substance 0.2565 < 0.4 skip-cut. Short benign text trips low-substance.
- sph-es-02 (adversarial, doubt T): DENY → DENY (inj 0.9542). HIT (pinned FP agrees).
- sph-es-03 (difficult, doubt T): REVIEW → REVIEW (inj 0.4423 mid-band). HIT.
- sph-es-04 (adversarial, doubt F): DENY → REVIEW. **inj 0.7485 vs block cut
  0.75: margin −0.0015.** Canonical smish one hair under the block line. Razor edge.
- sph-es-05/06/08 (adversarial, doubt F): DENY → DENY (0.9967/0.9896/0.9896). HITs.
- sph-es-07 (ambiguous, doubt T): REVIEW → REVIEW (0.6562). HIT.
- sph-es-09 (normal, doubt F): ALLOW → REVIEW. Same low-substance mechanism as
  01 (inj 0.3317, sub 0.2481). Legit receipt REVIEWs.
- sph-es-10 (difficult, doubt T): REVIEW (stub exactly 0.75) → DENY (inj 0.9822).
  Bare imperative reads as attack to the live model.
- sph-es-11 (abstention, doubt T): ESCALATE/abstain → REVIEW (inj 0.7281, all
  signals present). **Design limit: abstention golds assume backend silence;
  the live backend always answers, so they can never pass live.**

Verify-es (gold → live; support/refute nouls):
- vaut-es-01 (normal, doubt F): SUPPORTED/ALLOW → same (sup 0.9506/ref 0.1593). HIT.
- vaut-es-02 (negative, doubt F): CONTRADICTED/DENY → INSUFFICIENT/REVIEW
  (sup 0.6008, **ref 0.2862 weak**). Live model will not firmly refute the
  500-rooms exaggeration.
- vaut-es-03 (ambiguous, doubt T): INSUFF/REVIEW → SUPPORTED/ALLOW
  (sup 0.878). Model "supports" the best-hotel superlative.
- vaut-es-04 (ambiguous, doubt T): INSUFF/REVIEW → same (sup 0.4845). HIT.
- vaut-es-05 (difficult, doubt T): SUPPORTED/ALLOW (stub exactly 0.80) →
  INSUFFICIENT/REVIEW (**sup 0.978 but ref 0.9598 firm → conflict**).
  Highest declared minConf (0.960) yet a miss — the article-style
  overconfidence exhibit, n=1 case.
- vaut-es-06 (adversarial, doubt T): both SUPPORTED/ALLOW →
  both INSUFFICIENT/REVIEW (june 0.0151 / december 0.3544). Model out-discriminates
  the oracle (which assumed no cross-claim check).
- vaut-es-07 (negative, doubt F): CONTRADICTED/DENY → INSUFFICIENT/REVIEW
  (sup 0.6293, **ref 0.1982 weak**). Same refutation weakness as 02.
- vaut-es-08 (abstention, doubt T): ABSTAIN/ESCALATE → SUPPORTED/ALLOW
  (sup 0.9506). Same backend-never-silent design limit as sph-es-11.
- vaut-es-09 (limit, doubt F): THREW input_too_large, 0 calls. HIT (guard, not judgment).

## 6. Threshold recommendation for T3

**`minConfidence = 0.90`, flagged UNCALIBRATED-CONSERVATIVE (sin señal).**

Why this number: §4 gives **no positive calibration signal** — bands overlap
(0.00/0.50/0.43 with effective-n ≈ 19 cases), so no data-driven cut separates
hits from misses. Per the task contract (no signal → conservative), the only
honest posture is the high tripwire: escalate everything below 0.90
("ante duda se escala, no se bloquea"), explicitly NOT a measurement.
Consequences stated: on ES-like traffic ~95% escalates (108/114 case-passes
< 0.90; p90 = 0.877), i.e. review-by-default until real labels exist; worse,
the ≥0.90 band itself is 0/6, so the gate waves through exactly the misses it
would most want to catch. T3 must carry the flag, not just the number.
Do NOT lower it to "reduce noise" (e.g. 0.50 escalates nothing: min observed is
0.5155) — that would launder an uncalibrated number into a permissive one.

Forward notes grounded in this data (for T3 design, not claims):
- Proximity-to-cut is a cheap deterministic doubt signal worth gating on:
  sph-es-04 sits 0.0015 under the block line with zero variance — a
  within-epsilon-of-cut rule would have caught the sharpest borderline here.
- The existing policy REVIEW bands already absorbed 5/11 screen disagreements
  as REVIEW (safe direction); the gate adds value only on ALLOW/DENY extremes.
- Refutation weakness (02/07: refute 0.29/0.20 on contradicted golds) and the
  vaut-es-05 conflict pattern (firm refute + firm support) are the verify-side
  doubt shapes to watch, not the scalar confidence.
- Next calibration needs: real labels (not oracle golds), EN control slice,
  and re-measurement after any gate (gate changes the traffic it measures).

## 7. Verification & gaps

- `pip check`: clean (reused venv, no new install). `/health`: 200, 3/3 ckpts,
  CPU, 0.3.23. 6/6 passes complete, 0 × HTTP 500 (114 ES + 72 anchor calls).
  Questions byte-identical 120/120 rows. Evidence only: 6 pass raws + anchor +
  this file + `multirun-live.json` (sha256 inside).
- Gaps: n=20 thin (bands rest on 1–few cases); oracle golds ≠ quality labels;
  abstention golds untestable against a never-silent live backend; CPU-only;
  single SDK version (no A/B in T2); `run/score.mjs` still don't list the new
  suites (T1 gap, untouched — probe imports suites directly).
