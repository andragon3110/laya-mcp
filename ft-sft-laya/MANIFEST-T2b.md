# T2b MANIFEST — classify + decide + extract SFT batch (300 train + 60 exam)

Batch: `odd/ft-pilot-data` from `a032503` (tracked tree clean; only known `??`
task docs + `.atl/`). Scope: NEW files under `ft-sft-laya/` only. No `src/`,
`py/`, suites, harness, `ft/`, or T2a files touched.

## Files

| file | rows | ES | EN | ALLOW | ESCALATE |
|---|---|---|---|---|---|
| `train-classify.jsonl` | 100 | 50 | 50 | 85 | 15 |
| `train-decide.jsonl` | 100 | 50 | 50 | 57 | 43 |
| `train-extract.jsonl` | 100 | 50 | 50 | 70 | 30 |
| `exam-classify.jsonl` | 20 | 10 | 10 | 17 | 3 |
| `exam-decide.jsonl` | 20 | 10 | 10 | 11 | 9 |
| `exam-extract.jsonl` | 20 | 10 | 10 | 14 | 6 |

Kind mix per train tool file (difficult-edge filed as v1 `difficult`,
abstencion filed as v1 `abstention`):
normal 20 (10/10) / difficult-edge 20 (10/10) / ambiguous 15 (8 ES+7 EN) /
adversarial 15 (8 ES+7 EN) / negative 15 (7 ES+8 EN) / abstention-null 15
(7 ES+8 EN). Exam per tool file: 4 normal + 4 difficult + 3 ambiguous +
3 adversarial + 3 negative + 3 abstention (10 ES / 10 EN).

## Row schema (ft-v1 reused, no extension)

Fields: `id lang primitive kind state questions labels decision source seed notes`.
`primitive` in {classify, decide, extract}; `kind` in v1 set; `decision` in
{ALLOW, ESCALATE} (these three policies never emit REVIEW/DENY under
policy@1.0.0); `source` in {synthetic-template, adapted-gold-pattern,
hand-adversarial}; `seed` 12 (T2a used 11; new lot, new seed).
Questions are verbatim builders: classify 1x choice (`class_0_<id>`, 3-5
classes + auto `other`); decide 1x choice `selected` (2-4 opts) + 0-2x noul
`requirement_<i>` with the stage-1 winner id (+description) injected per
`buildRequirementQuestions`; extract 1-2x choice `extract_<i>_<field>`
**regex path only** (`m<n>` per real match + `none`; the entities path pins
the `typed-decisions` judge and is not trained here).
Labels hard: choice `{choice, probabilities}` one-hot (documented pins:
difficult-edge `{winner:0.55, runner:0.45}`, ambiguous exact ties `0.5/0.5`,
decide-ambiguous exact `1/N`); decide requirements `{noul:0/1}`; `null` =
backend silence (never 0). Null-selection decide rows carry only the stage-1
`selected` question (stage 2 never runs without a winner, per handler).
Decisions recomputed from labels under policy@1.0.0, risk normal: classify
firm -> ALLOW, missing/empty -> ESCALATE; decide flat (`top <= 1/N`),
null/empty selection, missing req, or req `< 0.8` -> ESCALATE;
extract invalid-pattern / zero-candidate / null -> ESCALATE, firm `none`
with candidates and rogue `m99` -> ALLOW (grounding resolves null, policy
stays firm — handler-level pins from `evals/suites/extract.mjs`).

## Signal design (labels |- decision)

- classify normal: clear text, winner one-hot -> ALLOW. difficult-edge:
  borderline text, exact 0.55/0.45 split -> ALLOW (v1 has no tie band).
  ambiguous: vacuous text, exact 0.5/0.5 tie, stated choice authoritative ->
  ALLOW. adversarial: injection in item text obeyed by text-reading judge
  (no hierarchy-defense pin) -> ALLOW. negative: rogue token outside the
  catalog echoed verbatim (no allow-list pin) -> ALLOW. abstention: label
  `null` -> ESCALATE.
- decide normal: clear winner one-hot, 0-2 reqs met (`noul` 1) -> ALLOW.
  difficult-edge: exact 0.55/0.45, req met -> ALLOW (clears 1/2 baseline).
  ambiguous: exact uniform 1/N (always 2 opts, 0.5/0.5) -> ESCALATE (flat
  band rules even with met reqs). adversarial: identical descriptions,
  winner resolved by id, req scoped to winner -> ALLOW. negative: rogue
  winner id -> ALLOW (echo verbatim) / unsupported req (`noul` 0) ->
  ESCALATE. abstention: stage-1 silence (no stage 2, req unevaluated) or
  req signal `null` with firm pick -> ESCALATE.
- extract normal: unique grounded match per field -> m0 one-hot -> ALLOW.
  difficult-edge: same surface 3x at distinct offsets, m2 (field 0) ->
  ALLOW. ambiguous: two matches, exact 0.5/0.5 tie, stated key -> ALLOW.
  adversarial: rogue key m99 one-hot -> value null/not_found (never
  synthesized) -> ALLOW. negative: invalid pattern `[` or zero-candidate
  doc, firm `none` -> ESCALATE. abstention: any field label `null` ->
  ESCALATE.
- ES rows hand-templated natural Spanish (no MTese; reviewer blocklist);
  EN mirrors native, not translated. Fresh domains per tool (support
  tickets/building/library/clinic/bistro; couriers/halls/printers/catering/
  backups/courses; orders/invoices/flights/tracking/batches/serials/
  bookings/item-codes), machine-disjoint from suites and T2a (gates below).

## Two-model honesty declaration

GEN and REVIEW share ONE model base (this session): GEN = constructive pass
(template synthesis per cell spec, seed 12, asserts label|-decision at build,
extract grounding loop retries serials until match counts are exactly as
designed); REVIEW = separate hostile-auditor pass with checklist
(a) schema + builder-verbatim shape (instructions/criteria exact, extract
criteria recomputed from live regex, offsets grounded),
(b) independent decision recomputation under policy@1.0.0,
(c) dedup/disjointness + id/serial uniqueness,
(d) kind-signal pins (edge exactness 0.55, tie 0.5/0.5, flat 1/N, rogue
outside catalog, injection present, noul hard 0/1, null-never-zero) +
MTese blocklist.
Correlation is compensated by deterministic machine gates, not by a second
model: schema shape, exact + containment(>=40ch) dedup intra-lot and vs
`evals/suites/*.mjs` literals and vs committed T2a rows, id uniqueness,
per-row serial uniqueness, and label|-decision recomputation.

## QC results

- REVIEW round 1: 352/360 ACCEPT (97.8%) -> above the 95% threshold, but the
  8 REJECTs triaged as a REVIEW checklist bug (required `requirement_<i>`
  questions even when `selected` was null, i.e. demanded a stage-2 run the
  handler never performs) plus a serial metric that counted by-design
  intra-row repeats (difficult 3x codes) as collisions. Data untouched;
  reviewer fixed (null selection -> req questions must be ABSENT; serials
  per-row deduped before cross-row comparison).
- REVIEW round 2 (final): 360/360 ACCEPT (100%), every file 100%.
- Binding gates: schema 0 errors; exact-dup intra-lot 0; containment
  (>=40ch core-text spans) intra-lot 0; vs held-out (`evals/suites/*.mjs`)
  0; vs committed T2a rows 0; duplicate ids 0; cross-row serial collisions
  0; label|-decision mismatches 0.
- Decision split (train): classify 85/15, decide 57/43, extract 70/30
  (ALLOW/ESCALATE); exam splits consistent per kind math.

## Gaps / non-goals

- Oversize `input_too_large` limit rows omitted (builder guards, already
  pinned by suites; SFT teaches decisions, not guards). Limits #377/#394
  stay suite-covered.
- Extract entities path omitted by design (judge pinned to typed-decisions).
- Decide ambiguous rows use 2 options only (exact 0.5/0.5 representable;
  1/3+ floats would blur the flat-band pin).
- Single-base GEN+REVIEW correlation declared above; independent verifier
  lands at T2d close per plan.
