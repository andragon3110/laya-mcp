# FINAL REPORT — laya-mcp, Fase 8 Final (T6)

- Branch: `odd/fase-8-final` (no branch change; no push; no PR).
- Commit: `913bc88` (`fix(doctor): fase-8 T5 redact secret env values plus regression test`).
- Date of verification: 2026-09-23. Host: Windows, Node v24.18.0, Python 3.11.9.
- Scope of this task (T6): final 1-to-1 no-regression battery plus this report.
  Zero functional code was written or modified for T6. No regression was found,
  so no regression fix was applied.
- Method: code over docs over prompt. Every claim below is either directly
  verified by the T6 re-run on `913bc88` or explicitly attributed to its source
  document or prior work unit. Nothing is asserted from memory alone.

## Executive Summary

`laya-mcp` (`0.4.0`) is a local, read-only MCP capability layer: twelve typed
judgment tools over a Node.js/TypeScript stdio server, backed by two Python
FastAPI sidecars (`laya-server :8765`, `gliner-server :8766`) and local model
checkpoints. It reports evidence plus deterministic policy decisions. It never
executes actions, never orchestrates, and never forces a call.

Fase 8 closes the project with the tree in a verified honest state:

- No-regression (T6 re-run on `913bc88`): typecheck pass, build pass, Python
  57/57 pass, Node batteries 487 passed / 1 environmental failure (by design)
  / 1 skip, eval harness 80/80, eval score/bench/integration-stub all exit 0,
  offline smoke pass (10 builders), doctor `--no-live` plus all four Fase 8
  flags at the known environmental verdict (exit 2, `laya` pip package absent).
  Zero delta against the T5 matrix: no commits exist between the T5 and T6
  runs, and every verdict reproduced identically.
- No breaking changes in Fase 8 (or in Fases 5–7). All contract evolution since
  Fase 5 is minor-additive under the executable `SCHEMA_VERSION_POLICY`.
- Security review re-verified (Fase 8 §4 verdict SEGURO, per the T5 record),
  including a real secret-leak fix in `py/doctor.py` (`_redact_env` plus a
  regression test) shipped in `913bc88`.
- Documentation is honest with two residual exceptions found by T6
  (`README.md:15`, `README.md:227-229`; see Known Limitations and Technical
  Debt). They are reported with file and line evidence, not silently fixed,
  because T6 scope is this report only.
- CUA (computer use / action execution) is not implemented. Verified absent;
  declared as future architecture reference only.

## Architecture

Verified final map (read from the tree at `913bc88`; consistent with
`AUDIT.md` Architecture as amended by Fases 2–6):

```text
OpenCode -> Gentle -> laya-mcp -> Evidence/Policy -> Decision -> Gentle -> Action -> Verification
```

- `dist/index.js` (stdio JSON-RPC, from `src/index.ts`): 12 tool definitions
  plus handlers; stateless MCP layer.
- `src/tools/*.ts`: judgment handlers. `src/client.ts` (`LayaClient`: POST
  `/predict`, plus `live()`/`ready()`/`models()` since Fase 2).
  `src/gliner.ts` (`GlinerClient`). `src/health.ts` (`HealthWatch` polls
  non-warming `live()`+`ready()`, 10 s interval, 2 s probe timeout).
- `src/policy/`: deterministic Policy Engine, 14 versioned policies, all at
  `1.0.0` (`classify`, `code-review`, `compare`, `decide`, `extract`, `find`,
  `gate`, `normal`, `pii`, `rerank`, `review`, `screen`, `security`, `verify`).
  `getPolicy` takes no caller input; the loader exports no mutation API.
- `src/envelope.ts`: additive metadata stamping (`ENVELOPE_SCHEMA_VERSION =
  "1.0.0"`), `resolveEnvelopeRevision` (env pin, backend value, or honest
  `null` with `revision_source: "unpinned"`; a hash is never invented).
- `src/trace.ts` + `src/metrics.ts` (Fase 6): opaque-id trace correlation and
  a bounded in-process metric registry (256-sample latency window), exposed
  only through the optional `metrics` field of `laya_capabilities`.
- Python side: `py/laya_server.py` (`GET /live`, structured non-warming `GET
  /ready` with `Retry-After`, `GET /models`, `POST /reload`, `POST /predict`),
  `py/gliner_server.py` (same control surface plus entity/PII endpoints),
  `py/doctor.py` (diagnostics, extended in Fase 8), `py/download_models.py`
  (`--revision`, default `$LAYA_MODEL_REVISION`, receipt printed, absent
  revision reported honestly as unpinned).

Confirmed structural properties:

- No Model-to-Action edge exists. The MCP layer is read-only inference plus
  discovery under every policy mode (including `enforce`, which binds the
  Gentle consumer, never this server). Verified by the Fase 6 immutability
  battery (16 checks: no input path reaches policy, config, mode, thresholds,
  or permissions).
- Degradation instead of failure: backend down yields exactly
  `[laya_capabilities]` on `tools/list` (verified live by T6 probe against the
  repo `dist/`) and `isError` judgment calls with a recovery hint.
- Execution lives outside: invocation timing, acting on decisions, and
  verification are Gentle-side configuration (`examples/gentle-hooks.yaml`,
  never read by `laya-mcp`).

## Changes by Phase

Source: `git log --oneline --reverse cb70301..HEAD` on this branch, plus the
seven phase documents (state cited, not re-audited).

- Fase 1 — Baseline audit (`cb70301`, main). Read-only audit plus reproducible
  T3 baseline artifacts. Verified 27 problems (5 P0, 11 P1, 7 P2, 4 P3), 4
  not-reproduced claims, 5 prompt-vs-code discrepancies. State per `AUDIT.md`
  (untracked working-tree copy).
- Fase 2 — P0 backend robustness (`b241568`, `cfed3ef`, `b7d20b3`,
  `5f8dd23`, `80b33a6`, `519d3f0`; log per `P0_IMPLEMENTATION.md`). `GET
  /live`, structured non-warming `GET /ready`, `GET /models` on both servers;
  load retry with backoff/jitter, circuit breaker, `POST /reload`; per-holder
  single-flight load plus bounded concurrent inference; tool timeout
  enforcement; configurable input limits with structured `input_too_large`
  (413) errors. Tests at phase close: 42/42 Python plus 16/16 `t6_limits.mjs`.
- Fase 3 — P1 semantics and policy (`6c1407e`, `83a080b`, `3516efe`,
  `10f55f8`, `94bd216`, `10cb870`; log per `P1_IMPLEMENTATION.md`). Honest
  Evidence plus ABSTAIN signals with legacy decisions byte-identical;
  deterministic Policy Engine with 14 versioned policies; all handlers wired
  to evidence-only outputs; semantic/adversarial gap battery (17 checks).
  Tests at phase close: 42/42 Python plus 126 Node checks.
- Fase 4 — Search primitives (`fb4ac51`, `0a97878`, `c1e0d3d`, `447d56c`,
  `196e85f`, `1bbf684`; log per `SEARCH_IMPLEMENTATION.md`). `extract`
  `top_k`/`min_gliner_score`/`max_candidates` plus grounded values; `find`
  and `rerank` token-overlap pre-filter pruning; `decide` two-stage
  (select, then requirements-vs-winner); per-primitive benchmarks. 101 checks
  added, zero removed, zero weakened.
- Fase 5 — MCP contract (`a3bfae7`, `c7d405c`, `1383c9e`, `34529ce`,
  `3de2592`; contract per `MCP_CONTRACT.md`). Typed outputs (`outputSchema`
  plus read-only annotations), same-object `structuredContent` plus decision
  metadata and revision plumbing, live `laya_capabilities` discovery with
  `schema_version` and the executable versioning policy, contract-gap battery.
  Additive-only (`minor` class); the four documented behavior changes are not
  breakings (see Breaking Changes).
- Fase 6 — Gentle observe (`ba87255`, `09573f8`, `e2d61f9`, `b26e50a`;
  contract per `GENTLE_INTEGRATION.md`). Inbound trace correlation, in-process
  metrics on `laya_capabilities`, `observe`/`shadow`/`enforce` modes with a
  declarative Gentle hooks table, immutability plus single-source discovery
  plus per-mode degradation battery (16 checks), MCP-to-Gentle integration
  battery (29 checks plus 1 environmental skip). All additions optional and
  additive; stored pre-Fase-6 outputs keep validating.
- Fase 7 — Evaluation (`0b98c04`, `e6c0b98`, `3284eaa`, `ccb9cf1`; report per
  `EVALUATION.md`). Ten oracle suites (80 cases), shared metrics plus
  wrong-confident slicing plus the calibration verdict (no output is a
  probability; Brier/ECE do not apply), benchmark tables plus reproducibility
  manifest plus versioned `evals/results/v1/`, comparable plus/minus-Laya
  integration protocol with a live-requirements gate. Zero functional changes
  in `src/` across Fase 7.
- Fase 8 — Final hardening (`b6d6906` T3, `d0743b7` T4, `913bc88` T5, plus
  this report as T6). T3: doctor `--models`/`--policy`/`--mcp`/`--benchmark`
  (real data only), `download_models.py --revision`, de-facto lock comments
  instead of unverifiable `==` pins, tokenizer `unknown` exposure, 14 new
  Python doctor tests (56 total at T3). T4: honest README (modes,
  observability, evaluation, revisions, security, environments, doctor) with
  nine aspirational claims corrected, plus the Fase 6 contract update
  (docs-only, +248/-29). T5: secret redaction fix in `py/doctor.py` plus a
  regression test (+56/-1), security §4 re-verification (SEGURO), 12-tool
  contract re-verification, full X/Y/Z matrix, no breakings. T6 (this task):
  matrix re-run plus `FINAL_REPORT.md`; no code changes.

## Security

Fase 8 §4 verdict recorded by T5: SEGURO, with the contract re-verified and
no breaking changes. Items independently confirmed by the T6 re-run or by
reading the tree at `913bc88`:

- Secret redaction (real fix, `913bc88`): `check_optional_agent_configs`
  previously dumped `opencode.json` environment verbatim, leaking values such
  as `GH_TOKEN`/`API_KEY` into `--json` and `GET /doctor`. Now `_redact_env`
  (`py/doctor.py:989-1007`) replaces values whose names match
  token/secret/key/password/auth/bearer/credential/private with `[redacted]`;
  names and non-secret values stay visible. Applied at `py/doctor.py:1048`
  and covered by a regression test in `tests/test_doctor_t3.py`. Python
  57/57 pass, including the redaction test.
- Immutability: 16/16 pass (`tests/fase6_t5_security_discovery.mjs`). No
  input path (arguments, `_meta`, text content) alters policy, configuration,
  mode, thresholds, or permissions.
- Local-only trust model: no authentication on the sidecars or the MCP
  transport by design; permissive CORS is justified solely by the 127.0.0.1
  bind (`py/laya_server.py`, `py/gliner_server.py`; cf. `AUDIT.md` Security
  and the T5 record, which documents the bind-override exposure as
  insecure-if-exposed rather than hiding it).
- Credential hygiene in probes: the integration live-gate reports presence
  flags only and never prints credential values (structural battery
  `tests/fase7_t6_integration.mjs`, 12/12 pass; live gate re-verified exit 2
  by T6).
- Trace and metric paths carry opaque identifiers and aggregates only
  (`src/trace.ts`, `src/metrics.ts`); PII payloads are excluded from tracing
  by design (hashing rejected: a hash still enables confirmation against
  known PII).

Four re-verification equalities recorded by T5 (contract re-verified at 12
tools with no breakings) are corroborated by the T6 re-run: the Fase 5
contract batteries reproduce 151/151 checks pass.

## MCP Contract

State per `MCP_CONTRACT.md` (Fase 6 update included),
re-verified by the T6 battery re-run:

- Protocol `2025-11-25` (SDK negotiates `2025-11-25` back to `2024-10-07`);
  SDK `@modelcontextprotocol/sdk` 1.30.0 installed (`package.json` declares
  `^1.0.0`); Node 20+ ESM stdio transport.
- 12 tools, all read-only annotated, all read-only inference: `laya_screen`,
  `laya_verify`, `laya_find`, `laya_rerank`, `laya_classify`, `laya_decide`,
  `laya_compare`, `laya_extract`, `laya_review`, `laya_gate`, `laya_pii`
  (sidecar-gated), `laya_capabilities` (always advertised, judges nothing).
- Every success returns one non-empty text block with the full JSON envelope
  and `structuredContent` carrying the same object (deep-equal, asserted live
  and offline per tool). Errors resolve to serializable `isError` results
  with builder vocabulary; calls never throw raw and blocks are never empty.
- Envelope `schema_version "1.0.0"` versions the whole call contract.
  `classifyContractChange` is executable: additive-only change sets are
  `minor`; any breaking flag forces `major`. Twelve known additive envelope
  keys (asserted at `tests/fase5_t6_contract_gaps.mjs:407-412`).
- `model_revision` honesty: operator pin, backend value, or honest `null`
  with `revision_source: "unpinned"`. A hash is never invented.
- Backend down: `tools/list` is exactly `[laya_capabilities]` — verified live
  by the T6 stdio probe against the repo `dist/` (one tool returned:
  `laya_capabilities`). GLiNER down: `laya_pii` unadvertised,
  `gliner.reachable` false.
- Re-verification totals (T6): `fase5_t3_contract` 64/64, `fase5_t4_envelope`
  23/23, `fase5_t5_capabilities` 14/14, `fase5_t6_contract_gaps` 50/50.
  Stored pre-contract and pre-Fase-6 outputs keep validating (back-compat
  stripping asserted by the T6 gap battery).

## Gentle AI

State per `GENTLE_INTEGRATION.md`, re-verified by the T6 battery
re-run (`fase6_t3` 13/13, `fase6_t4` 15/15, `fase6_t5` 16/16, `fase6_t6` 29
passed plus 1 environmental skip):

- `laya-mcp` is a capability layer: typed judgments as evidence. OpenCode
  hosts the session; Gentle decides when to call (four lifecycle hooks:
  `external_content.pre_context` → screen plus pii; `implementation.post_write`
  → review; `completion.pre_complete` → gate; `retrieval.candidate_selection`
  → find; all default `observe`); Gentle consumes the decision, acts, and
  verifies.
- Exact mode semantics: `observe` advisory; `shadow` base decision unchanged
  with the same input additionally evaluated under an explicit candidate
  policy (`shadow: { would_decide, under_policy }`, shadow mode only);
  `enforce` authoritative for the Gentle consumer. Every live envelope stamps
  `effective_mode`; the legacy `mode: "observe"` field is untouched.
- Tracing: `trace_id`/`span_id` travel on the MCP `_meta` object (8–64 hex
  accepted; absent or malformed replaced with generated ids; extraction never
  throws). Metrics: in-process aggregates only, exposed via the optional
  `metrics` field of `laya_capabilities`; no separate tool; mode-blind.
- Known template gap documented in the contract: the
  `completion.pre_complete` arg map lists `{claims, diff, evidence}` while
  `laya_gate` requires `request`; the orchestrator supplies the original task
  as `request`. The `laya_pii` leg needs the sidecar; without it the hook
  degrades to the screen leg alone.
- No live OpenCode/Gentle verification exists in this repository by
  architecture (external operator concern). The T6 battery simulates the
  Gentle side against stub backends and labels each simulated step as
  simulated. The one skip (`apply-orchestrator-policy.sh --check`) is
  environmental: no bash on this host.

## Evaluation

State per `EVALUATION.md`. All primitive evals run against the
real handlers (`dist/`) with deterministic oracle stubs; no live backend, no
models, no network. T6 re-ran every entry point; all exit 0 with shapes
intact.

- Datasets: 10 suites by 8 cases (80 total) covering normal, ambiguous,
  difficult, adversarial, negative (one fail-fast limit throw per suite,
  counted in `abstention.errors`, never in quality denominators), and
  abstention classes. T6: `node evals/run.mjs` → 80 passed, 0 failed.
- Metrics: binary family (exact-match decision accuracy, task accuracy, ALLOW
  polarity P/R/F1/FPR/FNR, abstention, wrong_confident), ranking family
  (MRR/nDCG/MAP/top-k), agreement family (review/gate). T6 `node
  evals/score.mjs` exits 0; the recorded report shows decision accuracy 1.000
  and task accuracy 1.000 on every suite with binary ALLOW F1 1.000 wherever
  computed. These figures confirm harness conservation of oracle golds end to
  end; they are not backend quality (stub ceiling, stated in the document).
- wrong_confident: 0.000 at every tau (0.70/0.80/0.90/0.95) on every scored
  suite; rerank not applicable (within-call scores carry no correctness
  value). Expected oracle-stub outcome; validates the slicing pipeline, not
  backend safety.
- Calibration verdict: no numeric output of this repository is a probability.
  Brier/ECE do not apply and are documented, never calculated. The taus are
  descriptive reporting cuts; promoting any of them to a production cutoff is
  a documented category error.
- Integration protocol (`evals/integration.mjs`): four synthetic hook-chain
  tasks in Gentle lifecycle order with paired metric columns per task per arm.
  T6 stub arm: 4/4 pass, INT-02 halt honored (1 hook run, 3 skipped), retries
  0, tokens/llm_calls/cost explicit nulls. Live arm refused by the
  requirements gate (exit 2, five unmet requirements tabled); no live numbers
  exist because no live run happened.
- Structural batteries re-verified: `fase7_t4` 10/10, `fase7_t5` 14/14,
  `fase7_t6` 12/12.

## Benchmarks

Recorded run: `evals/results/v1/` (never overwritten; commit `e6c0b98`,
2026-09-23, Node v24.18.0, win32 x64, AMD Ryzen 7 5700X). All values are
single-machine absolutes from that run; rows within one run share the
process. T6 re-ran `node evals/bench.mjs` (exit 0, structure intact; observed
cold import wall 46.1 ms vs recorded 44.7 ms — run-to-run shape, not a
comparison). Figures below are quoted from `EVALUATION.md` §7, not
re-measured for this report.

Primitives (canonical case each; stub reports 0 ms; wall is pipeline
overhead):

| Primitive | cold_1st_ms | warm_p50_ms | warm_p95_ms | ops/s |
|---|---|---|---|---|
| `laya_classify` | 1.090 | 0.213 | 0.510 | 4272.7 |
| `laya_decide` | 0.569 | 0.197 | 0.234 | 5084.3 |
| `laya_verify` | 0.671 | 0.195 | 0.238 | 4966.3 |
| `laya_screen` | 0.585 | 0.190 | 0.217 | 5252.3 |
| `laya_pii` | 0.603 | 0.175 | 0.208 | 5571.3 |
| `laya_extract` | 1.476 | 0.561 | 0.789 | 1713.0 |
| `laya_find` | 0.724 | 0.238 | 0.337 | 3858.7 |
| `laya_rerank` | 0.903 | 0.232 | 0.408 | 4057.1 |
| `laya_review` | 0.493 | 0.207 | 0.370 | 4591.5 |
| `laya_gate` | 0.658 | 0.205 | 0.260 | 4660.0 |

Rerank scale sweep (top_k=10): N=10/50 retain full judge quality
(MRR_sel 1.000; MRR_judge 0.500 via one intentional adjacent swap proving the
metric pipeline discriminates); N above the 64 transport cap reports the pure
selector plus projected judge load (e.g. N=1000: 0.99 drop ratio, sel_p50
1.0064 ms). Model load shape (MCP side only): cold import 44.7 ms, warm
re-import p50 0.012 ms; no local weights exist here, so real model-load
timing is unmeasured. No baseline exists; no improvement is claimed or
derivable.

## Tests

T6 re-execution on `913bc88`, foreground, one command per battery. Exact
counts per battery (passed / failed / skipped):

| Battery | Command | Passed | Failed | Skipped |
|---|---|---|---|---|
| typecheck | `npm run typecheck` | pass (exit 0) | 0 | 0 |
| build | `npm run build` | pass (exit 0) | 0 | 0 |
| Python unit | `python -m unittest discover -s tests -p "test_*.py"` (9.6 s) | 57 | 0 | 0 |
| `fase4_decide_twostage` | `node tests/fase4_decide_twostage.mjs` | 11 | 0 | 0 |
| `fase4_extract_primitives` | `node tests/fase4_extract_primitives.mjs` | 22 | 0 | 0 |
| `fase4_find_primitives` | `node tests/fase4_find_primitives.mjs` | 26 | 0 | 0 |
| `fase4_rerank_primitives` | `node tests/fase4_rerank_primitives.mjs` | 26 | 0 | 0 |
| `fase4_t7_gaps_benchmarks` | `node tests/fase4_t7_gaps_benchmarks.mjs` | 16 | 0 | 0 |
| `fase5_t3_contract` | `node tests/fase5_t3_contract.mjs` | 64 | 0 | 0 |
| `fase5_t4_envelope` | `node tests/fase5_t4_envelope.mjs` | 23 | 0 | 0 |
| `fase5_t5_capabilities` | `node tests/fase5_t5_capabilities.mjs` | 14 | 0 | 0 |
| `fase5_t6_contract_gaps` | `node tests/fase5_t6_contract_gaps.mjs` | 50 | 0 | 0 |
| `fase6_t3_trace_metrics` | `node tests/fase6_t3_trace_metrics.mjs` | 13 | 0 | 0 |
| `fase6_t4_modes` | `node tests/fase6_t4_modes.mjs` | 15 | 0 | 0 |
| `fase6_t5_security_discovery` | `node tests/fase6_t5_security_discovery.mjs` | 16 | 0 | 0 |
| `fase6_t6_gentle_integration` | `node tests/fase6_t6_gentle_integration.mjs` | 29 | 0 | 1 |
| `fase7_t4_metrics` | `node tests/fase7_t4_metrics.mjs` | 10 | 0 | 0 |
| `fase7_t5_bench_manifest` | `node tests/fase7_t5_bench_manifest.mjs` | 14 | 0 | 0 |
| `fase7_t6_integration` | `node tests/fase7_t6_integration.mjs` | 12 | 0 | 0 |
| `policy_engine` | `node tests/policy_engine.mjs` | 49 | 0 | 0 |
| `t5_review_gate_verify` | `node tests/t5_review_gate_verify.mjs` | 19 | 0 | 0 |
| `t6_limits` | `node tests/t6_limits.mjs` | 16 | 0 | 0 |
| `t6_screen_pii_rest` | `node tests/t6_screen_pii_rest.mjs` | 25 | 0 | 0 |
| `t7_semantic_adversarial` | `node tests/t7_semantic_adversarial.mjs` | 17 | 0 | 0 |
| `mcp_smoke` | `node tests/mcp_smoke.mjs` | 0 | 1 | 0 |
| eval harness | `node evals/run.mjs` | 80 cases | 0 | 0 |
| eval score | `node evals/score.mjs` | exit 0 | 0 | 0 |
| eval bench | `node evals/bench.mjs` | exit 0 | 0 | 0 |
| eval integration (stub) | `node evals/integration.mjs` | 4 tasks | 0 | 0 |
| eval integration (live gate) | `node evals/integration.mjs --mode live` | refused exit 2 (by design) | — | — |
| offline smoke | `LAYA_SKIP=1 python tests/smoke.py` | 10 builders OK | 0 | 0 |
| doctor | `python py/doctor.py --no-live` | 10 | 1 (env) | 3 |
| doctor `--models` | `python py/doctor.py --no-live --models` | exit 2 (same env fail) | 1 (env) | — |
| doctor `--policy` | `python py/doctor.py --no-live --policy` | exit 2 (same env fail) | 1 (env) | — |
| doctor `--mcp` | `python py/doctor.py --no-live --mcp` | exit 2 (same env fail) + honest WARN (stale installed dist) | 1 (env) | — |
| doctor `--benchmark` | `python py/doctor.py --no-live --benchmark` | live bench PASS within exit-2 run | 1 (env) | — |
| compileall | `python -m py_compile` (3 servers/doctor files) | exit 0 | 0 | 0 |

Node `.mjs` totals: 487 passed / 1 failed / 1 skipped. Python total: 57
passed / 0 failed / 0 skipped. No battery shows a `not ok` line; every
battery exits 0 except the rows noted below.

T5-vs-T6 comparison: zero functional delta by construction — no commit exists
between the T5 run and this T6 run (HEAD is still `913bc88`). Every verdict
reproduced identically: Python 57/57 (56 at T3 plus the T5 redaction test),
Node 487/1/1, evals 80/80 plus 4/4 stub, smoke 10 builders, doctor
10/0/1/3 exit 2, `mcp_smoke` FAIL offline by design. Bench wall figures are
run absolutes and were not compared. No cause analysis was needed because no
delta occurred.

Known environmental states (unchanged, not failures of the tree):

- `tests/mcp_smoke.mjs` FAILs offline by design (`FAIL -- laya_extract
  advertised`; both servers down; exit 1).
- `tests/test_*.sh` cannot execute on this host (literal
  `execvpe(/bin/bash) failed: No such file or directory`); the one
  affected assertion is replicated against fixtures in `fase6_t6` (the 1
  skip above).
- Doctor exits 2 because the `laya` pip package is not installed here
  (blocking `laya-sdk` fail; 3 skips cascade from absent optional
  components). No `pip install laya` was performed per mission scope.
- No lint script, config, or CI exists in the repository (not applicable,
  unchanged since baseline).
- `doctor --mcp` reports WARN (not pass) when the installed copy at
  `C:\Users\Andragon\laya-mcp\dist` advertises 0 tools: that copy predates
  the Fase 5 capabilities exemption, while the repo `dist/` correctly
  returns `[laya_capabilities]` (T6 probe). Silent pass would mislead; the
  warn text names rebuild/reinstall as the remedy.

## Breaking Changes

None in Fase 8. None in Fases 5–7 either: every contract evolution since Fase
5 classifies `minor` under the executable `SCHEMA_VERSION_POLICY`
(additive-only: new optional keys, new tool with its own schemas, `outputSchema`
announcements, `structuredContent` alongside unchanged text). The four
documented Fase 5 behavior changes are not breakings (old text readers keep
working): `tools/list` with the backend down returns `[laya_capabilities]`
instead of `[]`; list entries gained `outputSchema` plus `annotations`;
success text carries the additive metadata keys; malformed arguments keep
resolving to `isError` with builder vocabulary. Fase 6 additions (trace ids,
`effective_mode`, `shadow`, `modes`/`metrics`, identical per-mode
degradation, immutability) are likewise optional and additive. Old readers
ignore unknown keys; stored pre-contract and pre-Fase-6 outputs keep
validating (asserted by the re-run batteries).

## Known Limitations

1. Stub ceiling: every score, calibration slice, robustness figure, and
   benchmark measures harness plus handler plumbing under oracle-assigned
   signals. No hit rate, calibration figure, robustness result, or wall time
   transfers to the real backend or to agent quality.
2. No live comparison exists: the plus/minus-Laya paired table is a defined
   protocol with five unmet live requirements (host session, orchestrator
   session, reachable server, pinned revisions, LLM credentials). It remains
   future external-operator work.
3. Revisions unpinned in practice: `model_revision` is the honest `null`
   with `revision_source: "unpinned"` unless the operator pins
   `LAYA_MODEL_REVISION`/`GLINER_MODEL_REVISION` or the backend supplies one.
4. Rerank transport cap: pools above 64 cannot run the judge end to end;
   large-N rows are selector-only plus projection.
5. `laya_compare` has metric definitions but no eval dataset; reported as
   such, not silently dropped.
6. Single-machine absolutes: benchmark walls and throughput describe recorded
   runs, not hardware claims.
7. Residual README staleness found by T6 (see Technical Debt items 1–2):
   `README.md:15` still frames tool outputs as calibrated probabilities
   (contradicting `EVALUATION.md` §6 and `README.md:36` itself), and
   `README.md:227-229` still states `tools/list` is empty with the backend
   down (contradicting the shipped exemption, `MCP_CONTRACT.md` §7, and
   `README.md:556`).
8. Environment-bound verifications: `.sh` scripts need bash; doctor needs the
   `laya` pip package for a full pass; GLiNER-gated paths need the sidecar;
   no lint configuration exists to run.

## Technical Debt

1. `README.md:15` — "calibrated probabilities your code can branch on"
   over-claims for tool outputs; the repository verdict (`EVALUATION.md` §6)
   is that no output is a probability. One-line correction owed (the header
   should promise typed signals with explicit decisions, never calibrated
   probabilities).
2. `README.md:227-229` — "zero tools advertised if `laya-server` is down"
   describes pre-Fase-5 behavior; the shipped behavior since Fase 5 is
   exactly `[laya_capabilities]`. One-line correction owed (the Architecture
   section already states the correct behavior at `README.md:556`).
3. `py/requirements*.txt` keep `>=` ranges by deliberate T3 decision: `==`
   pins were unverifiable on this host, so exact installed versions are
   recorded as de-facto lock comment blocks (fastapi 0.139.0, uvicorn
   0.42.0, pydantic 2.12.5, huggingface_hub 0.36.2, psutil 5.9.8, protobuf
   6.33.6; `laya` and `gliner2` not installed) with the rationale
   documented. Converting ranges to verified `==` pins remains open.
4. Tokenizer recorded as `unknown` with an exposure note (no tokenizer
   metadata ships with the checkpoints in a consumable form).
5. `/health` retained as a legacy warming endpoint alongside the non-warming
   `/live`/`/ready` pair; kept intentionally for backward compatibility, but
   new callers must prefer the pair.
6. No lint, format, or CI configuration exists (unchanged since the Fase 1
   baseline recorded it as not applicable).

## Remaining Risks

1. Local-only trust model: no authentication anywhere by design. Safe while
   loopback-bound; any bind override or network exposure without an
   auth/secret story would be insecure (recorded as insecure-if-exposed by
   T5, not re-tested by T6 beyond the redaction and immutability re-runs).
2. Unvalidated model behavior: thresholds, tie rates, evasion robustness, and
   review/gate judgment quality are unvalidated on real traffic by
   construction of the stub ceiling. The suites pin known honest blind spots
   instead (detector blind-spot miss in screen, no instruction-hierarchy
   defense in classify, no cross-claim check in gate, REVIEW unreachable via
   the review-handler mid-band, authority notes denying any authorization).
3. Stale-install confusion: the operator install at
   `C:\Users\Andragon\laya-mcp` predates the Fase 5 exemption and advertises
   0 tools. `doctor --mcp` now warns honestly, but a reinstall remains the
   real remedy.
4. Doc drift recurrence: two stale README lines survived the T4 honest-docs
   pass (items above). A read-level contract check per future behavior change
   would catch this class earlier.

## Recommended Next Steps

1. Apply the two one-line README corrections (Technical Debt items 1–2);
   re-run no battery (docs-only), read back the three affected sections.
2. Run the paired plus/minus-Laya comparison with an external operator once
   the five live requirements are met; save both arms versioned (`v2`, …);
   never overwrite `evals/results/v1/`.
3. Convert `>=` ranges to verified `==` pins once a networked install run
   can prove them; pin `LAYA_MODEL_REVISION`/`GLINER_MODEL_REVISION` (or
   record backend-reported revisions) before any live comparison.
4. Reinstall or rebuild the operator copy at `C:\Users\Andragon\laya-mcp`
   so `doctor --mcp` returns to pass.
5. Add bash CI (or portable equivalents) for `tests/test_*.sh` and
   `scripts/apply-orchestrator-policy.sh --check` to retire the permanent
   skip; consider minimal lint/format configuration.
6. Build a T3-style dataset for `laya_compare` so the one unevaluated tool
   stops being reported-by-exception.

## Acceptance Checklist (§9)

Checklist of `odd/tasks/fase-8-final.md` acceptance criteria, answered
hecho / parcial / falta with evidence. (No other §9 in the task scope
defines a checklist; this is the fase acceptance list.)

- Reproducibility reviewed (pins or justification, tokenizer, revision
  documented) — hecho. `>=` ranges kept with de-facto lock comments and
  rationale; tokenizer `unknown` exposed; `--revision` plumbed with honest
  unpinned default (`b6d6906`; T6: flags re-run, behavior confirmed).
- Doctor `--benchmark`/`--models`/`--policy`/`--mcp` where the architecture
  allows, with real data — hecho. All four flags re-run by T6; `--mcp`
  warns honestly on the stale install; `--benchmark` runs the live bench.
- README/docs describe the real surface (§3 list) without aspirational
  content — parcial. T4 corrected nine claims and documented modes,
  observability, evaluation, revisions, security, environments, and doctor
  (`d0743b7`); T6 found two residual stale lines (`README.md:15`,
  `README.md:227-229`) reported above, not fixed (out of T6 scope).
- Security review §4 verified item by item plus the four confirmations —
  hecho per the T5 record (SEGURO), corroborated by T6: redaction fix plus
  regression test present and passing (`py/doctor.py:989-1007,1048`;
  57/57), immutability 16/16, live-gate credential hygiene 12/12.
- Contract re-verified plus breakings identified — hecho. 12 tools,
  151/151 Fase 5 checks pass on re-run; breakings identified: none
  (additive-only, §Breaking Changes).
- Full test matrix executed (unit/integration/contract/adversarial/e2e plus
  lint/typecheck/build/doctor) without deleting failures — hecho. §Tests
  table; the only FAIL (`mcp_smoke` offline) and the only skip are retained
  and labeled environmental/by-design; lint is not applicable (no config).
- Final architecture without Model-to-Action, execution outside, no CUA —
  hecho. Chain verified in tree; CUA grep over `src/` returns zero matches
  (see CUA Status).
- Checklist §9 answered; `FINAL_REPORT.md` with exact X/Y/Z — hecho. This
  section plus the §Tests table.

## CUA Status

Not implemented — declared, not built. A search over `src/` for computer
use, browser/mouse/keyboard control, screenshots, and action-execution
surface returns zero matches (verified by T6 grep). By
architecture, action execution belongs to the Gentle consumer side
(`Gentle -> Action -> Verification`); the MCP layer stays read-only
inference plus discovery under every mode. The four lifecycle hooks document
exact call points but force no call. Any future CUA work would live outside
this server (orchestrator policy and verification harness) and would require
its own threat model, since it crosses the read-only boundary this project
has held since Fase 1. This section is architecture reference, not a plan.

## Verification Honesty Note (§11)

Only what was verified is affirmed above. Visible errors are shown with
file and line evidence (the two README lines; the stale installed dist; the
`mcp_smoke` offline FAIL; the bash absence; the doctor exit 2). No metric
was invented: benchmark and score figures are quoted from `EVALUATION.md`
and `evals/results/v1/` (recorded run, commit `e6c0b98`); the T6 re-runs
asserted exit codes and structural shape, not new numbers. Skipped items are
labeled skipped with the literal cause. Anything attributed to a prior work
unit (T3/T4/T5 records, evaluation verdicts) is marked as such.
