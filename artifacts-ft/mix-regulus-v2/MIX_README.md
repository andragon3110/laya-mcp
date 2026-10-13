# WS-E regulus-v2 mix (built 2026-10-12, `py/.venv-ft/Scripts/python ft/gen_anchors_v2.py`)

## Files
- `batch4-train.jsonl`: **104 rows** (byte copy of `artifacts-ft/mix-regulus-v1/batch4-train.jsonl`;
  the v1 dir stays read-only), schema `{id, text, labels(true), candidates, source=batch4}`
- `anchors-train.jsonl`: **570 rows**, schema-identical, `source` = `synthetic-anchor:<lane>`
- `eval-ids.txt`: **244 ids** (EXTENDED exclusion universe: v1 140 r1+v2 ids + 104 batch-4
  train ids). Anchors were checked against all 244 (0 overlap). NOT the train-time exclusion
  (that would drop batch-4 from the mix).
- `eval-ids-train.txt`: **140 ids** (byte copy of the v1 file; the train-time `--eval-ids`,
  so batch-4 rows stay in the mix while r1/v2 ids stay out).
- `eval-texts.json`: 337 eval text strings (+trigrams) dumped from the corpora for the
  near-duplicate scan (see `overlap-report.json`).
- `cselect.json`: C re-selection on validation-80 (stock CPU-fp32 logits, focal base).
- `overlap-report.json`: 0-overlap evidence.

## Composition (674 rows total, weight 1 = plain concatenation)

| subset | n | text | true labels | candidates (K per row) |
|---|---|---|---|---|
| batch-4 SIGNED (20 classify-other + 20 gate-silence + 40 screen-filler + 24 d3-construction) | 104 | lane mappings (v1-identical) | lane golds | lane sets (K=3) |
| anchor classify: bug 60 + feature 60 + other 60 (EN/ES 90/90) | 180 | item text (general-domain: library, gym, transit, market, clinic...) | `[bug]`/`[feature]`/`[other]` | `[bug, feature, other]` (K=3) |
| anchor gate: SUP 90 + CON 90 (EN/ES 90/90) | 180 | `evidence \|\| claim` (quantitative records: logs, counts, meters...) | `[SUPPORTED]`/`[CONTRADICTED]` | 3 gate labels (K=3) |
| anchor screen: benign 120 + malicious 30 (EN/ES) | 150 | substantive factual prose / fresh-worded overrides | `[benign]`/`[malicious]` | 3 screen labels (K=3) |
| anchor relevance: rerank-style 30 + find-style 30 (EN/ES) | 60 | query | `[gold_text]` | `[gold_text, distractor_text]` order-shuffled (K=2) |

Per-row K design (the K-fix lineage, extended): every row carries explicit `candidates`;
the train loop uses each row's own candidate set as `all_labels` (K=3 lane rows, K=2
relevance rows) with an exact per-row loss loop — no global-union K (which would explode
past context with ~120 free-text relevance labels and dilute the lane gradients).

## Anchor generation method (deterministic, seed 777)
Template+slot expansion in `ft/gen_anchors_v2.py` (NO LLM, NO corpus mining). General-domain
subjects disjoint from all eval populations by construction; enforced by (a) a denylist of
eval-distinctive substrings (word-boundary match), (b) exact normalized-text match, (c) a
token-3-gram Jaccard near-dup scan vs all 337 eval texts. Result: 0 id overlap (vs 244),
0 exact-text overlap, max Jaccard 0.143, 0 denylist hits, 0 pairs >= 0.5.
Two generator bugs were caught and fixed before the final build: gate frame-1 SUP pairs
with decoupled evidence/claim numbers, and exam-count pairs with mismatched
numerator/denominator (`eleven of 10`); both now share slots. Counts: 570/570 unique ids.

## C re-selection (re-fit, NOT reused)
`ft/cselect_v2.py`, v1-identical procedure on validation-80 (v2d-* rows): stock CPU-fp32
forwards, augmentation OFF, label-shuffle OFF, focal base, grid
[0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.3], match = abstain-wins == stock-argmax-misses,
tie-break toward spike prior 0.02. Result: **C=0.05** (77/80, tied with 0.1 at 77/80,
tie broken toward 0.02 — independently fit). Scale note: force_mean 0.319 here vs v1's
0.466 because v2 prices C on per-row K=3 forwards (the v2 train encoding) while v1 priced
on K=9-union forwards; the selection procedure, not the scale, is what carries over.

## Head init (warm-start)
`AbstentionHead(bias_init=-2.2)` → q = sigmoid(-2.2) ≈ 0.0998 on every row at step 0, so
early steps carry the full (1-q) ≈ 0.9 base gradient; abstention is learned afterwards via
dL/dq = C - base. Recorded in the run config (`idk_bias_init: -2.2`, `idk_q_init: 0.0998`).

## Mapping rationale (v1-identical for lane rows; mirrors `evals/lanes-r1.mjs`)
- classify/gate/screen anchors: same lane-faithful mappings as v1 batch-4 rows.
- relevance: text=query vs the 2 shown candidate texts as labels; the lane argmaxes the
  gold text. True label is the exact gold string (order-shuffled in candidates).

## How the v1 gaps are addressed
1. **Replay/anchors ABSENT → FIXED**: 570 anchors restore the missing polarities
   (classify bug/feature, gate SUP/CON with bearing evidence, screen benign, relevance).
2. **Head zero-init half-gradient → FIXED**: warm-start bias -2.2 (q≈0.1).
3. **K-fix carried**: explicit per-row candidates (K=3/K=2, exact per-row loop).
4. **Gate SUP/CON unsupervised → FIXED**: 180 anchor pairs with bearing evidence
   (v1 had ABSTAIN-only gate pressure).

## Known caveats (recorded, not hidden)
1. **Find has no gliclass lane** (qwen/gte/d1 only): the 30 find-style rows anchor general
   relevance ability and are validated via the r1 rerank floor, never via find.
2. **Screen task ceiling stands** (assessment `irrelevant` unreachable via any gliclass
   model; low-substance leg pinned at 0.9): only decision REVIEW/ALLOW is movable.
3. **Validation-80 ⊂ train** (lineage-consistent, r3i precedent): post-train batch-4 numbers
   measure train-fit; v2 + r1 measure generalization.
4. **d3 agreement unmeasured** (carried from v1): the 24 d3 rows train as construction-ABSTAIN.
5. **Augmentation ON** (v1 recipe parity: removal 0.15 / addition 0.10 / ...): operates over a
   larger label pool now (relevance sentences join the addition pool as true negatives);
   eval-loss dataset runs augmentation OFF for a deterministic ABORT signal (instrumentation
   choice, recorded in config).
