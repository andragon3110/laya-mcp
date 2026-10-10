# classify-other-lane — let `other` through the gliclass classify lane (+1 task, measured)

## Why
The r1 catalog carries an explicit `other` class
(`evals/corpus-r1/classify.mjs:25-28`) and the two negative cases ship it in
their input (`classes: BUG_FEATURE_OTHER`), but `GliclassClient.predictClassify`
strips it before scoring (`evals/lanes-r1.mjs:439`). Live probe vs r3a
(2026-10-10, session-measured): EN `other` 0.402 < `feature` 0.480 (unfixable
free), ES `other` 0.723 > `feature` 0.471 (fixable). Removing the `other`
exclusion gains +1 task point (ES) with zero model risk; EN stays wrong.

## Scope override (user-authorized 2026-10-10)
G5 decision 2 in `odd/tasks/r3a-lanes.md` froze the exclusion ("scope del lane
compartido, sin cambio de lane"). The user explicitly overrode it
("ejecutemos lo que si recomiendas") for the gliclass lane only:
- Change: drop `l !== "other"` from the criteria filter; KEEP the
  `manual_review` exclusion (operator-escalation label, never a model choice).
- `laya`/`d1` lanes untouched. No retraining, no threshold tuning on r1.
- If the full-matrix re-measure shows ANY regression in the other 10
  classify cases, revert the line (revert-first rule, no negotiation).

## Allowed edit surfaces
- `evals/lanes-r1.mjs` (one filter line only).
- `odd/tasks/classify-other-lane.md` (this file).
- Forbidden: corpus files, checkpoints into git, thresholds on r1,
  push/PR/merge (user decisions).

## Acceptance criteria
- `es-negative-01`: task `other`→`other` GREEN; `en-negative-01` still
  `feature` (accepted, documented miss).
- Other 10 classify cases unchanged (matrix diff).
- `node evals/run.mjs` 98/98 AND `--corpus r1` 158/158 intact.
- Composed task 54/60 → 55/60 (decision stays 56/60).

## Applicable checks
- RED already observed (v12 + fresh /tmp/v13: both negatives task-wrong).
- GREEN check = fresh live matrix to `/tmp/v14` (12s on CPU) + stub/r1
  regression. No new test files: the r1 corpus IS the test.
- Native review: preflight inspect at close; the only offered route is the
  adjudicated-against workspace monolith — decline per standing disposition,
  report explicitly.
