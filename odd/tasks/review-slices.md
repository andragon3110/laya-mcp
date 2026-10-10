# review-slices — monolith review split (RDD, chained slices)

## Why
Monolith `af60eb37` (80 files, `a2ce4f1..5fdec11`) blocked in START preflight:
`lens_context_budget_exceeded`. Provider bound + user decision (2026-10-10):
split into a chained sequence of smaller reviewable candidates. Each slice
gets its own inspect → consent → start → collect → acknowledge cycle, one at
a time, in a `/tmp/rev-sliceN` detached worktree so `main` stays untouched.

## Slices (disjoint, in history order; START uses explicit baseRef + committed-only)
| # | Range | Tip | Base | Files | Theme |
|---|---|---|---|---|---|
| S1 | `a2ce4f1..e86c787` | e86c787 | a2ce4f1 | ~25 | GLiNER/Qwen spike + evidence |
| S2a | `e86c787..8968691` | 8968691 | e86c787 | ~17 | r1 corpus + live harness + sidecars |
| S2b | `8968691..af94724` | af94724 | 8968691 | 19 | manifests v5-v10 + feature record |
| S3 | `af94724..ea6634f` | ea6634f | af94724 | ~12 | r3a lanes + smoke + other-lane fix |
| S4 | `ea6634f..8d5ac8f` | 8d5ac8f | ea6634f | ~26 | escalations + measured caps + redact (14 tools) |
| S5 | `8d5ac8f..5fdec11` | 5fdec11 | 8d5ac8f | ~16 | corpus-v2 + consolidation + §13/banner |

## Rules
- One slice at a time, in order. No parallel review work.
- If a slice also hits `lens_context_budget_exceeded`, halve it and record.
- Every slice START needs its own human grant (per-candidate consent).
- Forecasts are relayed losslessly; reviewer runs only after ack.
- Worktree removed after its slice is acknowledged. `main` never checked out
  elsewhere; no source writes outside this doc + memory.
- No push. Remotes untouched.

## Status
- [ ] S1, [ ] S2a, [ ] S2b, [ ] S3, [ ] S4, [ ] S5

## S1 outcome (2026-10-10)
- S1 (`a2ce4f1..e86c787`, 16 files, ~6.6k added lines) also
  `lens_context_budget_exceeded` in START preflight (human had granted).
  No authority created. Worktree `/tmp/rev-slice1` removed.
- Diagnosis: bulk is generated JSON (`32b448d` = 3719 JSON + 256 code
  lines). Code-only deltas are small (max ~1.3k lines/commit).
- Micro-slice plan for S1 (pending workload decision):
  - S1a: `a2ce4f1..44c58cc` (~1.2k, doc + gliner server + doctor)
  - S1b: `44c58cc..e293c66` (~1.3k, qwen server + live-client)
  - S1c-code: synthetic commit from `32b448d` minus `evals/results/**.json`
    (~256 lines: suites find/rerank, manifest.mjs, EVALUATION, doc)
  - S1c-data: 6 generated JSONs (~3.7k) — low review value; candidate for
    functional checks (JSON parse + manifest counts) instead of lenses
  - S1d: `e293c66..e86c787` docs + EVALUATION + lockfile (~155 lines)
- Provider candidate-views under `.git/gentle-ai/` are tool-owned; untouched.

## Workload decision (2026-10-10)
- S1a probe: GRANTED. Strategy: full chain ("Todo con review", ~12-15
  slice reviews, one grant + forecast-ack per slice).

## S1a outcome (2026-10-10) — ENVIRONMENTALLY BLOCKED
- START ok: lineage `review-feca72efc3ce43ff`, state `reviewing`, tier high
  (shell_process in py/gliner_decide_server.py), 4 lenses, 1178 lines.
- Group forecast: 4 runs via `pi_host_relay` (risk, resilience,
  readability, reliability). Human strategy grant covered the runs.
- Acknowledged run → `pi-host-relay-transport-failure`:
  `reviewer-config-invalid`, "no model is configured for review-risk",
  0 prepared / 0 submitted. Nothing admitted, nothing to repair.
- Fresh STATUS reoffers the identical 4-slot group (rev f7276a23…);
  relaunch would fail deterministically (config, not transient), so no
  retry from transcript. Prior session already noted paid reviewer models
  missing on this host (explore/verify fallback inline).
- Worktree `/tmp/rev-s1a` kept while the lineage stays open.

## Pause decision (2026-10-10)
- Human: PAUSAR y reintentar afuera. Lineage S1a
  `review-feca72efc3ce43ff` stays OPEN (reviewing, rev f7276a23…).
- Kept: `/tmp/rev-s1a` (detached at 44c58cc) for continuation.
- To resume on a host with reviewer models: `gentle_review status`
  with lineageId + workspaceRoot /tmp/rev-s1a → re-forecast group →
  ack runs → collect → acknowledge-approved → remove worktree → S1b.
- Rest of chain (S1b..S5) untouched, pending.
