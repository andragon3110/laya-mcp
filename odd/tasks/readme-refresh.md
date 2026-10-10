# readme-refresh — status docs catch up with the GLiClass track (Oct 2026)

## Why
Public docs still say PAUSED with only the Laya-judge verdict. Since then the
GLiClass r3a track measured composed 56/60 decision, 55/60 task (live, CPU,
twice-identical) and owns rerank 12/12. Docs must state both truths: the Laya
verdict stands AND the GLiClass track is active with scoped claims.

## Scope decisions (parent, frozen)
- README: prepend a GLiClass-track status block ABOVE the pause banner;
  keep the pause block intact as history (Laya track). Update the status
  badge to active. No other README restructuring.
- EVALUATION.md: append §13 (r3a track, method, per-version notes, open
  gaps). Do NOT rewrite §§1–12 (frozen record).
- Numbers stated: v12 published 54/60 task; post-fix live re-measure (/tmp/v14)
  55/60 task; decision 56/60 both. Say where each lives.
- Caveats mandatory: gate/screen assistive (abstention), not autonomous;
  r1 = 60 golds (48 over r3a lanes + 12 find); Laya verdict unchanged.
- Forbidden: claiming autonomy for gate/screen, moving/deleting old verdicts,
  push/PR/merge (user decisions).

## Allowed edit surfaces
- `README.md` (banner block + badge line only).
- `EVALUATION.md` (append §13 only).
- `odd/tasks/readme-refresh.md` (this file).

## Acceptance criteria
- `git diff --stat` shows only README.md + EVALUATION.md (+ this file).
- No source diffs; stub/r1 untouched (docs-only, no test-first; proportionate
  check = diff scope + markdown sanity).
- Native review skipped: trivial passive documentation-only edit.

## Applicable checks
- `git diff --stat` scope check + visual read-back of both hunks.
