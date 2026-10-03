# T2d MANIFEST — gate + compare SFT batch (200 train + 40 exam) + calib 200

Batch: `odd/ft-pilot-data` from `532ccc9` (tracked tree clean; only known `??`
task docs + `.atl/`). Scope: 6 NEW files under `ft-sft-laya/` only. No `src/`,
`py/`, suites, harness, `ft/`, or T2a/T2b/T2c files touched.

## Files

| file | rows | ES | EN | ALLOW | REVIEW | DENY | ESCALATE |
|---|---|---|---|---|---|---|---|
| `train-gate.jsonl` | 100 | 50 | 50 | 40 | 30 | 0 | 30 |
| `train-compare.jsonl` | 100 | 50 | 50 | 85 | 0 | 0 | 15 |
| `exam-gate.jsonl` | 20 | 10 | 10 | 8 | 6 | 0 | 6 |
| `exam-compare.jsonl` | 20 | 10 | 10 | 17 | 0 | 0 | 3 |
| `calib.jsonl` | 200 | 100 | 100 | 148 | 28 | 5 | 19 |

Kind mix per train tool file (difficult-edge filed as v1 `difficult`,
abstention-null as v1 `abstention`):
normal 20 (10/10) / difficult 20 (10/10) / ambiguous 15 (8 ES+7 EN) /
adversarial 15 (8 ES+7 EN) / negative 15 (7 ES+8 EN) / abstention-null 15
(7 ES+8 EN). Exam per tool file: 4 normal + 4 difficult + 3 ambiguous +
3 adversarial + 3 negative + 3 abstention (10 ES / 10 EN).
Calib: 20 per each of the 10 tools (screen, verify, classify, decide,
extract, find, rerank, review, gate, compare; 10 ES + 10 EN each), kinds
normal 6 / difficult 5 / ambiguous 4 / adversarial 3 / negative 2 (no
abstention kind; `null` never appears in calib — the temp fit needs signal).

## Row schema (ft-v1 reused, no extension)

Fields: `id lang primitive kind state questions labels decision source seed notes`.
`primitive` in {gate, compare, + all 10 in calib}; `kind` in v1 set;
`source` in {synthetic-template, adapted-gold-pattern, hand-adversarial};
`seed` 14 (T2a 11, T2b 12, T2c 13; new lot, new seed).
IDs `t2d-gat-tr/ex-*`, `t2d-cmp-tr/ex-*`, `t2d-cal-*`.
Questions are verbatim builders: gate 2x score (`correctness`,
`spec_match`) + 1x noul (`safe_to_apply`) + per-claim support/refutation
pair (`claim_<i>` + `refute_<i>`); compare 1x choice `overall` + 0-1x choice
`aspect_<i>_<name>` (3-way same_fact/contradicts/different_facts).
Calib rows reuse each tool's exact builder shape (screen 3x noul, verify
claim/refute pairs, classify 1x choice, decide selected + 0-1x requirement,
extract regex-path choice, find 1x choice + auto none, rerank 2-3x noul,
review 4x score + 1x noul). Labels hard: score `{score}` in {0,1,2}
(decide requirements `{noul:0/1}` per T2b precedent); noul in [0,1]; choice
`{choice, probabilities}` summing to 1.0; `null` = backend silence (never 0;
absent from calib entirely). Decisions recomputed from labels under
policy@1.0.0, risk normal: gate contradicted (refute >= 0.8 + support < 0.8)
or any missing signal -> ESCALATE, safe > 0.85 -> ALLOW, else REVIEW (never
DENY; low safety alone REVIEWs — deliberate difference from review@1.0.0);
compare firm overall+aspects -> ALLOW (relation VALUE never gates; rogue
tokens echoed verbatim), any missing -> ESCALATE.

## Signal design (labels |- decision)

- gate normal: safe 0.90-0.95, support 0.87-0.93 / refute 0.08-0.15 ->
  ALLOW. difficult-edge: safe exactly 0.86 (strict-`>` pin) or support
  exactly 0.80 (`>=` pin) -> ALLOW. ambiguous: safe 0.60-0.75, weak support
  0.45-0.65 + weak refutation -> REVIEW. adversarial: firm refutation
  0.85-0.92 + weak support with HIGH safe 0.90-0.94 -> ESCALATE (contradicted
  dominates safety). negative: low safe 0.10-0.30 with SUPPORTED claims ->
  REVIEW (risky-but-true; safety alone never escalates). abstention: one of
  safe/support/refute `null` -> ESCALATE.
- compare normal: same_fact 0.85-1.0 -> ALLOW. difficult-edge:
  contradicts 0.55-0.60 near-boundary split -> ALLOW (no cut point).
  ambiguous: different_facts 0.70-0.85 -> ALLOW (incomparability is
  reportable). adversarial: overall-vs-aspect drift split, all firm ->
  ALLOW. negative: rogue token (`unrelated`/`partial_match`/`unclear`)
  0.80 echoed -> ALLOW. abstention: overall `null`, or firm overall + aspect
  `null` -> ESCALATE.
- ES rows hand-templated natural Spanish (no MTese); EN mirrors native, not
  translated. Fresh domains per tool (gate: 12 shops x 10 code tasks;
  compare: 14 topics x 5 variants), machine-disjoint from suites and
  T2a/T2b/T2c (gates below).

## Two-model honesty declaration

GEN and REVIEW share ONE model base (this session): GEN = constructive pass
(template synthesis per cell spec, seed 14, asserts label|-decision at build);
REVIEW = separate hostile-auditor pass with checklist (a) schema + builder-
verbatim shape (questions rebuilt from state via the same builders),
(b) independent decision recomputation under policy@1.0.0,
(c) dedup/disjointness + id/serial uniqueness, (d) kind-signal pins (gate
edge exactness 0.86/0.80, contradicted dominance, strict `>` band edges;
compare near-boundary magnitudes, rogue echo, null-never-zero) + MTese
blocklist. Correlation is compensated by deterministic machine gates, not by
a second model: schema shape, exact + full-field (>=40ch) containment
intra-lot and vs `evals/suites/*.mjs` literals and vs committed T2a/T2b/T2c
rows, id uniqueness, per-row-deduped cross-row serial uniqueness, and
label|-decision recomputation.

## QC results

- REVIEW round 1 (final): 440/440 ACCEPT (100%), every file 100%. No regen
  loop needed (>=95% threshold). Two REVIEW-checklist bugs fixed before
  scoring (decide `{noul:0/1}` hard labels are signal, not silence; extract
  criteria values derive from live regex matches — structural check), plus
  GEN defects fixed during build (compare double-format `None` serials,
  missing serials, slot/verb mismatches after req rewording).
- Binding gates: schema 0 errors; exact-dup rows intra-lot 0; exact vs
  committed T2a+T2b+T2c rows 0; full-field (>=40ch) containment intra-lot 0,
  vs held-out suites 0, vs committed T2a+T2b+T2c 0; duplicate ids 0 (also 0
  vs prior); cross-row serial collisions 0 (per-row deduped; 440 distinct
  serials: gate train 87101-87200, compare train 87301-87400, gate exam
  87501-87520, compare exam 87521-87540, calib 87601-87800 — all continuing
  past prior max 86344); label|-decision mismatches 0; `null` in calib 0.
- Diagnostic only: strict 40ch-shingle intra-lot = 323 shared spans over 85
  rows (template-span sharing from slot-filled diffs/evidences, same nature
  as T2a 2530-span and T2c 313-row diagnostics; NOT a binding gate), 0 spans
  >= 60ch, 0 rows without serial.
- Decision splits (train): gate 40/30/30, compare 85/15
  (ALLOW/ESCALATE; gate ALLOW/REVIEW/ESCALATE); exam splits consistent per
  kind math; calib ALLOW 148 / REVIEW 28 / DENY 5 / ESCALATE 19 with varied
  firm signals (no all-border pins).

## T2 consolidated totals (verified by count, 2026-10-03)

| lot | train | exam | calib |
|---|---|---|---|
| T2a screen+verify (`a032503`) | 200 | 40 | 0 |
| T2b classify+decide+extract (`e539b2d`) | 300 | 60 | 0 |
| T2c find+rerank+review (`532ccc9`) | 300 | 60 | 0 |
| T2d gate+compare+calib (this) | 200 | 40 | 200 |
| **T2 total in files** | **1000** | **200** | **200** |

Exam note (honest partial vs the 220 design figure): 200 exam rows exist in
files (10 tools x 20). The remaining 20 of the ft-pilot 220 are the LIMIT
(`input_too_large`) rows, deliberately never materialized as files in any
T2 lot (T2a/T2b/T2c gap notes: builder guards, suite-covered); they live as
limit cases in `evals/suites/*.mjs`. No T2d file adds them, per precedent.

## Gaps / non-goals

- Oversize `input_too_large` limit rows omitted (builder guards, already
  pinned by suites; SFT teaches decisions, not guards). Limits stay
  suite-covered.
- Compare adversarial covers the overall-vs-aspect drift split only (no
  multi-aspect rows); gate claims capped at 2 per row (budget allows 30).
- Calib carries no `null` labels by design (temp fit needs signal);
  abstention behavior stays train/exam-covered.
- Single-base GEN+REVIEW correlation declared above; independent verifier
  was planned at T2d close — this manifest's machine gates are the
  deterministic compensation.
