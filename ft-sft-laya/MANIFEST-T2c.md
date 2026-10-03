# T2c MANIFEST — find + rerank + review SFT batch (300 train + 60 exam)

Batch: `odd/ft-pilot-data` from `e539b2d` (tracked tree clean; only known `??`
task docs + `.atl/`). Scope: NEW files under `ft-sft-laya/` only. No `src/`,
`py/`, suites, harness, `ft/`, or T2a/T2b files touched.

## Files

| file | rows | ES | EN | ALLOW | REVIEW | ESCALATE |
|---|---|---|---|---|---|---|
| `train-find.jsonl` | 100 | 50 | 50 | 55 | 0 | 45 |
| `train-rerank.jsonl` | 100 | 50 | 50 | 70 | 0 | 30 |
| `train-review.jsonl` | 100 | 50 | 50 | 40 | 30 | 30 |
| `exam-find.jsonl` | 20 | 10 | 10 | 11 | 0 | 9 |
| `exam-rerank.jsonl` | 20 | 10 | 10 | 14 | 0 | 6 |
| `exam-review.jsonl` | 20 | 10 | 10 | 8 | 6 | 6 |

Kind mix per train tool file (filed as v1 `difficult` / `abstention`):
normal 20 (10/10) / difficult-edge 20 (10/10) / ambiguous 15 (8 ES+7 EN) /
adversarial 15 (8 ES+7 EN) / negative 15 (7 ES+8 EN) / abstention-null 15
(7 ES+8 EN). Exam per tool file: 4 normal + 4 difficult + 3 ambiguous +
3 adversarial + 3 negative + 3 abstention (10 ES / 10 EN).

## Row schema (ft-v1 reused, no extension)

Fields: `id lang primitive kind state questions labels decision source seed notes`.
`primitive` in {find, rerank, review}; `kind` in v1 set; `decision` in
{ALLOW, ESCALATE} for find/rerank and {ALLOW, REVIEW, ESCALATE} for review
(never DENY); `source` in {synthetic-template, adapted-gold-pattern,
hand-adversarial}; `seed` 13 (T2a used 11, T2b 12; new lot, new seed).
IDs `t2c-fnd-tr/ex-*`, `t2c-rrk-tr/ex-*`, `t2c-rev-tr/ex-*`.
Questions are verbatim builders: find 1x choice `exists` (4-5 candidates +
auto `none`, criteria text sliced to 240); rerank 2-3x noul
`relevance_<i>_<id>` (shown-order keys, legacy unpruned path); review 4x score
(correctness/spec_match/test_gap/blast_radius) + 1x noul `safe_to_apply`
with exact builder instructions/criteria. State mirrors tool inputs:
find/rerank {query, candidates}, review {request, diff, tests} (diffs are
code patches only, comments in row language, all <= 20,000 chars).
Labels hard: choice `{choice, probabilities}` summing to 1.0 (difficult-edge
exact 0.55/0.45, ambiguous exact 0.5/0.5, rogue `{rogue:0.9, none:0.1}`,
honest-none firm); noul `{noul}` in [0,1] (rerank near-tie 0.51/0.50,
ambiguous exact 0.5/0.5, review safe pins 0.93/0.95, 0.86, 0.6-0.75, 0.5
edge, 0.10-0.30); score `{score}` in {0,1,2}; `null` = backend silence
(never 0). Decisions recomputed from labels under policy@1.0.0, risk normal:
find firm unique above-baseline (1/N on real pool) -> ALLOW, none/empty/tie/
weak (top <= 1/N) -> ESCALATE, rogue echoed verbatim -> ALLOW (no allow-list
pin); rerank all-firm -> ALLOW (ties keep input order, never abstain; no
cuts), any missing or zero candidates -> ESCALATE; review safe > 0.85 ->
ALLOW, safe > 0.5 -> REVIEW, safe <= 0.5 or missing -> ESCALATE (strict `>`
edges: 0.85 -> REVIEW band, 0.50 -> ESCALATE; rubric scores audit-only).

## Signal design (labels |- decision)

- find normal: clear query, winner one-hot 1.0 -> ALLOW. difficult-edge:
  close but distinct answers, exact 0.55/0.45 -> ALLOW (clears 1/4-1/5).
  ambiguous: two equally good answers, exact 0.5/0.5 tie, stated choice
  authoritative -> ESCALATE. adversarial: rogue id outside pool (0.9/0.1)
  -> ALLOW. negative: nothing answers, firm `none` (0.8 + spread) ->
  ESCALATE. abstention: label `null` -> ESCALATE.
- rerank normal: clear gap (0.85/0.25, 0.88/0.55/0.20) -> ALLOW.
  difficult-edge: near tie (0.51/0.50, 0.62/0.61/0.30) -> ALLOW.
  ambiguous: duplicate bodies, exact 0.5/0.5 -> ALLOW. adversarial:
  lexical bait scores 0.2, semantic answer 0.8 (judge owns order) -> ALLOW.
  negative: partial silence (first firm, rest `null`) -> ESCALATE.
  abstention: all `null` -> ESCALATE.
- review normal: 2,2,0,0 + safe 0.93/0.95 -> ALLOW. difficult-edge:
  2,2,1,0 + safe exactly 0.86 -> ALLOW. ambiguous: 1,1,1,1 + safe 0.65/0.70
  -> REVIEW. adversarial: 2,2,2,2 + safe 0.60 -> REVIEW. negative: 0,0,2,2
  + safe 0.10-0.30, or 1,1,1,0 + safe exactly 0.50 -> ESCALATE.
  abstention: firm scores + safe `null` -> ESCALATE.
- ES rows hand-templated natural Spanish (no MTese); EN mirrors native, not
  translated. Fresh domains per tool (find: kitchen/hardware/pharmacy/bus/
  trails/museum; rerank: podcast/observatory/market/chess/photo/pottery;
  review: csv/pagination/retry/validation/cache/ratelimit/markdown/dates/
  search/mail), machine-disjoint from suites and T2a/T2b (gates below).

## Two-model honesty declaration

GEN and REVIEW share ONE model base (this session): GEN = constructive pass
(template synthesis per cell spec, seed 13, asserts label|-decision at build,
find 5th-loser fix for 5-cand negative rows); REVIEW = separate
hostile-auditor pass with checklist (a) schema + builder-verbatim shape,
(b) independent decision recomputation under policy@1.0.0,
(c) dedup/disjointness + id/serial uniqueness,
(d) kind-signal pins (edge exactness 0.55/0.45, tie 0.5/0.5, rogue echo,
noul/score ranges, null-never-zero, review strict edges 0.85/0.50).
Correlation is compensated by deterministic machine gates, not by a second
model: schema shape, exact + full-span (>=40ch) containment intra-lot and vs
`evals/suites/*.mjs` literals and vs committed T2a/T2b rows, id uniqueness,
per-row-deduped cross-row serial uniqueness, and label|-decision
recomputation.

## QC results

- REVIEW round 1 (final, after GEN fix): 360/360 ACCEPT (100%), every file
  100%. No regen loop needed (>=95% threshold). One GEN defect fixed before
  review: 5-candidate negative find rows reused loser E verbatim (intra-row
  text collision); fixed with a 5th distinct loser per domain, regenerated.
- Binding gates: schema 0 errors; exact-dup rows intra-lot 0; exact-dup core
  spans (>=40ch) 0; full-span containment intra-lot 0; vs held-out suites 0
  (also 0 under strict 40ch-shingle); vs committed T2a+T2b rows 0 (also 0
  under strict shingle); duplicate ids 0; cross-row serial collisions 0
  (per-row deduped; 360 distinct serials 77101-77400 train, 78101-78320
  exam); label|-decision mismatches 0.
- Diagnostic only: strict 40ch-shingle intra-lot = 313 rows colliding
  (expected template-span sharing from slot-filled candidates/diffs, same
  nature as T2a 2530-span diagnostic; NOT a binding gate).
- Decision splits (train): find 55/45, rerank 70/30, review 40/30/30
  (ALLOW/ESCALATE, review ALLOW/REVIEW/ESCALATE); exam splits consistent per
  kind math.

## Gaps / non-goals

- Oversize `input_too_large` limit rows omitted (builder guards, already
  pinned by suites; SFT teaches decisions, not guards). Limits stay
  suite-covered.
- Rerank ambiguous duplicates bodies by design (no dedupe pin, judge still
  scores each); find has no intra-row text duplicates after fix.
- Review negative covers both low safety and the exact 0.50 edge; mid-band
  REVIEW is firm evidence (no band abstention per policy).
- Single-base GEN+REVIEW correlation declared above; independent verifier
  lands at T2d close per plan.
