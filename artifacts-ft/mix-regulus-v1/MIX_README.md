# WS-E regulus-v1 mix (built 2026-10-12, `py/.venv-ft/Scripts/python /tmp/mk-mix.py`)

## Files
- `batch4-train.jsonl`: **104 rows**, schema `{id, text, labels(true), candidates, source}`
- `eval-ids.txt`: **140 ids** (60 r1 + 80 v2/v2b/v2c, extracted from the live corpora);
  overlap with the 104 train ids: **0** (checked at build time, enforced again at train time).
- `cselect.json`: stock logits on validation-80 + C comparison (selected **C=0.05**).

## Composition (all SIGNED human 2026-10-12, 0 DRAFT — build refuses otherwise)
| subset | n | text | true labels | candidates (lane set) |
|---|---|---|---|---|
| classify-other (ft/batch4) | 20 (10 EN/10 ES) | item text | `[other]` | `[bug, feature, other]` |
| gate-silence (ft/batch4) | 20 (10/10) | `evidence \|\| claim` | `[ABSTAIN]` | `[SUPPORTED, CONTRADICTED, ABSTAIN]` |
| screen-filler (ft/batch4, incl. 10 near-inject) | 40 (20/20) | input.text | `[suspicious]` | `[benign, suspicious, malicious]` |
| d3-distill-candidates (ft/batch4) | 24 (12/12) | `evidence \|\| claim` | `[ABSTAIN]` | `[SUPPORTED, CONTRADICTED, ABSTAIN]` |

Train-time `all_labels` = union of candidates = 9 labels
(`ABSTAIN, CONTRADICTED, SUPPORTED, benign, bug, feature, malicious, other, suspicious`).

## Mapping rationale (mirrors `evals/lanes-r1.mjs` lane construction exactly)
- classify: item text vs criteria keys, argmax → choice. true=`[other]` ✓ attainable.
- gate: per-claim POST `evidence || claim` vs 3 labels; ABSTAIN-win omits keys →
  handler ABSTAIN verdict + ESCALATE. true=`[ABSTAIN]` (NOT `[]`: all-zero targets
  cannot win an argmax; the script docstring's `[]` convention predates the harness).
- screen: text vs 3 labels; suspicious-0.5 → REVIEW + assessment `ambiguous`.
  true=`[suspicious]`. CEILING (structural, no SFT can move it): gold assessment
  `irrelevant` needs the low-substance leg, which the lane pins at constant 0.9
  (`GLICLASS_SCREEN_PRIOR`) — `irrelevant` is unreachable via any gliclass model.
  Screen task on fillers can therefore never match; only decision REVIEW is movable.

## Known gaps / caveats (recorded, not hidden)
1. **Replay/anchors (~600) ABSENT**: `train/` + en/es-3400s + refnear + hardneg +
   boilerplate live only in the external worktree (absent on this machine; verified by
   find + git history — never committed here). NO substitute invented. Mix = batch-4
   only (104 rows → 13 steps/epoch → 26 steps total at batch 8). Floor-collapse risk
   is carried by (a) the conservative IDK dynamics (confident rows price abstention
   over forcing, scorer gradient down-weighted by (1-q)), (b) the tiny step count,
   (c) the ABORT bar, and verified by the single final r1 pass; promotion requires
   floors held (else NO-PROMOTE + revert, checkpoints untouched).
2. **d3 agreement unmeasured**: the 24 d3 rows are construction-ABSTAIN SIGNED, but the
   d3-labeling agreement rate (WS-C readiness item) was never measured (d3 bridge :8002
   never up on this machine). They train as ABSTAIN like the 20 gate-silence rows.
3. **Validation-80 ⊂ train (lineage-consistent)**: the batch-4 validation split rows are
   IN the train mix (r3i precedent: trained on v2-80, evaluated v2). Held-out judges are
   corpus-v2 batches 1-3 (different ids/texts, excluded via eval-ids) + the r1 floor.
   Post-train batch-4 numbers measure train-fit; v2 + r1 measure generalization.
4. **Gate has no SUPPORTED/CONTRADICTED supervision on disk** (v2-gate is 100% abstention
   golds, r1-gate is floor/excluded): gate train pressure is ABSTAIN-only (44 rows).
   The IDK pricing (C=0.05) is what prevents always-ABSTAIN collapse — verified post-hoc
   by r1-gate normals + v2-gate misses table, not assumed.
