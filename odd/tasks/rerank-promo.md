# rerank-promo — r3a owns rerank (docs-only promo) + serving dispositions

## Why
G5 verdict (`odd/tasks/r3a-lanes.md`): r3a OWNS rerank — 12/12 decision and
task (`evals/results/v12/composed.json`, rows rerank/gliclass(r3a)) vs
qwen/gte 9/12. Exploration for this feature showed the promo collapses to a
record, not code: `gliclass` is already in the rerank lane set
(`evals/lanes-r1.mjs:100`), and flipping the live default (`RERANK_URL`
→ `:8770` in `evals/live-client.mjs:66-67,94`) would break existing Qwen
users and R1 comparability. So: recommend, don't rewire. Qwen `:8768`
default stays untouched.

## Promo decision (parent, frozen)
- Recommended rerank backend where the GLiClass sidecar is available:
  `gliclass(r3a)` at `:8770` (`GLICLASS_MODEL=<abs path>/run-20261009T055724Z-r3a/checkpoint`).
- Unchanged: `RERANK_URL` default `:8768`, `LANES.rerank` membership,
  `LAYA_BENCH_RERANK_URL` fallback chain, find lane (qwen 12/12 parked,
  F7 scope stands).
- A future default flip is a separate product decision (compat break +
  live re-measurement required) — explicitly NOT this feature.

## Serving dispositions (all seven gaps, evidence-checked 2026-10-10)
- Revision pin: INTENTIONAL as-is. Server reports `revision: null +
  revision_source: "unpinned"` by honesty contract
  (`py/gliclass_server.py:11-13,205-210`, never invent a hash). The real
  pin lives lane-side: smoke computes sha256 of `model.safetensors` +
  run-dir into the manifest (`evals/smoke-r3a-lanes.mjs` header). Nothing to do.
- 25-label cap: DONE. Enforced via 413, never silently cut
  (`py/gliclass_server.py:25-26,299-302`); gate fan-out already sends one
  POST per claim (`evals/lanes-r1.mjs:56-59`). Nothing to do.
- Magnitudes in `probabilities`: ACCEPTED provisional adjudication (G5
  decision 1). Raw scores/margins preserved per row in `metrics.json`;
  future routing uses raw margins, never bands. Changing it now = behavior
  change needing live re-measurement. No change.
- Ties: DONE. Input-order via handler stable sort
  (`evals/lanes-r1.mjs:40-43,70-71`). Nothing to do.
- `/health`, in-flight cap, stdlib `http.server`: OUT OF SCOPE (S5, noted
  in r3a-lanes spec). Reopening needs separate sign-off. No change.
- One-command bring-up: DOCUMENTED (smoke header:
  `GLICLASS_MODEL=<ckpt> py/.venv-r1/bin/python py/gliclass_server.py`).
  Verified `py/.venv-r1/bin/python` exists 2026-10-10. No new script —
  a wrapper adds surface for zero gain.

## Allowed edit surfaces
- `odd/tasks/rerank-promo.md` (this file). No source writes in this feature.

## Acceptance criteria
- `node evals/run.mjs` 98/98 AND `--corpus r1` 158/158 intact (tree clean,
  zero source diffs — cited from this session's observed runs).
- Qwen `:8768` default untouched (grep `live-client.mjs`).
- No retraining, no r1 threshold tuning, no push/PR/merge (user decisions).

## Applicable checks
- No test-first: passive documentation, no behavior change. Proportionate
  verification = regression cited + `git status` clean + venv path exists.
- Native review skipped: trivial passive documentation-only edit.
