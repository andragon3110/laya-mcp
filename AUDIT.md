# laya-mcp — Phase 1 Baseline Audit (no implementation)

> Scope: repository `laya-mcp@0.4.0`, branch `main`, HEAD `cb70301`.
> Method: read-only audit plus the pre-recorded T3 baseline evidence under
> `artifacts/baseline/`. No functional code was implemented.
> Note on length: the correct audit exceeds the ~400-line advisory heuristic
> because the task mandates 19 headings, a 9-field format for each of the 27
> verified problems, full baseline command logs, and file:line citations for
> every technical claim. No evidence, test, or comment was removed to save lines.

## Executive Summary

The repository is a three-layer, fully local decision stack (`README.md:171-201`):
a Node.js/TypeScript MCP server over stdio (`src/index.ts`), two Python FastAPI
sidecars (`py/laya_server.py:8765`, `py/gliner_server.py:8766`), and local model
checkpoints (Laya english / multilingual / typed-decisions plus optional
GLiNER2.5 287M). The design degrades instead of failing: with `laya-server`
down, `tools/list` returns `tools: []` (`src/index.ts:104-109`); with the GLiNER
sidecar down, `laya_pii` is unadvertised and `laya_extract` falls back to regex
(`src/tools/extract.ts:137-167`, `src/index.ts:110-113`).

The T3 reproducible baseline (`artifacts/baseline/tests.txt`,
`artifacts/baseline/typecheck.txt`, `artifacts/baseline/build.txt`,
`artifacts/baseline/doctor.txt`, `artifacts/baseline/mcp.txt`,
`artifacts/baseline/lint.txt`) shows: install OK (114 packages, 2.58 s),
typecheck OK (1.25 s), build OK (1.30 s, `dist/` generated), Python unit tests
9/9 OK (0.13 s incl. runner overhead; suite itself 0.007 s), offline smoke OK
(`LAYA_SKIP=1`, 10 builders), one by-design MCP smoke failure (`tools: []`
while backends are down), `test_*.sh` not runnable on this host (no bash),
`doctor --no-live` exit 2 (missing `pip laya`; 9 pass / 1 warn / 1 fail /
3 skip, 14 total with `--json`), no listener on `:8765` (inference deliberately
not started — cost), and lint not applicable (no script, no configs, no CI).

The T4 deep analysis verified 27 problems (5 P0, 11 P1, 7 P2, 4 P3), 4
not-reproduced claims, and 5 prompt-vs-code discrepancies plus one divergent
dead module (`py/workflows.py`). There is no Policy Engine, no metrics layer,
no retry, no circuit breaker, and no `structuredContent` in tool outputs.
Nothing was implemented in this phase; the only mutations are baseline
artifacts, install side effects, and this document (see "not done" declaration
in Recommended Implementation Order).

## Baseline

All commands below were executed once by the T3 worker and recorded verbatim in
`artifacts/baseline/`. They were NOT re-executed for this report (readback only).

| Check | Command (from `artifacts/baseline/*.txt`) | Result / duration | Evidence |
|---|---|---|---|
| `npm install` | `npm install` (node_modules was absent) | exit 0, 2.58 s, 114 packages, 0 vulns | `artifacts/baseline/build.txt:10-12` |
| typecheck | `npm run typecheck` (`tsc --noEmit`, `package.json:15`) | exit 0, 1.25 s, no errors | `artifacts/baseline/typecheck.txt:4-9` |
| build | `npm run build` (`tsc`, `package.json:11`) | exit 0, 1.30 s, `dist/` generated | `artifacts/baseline/build.txt:4-9` |
| python unit | `python -m unittest tests.test_opencode_v2 -v` | exit 0, 9 OK, 0.13 s wall (suite 0.007 s) | `artifacts/baseline/tests.txt:8-22` |
| offline smoke | `LAYA_SKIP=1 python tests/smoke.py` | exit 0, 0.05 s, 10 builders non-empty | `artifacts/baseline/tests.txt:24-27` |
| mcp smoke | `EXPECT_PII=0 node tests/mcp_smoke.mjs` | exit 1, 0.46 s, FAIL by design (`laya_extract advertised` fails on `tools: []`) | `artifacts/baseline/tests.txt:29-37` |
| native tools/list | JSON-RPC `initialize` + `tools/list` piped to `node dist/index.js` | exit 0, 0.23 s, `{"result":{"tools":[]}}` | `artifacts/baseline/tests.txt:46-54` |
| `test_tools_offline.sh` | `bash tests/test_tools_offline.sh` | not executable: no bash on host (WSL shim `execvpe(/bin/bash)` failure) | `artifacts/baseline/tests.txt:39-44` |
| `test_health.sh` | `bash tests/test_health.sh` | not executable (same cause); script is mostly informational, its only real check needs `.venv` (absent) | `artifacts/baseline/tests.txt:56-63` |
| doctor | `python py/doctor.py --no-live` | exit 2, 2.48 s: 9 pass / 1 warn / 1 fail / 3 skip; blocking fail `laya-sdk` (pip package missing) | `artifacts/baseline/doctor.txt:10-31` |
| doctor json | `python py/doctor.py --no-live --json` | exit 2, 2.64 s, same verdict, total 14 | `artifacts/baseline/doctor.txt:33-40` |
| liveness probe | `curl.exe --max-time 3 -fsS http://127.0.0.1:8765/health` | exit 7, connection refused (~2 s); `:8766`, `/ready`, `/doctor` not probed (nothing listening; inference not started — cost) | `artifacts/baseline/doctor.txt:42-47` |
| lint | script/config glob + `Test-Path .github` | not applicable: no `lint` script (`package.json:10-16`), no eslint/prettier/ruff/flake8/pyproject/Dockerfile/CI | `artifacts/baseline/lint.txt:4-13` |
| git | `git status --short` / `log --oneline -5` / `branch --show-current` | `main` @ `cb70301`; untracked `odd/` (+ `artifacts/` after T3) | `artifacts/baseline/mcp.txt:6-21` |

Environment recorded in baseline: `laya-mcp@0.4.0`, node v24.18.0, npm 11.17.0,
python 3.11.9, torch 2.13.0+cu130, CUDA RTX 5060 Ti, 5.2 GB RAM available,
126.2 GB disk free, HF cache with all three Laya checkpoints
(2262.7 / 646.8 / 807.0 MB) (`artifacts/baseline/doctor.txt:12-26`).
Caveat: doctor resolves the install dir to `C:\Users\Andragon\laya-mcp` (a
separate install), not the audited repo (`Documents\Github\laya-mcp`)
(`artifacts/baseline/doctor.txt:38-40`).

## Architecture

Real map (verified by reading, not assumed):

```text
dist/index.js (stdio JSON-RPC, src/index.ts:99-159)
  -> src/tools/*.ts (11 tool definitions + handlers)
  -> src/client.ts (LayaClient: POST /predict, POST-agnostic /health)
  -> src/gliner.ts (GlinerClient: /extract_entities, /pii_scan, /classify)
  -> src/health.ts (HealthWatch pollers, 10 s default, 2 s probe timeout)
  -> FastAPI laya-server :8765 (py/laya_server.py, lazy _RouterHolder)
  -> FastAPI gliner-server :8766 (py/gliner_server.py, lazy _ExtractorHolder)
  -> checkpoints: english ModernBERT-large, multilingual mmBERT 100+ langs,
     typed-decisions FT (README.md:306-314), GLiNER2.5 287M (py/gliner_server.py:5-7)
```

Key properties: stateless MCP layer (`src/index.ts:17`); one `fetch` per call,
no retry, no breaker (`src/client.ts:112-123`, `src/gliner.ts:71-105`);
degradation by design (`src/index.ts:104-121`); lazy holders that boot HTTP
before models load (`py/laya_server.py:57-64`, `py/gliner_server.py:71-78`);
permissive CORS justified only by 127.0.0.1 bind
(`py/laya_server.py:161-167`, `py/gliner_server.py:150-156`,
`py/laya_server.py:259-262`, `py/gliner_server.py:261-264`).
There is no state, no auth, no metrics, and no policy layer (grep for `policy`
over `src/` returns 0 hits; Policy Engine was explicitly out of scope).

## Public Contracts

MCP (stdio JSON-RPC): `tools/list` returns 10 base tools when Laya is ready
plus `laya_pii` when GLiNER is ready, else `tools: []`
(`src/index.ts:104-121`); `tools/call` on an unknown name returns
`isError: true, "Unknown tool: <name>"` (`src/index.ts:123-131`); handler
exceptions return `isError: true` with `{tool, error, hint}` JSON
(`src/index.ts:137-158`); success returns exactly
`content: [{type: "text", text: <JSON string>}]` — no `structuredContent`
(`src/index.ts:135-136`).

HTTP laya-server (`py/laya_server.py:129-253`): `GET /health` (liveness +
readiness, hot-loads models), `GET /ready` (200/503, never consumed by TS),
`GET /doctor?live=` (reuses `py/doctor.py`), `POST /predict`
(`{state, questions, model?, task?, lang?}` → `{answers, confidence, routing,
latency_ms, usage}`). Routing overrides pass straight through
(`py/laya_server.py:101-105`, `220-231`).

HTTP gliner-server (`py/gliner_server.py:159-255`): `GET /health`, `GET /ready`,
`POST /extract_entities` (`{text, labels, include_spans, include_confidence}`),
`POST /classify` (passthrough to `classify_text`), `POST /pii_scan`
(`{text, extra_types}` → `{findings[], counts, latency_ms}`, sorted by offset,
`py/gliner_server.py:247-255`).

CLI: `py/doctor.py` flags `--host/--port/--gliner-host/--gliner-port/--no-live/
--json/--fail-on` (`py/doctor.py:712-731`); `py/download_models.py` flags
`--model/--subfolder/--all-checkpoints/--gliner` (`py/download_models.py:24-45`);
`install.sh [--with-gliner]` (`install.sh:14-25`); MCP env config
(`README.md:383-399`): `LAYA_URL` :8765, `GLINER_URL` :8766, `LAYA_TIMEOUT_MS`
5000, `LAYA_TOOL_TIMEOUT_MS` 8000 (declared, never enforced — V-07),
`LAYA_HEALTH_INTERVAL_MS` 10000, `GLINER_TIMEOUT_MS` 10000.

## MCP Tools

11 tools: 10 base (`BASE_TOOLS`, `src/index.ts:52-63`) + conditional `laya_pii`
(`src/index.ts:110-113`). Per-tool behavior:

| Tool | Backend call shape | Notable verified fact |
|---|---|---|
| `laya_screen` | 3 × `noul` (`src/tools/screen.ts:22-50`) | emits `allow` in docs vs `pass` in code (V-01) |
| `laya_verify` | N × `noul` (`src/tools/verify.ts:26-41`) | bins ≥0.8/≥0.4 (V-17) |
| `laya_find` | 1 × `choice` (`src/tools/find.ts:37-43`) | "up to 250" uncapped + 240-char silent cut (V-10) |
| `laya_rerank` | N × `noul` (`src/tools/rerank.ts:26-41`) | duplicate-id key collision, no tiebreak (V-11) |
| `laya_classify` | N × `choice` (`src/tools/classify.ts:43-52`) | `confidence=max(probs)` (V-18) |
| `laya_decide` | 1 × `choice` + N × `noul` (`src/tools/decide.ts:41-58`) | `ask_user` documented, no code; 2–6 only in schema (V-12) |
| `laya_compare` | 1 + N × `choice` (`src/tools/compare.ts:35-51`) | sound; `state` built then discarded (`src/tools/compare.ts:49-51`) |
| `laya_extract` | regex or span `choice` + forced `typed-decisions` judge (`src/tools/extract.ts:174-175`) | only tool with grounding + routing echo; silent caps (V-04, V-05) |
| `laya_review` | 4 × `score` + 1 × `noul` (`src/tools/review.ts:20-49`) | magic 0.85/0.5 action cut (V-19) |
| `laya_gate` | 2 × `score` + claims (`src/tools/gate.ts:28-61`) | drops `test_gap`/`blast_radius`, evidence optional (V-02) |
| `laya_pii` | GLiNER only, zero Laya (`src/tools/pii.ts:25,42-44`) | hardcoded secrets, no threshold (V-03) |

All Laya-backed handlers funnel through `runTool` (`src/tool.ts:38-52`), which
performs no argument validation and forwards `timeoutMs=undefined`
(`src/tool.ts:46`), so every call uses `LAYA_TIMEOUT_MS` (5000 ms,
`src/client.ts:62,110`).

## Python Backend

`laya-server` (`py/laya_server.py`): `FastAPI` app (`py/laya_server.py:159`),
`_RouterHolder` lazy loader (`py/laya_server.py:57-124`), `/predict` runs
`router.predict` inside `asyncio.to_thread` unbounded
(`py/laya_server.py:227-231`), per-question `confidence` extraction
(`py/laya_server.py:238-242`), error mapping 503 (load) / 500 (prediction)
(`py/laya_server.py:232-235`). `gliner-server` (`py/gliner_server.py`):
`_ExtractorHolder` (`py/gliner_server.py:71-114`), fixed `PII_LABELS` map with
Spanish `telefono`/`persona`/`token_secreto` keys
(`py/gliner_server.py:43-50`), `extra_types` defaulting to
`extra.replace("_", " ")` (`py/gliner_server.py:217-219`). `py/doctor.py` never
raises and always returns `{ok, summary, checks}` (`py/doctor.py:1-14,
647-691`); `py/workflows.py` builders are unreachable at runtime (V-27);
`py/download_models.py` uses `snapshot_download` without `revision`
(`py/download_models.py:76-80`).

## Model Loading

`LAYA_PRELOAD=1` loads all three checkpoints at startup (`install.sh:119-136`,
`py/laya_server.py:43`); `LAYA_MAX_LOADED=3` with LRU eviction
(`py/laya_server.py:42`); `LAYA_AUTO_TASK_DETECTION=1` routes workflow-shaped
questions to `typed-decisions` (`py/laya_server.py:44`); `LAYA_DEVICE=auto`
(`py/laya_server.py:41`). Loading is hot inside `health()`
(`py/laya_server.py:107-121` — V-13); any load failure is cached in
`_load_error` and re-raised forever until process restart
(`py/laya_server.py:68-69,95-98` — V-14). The only forced-routing call site is
entity-mode extract → `{model: "typed-decisions"}`
(`src/tools/extract.ts:174-175`, reason documented `src/tools/extract.ts:169-173`).
No response carries a model revision (V-24); VRAM guidance is docs-only
(`README.md:297-300`; doctor warns at 5.2 GB available,
`artifacts/baseline/doctor.txt:21`).

## Concurrency

One `fetch` per call with `AbortController` timeouts: Laya default 5000 ms
(`src/client.ts:62,110`), health probes 1000 ms (`src/client.ts:65`) except the
watcher which probes at 2000 ms (`src/health.ts:49`), GLiNER default
10000 ms (`src/gliner.ts:31,73`). No retry (V-08), no circuit breaker (V-09),
no client-side semaphore, unbounded `asyncio.to_thread` fan-out server-side
(V-16). `HealthWatch` polls every 10 s (`src/health.ts:21`,
`src/index.ts:87-92`), logs only on change (`src/health.ts:50-58`), and exposes
the last status synchronously (`src/health.ts:39-41`). Cold start races live
here: initial status is `{ready:false, "not checked yet"}` (`src/health.ts:15`)
while `poll()` is async (`src/health.ts:25-30`), so early `tools/list` and even
direct `tools/call` race readiness (V-15).

## Security

Transport: both servers default-bind `127.0.0.1:8765/:8766`
(`py/laya_server.py:259-260`, `py/gliner_server.py:261-262`; `install.sh:29-32`),
so permissive CORS is loopback-scoped, not internet-exposed
(`py/laya_server.py:161-167`). No auth layer exists (local-only design; not
reproduced as an issue). Prompt-injection screening (`src/tools/screen.ts`) and
PII scanning (`src/tools/pii.ts`) are advisory judgments, and both have P0 gaps
(V-01, V-03). No payload bodies are logged: TS logs only a startup banner
(`src/index.ts:164-169`) and ready/down transitions (`src/health.ts:53-56`);
Python logs load/startup lines only (`py/laya_server.py:73-94,261`,
`py/gliner_server.py:89-93,263`) — the alleged PII-in-logs leak did not
reproduce. `SECRET_TYPES` gating (`api_key`, `token_secreto`, `password`) is a
hardcoded client-side set with no confidence floor (`src/tools/pii.ts:28`).
`snapshot_download` pins no `revision`, so checkpoint bytes can drift under the
same id (V-24).

## Laya Semantics

Answer types used: `noul` (screen/verify/rerank/decide-requirements/review-gate
safety/claims), `choice` (find/rerank-n/a/classify/decide/compare/extract),
`score` 0–2 (review/gate rubrics). `PredictResult.confidence` is populated
server-side (`py/laya_server.py:238-242`) but no TS handler reads
`raw.confidence` — every handler recomputes its own number from
`answers[...].noul` or `max(probabilities)` (`src/tools/*.ts` handlers; e.g.
`src/tools/classify.ts:65`, `src/tools/extract.ts:187`). Thresholds are magic
numbers dispersed per tool: screen 0.75/0.25/0.4 (`src/tools/screen.ts:59`),
verify/gate 0.8/0.4 (`src/tools/verify.ts:49`, `src/tools/gate.ts:70`), review
0.85/0.5 (`src/tools/review.ts:64`). "Calibrated" (`README.md:15,33-43,166`)
has no harness in-repo: no calibration test, no threshold-sweep, no accuracy
job; the 0.766 typed-decisions figure is asserted in docs/diagram
(`README.md:181,313`) without a reproducing evaluation. Abstention is partial:
`none`/`other`/`not_found` exist in find/classify/extract, but
verify/decide/review/gate/screen always emit a verdict (V-23).

## GLiNER Integration

Composition rule "GLiNER proposes, Laya disposes" (`README.md:42-43,203-221`):
spans locate, Laya judges. `extractEntities(text, labels)` maps
`/extract_entities` to `spansByType` (`src/gliner.ts:107-120`); `piiScan`
forwards `{text, extra_types}` (`src/gliner.ts:122-136`); `classify()` wraps
`/classify` but has zero call sites (V-22, `src/gliner.ts:138-141`). Entity
candidates are embedded as `text [start:end] (type, gliner_conf=0.XX)` strings
(`src/tools/extract.ts:110-111`) and resolved back through a local `spanIndex`
(`src/tools/extract.ts:101-124,192-199`), so winning offsets are always
grounded substrings. `source=entities` with the sidecar down throws a clear
actionable error (`src/tools/extract.ts:156-162`); `source=auto` falls back to
regex with a note (`src/tools/extract.ts:152-165,216`). GLiNER confidence is
displayed and stored (`gliner_confidence`, `src/tools/extract.ts:199`) but
never gates anything; PII ignores it entirely (V-03).

## OpenCode Integration

Native V2 shape `mcp.servers.laya` is required (names directly under `mcp` are
ignored, `README.md:140-143`); snippet at `examples/opencode.snippet.json:1-15`
(absolute path required, `tests/test_opencode_v2.py:64-74`). Doctor resolves
config via `OPENCODE_JSON` → `OPENCODE_CONFIG_DIR/opencode.json` →
`~/.config/opencode/opencode.json` (`py/doctor.py:559-571`) and accepts legacy
V1 `mcp.laya` / `enabled` with a pass (`py/doctor.py:574-597`); 9 unit tests
cover registered/disabled/legacy/missing/non-ASCII/dir-resolution
(`tests/test_opencode_v2.py:64-146`, all OK per
`artifacts/baseline/tests.txt:8-22`). Doctor `opencode-config` passed in this
environment against the separate install's config
(`artifacts/baseline/doctor.txt:29,38-40`). `check_mcp_server_starts` spawns
`dist/index.js` with an unreachable `LAYA_URL` and treats boot-then-kill as
success (`py/doctor.py:528-556`).

## Gentle AI Integration

Two opt-in surfaces, both off by default (`examples/gentle-ai-integration.md:7`):
(1) `scripts/apply-orchestrator-policy.sh` installs/refreshes/removes/checks a
marker-delimited policy block (`<!-- laya-mcp:orchestrator-policy -->`,
`scripts/apply-orchestrator-policy.sh:40-41`) anchored on Gentle-AI's own
`sdd-model-assignments` marker, refusing to guess when the anchor moved
(`scripts/apply-orchestrator-policy.sh:99-101`), with timestamped backup before
writes (`scripts/apply-orchestrator-policy.sh:90-91`) and V1/V2 prompt-shape
handling (`scripts/apply-orchestrator-policy.sh:58-77`); (2) five documented
call patterns in `examples/gentle-ai-integration.md` (sdd-apply→review,
issues→classify ≥0.85, screen guardrail, PII pre-screen, grounded extraction).
The policy block itself (`examples/gentle-orchestrator-policy.md:1-53`) routes
each tool and encodes standing rules (never invent results, honor returned
`action`, escalate low confidence). Two policy claims exceed the code and are
tracked as discrepancies: `ask_user` escape hatches
(`examples/gentle-orchestrator-policy.md:40`, V-12) and the `allow` vocabulary
(`src/tools/screen.ts:8` vs `:59`, V-01). No Policy Engine code exists in-repo;
the "policy" is a markdown block edited into the host config.

## Verified Problems

Format per item: Problem / Exists / Severity / File / Line / Evidence /
Impact / Recommended change / Dependencies / Regression risk.

V-01 — screen action vocabulary mismatch (`allow` documented, `pass` emitted),
plus evidence/authority mixing.
Exists: yes. Severity: P0. File: `src/tools/screen.ts`. Lines: 8, 59.
Evidence: description promises `allow/review/block/skip` (`:8`) but the handler
emits `pass` (`:59`); policy/docs branch on `pass/block/skip`
(`examples/gentle-orchestrator-policy.md:18-20,48`). Impact: orchestrator
consumers matching `allow` never match; authority signal (`is_relevant`)
mixes into a safety verdict. Recommended change: rename to one vocabulary
(`pass`) across description, policy doc, and integration guide; or map
`pass→allow` at presentation with a test. Dependencies: V-17 (thresholds),
policy doc. Regression risk: low — string-level, covered by adding a
vocabulary assertion test.

V-02 — gate drops `test_gap`/`blast_radius` despite "same rubric as review"
plus optional evidence.
Exists: yes. Severity: P0. File: `src/tools/gate.ts`. Lines: 7-9, 28-61;
compare `src/tools/review.ts:20-49`.
Evidence: description claims "same rubric" (`:7`) but builders omit both
questions; `evidence` is not in `required` (`:25`). Impact: completion gate is
weaker than advertised; claims verified against empty evidence default to
`noul ?? 0` → `contradicted` noise or false assurance. Recommended change: add
both score questions, require `evidence` when `claims` is non-empty.
Dependencies: V-17, V-23. Regression risk: medium — output shape grows; pin
golden tests first.

V-03 — PII gating on hardcoded types with no confidence floor, GLiNER-only.
Exists: yes. Severity: P0. File: `src/tools/pii.ts`. Lines: 28, 44-47;
backend `py/gliner_server.py:43-50`.
Evidence: `SECRET_TYPES = {api_key, token_secreto, password}` (`:28`); any
single span flips `pass→review→block` (`:46-47`) regardless of `confidence`.
Impact: false blocks on low-confidence spans; missed secret phrasings outside
three labels pass silently. Recommended change: per-type confidence floor +
count floor for `block`; document residual risk. Dependencies: GLiNER
threshold calibration data. Regression risk: medium — tuning shifts block
rate; measure on the Spanish smoke sentence first.

V-04 — extract silently caps candidates at 20 per field (both paths).
Exists: yes. Severity: P0. File: `src/tools/extract.ts`. Lines: 63, 108.
Evidence: `.slice(0, 20)` in `regexCandidates` (`:63`) and span indexing
(`:108`); neither `fallback` nor output mentions truncation. Impact: silent
recall loss; the true value beyond rank 20 can never win. Recommended change:
emit `truncated: true` + counts when capped; or page fields. Dependencies:
none. Regression risk: low — additive output field.

V-05 — invalid regex silently yields zero candidates (`[]`).
Exists: yes. Severity: P0. File: `src/tools/extract.ts`. Lines: 60-67.
Evidence: `catch { return []; }` (`:64-66`) feeds a `choice` among `{none}`,
so a typo'd pattern reads as "not_found" instead of a caller error. Impact:
masks caller bugs as grounded negatives. Recommended change: throw a
caller-error naming the field id and pattern. Dependencies: none. Regression
risk: low — converts silent negative into loud error; update smoke
expectations.

V-06 — `runTool` performs no validation and forwards `timeoutMs=undefined`.
Exists: yes. Severity: P1. File: `src/tool.ts`. Line: 46; consumer
`src/client.ts:103-110`.
Evidence: `client.predict(args, questions, undefined, opts)` — the positional
timeout is hardcoded `undefined`, so per-tool overrides are impossible and
`questions` shape is never checked. Impact: malformed payloads reach the
server; timeout tuning requires env-only control. Recommended change: validate
`questions` non-empty pre-call; thread an explicit `timeoutMs` parameter.
Dependencies: V-07. Regression risk: low.

V-07 — `LAYA_TOOL_TIMEOUT_MS` is declared but never enforced.
Exists: yes. Severity: P1. Files: `src/index.ts`. Lines: 44, 168.
Evidence: constant parsed (`:44`) and printed in the banner (`:168`) but never
passed to any handler or `predict`. Impact: operators believe a per-tool
8 s budget exists; effective budget is `LAYA_TIMEOUT_MS` 5000 ms
(`src/client.ts:62`). Recommended change: enforce as the default `timeoutMs`
for all Laya-backed handlers or delete the variable and banner field.
Dependencies: V-06. Regression risk: low-medium — changes effective timeouts;
announce as breaking if enforced.

V-08 — no retry on transient failures.
Exists: yes. Severity: P1. File: `src/client.ts`. Lines: 112-123.
Evidence: single `fetch`; any throw maps to `BackendUnavailableError` with no
retry counter, backoff, or idempotency note. Impact: one slow/flaky `/predict`
fails the whole tool call. Recommended change: one bounded retry (read-only
`noul`/`choice`/`score` calls are idempotent) with jitter; document in output.
Dependencies: V-09, V-16. Regression risk: medium — added latency tail.

V-09 — no circuit breaker / bulkhead around backends.
Exists: yes. Severity: P1. Files: `src/client.ts`, `src/gliner.ts`,
`src/health.ts`.
Evidence: every handler awaits a fresh `fetch` even while the watcher reports
DOWN; no open/half-open state gates calls. Impact: thundering calls against a
recovering Python process; slow cascades into the agent. Recommended change:
fail fast while `health.current().ready === false` with the existing hint
(`src/index.ts:148-150`). Dependencies: V-15. Regression risk: low.

V-10 — `find` has no candidate cap ("up to 250" unenforced) plus silent
240-char truncation.
Exists: yes. Severity: P1. File: `src/tools/find.ts`. Lines: 8, 30-36.
Evidence: description claims "up to 250 candidates" (`:8`); builder loops all
candidates with no length check while slicing each text to 240 chars (`:34`)
silently. Impact: oversized payloads to `/predict`; truncated bodies judged as
whole. Recommended change: enforce `maxItems: 250` in schema + warn/truncate
flag. Dependencies: V-04 (shared truncation policy). Regression risk: low.

V-11 — `rerank` duplicate-id key collision, no cap, order-unstable sort.
Exists: yes. Severity: P1. File: `src/tools/rerank.ts`. Lines: 26-55.
Evidence: keys are `relevance_${i}_${c.id}` but results are read back by the
same composite key while `scored` maps over raw `candidates` — duplicate ids
produce ambiguous pairs; no length cap; `.sort((a,b) => b.relevance -
a.relevance)` (`:54`) has no tiebreak. Impact: nondeterministic ranks on ties;
duplicate ids corrupt attribution. Recommended change: dedupe-or-reject
duplicate ids; cap with notice; tiebreak by index. Dependencies: none.
Regression risk: low.

V-12 — `decide` promises `ask_user` escape hatches with zero code; 2–6 bound
lives only in JSON schema.
Exists: yes. Severity: P1. Files: `src/tools/decide.ts`,
`examples/gentle-orchestrator-policy.md`. Lines: 16-17 (`minItems`/`maxItems`),
policy `:40`.
Evidence: grep for `ask_user` over `src/` returns 0 hits; bounds are schema
hints, never checked in `buildQuestions`/handler (`:33-60`). Impact:
orchestrator honors hatches that never arrive; oversized candidate lists pass
through. Recommended change: remove `ask_user` from policy or implement a
real low-margin escape verdict; validate bounds in code. Dependencies: V-23.
Regression risk: low.

V-13 — `/health` hot-loads models on the readiness path.
Exists: yes. Severity: P1. File: `py/laya_server.py`. Lines: 107-121;
watcher `src/health.ts:49`.
Evidence: `health()` calls `_ensure()` (`:109`), which constructs the full
`Router` synchronously (`:82-88`); the TS watcher probes with a 2000 ms budget
(`src/health.ts:49`). Impact: first probes time out during multi-minute loads;
readiness flaps; `/health` latency is load latency. Recommended change: load
once at startup (or background thread) and make `/health` a cheap flag read.
Dependencies: V-14, V-21. Regression risk: medium — startup behavior change.

V-14 — `_load_error` poisons both holders until process restart.
Exists: yes. Severity: P1. Files: `py/laya_server.py:68-69,95-98`,
`py/gliner_server.py:83-84,94-97`.
Evidence: first exception cached and re-raised on every later call; no reset
endpoint, no retry-after. Impact: one transient failure (e.g. HF hub blip)
permanently wedges the server. Recommended change: retry with backoff +
`/reload` or error TTL. Dependencies: V-13. Regression risk: low-medium.

V-15 — ListTools/handler readiness race; cold start advertises nothing while
calls can still run.
Exists: yes. Severity: P1. Files: `src/index.ts:104-109`, `src/health.ts:15,25-30`.
Evidence: initial status `{ready:false}` (`src/health.ts:15`); `ListTools`
gates on it but `CallTool` does not recheck — a call during warmup hits the
backend directly. Impact: flapping tool surface on (re)start; calls fail while
listing says empty and vice versa. Recommended change: gate `CallTool` on the
same readiness flag with the standard hint, or document the race. Dependencies:
V-09. Regression risk: low.

V-16 — unbounded concurrency both layers.
Exists: yes. Severity: P1. Files: `src/client.ts`, `src/gliner.ts`,
`py/laya_server.py:227-231`.
Evidence: no semaphore/queue/limit in TS; each `/predict` spawns an unbounded
`asyncio.to_thread`. Impact: candidate-fan-out tools (rerank N×`noul`,
verify N claims) can saturate the event loop / thread pool / VRAM-adjacent
memory. Recommended change: bound TS fan-out (one in-flight `/predict` per
tool call is already the case — bound concurrent tool calls instead) and cap
server workers. Dependencies: V-08. Regression risk: medium — throughput
trade-off.

V-17 — verdict bins use magic cutoffs with no calibration harness.
Exists: yes. Severity: P2. Files: `src/tools/verify.ts:49`,
`src/tools/gate.ts:70`, `src/tools/screen.ts:59`.
Evidence: `≥0.8/≥0.4` (verify/gate), `0.75/0.25/0.4` (screen) inline; no test
or doc derives them; "calibrated" asserted (`README.md:15,166`) without a
sweep. Impact: thresholds look scientific but are arbitrary; drift in the
checkpoints silently invalidates them. Recommended change: centralize
thresholds + record the harness gap as tech debt (no new metrics per scope).
Dependencies: evaluation story (V-27 seasoning). Regression risk: low
(centralize only; do not retune here).

V-18 — `classify`/`extract` confidence is `max(probabilities)`, not winner mass.
Exists: yes. Severity: P2. Files: `src/tools/classify.ts:65`,
`src/tools/extract.ts:187`.
Evidence: `Math.max(...Object.values(ans.probabilities ?? {}))` — equals the
winner only under normalization; otherwise overstates. Impact: auto-apply at
≥0.85 (`examples/gentle-ai-integration.md:47`,
`examples/gentle-orchestrator-policy.md:35`) fires on inflated numbers.
Recommended change: report winner's probability as `confidence` plus full map.
Dependencies: none. Regression risk: low — output widens, values drop
honestly; flag as breaking for ≥0.85 consumers.

V-19 — `review` action cutoffs (0.85/0.5) are magic and coarse.
Exists: yes. Severity: P2. File: `src/tools/review.ts`. Line: 64.
Evidence: `> 0.85 ? "auto" : > 0.5 ? "review" : "escalate"` inline; `tests`
input is accepted by schema (`:15`) but never sent to any question.
Impact: `tests` evidence is decorative; auto-merge advice rests on one `noul`
number. Recommended change: wire `tests` into the `safe_to_apply`
instructions; centralize cutoffs. Dependencies: V-17. Regression risk: low.

V-20 — tool outputs lack `structuredContent` (untyped JSON-in-text only).
Exists: yes. Severity: P2. File: `src/index.ts`. Lines: 135-136.
Evidence: every success is `content: [{type:"text", text: <JSON>}]`; grep for
`structuredContent` over the repo returns 0 hits. Impact: agents must
string-parse; no schema validation host-side. Recommended change: add
`structuredContent` alongside text (dual-emit) when the SDK/host allows.
Dependencies: SDK version (`@modelcontextprotocol/sdk@1.30.0` per
`artifacts/baseline/build.txt:11-12`). Regression risk: low (additive).

V-21 — `/ready` exists on both servers but no TS consumer uses it.
Exists: yes. Severity: P2. Files: `py/laya_server.py:176-182`,
`py/gliner_server.py:165-170`, `src/health.ts`, `src/client.ts:65-101`.
Evidence: watcher polls `/health` only (`src/client.ts:69`,
`src/gliner.ts:38`); `/ready` (cheap 200/503) is unreferenced in `src/`.
Impact: readiness stays coupled to the hot-loading `/health` (V-13).
Recommended change: poll `/ready` for advertisement, `/health` for detail.
Dependencies: V-13. Regression risk: low.

V-22 — `GlinerClient.classify()` wraps `/classify` with zero call sites.
Exists: yes. Severity: P2. File: `src/gliner.ts`. Lines: 138-141.
Evidence: defined; no importer in `src/tools/*` or `src/index.ts`.
Impact: dead surface suggesting a classification path that does not exist;
`/classify` server route equally unexercised end-to-end here. Recommended
change: delete or wire to a real tool; cover with the Spanish smoke test.
Dependencies: none. Regression risk: none (deletion of dead code) — or
low if wired.

V-23 — abstention is partial: five tools always emit a verdict.
Exists: yes. Severity: P2. Files: `src/tools/verify.ts:49`,
`src/tools/decide.ts:62-77`, `src/tools/review.ts:64`,
`src/tools/gate.ts:74`, `src/tools/screen.ts:59`.
Evidence: `other`/`none`/`not_found` exist only in classify/find/extract;
verify/decide/review/gate/screen map every probability to a verdict with no
`abstain` band. Impact: low-confidence outputs read as decisions; policy's
"escalate low-confidence outcomes" rule
(`examples/gentle-orchestrator-policy.md:47-52`) has nothing to key on.
Recommended change: add a documented low-confidence band returning
`review`/`unsupported` explicitly. Dependencies: V-17. Regression risk:
medium — verdict distribution shifts; golden-test first.

V-24 — model downloads pin no `revision`; responses carry no model revision.
Exists: yes. Severity: P3. File: `py/download_models.py`. Lines: 48-80.
Evidence: `snapshot_download(repo_id, allow_patterns, ...)` with no `revision`
(`:76-80`); `/predict` echoes `routing` but never a snapshot rev
(`py/laya_server.py:243-253`); doctor reports sizes/paths, not revs
(`py/doctor.py:157-171`). Impact: bytes drift under identical ids;
audits cannot reproduce exact weights. Recommended change: pin `revision` in
download + echo it in `routing`/`/health`. Dependencies: none. Regression
risk: low.

V-25 — observability is banner/transitions/`latency_ms` only; zero metrics.
Exists: yes. Severity: P3. Files: `src/index.ts:164-169`,
`src/health.ts:53-56`, `src/client.ts:144`.
Evidence: only startup banner, ready/down transitions, and per-call
`latency_ms`; no counters, histograms, or structured logs. Impact: threshold
tuning (V-17) and capacity calls (V-16) fly blind in production. Recommended
change: none in this phase per scope (no new metrics); record as P3 debt.
Dependencies: none. Regression risk: none (deferred).

V-26 — reproducibility evidence is limited to the `routing` echo in extract.
Exists: yes. Severity: P3. File: `src/tools/extract.ts`. Lines: 211-218.
Evidence: only extract surfaces `raw.routing`; all other tools return
`latency_ms` without model/checkpoint identity. Impact: judgments are not
attributable to a checkpoint except in one tool. Recommended change: echo
`model`+`routing` in every tool response (extract already proves the shape).
Dependencies: V-24. Regression risk: low (additive fields).

V-27 — `py/workflows.py` diverges from the TS builders and is dead at runtime.
Exists: yes. Severity: P3. File: `py/workflows.py`. Lines: 27-244.
Evidence: `find_questions` builds `noul` (`:66-80`) while TS sends `choice`
(`src/tools/find.ts:37-43`); `screen` relevance reuses injection criteria
(`:47`); only consumer is `tests/smoke.py:24` builder-shape checks.
Impact: parallel truth rots; smoke tests validate payloads the server never
sends. Recommended change: delete the module and assert TS-built payloads in
smoke, or generate one side from the other. Dependencies: `tests/smoke.py`.
Regression risk: low (test-only blast radius).

## Problems Not Reproduced

Four alleged issues were checked against code and live behavior and did NOT
reproduce (each was verified, not assumed):

1. Crash with backend down. `tools/list` → `tools: []` (exit 0, 0.23 s,
`artifacts/baseline/tests.txt:46-54`) and `CallTool` → `isError: true` with
recovery hint (`src/index.ts:137-158`); `tools: []` is the documented contract
(`src/index.ts:11-13`). Degradation is correct.
2. PII leakage into logs. No payload or span text is logged anywhere: TS logs
banner + transitions only (`src/index.ts:164-169`, `src/health.ts:53-56`);
Python logs load/startup only (`py/laya_server.py:73-94`,
`py/gliner_server.py:89-93`). Claim rejected on evidence.
3. Exposed auth / network surface. Both servers bind `127.0.0.1` by default
(`py/laya_server.py:259-260`, `py/gliner_server.py:261-262`); CORS `*` is
loopback-scoped. No remotely reachable auth surface exists to exploit.
4. Broken `test_*.sh` scripts. `tests/test_tools_offline.sh:1-30` and
`tests/test_health.sh:1-43` are sound bash; the failure is environmental (no
bash on this Windows host, `artifacts/baseline/tests.txt:39-44`). The native
PowerShell equivalent of the offline expectation passed
(`artifacts/baseline/tests.txt:46-54`). Not a repo bug.

## Recommended Implementation Order

Explicitly NOT done in this phase (scope, `odd/tasks/fase-1-baseline-audit.md:18-19`):
no Policy Engine, no policies, no shadow mode, no new metrics, no new schemas,
no new MCP tools, no CUA-MCP, no large refactors. The only mutations performed
were: `artifacts/baseline/*` (6 files), `npm install` side effects
(`node_modules/`, `package-lock.json`), generated `dist/`, this `AUDIT.md`,
and ODD working files under `odd/tasks/*`.

P0 first (safety/silence): V-01 vocabulary → V-02 gate parity → V-03 PII
floors → V-04/V-05 extract silence. Each is small, testable, and unblocks
trust in guardrail outputs.
P1 next (contracts/availability): V-06/V-07 timeout truth → V-15 readiness
gating → V-13/V-14 load path → V-21 `/ready` adoption → V-08/V-09/V-16
resilience → V-10/V-11 caps → V-12 decide honesty.
P2 after (semantics): V-17 centralize thresholds → V-18 winner-confidence →
V-19 wire `tests` → V-23 abstention band → V-20 `structuredContent` →
V-22 dead classify.
P3 last (hygiene): V-24 revision pins → V-26 routing echo everywhere →
V-25 metrics (out of scope until authorized) → V-27 kill or generate
`workflows.py`.
Suggested work-unit split: one slice per P0 item; one slice per P1 pair;
one slice for P2 semantics; one for P3 hygiene. Re-run `npm run typecheck`
(1.25 s), `npm run build` (1.30 s), `python -m unittest
tests.test_opencode_v2` (0.13 s), and `EXPECT_PII=0 node tests/mcp_smoke.mjs`
against live backends before/after each slice.

## Breaking Changes

Enforcing `LAYA_TOOL_TIMEOUT_MS` (V-07) changes effective per-call budgets
(5000 ms → 8000 ms) — announce before flipping. Gate parity (V-02) widens
`laya_gate` output (`test_gap`, `blast_radius`, required `evidence`) — old
parsers must tolerate new keys. Winner-confidence (V-18) lowers reported
numbers — any `>= 0.85` auto-apply consumer will fire less often (intended).
Abstention band (V-23) shifts verdict distributions — golden-test verdict
snapshots will change. Invalid-regex loud errors (V-05) turn former
`not_found` results into tool errors — callers must handle them. Capping
`find` at 250 (V-10) rejects payloads accepted today. `structuredContent`
dual-emit (V-20) is additive but hosts may prefer it over text — verify host
behavior. Deleting `py/workflows.py` (V-27) breaks `tests/smoke.py` imports
unless the smoke test is migrated in the same slice.

## Risks

Retuning thresholds without a harness (V-17) replaces arbitrary numbers with
different arbitrary numbers — centralize first, tune only with live eval data.
PII floors (V-03) trade false blocks against missed secrets; measure on the
Spanish smoke sentence (`py/doctor.py:388-391`) before shipping. Retry (V-08)
without a breaker (V-09) can amplify load on a recovering server — ship gating
first. Bounding concurrency (V-16) trades p99 latency for throughput; load-test
rerank fan-out. Hot-load fixes (V-13/V-14) change startup semantics; keep the
lazy-boot property the offline contract depends on
(`artifacts/baseline/tests.txt:46-54`). Revision pins (V-24) freeze weights
operators may currently rely on drifting — coordinate with model consumers.
Documentation edits (V-01/V-12 policy wording) must stay in sync across
`README.md`, tool descriptions, policy block, and integration guide or the
discrepancy class re-grows.

## Open Questions

1. What is the intended effective timeout: 5000 ms (`LAYA_TIMEOUT_MS`,
`src/client.ts:62`) or 8000 ms (`LAYA_TOOL_TIMEOUT_MS`, `src/index.ts:44`)?
2. Is one bounded retry acceptable for idempotent judgments, and should
`safe_to_apply` advice be excluded from retry?
3. What per-type confidence and count floors should govern `laya_pii`
`block`, and who owns the calibration set?
4. Should `laya_gate` require `evidence` whenever `claims` is non-empty, and
is "same rubric as review" (`src/tools/gate.ts:7`) a hard contract?
5. Is `py/workflows.py` a spec to generate from, or dead code to delete —
and should smoke tests assert TS-built payloads instead?
6. Should readiness move to `/ready` polling with `/health` as detail, and
should `CallTool` fail fast while not-ready?

### Prompt-vs-code discrepancies

| # | Prompt/doc claim | Observed reality | Evidence |
|---|---|---|---|
| D-1 | `laya_screen` returns `allow` | handler emits `pass` | `src/tools/screen.ts:8` vs `:59` |
| D-2 | `laya_decide` honors `ask_user` hatches | 0 hits in `src/`; bounds schema-only | `src/tools/decide.ts:16-17`; `examples/gentle-orchestrator-policy.md:40` |
| D-3 | routing is universal | only `laya_extract` echoes `routing` | `src/tools/extract.ts:211-218` vs all other handlers |
| D-4 | `laya_find` handles "up to 250" | no cap enforced; silent 240-char cut | `src/tools/find.ts:8` vs `:30-36` |
| D-5 | `laya_gate` uses "same rubric" as review | `test_gap`/`blast_radius` missing; evidence optional | `src/tools/gate.ts:7-9,25-61` vs `src/tools/review.ts:20-49` |
| D-6 | `py/workflows.py` mirrors tool payloads | divergent and runtime-dead (find `noul` vs `choice`) | `py/workflows.py:66-80` vs `src/tools/find.ts:37-43`; sole consumer `tests/smoke.py:24` |

### Completion criteria

| Acceptance criterion (`odd/tasks/fase-1-baseline-audit.md:30-38`) | Status |
|---|---|
| Baseline run with command/result/duration/errors/warnings | done — Baseline section + `artifacts/baseline/*.txt` |
| Public contracts inventoried (MCP/HTTP/CLI/config) | done — Public Contracts section |
| Real (not assumed) architecture documented | done — Architecture section |
| 10 `laya_*` tools analyzed + extra `laya_pii` | done — MCP Tools section (11 rows) |
| Proposed problems verified in required format + P0–P3 | done — 27 items, 5 P0 / 11 P1 / 7 P2 / 4 P3 |
| AUDIT.md with the required sections | done — 19 headings in mandated order (see readback) |
| Prompt-vs-code discrepancies documented | done — table D-1…D-6 above |
| Recommended order + breaking changes + risks + open questions | done — four closing sections, 6 questions |
