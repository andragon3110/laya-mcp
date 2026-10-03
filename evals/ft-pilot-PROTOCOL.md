# ft-pilot T4 protocol — frozen conventions

Status: FROZEN for T4 (eval A/B base-vs-FT). Parent commit `4c604c6` on
`odd/ft-pilot-data`. Scope: conventions only. T4 must not touch the harness
(`evals/run.mjs`, `evals/score.mjs`, `evals/multirun.mjs`), any suite in
`evals/suites/`, `src/`, `py/`, or T2 data in `ft-sft-laya/`.

Sources (read-only): `odd/tasks/ft-pilot.md` (T1 design + T2a–T2d + 12-item
cross-session note); `evals/multirun.mjs` (what it reports today, §5 below);
`evals/results/doubt-gate-es/BASELINE.md` §4 (calibration bands) and §6
(operative cut `0.90-UNCALIBRATED-CONSERVATIVE`).

Cross-session items 1–4 (the four T4 gaps) are frozen here:
1. clear/doubtful split per tool in scoring → §1;
2. timeouts/hangs as a metric → §3;
3. per-call latency with caveat → §3;
4. Jungla CSV as external test-only set (license gap, never train) → §6.

## 1. Clear / doubtful split per tool (scoring)

Kind vocabulary (all 10 tools): `normal`, `difficult` (difficult-edge pins),
`ambiguous`, `adversarial`, `negative`, `abstention` (null = backend silence),
plus `limit` (`input_too_large` guard rows, live only in `evals/suites/*.mjs`,
never materialized as T2 files).

Frozen mapping — identical kinds across tools; decisions differ per policy:

| tool | clear (accuracy-scored) | doubtful (doubt-scored, NOT accuracy) | out of scoring |
|---|---|---|---|
| screen | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| verify | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| classify | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| decide | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| extract | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| find | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| rerank | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| review | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| gate | normal, difficult, adversarial, negative | ambiguous, abstention | limit |
| compare | normal, difficult, adversarial, negative | ambiguous, abstention | limit |

Rules: clear rows score `acc` (agreement with held-out golds); doubtful rows
score `doubt-rate` (fraction below the doubt threshold), never `acc`;
`limit` rows score guard behavior only (threw `input_too_large`, 0 model
calls), never judgment. Exam composition stays 20/tool (4 normal + 4
difficult + 3 ambiguous + 3 adversarial + 3 negative + 3 abstention) + 20
limit rows living in the suites = 220 total. Jungla `ambiguo` rows map to
doubtful by definition when used as an external set (§6).

## 2. Frozen thresholds

- Doubt: declared confidence `< 0.80` → the model doubted (rule fixed before
  the first Jungla run, never retouched).
- Sure: declared confidence `≥ 0.90` → "estoy seguro" (same frozen rule).
- Operative cut (vigente): `minConfidence = 0.90`, flagged
  `UNCALIBRATED-CONSERVATIVE (sin señal)` per BASELINE §6. Rationale: §4 bands
  overlap (`≥0.90`: 0/6 on effectively 1 case; `0.80–0.90`: 12/24 = 0.500;
  `<0.80`: 36/84 = 0.429), so no data-driven cut separates hits from misses;
  the honest posture is the high tripwire ("ante duda se escala, no se
  bloquea"), explicitly NOT a measurement.
- Consequences (stated, not hidden): on ES-like traffic ~95% escalates
  (108/114 case-passes `< 0.90`; p90 = 0.877); the `≥0.90` band itself is 0/6,
  so the gate waves through exactly the misses it would most want to catch.
- Do NOT lower the cut to "reduce noise" (e.g. 0.50 escalates nothing: min
  observed 0.5155) — that would launder an uncalibrated number into a
  permissive one. T3/T4 must carry the flag, not just the number.
- Deterministic doubt shapes worth gating on (BASELINE §6 forward notes, not
  claims): within-epsilon-of-cut proximity (sph-es-04 sits 0.0015 under the
  block line with zero variance); verify refutation weakness (contradicted
  golds with refute 0.29/0.20) and firm-support + firm-refute conflict
  (vaut-es-05, minConf 0.960 yet a miss). Scalar confidence alone does not
  separate hits from misses on these slices.

## 3. Mandatory T4 report columns (per tool + totals)

Every T4 A/B report (base-vs-FT, 220 exam + 80 anchor + optional external
set) MUST contain, per tool and pooled:

- `acc` on clear rows only (with n), `sure-rate` (fraction `≥ 0.90`) and
  `doubt-rate` (fraction `< 0.80`) on clear AND doubtful slices separately.
- Timeouts/hangs: count + rate, with the declared per-call limit stated up
  front (limit value, what counts as hang vs model judgment, affected case
  ids). The Jungla precedent (1/10 Jev calls hung ~30–45 s, never the same
  cases; wait equaled the caller timeout, i.e. a connection issue, not the
  model) must be dispositioned the same way: hangs are a metric, never
  silently retried into a pass.
- `latencyMs` per model call: median + p95, with the CPU-local caveat stated
  (Laya measured in-computer ≈22 ms ES / 46 ms EN vs Jev over internet from
  Ecuador ≈680/568 ms; different measures, never compared row-by-row).
- Flips: `flipped_cases` (pass-any-but-not-all) across the declared N, plus
  `unstable_decisions` and `unstable_questions` counts with case lists.
- Byte-identity: fraction of rows with byte-identical captured backend
  questions across passes (120/120 in BASELINE T2); any non-identical row
  listed with `sigDelta`.
- Bundle of results: raw pass files + machine-readable report + this protocol
  sha pinned together (same "bundle" discipline as the cross-session
  partial: no orphan numbers).

## 4. Single-pass scoring separated from stability; N declared first

- Scoring = SINGLE pass per model per case (one shot, no retries, no
  re-asking, no cherry-picking). Temperature settings never count as a method
  improvement.
- Stability = SEPARATE multirun on the same frozen exam, with N declared
  BEFORE running (BASELINE precedent: N = 6 over 20 ES cases + 1 anchor pass
  over 80 base cases = 114 ES + 72 anchor calls, 0 × HTTP 500).
- What `evals/multirun.mjs` reports today (read-only, unchanged): per-pass
  `passed/total` + `pass_rate`; per-case `pass_by_pass`, `pass_all`,
  `flipped`, `stable_decision` (identical check output every pass),
  `stable_questions` (byte-identical captured backend questions every pass);
  pooled `variance: total_cases, flipped_cases, unstable_decisions,
  unstable_questions`. Under the oracle stub every pass is deterministic BY
  CONSTRUCTION (expected variance ZERO; a non-zero flip means
  harness/handler nondeterminism, never model variance). It carries no
  thresholds, gates, or `answer_confidence` logic.

## 5. Post-hoc fix policy (exam frozen)

The exam is frozen once T4 starts. Any post-hoc correction (gold fix, prompt
fix, harness fix) requires: what changed, why, affected case ids, and
before/after deltas on every mandatory column (§3) for base AND FT —
never silent. Precedent: the Jungla mermelada correction (annotated
`amarillo` → `rojo` after seeing Jev's answer; disclosed in-article; Jev
95→96, Laya-ES 53→52) is the model: disclosed, counted both sides, single
case. Undisclosed retouching of questions or golds after results is void.

## 6. External Jungla CSV — test-only, NEVER committed (license gap)

- Provenance: article `https://jungladigital.com/jev-vs-laya/` (section "Cómo
  repetir la prueba con tus propios casos"; also referenced from
  `https://jungladigital.com/jev-vs-kev-y-djev/`); CSV
  `https://jungladigital.com/wp-content/uploads/jev-vs-laya/jev-vs-laya-120-casos.csv`;
  bundle ZIP `https://jungladigital.com/wp-content/uploads/jev-vs-laya/jev-vs-laya-prueba.zip`.
- Schema (inspected in TEMP only, 2026-10-03): sha256
  `51B8464FD24D657B25E42FE639076F46B4D9D04F6103786E5621A69963D84272`;
  120 data rows; 15 columns `tarea,caso,texto_es,texto_en,esperado,jev_es_dijo,
  jev_es_seguridad,laya_ml_es_dijo,laya_ml_es_seguridad,jev_en_dijo,
  jev_en_seguridad,laya_en_dijo,laya_en_seguridad,laya_ml_en_dijo,
  laya_ml_en_seguridad`; 6 tasks × 20 (`semaforo,estafa,freno,camara,correo,
  resena`); `texto_es` 120/120 non-empty, `texto_en` 120/120 non-empty;
  `esperado` includes `ambiguo` (the by-design doubtful rows).
- Download headers (2026-10-03): `HTTP 200`, `Content-Type: text/csv`,
  `Content-Length: 37908`, `Last-Modified: Thu, 24 Sep 2026 20:10:23 GMT`;
  NO `Content-Disposition` license, NO `License` header, NO grant.
- License finding: NO explicit permissive license found. Both article pages
  offer the CSV/ZIP for download with no license text (no CC0/CC-BY/MIT/
  public-domain grant, no redistribution terms); footers read `© 2026 Jungla
  Digital`. Decision per ft-pilot constraint (public repo = redistribution):
  the CSV is NOT committed (`evals/external/` stays absent).
- T4 procedure: fetch to TEMP at eval time (`%TEMP%/jungla-120.csv`), verify
  sha256 above, run as an external test-only set (doubt/sure columns per §3;
  `ambiguo` → doubtful per §1). NEVER commit to the repo, NEVER train on it.
  No-redistribution note: do not re-host, attach, or inline the file contents
  beyond short fair-use excerpts with source links.

## 7. Keep rule (T4-mejora-laya)

- KEEP iff ALL hold: (i) `Δpass ≥ +5 pts` on the frozen exam vs base;
  (ii) ZERO regressions on the 80-case anchor (per-suite identical or better);
  (iii) sure-band not worse (sure-rate `≥ 0.90` precision must not degrade).
- KILL iff `Δpass ≤ 0` or any anchor regression. Temperature never counts.
- Cost envelope (unchanged): $0 (Kaggle free 2×T4 or equivalent); final
  inference stays CPU-local.
