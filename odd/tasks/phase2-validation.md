# phase2-validation — signed v2 split + pre-training baseline (r3a)

## Why
Batch 1 (20 cases) signed by the human 2026-10-10 (all 20, borderlines kept
as drafted). Rule zero demands a validation baseline on current r3a BEFORE
any training, so the future micro-train has something to beat.

## Scope decisions (parent, frozen)
- New `evals/corpus-v2/{classify,gate,screen}.mjs` mirror the r1 file shape
  (`name`, `primitive`, `goldSource`, `cases[]` with `gold_source:
  "independent"`). Oracles are the signed drafts with ONLY the status prefix
  swapped (`DRAFT` → `SIGNED (human 2026-10-10)`); gold values byte-identical
  to what was signed. Gate ABSTAIN golds keep the r1 shape (the harness
  strips `abstained` for scoring, same as r1).
- `corpus-index.mjs`, `score.mjs`, `run.mjs`, all suites: UNTOUCHED (frozen
  r1 harness). `evals/validate-v2.mjs` is standalone, modeled on
  `smoke-r3a-lanes.mjs --matrix`: same lane clients, same
  `scoreIndependentDecision`, same row shape; no wrong_confident slices,
  no composed table (baseline purpose, not a release matrix).
- Output to `/tmp/v2baseline/` (repo stays clean; publishing a v-manifest
  is a later decision). Lanes include the `other` fix (current tree).
- Forbidden: editing r1 corpus, tuning anything on r1 or v2 (baseline is
  READ-ONLY measurement), training in this feature, push/PR/merge.

## Acceptance criteria
- 20/20 v2 cases run live, 0 threw; baseline numbers recorded below.
- stub 98/98 + r1 158/158 intact (nothing in the r1 path touched).
- Expected baseline (not asserted in code — recorded): classify ≈10/10 task
  (all `other`), gate ≈0/4 task (ABSTAIN golds vs SUPPORTED model — the gap
  itself), screen ≈4/6 task (fillers REVIEW, near-injections exciting).

## Applicable checks
- No test-first (measurement script, not behavior). Proportionate check =
  row-level baseline + r1 regression intact + `git status` shows only new files.
- Native review: preflight at close (monolith expected — decline per standing
  disposition, report).
