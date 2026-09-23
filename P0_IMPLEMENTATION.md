# P0 Backend Robustness — Implementation Log (Fase 2)

Branch: `odd/fase-2-p0-backend` over `cb70301` (main). Scope is P0 inference-backend
robustness only: liveness/readiness probes, load retry/backoff/recovery, concurrency
bounds, configurable input limits, real-behavior tests. No Policy Engine, no shadow
mode, no eval harness, no CUA, no new verify/screen/PII semantics.

All "before" citations refer to pre-change `cb70301`, verified with
`git show cb70301:<file>` during T8. All "after" citations refer to the working
tree at `80b33a6` plus the T8 docs commit.

## 1. Problems found (re-verified against code, not assumed from AUDIT.md)

- **P1 — No `/live`, no `/models`.** Before: `py/laya_server.py@cb70301` exposed
  only `@app.get("/health")` (:170), `@app.get("/ready")` (:176),
  `@app.get("/doctor")` (:185), `@app.post("/predict")` (:215);
  `py/gliner_server.py@cb70301` exposed only `/health` (:159), `/ready` (:165),
  `/extract_entities` (:173), `/classify` (:196), `/pii_scan` (:213). No
  liveness probe, no model inventory, no reload on either server.
- **P2 — `/ready` warmed models and hid structure.** Before: laya
  `ready()` (`py/laya_server.py@cb70301:176-184`) called `router.health()`,
  which lazy-loads the backend, and answered 503 with unstructured
  `detail=info` and no `Retry-After` header. The TS `HealthWatch`
  (`src/health.ts@cb70301`) polled the warming `/health`; no TS caller used
  `/ready` or `/live` (neither client had such methods).
- **P3 — Permanent load failure until restart.** Before:
  `RouterHolder._load_error` (`py/laya_server.py@cb70301`) was set once on
  construction failure and raised on every later call. No retry, no backoff,
  no circuit breaker, no TTL expiry, no operator reset.
- **P4 — No concurrency guards.** Before: the only concurrency primitive in
  `py/laya_server.py@cb70301` was one bare `asyncio.to_thread` (:227). No
  single-flight on load (double construction possible), no bound on
  concurrent inference. `LAYA_TOOL_TIMEOUT_MS` existed as an env name but
  `runTool` (`src/tool.ts@cb70301`) called
  `client.predict(args, questions, undefined, opts)` — timeout `undefined`,
  so the tool timeout was never enforced.
- **P5 — Phantom/partial limits.** Before: `src/tools/find.ts@cb70301`
  advertised "up to 250 candidates" while iterating every candidate with no
  check; `src/tools/rerank.ts@cb70301` advertised "(truncated to 2,000 chars
  internally)" with zero truncating code (description was the only match);
  `py/laya_server.py@cb70301` contained no `413`, no `input_too_large`, no
  `_InputTooLarge`. Over-limit payloads were silently accepted (or silently
  sliced, e.g. `extract`'s `slice(0, 20)` in `src/tools/extract.ts@cb70301`).
- **P6 (T7 gaps) — Uncovered §5 behaviors.** Readiness-after-load shape,
  no-duplicate-loading across inferences, inference-time model failure, and
  mixed laya+gliner concurrent inference had no tests (verified by grep
  before writing T7 tests).

## 2. Changes made

**T3 — Endpoints (`b241568`).** Both servers: `GET /live` (immediate, never
touches holders; `py/laya_server.py:675`, `py/gliner_server.py:697`),
structured `GET /ready` (non-warming snapshot, 200 or 503 with
`{ready, reason, loaded, failed, device, versions, uptime_seconds, circuit,
load_attempts, retry_after_seconds}` + `Retry-After` header;
`py/laya_server.py:699`, `py/gliner_server.py:721`), `GET /models` (always
200, per-model `{name, loaded, revision, revision_source, device}`;
`py/laya_server.py:715`, `py/gliner_server.py:737`). `/health` kept as
legacy (documented warming; `py/laya_server.py:689`). TS clients gained
`live()`/`ready()`/`models()` (`src/client.ts:167,189,211` and
`src/gliner.ts`); no caller migrated yet in T3.

**T4 — Load recovery (`cfed3ef`).** Both holders replaced permanent
`_load_error` with failure tracking `{error, at, attempts}`, exponential
backoff with jitter computed from `LAYA_/GLINER_LOAD_RETRY_BASE_S=1.0`,
`_FACTOR=2.0`, `_CAP_S=60.0`, `_MAX=5` (`py/laya_server.py:96-125`,
`py/gliner_server.py:101-130`): fail-fast inside the window, no sleep or
loop in the request path. Circuit closed→open after
`_CIRCUIT_THRESHOLD=3` consecutive failures, half-open probe after
`_CIRCUIT_COOLDOWN_S=30.0`, cached-error TTL
`_LOAD_ERROR_TTL_S=300.0`, clear-on-success. `POST /reload`
(`py/laya_server.py:728`, `py/gliner_server.py:750`) is operational and
non-destructive (clears tracking, never unloads a healthy backend). TS
`HealthWatch` migrated from warming `/health` to `live()`+`ready()`
(`src/health.ts:4-18,58-70`; 10 s interval, 2 s per-probe timeout).

**T5 — Concurrency (`b7d20b3`).** Per-holder (never cross-model global):
threading `Lock` single-flight for sync ensure, `asyncio.Lock`
single-flight for `ensure_async` (`py/laya_server.py:420`), and an
`asyncio.Semaphore` bounding concurrent inference
(`py/laya_server.py:432-447`, sized from `LAYA_MAX_INFLIGHT`, default 3 =
checkpoint count; `py/gliner_server.py:442-450`, `GLINER_MAX_INFLIGHT`
default 4) with immediate structured 503 + `Retry-After` on saturation
instead of unbounded queueing. All inference endpoints route through
`ensure_async` + `run_bounded` (`py/laya_server.py:785-790`).
`LAYA_TOOL_TIMEOUT_MS` (8000) now enforced in `runTool`
(`src/tool.ts:38-53`; explicit `opts.timeoutMs` still wins).

**T6 — Limits (`5f8dd23`).** Python size validators on all request models:
`/predict` guards `LAYA_LIMITS_MAX_STATE_CHARS=20000`,
`_MAX_QUESTIONS=64`, `_MAX_BODY_CHARS=100000`
(`py/laya_server.py:160-170`); sidecar guards
`GLINER_LIMITS_MAX_TEXT_CHARS=50000`, `_MAX_LABELS=64`, `_MAX_TASKS=32`,
`_MAX_EXTRA_TYPES=32`, `_MAX_BODY_CHARS=100000`
(`py/gliner_server.py:174-178`). Over-limit answers structured 413
`{code:"input_too_large", field, limit, actual, hint}`, no `Retry-After`
(`py/laya_server.py:173-199`). TS `src/limits.ts:1-88` mirrors server
defaults for fail-fast builders with the same vocabulary (`find` ≤ 250 now
enforced; `decide` 2–6 options + ≤ 32 requirements; `rerank` 2000-char
truncation made real with `truncated`/`truncated_ids`; `classify` ≤ 64;
`extract` 20-cap surfaced via `truncated`/`dropped`; `verify`/`screen`/
`review`/`gate`/`compare`/`pii` early checks). Tool descriptions and JSON
schemas corrected where the code made them real.

**T7 — Coverage + perf (`80b33a6`).** `tests/test_p0_t7_gaps.py`, 8 tests
for the §5 gaps (readiness-after-load, no-duplicate-loading,
inference-time failure, mixed concurrent inference) plus host perf
absolutes (see §5).

**T8 — No-regression + docs (this commit).** Full battery vs
`artifacts/baseline/*.txt` (see §4, all equal or better, zero test
weakening); `README.md` gained the backend probes/reload/limits section
and the new env rows; this file.

## 3. Modified files (per commit/slice)

- T3 `b241568` feat(backend), +442/-12: `py/laya_server.py`,
  `py/gliner_server.py`, `src/client.ts`, `src/gliner.ts`, `src/health.ts`
  (comment-only), `src/index.ts` (comment-only).
- T4 `cfed3ef` feat(backend), +595/-86: `py/laya_server.py`,
  `py/gliner_server.py`, `src/client.ts`, `src/gliner.ts`, `src/health.ts`,
  `src/index.ts`.
- T5 `b7d20b3` feat(backend), +746/-27: `py/laya_server.py`,
  `py/gliner_server.py`, `src/index.ts`, `src/tool.ts`,
  `tests/test_p0_t4t5_robustness.py` (new, 14 tests).
- T6 `5f8dd23` feat(backend), +1120/-48: `py/laya_server.py`,
  `py/gliner_server.py`, `src/limits.ts` (new), `src/tools/classify.ts`,
  `compare.ts`, `decide.ts`, `extract.ts`, `find.ts`, `gate.ts`, `pii.ts`,
  `rerank.ts`, `review.ts`, `screen.ts`, `verify.ts`,
  `tests/test_p0_t6_limits.py` (new, 11 tests), `tests/t6_limits.mjs`
  (new, 16 checks).
- T7 `80b33a6` test(backend), +337: `tests/test_p0_t7_gaps.py` (new, 8 tests).
- T8 (this commit) docs(backend): `README.md`, `P0_IMPLEMENTATION.md`. No
  functional code changed in T8.

## 4. Tests (coverage per file + counts; total 42/42 + 16/16)

- `tests/test_opencode_v2.py` — pre-existing config-layer unit tests, no
  models needed. 9/9 pass (unchanged, untouched).
- `tests/test_p0_t4t5_robustness.py` — 14 real-behavior TestClient tests
  with constructor-level fakes (fail-twice-then-ok, fail-always, ok):
  backoff `attempts == max` + fail-fast, clear-on-success, TTL expiry,
  half-open probe, reload reset, live-always-200, laya↔gliner process
  independence, 10-thread single-flight (×2 servers), saturation 503 with
  `Retry-After` (×2). 14/14 pass.
- `tests/test_p0_t6_limits.py` — 11 TestClient boundary tests: just-under
  passes / just-over 413s per field, body-total 413 with individually fine
  parts, structured state measured as JSON, env configurability,
  validation-before-load proven by zero constructor calls. 11/11 pass.
- `tests/test_p0_t7_gaps.py` — 8 tests: readiness-after-load shape (laya
  partial checkpoints, gliner loaded model, `/models` per-checkpoint
  flags), second inference reuses backend (constructor calls stay 1),
  inference-time `RuntimeError` → 503 + `Retry-After` without holder
  poisoning (and recovery without rebuild), unexpected error → structured
  500, mixed laya+gliner concurrent inference all-200. 8/8 pass.
- `tests/t6_limits.mjs` — 16 server-less checks against `dist/` builders
  (find/decide/rerank/classify/extract/verify/screen/review/gate/compare/
  pii boundaries). 16/16 pass.
- No-regression vs baseline (T8 re-run): typecheck exit 0 (was 0);
  build exit 0 (was 0); `test_opencode_v2` 9/9 (was 9/9);
  `LAYA_SKIP=1 python tests/smoke.py` OK 10 builders (was OK);
  `python py/doctor.py --no-live` exit 2 with 10 pass / 0 warn / 1 fail /
  3 skip (was exit 2 with 9 pass / 1 warn / 1 fail / 3 skip — the
  warn→pass flip is environmental: host RAM 8.7 GB available now vs
  5.2 GB at baseline; the single fail is the same environmental
  `laya-sdk not installed`, no `pip install laya` per mission);
  `EXPECT_PII=0 node tests/mcp_smoke.mjs` exit 1 FAIL at
  `laya_extract advertised` (identical to baseline: laya-server down →
  `tools: []` by design, servers never lifted — no model downloads per
  mission); `curl :8765/health` exit 7 connection-refused (identical);
  `bash tests/test_*.sh` not executable, literal
  `execvpe(/bin/bash) failed: No such file or directory` (identical);
  `python -m py_compile` on both servers exit 0; no lint config in repo
  (unchanged, still not applicable). No test was deleted or weakened to
  reach green.

## 5. Benchmark (host absolutes, in-process TestClient/ASGI, no heavy models)

No pre-change baseline exists, so **no improvement claim is made**; figures
are absolute capacities of this host (Windows, Python 3.11.9) at `80b33a6`:

| Probe | Result |
|---|---|
| Cold import | ~562–584 ms |
| Import + app + first `/live` | ~581–604 ms |
| Warm `/live` p50/p99 (laya, N=200) | 1.740 / 5.049 ms |
| Warm `/ready` p50/p99 (laya, N=100) | 2.113 / 2.963 ms |
| Warm `/models` p50/p99 (laya, N=100) | 2.259 / 3.651 ms |
| Warm `/live` p50/p99 (gliner, N=200) | 1.619 / 2.312 ms |
| Warm `/ready` p50/p99 (gliner, N=100) | 1.748 / 2.965 ms |
| Warm `/models` p50/p99 (gliner, N=100) | 1.707 / 2.665 ms |
| Concurrent `/live` 4×25 vs 32×25 | 752 rps vs 712 rps |
| Concurrent `/models` 4×25 vs 32×25 | 565 rps vs 525 rps |

Throughput is preserved under higher concurrency (no collapse); `/live`
stays single-digit ms warm. No optimization was performed on these paths.

## 6. Breaking changes (complete list, each verified old-vs-new)

1. `/ready` body shape: unstructured `{status, ...health()}` (+ warming
   side effect) → structured snapshot with `ready/reason/loaded/failed/
   device/versions/circuit/load_attempts/retry_after_seconds` and
   `Retry-After` on 503. Parsers of the old body, and any client relying
   on `/ready` to warm models, break.
2. `/health` under failure: every call used to attempt construction; now
   fails fast inside the backoff/cooldown window (no constructor call).
3. New 413 `input_too_large` refusals on `/predict`, `/extract_entities`,
   `/classify`, `/pii_scan` for payloads previously accepted (no validator
   existed at `cb70301`).
4. New TS builder refusals (`InputTooLargeError`): `find` > 250, `decide`
   outside 2–6 options or > 32 requirements, `rerank` > 64 candidates,
   `classify` > 64 items, `verify` > 64 claims, `gate` > 61 claims,
   `compare` > 32 aspects, over-limit texts — all previously built
   unbounded payloads.
5. `rerank` now truncates each candidate to 2000 chars (with
   `truncated`/`truncated_ids`); previously full text was sent despite the
   description.
6. `LAYA_TOOL_TIMEOUT_MS` enforced (default 8000 ms): calls slower than
   the budget now fail instead of running unbounded (explicit
   `opts.timeoutMs` still overrides).
7. New saturation refusal: concurrent inference beyond `LAYA_MAX_INFLIGHT`
   (3) / `GLINER_MAX_INFLIGHT` (4) answers 503 + `Retry-After` instead of
   queueing unboundedly.
8. Additive (non-breaking): `extract` 20-cap now reported via
   `truncated`/`dropped`; `POST /reload`, `GET /live`, `GET /models` are
   new; the offline MCP contract is unchanged (zero tools advertised when
   laya-server is down).

## 7. Risks

- **Env-name sprawl:** 7 load + 3/5 limit knobs per server. Mitigated by
  in-module documented defaults (single source of truth) and dynamic
  per-validation reads, but operators can still misconfigure (e.g.
  `MAX=0`); `_i`/`_f` clamp invalid values back to defaults.
- **Semaphore sizing:** `LAYA_MAX_INFLIGHT=3` mirrors the checkpoint count,
  not measured contention; too low throttles bursty agents with 503s, too
  high risks VRAM pressure. It is env-tunable without code changes.
- **Half-open stampede:** after cooldown a single probe passes; concurrent
  requests behind one half-open probe each fail fast rather than queue —
  correct but chatty under outage.
- **`revision: null`:** `/models` deliberately does not resolve HF pins
  offline; consumers must not treat `null` as "unknown version", it means
  "unpinned by design".
- **Single-loop assumption:** holder locks/semaphores are single-loop-only
  (see §8); multi-loop hosting (e.g. exotic ASGI workers) would deadlock.

## 8. Technical decisions

- **413 over 422** (`py/laya_server.py:173-179`): the payload is
  syntactically valid but too large — the fix is to shrink, not to correct
  the schema. No `Retry-After`, since resending the same bytes can never
  succeed.
- **Fail-fast without sleep** (`py/laya_server.py:216-241`): backoff math
  only computes `retry_after_seconds` for the 503 answer; the request path
  never sleeps or loops — the *client* retries after `Retry-After`.
- **Semaphore without queueing** (`py/laya_server.py:260-266`): saturation
  answers 503 immediately. An unbounded queue would hide overload as
  latency and risk VRAM exhaustion under bursty agents.
- **Watcher on live+ready, CallTool intact** (`src/health.ts:11-18`):
  announcement follows the cheap probes, but per-call gating on a
  10 s-stale snapshot could wrongly reject calls right after recovery, so
  handlers keep failing fast on their own via client timeouts.
- **`revision: null` + `revision_source: "unpinned"`**
  (`py/laya_server.py:56-57,553-565`): pins are not resolved offline; a
  hash is never invented.
- **Single-loop-only concurrency** (`tests/test_p0_t7_gaps.py:293-298`):
  mixed laya+gliner concurrency is tested via one event loop
  (`httpx` ASGI transport + `asyncio.gather`) because threads +
  `TestClient` deadlock deterministically (each `TestClient` owns its own
  portal/loop while holders cache one loop's primitives). Production runs
  one loop (uvicorn), so this is the faithful shape.

## 9. Non-facts (explicitly unchanged)

Policy Engine, shadow mode, eval harness, CUA, and the decision semantics
of verify/screen/PII/review/gate/find/rerank/classify/decide/compare/
extract are intact — T6 only added size guards and made pre-existing
descriptions real. Checkpoints, routing rules, calibration, and the
`routing` audit block are untouched. Live-model behavior (GPU/VRAM, real
checkpoints, Spanish smoke) was never exercised here: no models were
downloaded and no inference server was lifted, per mission constraints.
