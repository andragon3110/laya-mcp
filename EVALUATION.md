# Evaluation — laya-mcp (Fase 7)

This document reports what the `evals/` infrastructure measures, what it
cannot measure, and how to reproduce every number. All primitive evals run
against the real handlers (`dist/`) with deterministic oracle stubs; no
live backend, no models, and no network are involved. Nothing here is a
claim about the real backend or about agent quality.

## 1. Scope and honesty contract

- Absolute numbers only. There is no baseline, no cross-machine comparison,
  and no improvement is declared anywhere.
- Stub ceiling: every score below measures harness plus handler plumbing
  under oracle-assigned signals. Stub answers are derived from each case
  oracle (the signal a real backend would plausibly return for that input),
  never arbitrary canned responses — but they are still oracle-assigned, so
  no hit rate, calibration figure, or robustness result transfers to the
  real backend.
- Thresholds untouched: zero functional changes in `src/` across Fase 7
  (verified by the T6 no-regression battery, section 12). The
  wrong_confident taus (0.70/0.80/0.90/0.95) are reporting slices, never
  production cutoffs.
- No live comparison exists: the +/-Laya integration comparison is defined
  as a protocol with explicit requirements (section 8). No live result is
  reported because no live run happened.

## 2. Structure

| Path | Role |
|---|---|
| `evals/run.mjs` | Common harness: loads the 10 suites, runs every case against the real handler with the oracle stub, checks the output against the case gold. Exit 0 when all golds match. |
| `evals/suites/*.mjs` | 10 datasets with golds plus thin per-primitive adapters (`invoke` + `check`): `classify`, `decide`, `verify`, `screen`, `pii`, `extract`, `find`, `rerank`, `review`, `gate`. |
| `evals/metrics.mjs` | Shared pure metric functions (binary, decision accuracy, abstention, ranking, score agreement, wrong_confident). No I/O, no thresholds. |
| `evals/score.mjs` | T4 runner: applies `metrics.mjs` to the 10 suites; prints the metrics table; optionally saves to `--out` (default `artifacts/`, untracked). |
| `evals/calibration.md` | Calibration verdict: no output is a probability; Brier/ECE do not apply; forbidden conclusions. |
| `evals/bench.mjs` | T5 benchmarks: primitive latency/throughput/memory, rerank scale sweep, model-load shape. Absolutes only. |
| `evals/manifest.mjs` | T5 reproducibility manifest plus the never-overwrite versioned saver for `evals/results/vN/`. |
| `evals/integration.mjs` | T6 comparable +/-Laya protocol: 4-task hook-chain set with golds, stub arm, and live-requirements gate. |
| `evals/results/v1/` | First versioned run: `manifest.json` + `bench.json` + `metrics.json`. Never overwritten; new runs take `v2`, `v3`, … |
| `tests/fase7_t4_metrics.mjs` | 10 hand-fixture checks over `metrics.mjs` (pure functions). |
| `tests/fase7_t5_bench_manifest.mjs` | 14 structural checks over `bench.mjs` + `manifest.mjs` (shapes and versioning; no timing asserted). |
| `tests/fase7_t6_integration.mjs` | 12 structural checks over `integration.mjs` (task set, halt, null-slot honesty, live-gate refusal). |

## 3. Datasets

10 suites x 8 cases = 80 cases. Every suite covers the six honest
classes: normal, ambiguous, difficult, adversarial, negative, abstention.
One negative case per suite is a fail-fast limit test (`input_too_large`
throw), counted in `abstention.errors`, never in quality denominators.

| Suite | Primitive | Normal | Difficult | Ambiguous | Adversarial | Negative (incl. limit) | Abstention | Total |
|---|---|---|---|---|---|---|---|---|
| `classify` | `laya_classify` | 2 | 1 | 1 | 1 | 2 (1) | 1 | 8 |
| `decide` | `laya_decide` | 1 | 1 | 1 | 1 | 2 (1) | 2 | 8 |
| `verify` | `laya_verify` | 1 | 1 | 1 | 1 | 2 (1) | 2 | 8 |
| `screen` | `laya_screen` | 1 | 1 | 1 | 2 | 2 (1) | 1 | 8 |
| `pii` | `laya_pii` | 2 | 1 | 1 | 1 | 2 (1) | 1 | 8 |
| `extract` | `laya_extract` | 1 | 1 | 1 | 1 | 3 (1) | 1 | 8 |
| `find` | `laya_find` | 1 | 1 | 1 | 1 | 2 (1) | 2 | 8 |
| `rerank` | `laya_rerank` | 2 | 1 | 1 | 1 | 2 (1) | 1 | 8 |
| `review` | `laya_review` | 1 | 1 | 1 | 1 | 3 (1) | 1 | 8 |
| `gate` | `laya_gate` | 1 | 1 | 1 | 1 | 3 (1) | 1 | 8 |
| **Total** | | **13** | **10** | **10** | **11** | **23 (10)** | **13** | **80** |

Each suite file documents its own `stubModel` (which backend signal each
oracle answer emulates) and `stubLimits` (what the stub cannot prove).
The harness smoke state is 80/80 golds matching (`node evals/run.mjs`).

## 4. Metrics by primitive

Family `binary` = exact-match decision accuracy + task accuracy + ALLOW
polarity P/R/F1/FPR/FNR + abstention rate + wrong_confident.
Family `ranking` (rerank) = MRR/nDCG/MAP/top-k over orders.
Family `agreement` (review/gate) = decision accuracy + task accuracy +
abstention rate + wrong_confident; rubric-score agreement is defined in
`scoreAgreement()` for future score oracles.

| Primitive(s) | Valid here | Not applicable (with reason) |
|---|---|---|
| `classify`, `decide`, `verify`, `screen`, `pii`, `extract`, `find` (+`compare`, future) | accuracy, P/R/F1 on ALLOW polarity, FPR/FNR, `abstention_rate`, `wrong_confident_rate` on the primitive signal | Brier/ECE (no calibrated probabilities exist) |
| `review`, `gate` | decision accuracy, task accuracy, `abstention_rate`, `wrong_confident_rate` on the safe / per-claim signal | Brier/ECE (same reason); rubric-score agreement on T3 golds (golds hold decisions, not score oracles) |
| `rerank` | MRR/nDCG/MAP/top-k over ranked orders | accuracy over scores, any threshold, `wrong_confident_rate`, cross-call score comparison (`relevance_score` is within-call only by contract) |

Denominators: throws excluded everywhere (fail-fast limit tests are not
quality judgments; counted in `abstention.errors`). Binary P/R/F1 use
non-throw, non-abstained cases. Ranking uses non-throw, non-abstained
cases with array golds. `wrong_confident` uses non-throw, non-abstained,
non-null-signal judgments; every exclusion count is reported.

Stub results (`node evals/score.mjs`): decision accuracy 1.000 and task
accuracy 1.000 on every suite; binary ALLOW F1 1.000 wherever computed
(`fpr` is null where the denominator has no negatives); ranking
MRR/nDCG/MAP 1.000 with top-1/top-3 1.000. These numbers confirm the
harness conserves oracle golds end to end. They are not backend quality.

## 5. wrong_confident_rate

One honest signal per primitive (see `evals/score.mjs`): `winner_probability`
for classify/decide/find/extract; per-claim support signal for
verify/gate; injection signal for screen; `safe_to_apply` signal for
review; max `detector_score` for pii (null when zero findings, excluded).
Rerank: no aplica (within-call scores, no correctness value per score).

| Suite | Signal | Scored | wc@0.70 | wc@0.80 | wc@0.90 | wc@0.95 |
|---|---|---|---|---|---|---|
| `classify` | `winner_probability` | 7 | 0.000 | 0.000 | 0.000 | 0.000 |
| `decide` | `winner_probability` | 4 | 0.000 | 0.000 | 0.000 | 0.000 |
| `verify` | per-claim support | 4 | 0.000 | 0.000 | 0.000 | 0.000 |
| `screen` | injection signal | 6 | 0.000 | 0.000 | 0.000 | 0.000 |
| `pii` | max `detector_score` | 2 | 0.000 | 0.000 | 0.000 | 0.000 |
| `extract` | `winner_probability` | 4 | 0.000 | 0.000 | 0.000 | 0.000 |
| `find` | `winner_probability` | 3 | 0.000 | 0.000 | 0.000 | 0.000 |
| `rerank` | — | — | no aplica | no aplica | no aplica | no aplica |
| `review` | `safe_to_apply` | 4 | 0.000 | 0.000 | 0.000 | 0.000 |
| `gate` | per-claim support | 6 | 0.000 | 0.000 | 0.000 | 0.000 |

Stub ceiling: 0.000 at every tau is the expected oracle-stub outcome
(signals are assigned together with the golds, so confident-and-wrong
cannot occur). It validates the slicing pipeline (counts, exclusions,
joint vs conditional rates), not backend safety. The conditional rate
`P(wrong | signal >= tau)` is reported alongside and is null wherever no
judgment reaches the slice. Full per-tau confident counts and exclusion
breakdowns are in `evals/results/v1/metrics.json`.

## 6. Calibration verdict

No numeric output of this repo is a probability. No signal is calibrated.
Brier score and ECE do not apply to any primitive: they are documented in
`evals/calibration.md` and never calculated, approximated, or shown for
reference. Every Router `noul`, every `winner_probability` share, every
GLiNER `detector_score`, every rerank `relevance_score`, and every
review/gate 0-2 rubric `score` is a raw, uncalibrated signal. A value of
0.9 means "the backend returned 0.9", never "90% likely correct". The
taus above are descriptive reporting cuts over stub runs; promoting any
of them to a production cutoff is a category error (unvalidated on real
traffic, circular on stub data).

## 7. Benchmarks

Recorded run: `evals/results/v1/bench.json` (config: 15 e2e reps per
primitive, 5 judge reps, rerank N in [10, 50, 100, 500, 1000] at top_k=10;
machine: Node v24.18.0, win32 x64, AMD Ryzen 7 5700X, 16 CPUs; commit
`e6c0b98`). All values are absolutes from that run. Rows within one run
share the process: compare shapes, not machines.

### 7.1 Primitives (canonical case each; stub reports 0 ms)

| Primitive | Canonical | N | cold_1st_ms | warm_p50_ms | warm_p95_ms | ops/s |
|---|---|---|---|---|---|---|
| `laya_classify` | classify-normal-01 | 1 item | 1.090 | 0.213 | 0.510 | 4272.7 |
| `laya_decide` | decide-normal-01 | 2 options | 0.569 | 0.197 | 0.234 | 5084.3 |
| `laya_verify` | verify-normal-01 | 1 claim | 0.671 | 0.195 | 0.238 | 4966.3 |
| `laya_screen` | screen-normal-01 | 1 call | 0.585 | 0.190 | 0.217 | 5252.3 |
| `laya_pii` | pii-normal-01 | 1 text | 0.603 | 0.175 | 0.208 | 5571.3 |
| `laya_extract` | extract-normal-01 | 1 field | 1.476 | 0.561 | 0.789 | 1713.0 |
| `laya_find` | find-normal-01 | 2 candidates | 0.724 | 0.238 | 0.337 | 3858.7 |
| `laya_rerank` | rerank-normal-01 | 2 candidates | 0.903 | 0.232 | 0.408 | 4057.1 |
| `laya_review` | review-normal-01 | 1 call | 0.493 | 0.207 | 0.370 | 4591.5 |
| `laya_gate` | gate-normal-01 | 1 claim | 0.658 | 0.205 | 0.260 | 4660.0 |

Wall time is pipeline overhead; the stub-reported `latency_ms` (0) is
kept in a separate column and never conflated. A latency-split demo
(classify canonical reporting 0 ms vs 5 ms with no injected delay) shows
the reported column moving while the wall stays at overhead level.

### 7.2 Rerank scale sweep (top_k=10)

| N | Kept | Dropped | Ratio | sel_p50_ms | sel_cand/s | MRR_sel | nDCG_sel | MRR_judge | nDCG_judge |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 10 | 0 | 0.000 | 0.0005 | 16515277 | 1.000 | 0.940 | 0.500 | 0.792 |
| 50 | 10 | 40 | 0.800 | 0.0526 | 811860 | 1.000 | 0.843 | 0.500 | 0.760 |
| 100 | 10 | 90 | 0.900 | 0.0974 | 966529 | 1.000 | 0.803 | projected | projected |
| 500 | 10 | 490 | 0.980 | 0.5115 | 910017 | 1.000 | 0.738 | projected | projected |
| 1000 | 10 | 990 | 0.990 | 1.0064 | 959146 | 1.000 | 0.717 | projected | projected |

Quality gold is the construction truth (pool item `i` carries
`(i*7+3)%4` query tokens; ideal order is token-count descending,
computed from the construction formula, never from the selector under
test). N > 64 cannot run the stubbed judge end to end (the 64 transport
cap rejects before pruning), so those rows report the pure selector plus
the projected judge load. The end-to-end judge stub (N <= 64) carries
one intentional adjacent swap (positions 0/1), which is why MRR_judge is
0.500: the metric pipeline provably discriminates order differences.
Every quality figure measures harness conservation under the stub
ceiling, not backend ranking quality.

### 7.3 Model load / warm / cold (MCP side only)

Cold import wall 44.7 ms (fresh Node spawn plus import, spawn cost
included); warm re-import p50 0.012 ms (ESM cache hit); probe-holder
cold 0.059 ms / warm p50 0.003 ms (fake `/models`+`/ready` shape demo
reporting 3 ms without burning wall time). No local model weights exist
in this repo; real model-load timing requires a live backend and was not
measured.

### 7.4 Method (no claims)

Single process; stub-reported `latency_ms` kept separate from measured
wall; memory is absolute `heapUsed` in MB (whole process, single sample,
no GC forcing); quantiles are nearest-rank p50/p95/p99 (the
`src/metrics.ts` definition); throughput is count over mean wall; rerank
N > 64 is selector-only plus projected judge; quality is MRR/nDCG
against the construction-truth gold. No baseline exists, so no
improvement is claimed and none can be derived from these tables.

## 8. Integration

### 8.1 Protocol (comparable +/-Laya)

`evals/integration.mjs` defines the minimum comparable task set: 4
synthetic hook-chain tasks walked in Gentle lifecycle order
(`screen` -> `classify` -> `review` -> `gate`, per
`examples/gentle-hooks.yaml`).

| Task | Shape | Expected hook verdicts |
|---|---|---|
| INT-01 `clean-feature-ship` | benign text, feature request, tested diff, truthful completion | ALLOW x 4 |
| INT-02 `injection-refuse` | plain override injection | screen DENY, chain halts, downstream skipped |
| INT-03 `untested-change-escalate` | benign text, mid-band review/gate safety | ALLOW, ALLOW, ESCALATE, ESCALATE |
| INT-04 `contradictory-completion` | mutually exclusive completion claims | ALLOW x 4 with verdicts [SUPPORTED, SUPPORTED]; pins the v1 limitation (no cross-claim check) |

Metric columns per task per arm: `task_success`, `tokens`, `latency_wall_ms`,
`llm_calls`, `retries`, `test_failures`, `human_intervention`, `cost_usd`.
The comparison is the paired table: the same 4 tasks and golds run twice,
once WITHOUT Laya (hooks disabled) and once WITH Laya (hooks enabled,
default observe).

### 8.2 Stub arm (executed)

`node evals/integration.mjs`: 4/4 tasks pass against the oracle golds;
the INT-02 halt is honored (1 hook run, 3 skipped); total stub walls are
harness overhead only (a few milliseconds per task); `retries` is 0 (the
harness never retries); `tokens`, `llm_calls`, and `cost_usd` are explicit
nulls with reasons (no LLM runs inside this repo). This arm measures the
harness. It declares no improvement and substitutes for neither live arm.

### 8.3 Live requirements (not met; no live results)

`node evals/integration.mjs --mode live` gates on five requirements and
exits 2 with the requirements table when anything is missing:

1. `opencode-host` — OpenCode host session able to run the 4 tasks twice.
2. `gentle-orchestrator` — Gentle skills wired to the hook table (a live
   orchestrator session; the table file alone is not a session).
3. `laya-server` — reachable server with `/health` ready=true (real-model
   judgments instead of the oracle stub).
4. `models-pinned` — pinned model revisions (no honest nulls in a live
   manifest).
5. `llm-credentials` — provider credentials for the coding-agent loop
   (tokens, calls, and cost are otherwise unmeasurable).

In this tree the gate refuses the live run (verified Fase 6 state:
OpenCode/Gentle/models absent; the server probe is down; no revision or
credential is present). The probe reports presence flags only and never
prints credential values. No live numbers are reported because none were
produced; the external operator run (both arms, versioned) remains future
work.

## 9. Reproducibility

- `node evals/run.mjs [--json] [suite]` — 80-case harness smoke.
- `node evals/score.mjs [--json] [--out <path>]` — T4 metrics report.
- `node evals/bench.mjs [--json]` — T5 benchmark tables (absolutes).
- `node evals/manifest.mjs [--json]` — manifest for the current tree.
- `node evals/manifest.mjs --save [--json]` — full run (bench + score
  capture + manifest) saved under `evals/results/vN/`. Never overwrites:
  each run takes the next free version.
- `node evals/integration.mjs [--json]` — T6 stub protocol run.
- `node evals/integration.mjs --mode live` — live-requirements gate.
- `node tests/fase7_t4_metrics.mjs`, `node tests/fase7_t5_bench_manifest.mjs`,
  `node tests/fase7_t6_integration.mjs` — structural batteries (36 checks).

## 10. Limitations

1. Stub ceiling: oracle-assigned signals cannot validate backend quality,
   calibration, tie rates, evasion robustness, or review/gate judgment
   quality. The suites pin known honest limitations instead (detector
   blind-spot miss in screen, no instruction-hierarchy defense in
   classify, no cross-claim check in gate, REVIEW unreachable via the
   review handler mid-band, authority notes denying any authorization).
2. No calibrated probabilities: Brier/ECE absent by verdict, not by
   omission.
3. Rerank transport cap: pools above 64 cannot run the judge end to end;
   large-N rows are selector-only plus projection.
4. Single-machine absolutes: benchmark walls and throughput describe one
   recorded run, not hardware claims.
5. No live comparison: OpenCode, the Gentle orchestrator session, and
   models are absent here, so the paired +/-Laya table is future work.
6. `laya_compare` has metric definitions in `metrics.mjs` but no T3
   dataset, and is reported as such, not silently dropped.

## 11. Per-run record (what each `evals/results/vN/` answers)

Every version directory contains exactly three files written atomically
by one `--save` run, and no later run mutates them:

- `manifest.json` — date (ISO), git commit (full + short), model id
  (`evals-bench-stub` for bench runs) with the honest null revision,
  tokenizer (`unknown`, with the exposure note), device
  (`unknown (stub run; no live backend)`), the 14-entry live policy
  registry, envelope schema version, software (Node, platform, arch,
  package version), hardware (arch, CPU count/model, total memory),
  bench config, MCP/policy modes, the method string, the honesty notes,
  and the bench/metrics link counts.
- `bench.json` — method, config, heap baseline, the 10 primitive rows
  (canonical, stub vs reported latency, cold-first wall, warm p50/p95/p99,
  ops/s, cand/s, pruning, heap), the latency-split demo, the 5 rerank
  sweep rows (selector walls, retention quality, judge quality or
  projection note), and the model-load shape block with its limit note.
- `metrics.json` — the full T4 score report: per-suite family, abstention
  accounting, decision/task accuracy, binary ALLOW metrics or ranking
  means or the score-agreement non-computability note, and the
  wrong_confident slices with scored/excluded counts.

Answerable per run: which commit and date produced it, which stub and
config, which method, and which numbers came from it. `v1` answers:
commit `e6c0b98`, 2026-09-23, default bench config, method and honesty
strings quoted in sections 7.4 and 1.

## 12. Verification evidence (T6 no-regression)

1-to-1 against Fase 6 (`b26e50a`): typecheck pass, build pass, Python
42/42, all Node batteries pass (475 pre-T6 checks plus the 12 new T6
checks, 487 total), `LAYA_SKIP=1 python tests/smoke.py` pass,
`python py/doctor.py --no-live` exit 2 (environmental: `laya` pip package
absent), `compileall` pass. Known environmental states, unchanged:
`tests/mcp_smoke.mjs` fails offline by design (no servers), `test_*.sh`
need bash, no lint script exists. No tests deleted or weakened; zero
functional changes in `src/` (the Fase 7 diff adds only `evals/`,
`tests/`, `evals/results/v1/`, and this document).
