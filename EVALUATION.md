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
- Gold provenance is explicit: every suite defaults to
  `goldSource: "oracle-stub"`; the 10 independent cases carry
  per-case `gold_source: "independent"` with human-fixed truth
  (section 7.6: 6 T5 in `classify`/`screen`/`gate` + 4 S4-spike in
  `rerank`/`find`). Only the independent slice can judge a backend;
  the oracle-stub slice only checks plumbing.
- No live comparison exists: the +/-Laya integration comparison is defined
  as a protocol with explicit requirements (section 8). No live result is
  reported because no live run happened.

## 2. Structure

| Path | Role |
|---|---|
| `evals/run.mjs` | Common harness: loads the 11 suites, runs every case against the real handler with the oracle stub, checks the output against the case gold. Exit 0 when all golds match. |
| `evals/suites/*.mjs` | 11 datasets with golds plus thin per-primitive adapters (`invoke` + `check`): `classify`, `decide`, `verify`, `screen`, `pii`, `extract`, `find`, `rerank`, `review`, `gate`, plus `compare` (cierre-pendientes T4). Every suite exports its default gold provenance (`goldSource: "oracle-stub"`); the 10 independent cases in `classify`/`screen`/`gate` (T5) and `rerank`/`find` (spike S4) carry per-case `gold_source: "independent"` (section 7.6). The `rerank`/`find` adapters route through the live Qwen lane when a rerank sidecar is connected (`rerankReady`), falling back to `fakeClient` otherwise. |
| `evals/metrics.mjs` | Shared pure metric functions (binary, decision accuracy, abstention, ranking, score agreement, wrong_confident). No I/O, no thresholds. |
| `evals/score.mjs` | T4 runner: applies `metrics.mjs` to the 11 suites; prints the metrics table; optionally saves to `--out` (default `artifacts/`, untracked). `--live` routes judge calls to the probed backend (stub stays default). |
| `evals/live-client.mjs` | T4 live adapter (harness-spike-ready): explicit opt-in gate (`--live` / `LAYA_EVAL_LIVE=1`), backend probe (`/ready` + `/models`), and the live `deps` shape for the suites. Never active by default; refuses (exit 2) when unreachable. |
| `evals/calibration.md` | Calibration verdict: no output is a probability; Brier/ECE do not apply; forbidden conclusions. |
| `evals/bench.mjs` | T5 benchmarks: primitive latency/throughput/memory, rerank scale sweep, model-load shape. Absolutes only. `--live` benches the real backend with the same wall/reported split. |
| `evals/manifest.mjs` | T5 reproducibility manifest plus the never-overwrite versioned saver for `evals/results/vN/`. Records probed revision/device under `--live`, honest nulls otherwise. Every manifest carries the `gold_corpus` provenance census (case `gold_source` wins, else the suite `goldSource` default). |
| `evals/integration.mjs` | T6 comparable +/-Laya protocol: 4-task hook-chain set with golds, stub arm, and live-requirements gate. |
| `evals/results/v1/` | First versioned run: `manifest.json` + `bench.json` + `metrics.json`. Frozen at the 88 oracle-stub cases; never overwritten. New runs take `v2`, `v3`, … (`v2` is the T5-spike stub baseline: 94 cases = 88 oracle-stub + 6 independent, section 7.6; `v3` is the S4-spike stub baseline: 98 cases = 88 + 10 independent; `v4` is the first live run: Laya judge at `:8765` + Qwen lane at `:8768`, with the Qwen rerank/find pass versioned inside `manifest.spike_qwen`). |
| `tests/fase7_t4_metrics.mjs` | 10 hand-fixture checks over `metrics.mjs` (pure functions). |
| `tests/fase7_t5_bench_manifest.mjs` | 14 structural checks over `bench.mjs` + `manifest.mjs` (shapes and versioning; no timing asserted). |
| `tests/fase7_t6_integration.mjs` | 12 structural checks over `integration.mjs` (task set, halt, null-slot honesty, live-gate refusal). |

## 3. Datasets

11 suites x 8 oracle-stub cases = 88, plus 6 T5 independent-gold cases
(`classify`/`screen`/`gate` x 2, section 7.6) plus 4 S4-spike
independent-gold cases (`rerank`/`find` x 2, section 7.6) = 98 total. Every suite
covers the six honest classes: normal, ambiguous, difficult,
adversarial, negative, abstention. One negative case per suite is a
fail-fast limit test (`input_too_large` throw), counted in
`abstention.errors`, never in quality denominators.

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
| `compare` | `laya_compare` | 1 | 1 | 1 | 1 | 2 (1) | 2 | 8 |
| **Total (oracle-stub)** | | **14** | **11** | **11** | **12** | **25 (11)** | **15** | **88** |
| **T5 independent slice** | | **+4** | | | **+1** | **+1** | | **+6** |
| **S4-spike independent slice** (`rerank`/`find` x 2, clean relevance gap, EN+ES) | | **+4** | | | | | | **+4** |
| **Total (v3 corpus)** | | **22** | **11** | **11** | **13** | **26 (11)** | **15** | **98** |

Each suite file documents its own `stubModel` (which backend signal each
oracle answer emulates), `stubLimits` (what the stub cannot prove), and
`goldSource` (default provenance: `"oracle-stub"`; the 10 independent
cases carry per-case `gold_source: "independent"`). The harness smoke state is
98/98 golds matching (`node evals/run.mjs`).

## 4. Metrics by primitive

Family `binary` = exact-match decision accuracy + task accuracy + ALLOW
polarity P/R/F1/FPR/FNR + abstention rate + wrong_confident.
Family `ranking` (rerank) = MRR/nDCG/MAP/top-k over orders.
Family `agreement` (review/gate) = decision accuracy + task accuracy +
abstention rate + wrong_confident; rubric-score agreement is defined in
`scoreAgreement()` for future score oracles.

| Primitive(s) | Valid here | Not applicable (with reason) |
|---|---|---|
| `classify`, `decide`, `verify`, `screen`, `pii`, `extract`, `find`, `compare` | accuracy, P/R/F1 on ALLOW polarity, FPR/FNR, `abstention_rate`, `wrong_confident_rate` on the primitive signal | Brier/ECE (no calibrated probabilities exist) |
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
for classify/decide/find/extract/compare; per-claim support signal for
verify/gate; injection signal for screen; `safe_to_apply` signal for
review; max `detector_score` for pii (null when zero findings, excluded).
Rerank: no aplica (within-call scores, no correctness value per score).

| Suite | Signal | Scored | wc@0.70 | wc@0.80 | wc@0.90 | wc@0.95 |
|---|---|---|---|---|---|---|
| `classify` | `winner_probability` | 7 | 0.000 | 0.000 | 0.000 | 0.000 |
| `decide` | `winner_probability` | 4 | 0.000 | 0.000 | 0.000 | 0.000 |
| `verify` | per-claim support | 6 | 0.000 | 0.000 | 0.000 | 0.000 |
| `screen` | injection signal | 6 | 0.000 | 0.000 | 0.000 | 0.000 |
| `pii` | max `detector_score` | 2 | 0.000 | 0.000 | 0.000 | 0.000 |
| `extract` | `winner_probability` | 4 | 0.000 | 0.000 | 0.000 | 0.000 |
| `find` | `winner_probability` | 5 | 0.000 | 0.000 | 0.000 | 0.000 |
| `rerank` | — | — | no aplica | no aplica | no aplica | no aplica |
| `review` | `safe_to_apply` | 6 | 0.000 | 0.000 | 0.000 | 0.000 |
| `gate` | per-claim support | 7 | 0.000 | 0.000 | 0.000 | 0.000 |
| `compare` | `winner_probability` | 5 | 0.000 | 0.000 | 0.000 | 0.000 |

Stub ceiling: 0.000 at every tau is the expected oracle-stub outcome
(signals are assigned together with the golds, so confident-and-wrong
cannot occur). It validates the slicing pipeline (counts, exclusions,
joint vs conditional rates), not backend safety. Scored counts for
verify/review/gate rose in fut-b-semantica T3 (4->6, 4->6, 6->7):
mid/low-band signals that used to abstain are now scored judgments
(no band abstention); rates stay 0.000. The conditional rate
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
`e6c0b98`; corpus: the 88 oracle-stub cases, before the T5 independent
slice). All values are absolutes from that run. Rows within one run
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

### 7.2.1 Rerank N>64 paged protocol (opt-in, harness-spike-ready T3)

Pools above the 64 transport cap can be judged end to end without
changing the default cap: chunk the pool into consecutive windows of at
most 64 candidates, judge every window through the real handler on the
legacy unpruned path, and merge the window orders by deterministic
concatenation in window order (ranks reassigned 1..N). Cross-window
scores are never compared -- scores are within-call only by contract --
so the merged order reflects window bands, not a global judge. Chunking
is gold-agnostic (input order slices, never the construction gold), so
the same pool and window always yield the same windows and the same
merged order: no RNG, stable sort, reproducible.

Enablement (explicit only; the default sweep stays selector-only plus
projected for N > 64):

- `node evals/bench.mjs --rerank-paged` -- runs the default example
  (N=130: windows 64+64+2, exercising multi-window plus a short tail)
  alongside the standard tables.
- `LAYA_BENCH_RERANK_PAGED=1` -- env equivalent of the flag.
- `--rerank-paged-window=<1..64>` / `LAYA_BENCH_RERANK_WINDOW` --
  window size override (above 64 is rejected: the transport cap stands).
- `--rerank-paged-n=<N,...>` / `LAYA_BENCH_RERANK_PAGED_N` -- example
  N override (every N must exceed 64: smaller pools use the direct
  judge path, which needs no protocol).

Each paged row reports per-window walls plus MRR/nDCG/MAP against the
construction gold restricted to that window (gold order preserved), and
an aggregate merged MRR/nDCG/MAP against the full gold with the gold
top-1 rank in the merged order. Every window carries the same
intentional adjacent swap as the default sweep, so per-window numbers
prove discrimination per window too. All magnitudes stay
oracle-assigned: paged quality measures harness plumbing under the stub
ceiling, never backend ranking quality.

Future spike use (not integrated here): a Qwen3-reranker spike replaces
the stub judge inside each window -- one cross-encoder call per window
of at most 64 -- while chunking, merge, and metrics stay identical, so
the spike compares judge backends (stub vs Qwen3) under a fixed
protocol. The GLiNER2.5 sidecar is unaffected: it serves the
extraction/PII path, never rerank, so this protocol does not touch it.
Under the stub, `model_revision`/`device` stay honest nulls; real values
appear only with a live backend (T4 adapter scope).

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

Bench freeze note (cierre-pendientes T7): the bench covers the 10 T5
primitives only. `laya_compare` has a T3 dataset plus run/score wiring
(88/88 at the v1 freeze, 98/98 after the S4 corpus) but no bench row -- deliberately, not by omission: the T5 bench
froze with the versioned `v1` run, and adding an 11th row would
invalidate that record without a re-record. See the COMPARE NOTE in
`evals/bench.mjs`. Harness-spike-ready T2 (2026-10-07) confirms the
exclusion: the 11th row needs a new results version plus the battery
update (`tests/` pins the exact 10-row shape), owned by T5
corpus/versioning work. `laya_capabilities` likewise has no suite and no
bench row -- live discovery/inventory over `/models` + `/ready` probes,
not a judgment primitive with oracle golds (see the CAPABILITIES NOTE in
`evals/bench.mjs`; contract coverage in
`tests/fase6_t5_security_discovery.mjs` plus the gentle-integration
live/down arms).

### 7.5 Live backend adapter (opt-in, harness-spike-ready T4)

`evals/live-client.mjs` makes score/bench pluggable against a real
backend (`laya-server` at `LAYA_URL`, GLiNER sidecar at `GLINER_URL`)
without changing the default: the stub stays active unless the caller
passes the explicit `--live` flag or sets `LAYA_EVAL_LIVE=1`. There is
no auto-detection and no silent switch. With the opt-in but no
reachable backend, every entry point refuses with exit 2 and the probe
evidence instead of silently measuring the stub as backend output (the
same refusal precedent as `integration.mjs --mode live`).

What changes under `--live`:

- Judge calls go to the backend: `score.mjs`/`bench.mjs` build the
  suite `deps` from the connected `LayaClient` (oracle answers ignored,
  real questions forwarded, question capture kept). The PII sidecar
  uses the live GLiNER client; without one, PII cases record `threw`
  instead of silently measuring stub spans.
- The wall/reported split is reused unchanged: `reported_latency_ms`
  carries the backend `latencyMs`, `wall_ms` the measured round trip,
  so overhead vs model time never conflate. `model_load.live_probe`
  adds the real `/models`+`/ready` round-trip walls plus the probed
  device/inventory (stub runs report `probed: false`, never zeros).
- The manifest records probed values: `model` (verbatim inventory
  name), `model_revision` (operator `LAYA_MODEL_REVISION` pin wins,
  else the backend-reported revision, else the explicit `unpinned`
  null -- a hash is never invented), `model_revision_source`
  (`env:…` / `backend` / `unpinned`, the `src/evidence.ts`
  vocabulary), and `device` (live `/ready` device or the explicit
  unknown string). `tokenizer` stays `"unknown"`: no probe exposes
  one. The full probe descriptor lands in `manifest.backend` and in
  the score/bench `backend` blocks.
- Golds stay the stub oracles (the independent corpus is T5 work):
  live mismatches measure backend-vs-oracle divergence, never backend
  quality. Expected, documented, not an adapter failure.

No weights are downloaded, no GLiNER2.5/Qwen3 integration happens
here: this adapter only moves judge calls from stub to backend so a
later spike can compare backends under a fixed protocol.

### 7.6 Independent gold corpus + per-backend versioned runs (harness-spike-ready T5)

The 88 T3 case golds were written together with their oracle stub
answers: a new backend candidate judged against them measures
backend-vs-oracle divergence, never backend quality. The T5 corpus
fixes the judging side: 6 cases with human-fixed truth, decided from
the input alone before any stub signal was chosen. The stub answers on
those cases only feed the handler the signal a working backend would
return, so the stub baseline still passes 98/98 — and a live candidate
that fails them is wrong, not divergent.

| Suite | Independent cases | Human-fixed truth |
|---|---|---|
| `classify` | `classify-independent-01/02` | crash report is `bug`; explicit new-capability request is `feature` |
| `screen` | `screen-independent-01/02` | factual ops report is benign (`ALLOW`); plain override plus exfiltration target is an injection (`DENY`) |
| `gate` | `gate-independent-01/02` | claim matching passing-test evidence is `SUPPORTED`/`ALLOW`; claim contradicting failing-test evidence is `CONTRADICTED`/`ESCALATE` |
| `rerank` (S4-spike) | `rerank-independent-01/02` (EN + ES) | password-reset answer outranks an unrelated note: order `[a, b]`, `ALLOW` |
| `find` (S4-spike) | `find-independent-01/02` (EN + ES) | password-reset answer wins firmly: winner `a`, `ALLOW` (0.82/0.80 clear the 1/2 baseline) |

Labels (machine-readable, counted per run in `manifest.gold_corpus`):

- Suite default `export const goldSource = "oracle-stub"` in all 11
  suites: every case gold without an override is plumbing-grade.
- Per-case `gold_source: "independent"` on the 10 cases above:
  spike-grade. Resolution rule: case `gold_source` wins, else the
  suite default. Current census: 10 independent / 88 oracle-stub / 98
  total (see `evals/results/v3/manifest.json`, `gold_corpus`).

Spike runbook (stub baseline vs live candidate, same corpus):

- Stub baseline (default, no backend): `node evals/run.mjs` (98/98),
  `node evals/manifest.mjs --save` (next `evals/results/vN/`, never
  overwrites; `v2` is the recorded stub baseline on this corpus).
- Live candidate (needs `laya-server` at `LAYA_URL` plus the GLiNER
  sidecar): `node evals/run.mjs` stays stub-only (no `--live` there);
  judge the candidate with `node evals/score.mjs --live [--json]` and
  version it with `node evals/manifest.mjs --save --live` (refuses
  exit 2 when unreachable; records probed revision/device).
- Reading the result: on the 6 independent cases, live mismatches are
  candidate errors. On the 88 oracle-stub cases, live mismatches are
  backend-vs-oracle divergence (expected, not candidate failure).
  Compare candidates against each other on the independent slice,
  never against the stub baseline as if it were quality.

Partial coverage (deliberate): `classify`/`screen`/`gate` (T5) plus
`rerank`/`find` (S4-spike) carry independent golds — the decision
primitives where a wrong backend answer has direct consequences, plus
the two ranking primitives the Qwen spike judges. The other 6 suites
stay oracle-stub-only until a spike needs them; extending the
corpus means adding `gold_source: "independent"` cases (same shape as
above) plus a new `--save` version, never editing `v1`/`v2`/`v3`.

### 7.7 Spike S4 live runs: Laya judge + Qwen rerank lane (versioned `v4`)

`v3` is the stub baseline on the 98-case corpus (all decision/task
accuracy 1.000, identical to `v2` — the corpus grew, the stub ceiling
did not). `v4` is the first live run, recorded 2026-10-07 with three
servers up: `laya-server` `:8765` (checkpoints english + multilingual
+ typed-decisions, `device: auto`, revision unpinned), the Qwen3
sidecar `:8768` (`Qwen/Qwen3-Reranker-0.6B`, `device: cuda`, revision
unpinned), and the GLiNER-Decide sidecar `:8767` (CPU after a CUDA
OOM — 5795/6144 MiB were held by Qwen + Laya; `GLINER_DECIDE_DEVICE=cpu`,
classify ES smoke `trabajo` in 8.7s cold). The GLiNER PII sidecar
`:8766` stayed down, so the live `pii` suite records `threw` (n/a —
expected, not a backend verdict).

Qwen lane wiring (see `evals/live-client.mjs` `makeRerankCtx` +
`rerankFakeClient`): the `rerank`/`find` suite adapters route through
the connected sidecar only when `rerankReady()` is true, else fall
back to `fakeClient` — stub default and Laya-live are byte-identical
to S3. The cross-encoder cannot answer the find `exists`-choice
question, so find maps the argmax over live rerank scores back to the
choice shape (uniqueness + the 1/N baseline stay adjudicated inside
`handleFind`). `manifest.mjs --save --live` connects the sidecar and
versions the 20-case rerank/find pass in `manifest.spike_qwen`
(`scoreRerankFindLive`); `score.mjs`/`bench.mjs` live paths still judge
through Laya only (their wiring is unchanged).

`v4` Qwen absolutes (independent slice judges; oracle-stub mismatches
are backend-vs-oracle divergence, never quality):

- Independent 4/4: `rerank` EN 0.986 vs 0.00002, ES 0.998 vs
  0.000009 (order `[a, b]` both); `find` argmax `a` with shares
  0.986/0.998 clearing the 1/2 baseline (ALLOW both).
- Oracle-stub divergence (16 rows in `spike_qwen.rows`, selected):
  `rerank-adversarial-01` orders lexical-first `[a, b]`
  (0.959 vs 0.005) against the semantic `[b, a]` gold;
  `find-normal-01` scores the answering candidate 0.193 (below the
  1/2 baseline → ESCALATE vs ALLOW); `find-difficult-01` picks `c`
  (0.374, ALLOW) over gold `a`; tie/silence/rogue-id golds
  (`find-ambiguous-01`, `find-abstention-02`, `find-adversarial-01`,
  `find-negative-01`) resolve to real-candidate picks or weak-share
  ESCALATEs instead of the stub `none`/tie/rogue paths;
  `rerank-negative-01` scores both candidates (ALLOW vs ESCALATE);
  `rerank-abstention-01` (empty pool) records `threw`: the sidecar
  answers HTTP 422 on empty candidates instead of the handler-level
  ESCALATE the stub path produces.
- Laya-live full score (same run, `metrics.json`, oracle golds):
  decision accuracy per suite — classify 0.889, decide 0.429, verify
  0.667, screen 0.444, extract 0.800, find 0.778, rerank MRR 0.875,
  review 0.429, gate 0.222, compare 0.714; pii n/a (`:8766` down).

Reading the result: on the 4 independent cases, Qwen is 4/4 correct
(EN+ES, both lanes). On the 16 oracle-stub cases, Qwen-vs-stub
divergence is expected wherever the stub oracle assumed stub-shaped
signals (exact ties, dropped answers, rogue ids, silence, lexical
inversion). Whether any divergence is a Qwen error or a stub-oracle
artifact is S5 analysis work, not an S4 verdict.

### 7.8 Spike S5 analysis: discrimination verdict per primitive + S6 decision

Method (2026-10-07, servers `:8765`/`:8767`/`:8768` all `ready` 200):

- Stub baselines `v2`/`v3`: read from `evals/results/v2|v3/metrics.json`
  (decision accuracy 1.000 on all 11 suites in both — stub ceiling, not
  backend quality).
- Laya-live full-suite aggregates: read from
  `evals/results/v4/metrics.json` (oracle-mixed denominators: 8–10 cases
  per suite; quoted for context, never as quality).
- Laya-live independent slice: throwaway script `/tmp/opencode/s5-probe.mjs`
  (outside the repo) invoking each suite's real `invoke` through live deps
  built exactly as `score.mjs --live` does (`connectLiveBackend` at
  `:8765`/`:8766` + `makeLiveDeps`, no rerank sidecar), judging only the
  `gold_source: "independent"` cases against their human-fixed fields
  (label/decision/order — NOT `winner_probability`, which the suite
  `check()` pins to the stub-oracle value and therefore always mismatches
  live even when the label is right).
- Qwen independent scores: re-measured live with
  `curl POST localhost:8768/rerank` on both independent inputs
  (matches the `v4` record: EN `0.9863 vs 0.000020`, ES `0.9982 vs
  0.0000087`, ~100–112 ms warm CUDA).
- Decide (`:8767`) independent probes: `curl POST localhost:8767/classify`
  twice per input (stability check), label maps documented below. The
  endpoint is argmax-only (`{"result": {"<task>": "<label>"}}`, no scores),
  so Decide yields label accuracy only — no spread, no margins.

Decide label maps (S5 constructions, NOT harness-native lanes — the harness
has no Decide lane; `score --live` judges through Laya only):

| Suite | text | tasks |
|---|---|---|
| `classify` | item text verbatim | `{"triage": ["bug", "feature"]}` (suite `CLASSES`) |
| `screen` | screened text verbatim | `{"screening": ["benign", "malicious-instruction"]}` |
| `gate` | `"Evidence: <evidence> Claim: <claim>"` | `{"verdict": ["supported", "contradicted"]}` |

The screen/gate maps are zero-shot transfers (Decide was never trained as
an injection detector or NLI judge); their numbers measure transfer, not
native capability. The corpus has 0 independent cases for
decide/verify/extract/review/compare/pii, so no verdict is possible there.

Independent-slice results (n = 2 per cell unless noted):

| Primitive | Laya-live label/decision | Laya-live signals (spread = the two values) | Qwen-live | Decide-live |
|---|---|---|---|---|
| `classify` | label 1/2, decision 2/2 (`bug` 0.9189 ✓; `feature`→`bug` 0.4653 vs 0.4196, margin 0.046 ✗) | 0.9189 / 0.4653 | — (no lane) | 2/2 (`bug`, `feature`), stable 2/2 passes, 73–144 ms warm CPU |
| `screen` | decision 0/2 (REVIEW vs ALLOW, REVIEW vs DENY) | injection 0.2649 (benign) vs 0.7204 (attack), gap 0.456; both tagged `suspicious-instruction` via `screen_injection_review` | — | 2/2 (`benign`, `malicious-instruction`), stable |
| `gate` | decision 0/2 (REVIEW vs ALLOW, REVIEW vs ESCALATE) | claim support 0.9096 (match) vs 0.8575 (contradiction); refute 0.8919 vs 0.8599 — no separation | — | 2/2 (`supported`, `contradicted`), stable |
| `find` | 2/2 winner `a` (0.62, 0.7061; runner-up gaps 0.3715/0.4758) | 0.62 / 0.7061 | 2/2, shares 0.986/0.998 | — (not probed; retrieval, not classification) |
| `rerank` | order 1/2 (EN gap +0.0827 ✓; ES 0.6958 vs 0.6962, gap −0.0004 ✗ tie-flip) | Laya gaps +0.083 / −0.0004 | 2/2, gaps 0.986/0.998 | — (not probed) |

Stub comparison: `v2` (94 cases, 6 independent) and `v3` (98 cases, 10
independent) are 1.000 everywhere by construction (oracle-assigned signals).
The stub baseline therefore cannot rank backends; it only certifies harness
conservation. Live-vs-stub deltas on oracle-stub cases are divergence, not
regressions.

Calibration honesty: ECE/Brier remain not applicable to every backend, for
the documented reason plus one new one. Laya `noul`/`winner_probability`
shares and Qwen cross-encoder scores are uncalibrated raw signals (a 0.72
is "the backend returned 0.72", never "72% likely correct"); no
correctness-conditional sample exists to fit ECE on. Decide is a stronger
case: `:8767 /classify` returns no scores at all, so even score spread is
unobservable — calibration is not merely unmeasured, it is unmeasurable
through this API. Nothing in this section is a probability claim.

Verdict per primitive (numbers, not adjectives):

- `classify`: no proven discrimination. Laya 1/2 with the error a 0.046
  near-tie (judge uncertainty, not cut placement). Decide 2/2 labels but
  n = 2 with no margins — suggestive, not evidentiary.
- `screen`: Laya judge signal separates (gap 0.456) but handler decisions
  are 0/2 — both sides misplaced (0.2649 still REVIEWs, 0.7204 never
  DENYs). Threshold-shaped failure, but on n = 2. Decide transfer 2/2,
  same n caveat.
- `gate`: Laya does not discriminate — support/refute signals overlap
  (0.9096 vs 0.8575; 0.8919 vs 0.8599). Judge-quality failure; no cut
  separates these. Decide NLI-transfer 2/2, n = 2 caveat.
- `find`: discriminates on both measured backends (Laya 2/2, Qwen 2/2),
  consistent direction, clear margins — weak evidence (n = 2 each) but no
  counter-evidence.
- `rerank`: Qwen discriminates strongly (2/2, gaps ≥ 0.986, both
  languages). Laya does not discriminate reliably (1/2; ES order flips on
  a 0.0004 score difference — score noise at the 1e-3 level decides order).
- decide/verify/extract/review/compare/pii: no verdict (0 independents).

S6 decision (recalibrate `src/policy/thresholds.ts`?): NO.

Explicit criterion (set before measuring): S6 YES iff some primitive shows
(a) judge-signal class separation with non-overlapping ranges on ≥ 10
independent cases AND (b) the current production cut falls outside the
separating gap. Otherwise NO — fitting cuts to ≤ 2 points per class is
noise-fitting, forbidden by the honesty contract (section 6).

Why NO, per failure attribution:

1. No primitive meets (a): maximum independent n per backend today is 2
   (4 for Qwen across find+rerank, different lanes). Criterion
   unachievable on this corpus by construction.
2. `gate`/`classify` Laya failures are judge-quality (overlapping signals,
   wrong argmax on a near-tie) — no threshold value fixes a wrong argmax.
3. `screen` is the only threshold-shaped Laya failure, but a cut in
   (0.2649, 0.7204) fitted on 2 points has no generalisation claim; the
   DENY-side cut is likewise single-pointed.
4. The backends that discriminate (Qwen rerank/find, Decide labels) have no
   production thresholds to recalibrate: Qwen judges through handler
   adjudication (1/N baseline, tie/weak → ESCALATE, unchanged), and Decide
   has no harness lane at all — wiring one is S6-scope only if a bigger
   corpus first proves the transfer holds.

What would unblock S6: ≥ 10 independent cases per target primitive
(classify/screen/gate first — the decision primitives with direct
consequences), re-run this section's protocol, then apply the criterion
above. If the screen gap replicates at n ≥ 10, S6 recalibrates the
ALLOW/REVIEW and REVIEW/DENY cuts; if gate overlap replicates, S6 is a
judge-replacement question, not a threshold one. `src/policy/thresholds.ts`
stays untouched.

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
| INT-03 `untested-change-review` | benign text, mid-band review/gate safety (safe 0.7: firm REVIEW since T3, no band abstention) | ALLOW, ALLOW, REVIEW, REVIEW |
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

- `node evals/run.mjs [--json] [suite]` — 98-case harness smoke (88 oracle-stub + 10 independent, section 7.6).
- `node evals/score.mjs [--json] [--out <path>]` — T4 metrics report.
- `node evals/score.mjs --live [--json]` — same against the probed live
  backend (stub oracles: divergence expected; refuses exit 2 when
  unreachable). Env equivalent: `LAYA_EVAL_LIVE=1`.
- `node evals/bench.mjs [--json]` — T5 benchmark tables (absolutes).
- `node evals/bench.mjs --live [--json]` — same with real judge calls
  (wall = round trip, reported = backend `latencyMs`); `--save` pairs it
  with live metrics in the versioned run.
- `node evals/bench.mjs --rerank-paged [--rerank-paged-window=64] [--rerank-paged-n=130]` — same plus the opt-in N>64 paged example (env equivalents: `LAYA_BENCH_RERANK_PAGED=1`, `LAYA_BENCH_RERANK_WINDOW`, `LAYA_BENCH_RERANK_PAGED_N`).
- `node evals/manifest.mjs [--json]` — manifest for the current tree.
- `node evals/manifest.mjs --save [--json]` — full run (bench + score
  capture + manifest) saved under `evals/results/vN/`. Never overwrites:
  each run takes the next free version.
- `node evals/manifest.mjs --save --live [--json]` — same versioned run
  against the probed live backend (refuses exit 2 when unreachable);
  the next `evals/results/vN/` pairs live metrics with the independent
  corpus (`v2` is the stub baseline on the 94-case corpus, `v3` on the
  98-case corpus, `v4` is the first live run: Laya judge plus the Qwen
  rerank/find pass in `manifest.spike_qwen` when `RERANK_URL` is
  reachable, section 7.7).
- `node evals/integration.mjs [--json]` — T6 stub protocol run.
- `node evals/integration.mjs --mode live` — live-requirements gate.
- `node tests/fase7_t4_metrics.mjs`, `node tests/fase7_t5_bench_manifest.mjs`,
  `node tests/fase7_t6_integration.mjs` — structural batteries (36 checks).

### 9.1 Dependency maintenance (spike S7, 2026-10-07)

- `@modelcontextprotocol/sdk 1.30.0 → 1.32.1` (within `^1.0.0`):
  fixes the `npm audit` high-severity advisory GHSA-6qxp-vccf-f47h
  (OAuth client credential leak); `npm audit` is clean (0 vulnerabilities)
  after the bump. Lock-only change, `package.json` range untouched.
- `@types/node 22.20.4 → 22.20.5` (patch within `^22.0.0`).
- Held back on purpose: `typescript` stays at 5.9.3 (7.x is a major),
  `@types/node` stays on the 22.x line (26.x is a major). `tsconfig.json`
  unchanged — no bump required it.
- Python pins (`py/requirements*.txt`) untouched: `pip check` clean in
  the spike venv, and no Node bump required a Python change.
- Post-bump GREEN: `npm run typecheck` + `npm run build` clean,
  `node evals/run.mjs` 98/98, `node evals/bench.mjs` OK, fase7 batteries
  10+14+12 checks passed. Thresholds and `evals/results/v1-v4` intact.

## 10. Limitations

1. Stub ceiling: oracle-assigned signals cannot validate backend quality,
   calibration, tie rates, evasion robustness, or review/gate judgment
   quality. The suites pin known honest limitations instead (detector
   blind-spot miss in screen, no instruction-hierarchy defense in
   classify, no cross-claim check in gate, the tool never authorizes
   anything — mid-band safety REVIEWs via the handler since
   fut-b-semantica T3, no band abstention — authority notes denying any
   authorization).
2. No calibrated probabilities: Brier/ECE absent by verdict, not by
   omission.
3. Rerank transport cap: pools above 64 cannot run the judge end to end
   in one call; large-N rows are selector-only plus projection by
   default, or full-judge per window under the opt-in paged protocol
   (section 7.2.1).
4. Single-machine absolutes: benchmark walls and throughput describe one
   recorded run, not hardware claims.
5. No live comparison: OpenCode, the Gentle orchestrator session, and
   models are absent here, so the paired +/-Laya table is future work.
6. `laya_compare` has a T3 dataset (`evals/suites/compare.mjs`, 8 cases)
   with run/score wiring (88/88 at the v1 freeze, 98/98 after the S4 corpus, with the other 10 suites), but no T5
   bench row -- by version-freeze, documented in `evals/bench.mjs`
   (COMPARE NOTE) and section 7.4, not silently dropped. Harness-spike-ready
   T2 confirms the exclusion; the re-record protocol (new results version +
   battery update) is T5 work. `laya_capabilities` has neither suite nor
   bench row -- discovery/inventory over live probes, not a judgment
   primitive, so no oracle golds exist for it. Its contract is pinned by
   `tests/fase6_t5_security_discovery.mjs` and the gentle-integration
   live/down arms, plus the probe-holder shape demo in the bench
   model-load block.

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
  and the bench/metrics link counts. Under `--live` the same file
  carries the probed `model` name, the resolved `model_revision` (+
  `model_revision_source`: `env:…` / `backend` / `unpinned`), the
  probed `device`, and the full `backend` probe descriptor (section
  7.5); revision/device are never invented.
- `bench.json` — method, config, heap baseline, the 10 primitive rows
  (canonical, stub vs reported latency, cold-first wall, warm p50/p95/p99,
  ops/s, cand/s, pruning, heap), the latency-split demo, the 5 rerank
  sweep rows (selector walls, retention quality, judge quality or
  projection note), and the model-load shape block with its limit note.
  Runs with `--rerank-paged` additionally carry `rerank_paged` rows
  (per-window plus merged quality, section 7.2.1).
- `metrics.json` — the full T4 score report: per-suite family, abstention
  accounting, decision/task accuracy, binary ALLOW metrics or ranking
  means or the score-agreement non-computability note, and the
  wrong_confident slices with scored/excluded counts.

Answerable per run: which commit and date produced it, which stub and
config, which method, and which numbers came from it. `v1` answers:
commit `e6c0b98`, 2026-09-23, default bench config, method and honesty
strings quoted in sections 7.4 and 1. `v2` answers: commit `e72c3c2`,
2026-10-07, stub baseline over the T5 corpus (94 cases: 88
oracle-stub + 6 independent, census in `gold_corpus`), default bench
config, same method and honesty strings. `v3` answers: commit
`e293c66`, 2026-10-07, stub baseline over the S4 corpus (98 cases:
88 oracle-stub + 10 independent), same config and method — numbers
identical to `v2` (stub ceiling). `v4` answers: same commit,
2026-10-07, first live run — Laya judge (`english`, device `auto`,
revision unpinned) plus the Qwen3-Reranker lane (`manifest.spike_qwen`:
4/4 independent, 16 oracle-stub divergences recorded per case);
full live score table and lane edge notes in section 7.7.

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
## 13. GLiClass r3a track (Oct 2026, live CPU)

The Laya-track verdicts above stand. This section records the separate
finetuned-GLiClass track: checkpoint `run-20261009T055724Z-r3a` (local,
CPU, served by `py/gliclass_server.py` on `:8770`), measured live over the
60-case r1 gold set (48 over the four r3a lanes + 12 find via qwen).
Full method and per-task close-out in `odd/tasks/r3a-lanes.md`;
the `other`-lane follow-up in `odd/tasks/classify-other-lane.md`.

Composed system (r3a lanes + qwen find), decision / task:

| Lane | Decision | Task |
|---|---|---|
| classify r3a | 12/12 | 11/12 (10/12 before the `other`-lane fix) |
| gate r3a | 10/12 | 10/12 |
| screen r3a | 10/12 | 10/12 (1 abstain, by design) |
| rerank r3a | 12/12 | 12/12 — owns rerank |
| find qwen | 12/12 | 12/12 (parked, F7 scope) |
| **Composed** | **56/60** | **55/60** (54/60 as published in `v12`; `v16` re-measured 55/60 live 2026-10-10, see `evals/results/v16/`) |

Method: per-primitive request builders over POST /predict (classify as-is;
gate one POST per claim; screen text + 3 labels; rerank query-as-text vs
candidate labels), argmax adjudication inside the real handlers, raw
scores/margins preserved per row. Gate routing OFF (ABSTAIN golds score
SUPPORTED ~0.98: thresholds dead, training avenue exhausted); screen
τ=0.2 from 580 held-out validation rows (never tuned on r1); fixed
argmax→band magnitudes at public policy centers. Checkpoint pin lives
lane-side (run-dir + path + computed sha256 in the manifest); the server
reports revision unpinned by honesty contract, never invented.

Per-version notes: `v5`–`v10` round-1 live matrix over several backends
(branches `review/c4v5`…`c4v10`); `v11` the four r3a lanes + versioned
smoke (`evals/smoke-r3a-lanes.mjs`) + composed table; `v12` validated
screen-margin routing; `v13` confirmation re-measure (scores identical —
deterministic on CPU); `v14` (held in `/tmp/v14`, same backend and data)
the `other`-lane fix, task 54/60 → 55/60 with exactly one case changed
in 48 and zero regressions; `v16` the r3a re-measure on current source
(live CPU 2026-10-10, 56/60 + 55/60, `evals/results/v16/`).

`r3f` (2026-10-10, train-now with batch 1): SFT continuation from r3a
(LR 2e-5, 2 epochs, 34s, VRAM 2.7GB, RTX 3050), mix 620 rows weight 1
(20 signed v2: 10 classify-other + 4 gate-ABSTAIN + 6 screen-suspicious;
200 gate SUP/CON replay; 400 classify/rerank/find/screen anchors;
abstain/screen-slice/boilerplate/hardneg shelved; eval-ids excluded).
Eval-loss deltas all negative (full −0.034, no ABORT, spike 0.07).
Measured live on CPU: v2 classify task 2/10 → 3/10 (gate/screen still
0/4, 0/6); r1 lanes classify 12/12 task (was 11/12), rest identical →
composed 56/60 decision, 56/60 task (`evals/results/v17/`). r3f promoted
to the recommended checkpoint and the advertised track numbers.

`r3g` (2026-10-10, batches 1+2): SFT continuation from r3f (LR 2e-5,
2 epochs, 46s, VRAM 2.8GB), mix 660 rows weight 1 (60 signed v2:
26 classify-other + 12 gate-ABSTAIN + 22 screen-suspicious; 200 gate
SUP/CON replay; 400 anchors; same shelving; eval-ids excluded).
Eval-loss deltas tiny (full −0.001, gate +0.013, no ABORT, spike < 0.3).
Measured live on CPU: v2 classify task 3/10 → 5/10 on the batch-1 subset
(11/16 on batch 2; 16/26 overall), gate/screen task still 0/12 and 0/22
but several ABSTAIN golds collapsed toward the abstention region
(SUPPORTED 0.98 → 0.26/0.36 on three cases — signal, not yet decisions).
r1 lanes bit-identical to r3f → composed 56/60 + 56/60 held, no revert
(`evals/results/v18/`). r3g promoted to the recommended checkpoint.

Open gaps (4 r1 misses, each dispositioned): the r1 classify EN case is
RESOLVED by r3f (12/12 — `other` training worked); remaining: 2 gate
ABSTAIN→SUPPORTED (needs abstention-aware training objective),
1 screen confident (accepted), 1 screen abstained (excluded, monitored).
v2 other-negatives still miss 7/10 — lote-2 data territory, not a lane
regression. Data-collection templates for
the trainable gaps in `odd/tasks/phase2-data-templates.md`; first draft
batch (20, signed 2026-10-10, promoted to `evals/corpus-v2/`) in `odd/tasks/phase2-draft-cases.md`.
Until then gate/screen are assistive (abstention-first), not autonomous.
