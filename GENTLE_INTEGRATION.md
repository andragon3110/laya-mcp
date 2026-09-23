# Gentle Integration — laya-mcp

This document is the integration contract between the Gentle AI
orchestrator side (OpenCode + Gentle skills) and the `laya-mcp` server.
`laya-mcp` is a **capability layer**: it reports typed judgments as
evidence. It never executes actions, never orchestrates Gentle, and never
forces a call. Every claim below is verified against the shipped code and
the fase-6 batteries (`tests/fase6_t3_trace_metrics.mjs`,
`tests/fase6_t4_modes.mjs`, `tests/fase6_t5_security_discovery.mjs`,
`tests/fase6_t6_gentle_integration.mjs`).

## 1. Architecture

```
OpenCode -> Gentle -> laya-mcp -> Evidence/Policy -> Decision -> Gentle -> Action -> Verification
```

- **OpenCode** hosts the session and the MCP tool list.
- **Gentle** (orchestrator skills + hooks in `examples/gentle-hooks.yaml`)
  decides *when* to call. Each hook fires only at its lifecycle point,
  only when a `laya_*` tool is present, and never on every request.
- **laya-mcp** runs the local judgment (`/predict` against laya-server,
  spans against the GLiNER sidecar) and returns a decision envelope:
  evidence plus a deterministic `decision` from a versioned policy.
- **Gentle** consumes the decision according to the effective mode
  (§3), acts, and verifies.

Laya is a detector, never a security authority: an `ALLOW` is evidence
for the agent/policy to consume, not permission to include.

## 2. Configuration

Server-side (environment of the `laya-mcp` process):

| Scope | Variable | Example | Default |
|---|---|---|---|
| Global mode | `LAYA_MODE` | `LAYA_MODE=observe` | `observe` |
| Per-tool mode | `LAYA_MODE_<TOOL>` | `LAYA_MODE_LAYA_GATE=enforce` | inherits global |
| Shadow candidate (global) | `LAYA_SHADOW_POLICY` | `LAYA_SHADOW_POLICY=review@1.0.0` | none (no shadow) |
| Shadow candidate (per tool) | `LAYA_SHADOW_POLICY_<TOOL>` | `LAYA_SHADOW_POLICY_LAYA_SCREEN=screen@1.0.0` | inherits global |

Tool names are uppercased with non-alphanumerics as `_`
(`src/policy/mode.ts`: `toolModeEnvVar`). Invalid modes fall back to
`observe`; malformed or unknown shadow candidates report no shadow with
the base decision intact. Resolution happens per call from the live
environment (never cached), so operators can change it without a reload.

Gentle-side (declarative, opt-in):

| File | Role |
|---|---|
| `examples/gentle-hooks.yaml` | Machine-readable hook table: hook id, lifecycle point, tool call(s), default mode, `on_decision` routing. Never read by `laya-mcp`. |
| `examples/gentle-hooks.md` | Human-readable companion: hook table, exact mode semantics, configuration pointers. |
| `examples/gentle-orchestrator-policy.md` | Optional orchestrator-prompt block (installed by `scripts/apply-orchestrator-policy.sh`). Ignored entirely when no `laya_*` tool is present. |

Hook table:

| Hook | Lifecycle point | Tool(s) | Default mode |
|---|---|---|---|
| `external_content.pre_context` | BEFORE external text enters context | `laya_screen` + `laya_pii` | `observe` |
| `implementation.post_write` | AFTER a writer finishes, BEFORE done | `laya_review` | `observe` |
| `completion.pre_complete` | WHEN a worker claims completion | `laya_gate` | `observe` |
| `retrieval.candidate_selection` | WHEN picking/ranking candidates | `laya_find` | `observe` |

Hook arg maps are **templates** (angle-bracket placeholders), not literal
payloads: every documented arg key is a declared input property, but
Gentle must fill all *required* inputs at wire time. Known template gap:
the `completion.pre_complete` map lists `{claims, diff, evidence}` while
`laya_gate` requires `request` — the orchestrator supplies the original
task as `request`. The `laya_pii` leg additionally needs the GLiNER
sidecar (`install.sh --with-gliner`); when the sidecar is down the hook
degrades to the `laya_screen` leg alone (`on_missing_tools: ignore`).

## 3. Modes (exact semantics)

- `observe` (default): execute and record; the decision is **advisory**
  evidence. Output shape is the base envelope (no `shadow` key).
- `shadow`: the base decision is **unchanged** (the flow continues with
  the tool's own policy) AND the same input is additionally evaluated
  under an explicit candidate policy `{name, version}`. The outcome is
  reported in top-level `shadow: { would_decide, under_policy }`,
  present only in shadow mode with a resolvable candidate. Shadow never
  alters the flow, including under misconfiguration.
- `enforce`: the engine decision is **authoritative** — Gentle must
  honor it (`ALLOW`/`REVIEW`/`DENY`/`ESCALATE`). Output shape matches
  observe; only the `effective_mode` stamp differs.

Every envelope stamps `effective_mode`; `laya_capabilities` reports
`modes: { supported, effective, default }` from code truth
(`SUPPORTED_MODES`, live `effectiveMode()`, `DEFAULT_MODE`). The legacy
`mode: "observe"` field is untouched: the MCP layer itself (read-only
discovery + inference) never acts, under every policy mode.

## 4. Tracing

Correlation chain: `trace_id` / `span_id` travel
OpenCode -> Gentle -> laya-mcp on the MCP request `_meta` object and are
threaded into the decision envelope as optional keys alongside
`decision_id` (`src/trace.ts`, `src/envelope.ts`: `augmentEnvelope`).

- Incoming ids are normalized (dashes stripped, lowercased) and accepted
  iff 8–64 hex chars — W3C traceparent ids, UUIDs, and short correlation
  tokens all correlate. Absent or malformed ids are replaced with fresh
  generated ones (`trace_id`: 32 hex, `span_id`: 16 hex); extraction never
  throws. One `trace_id` correlates a whole Gentle workflow across hook
  calls; each call keeps its own `decision_id` (`dec_<16 hex>`).
- **No PII in traces.** The trace context carries opaque ids only.
  Argument content never enters the trace path (this module logs
  nothing), `decision_id` stays random (never a content hash), and `laya_pii`
  payloads are excluded outright — hashing was deliberately rejected
  because a hash still enables confirmation against known PII.

## 5. Metrics

In-process registry (`src/metrics.ts`): no dependencies, no exporters,
categorical/numeric aggregates only — never argument content, never free
text, never span payloads.

| Metric | Per | Notes |
|---|---|---|
| `requests_total` | tool | served + failed |
| `requests_failed` | tool | error branch + unknown tool |
| `inference_latency_ms` | tool (`count`, `p50`, `p95`, `p99`) | from envelope `latency_ms`, nearest-rank |
| `policy_decisions` | tool × decision label | engine labels uppercased verbatim |
| `abstentions` | tool | `abstention.abstained === true` |
| `escalations` | tool | decision label `ESCALATE` (shorthand; also inside `policy_decisions`) |
| `by_model` | tool × model (`total`, `p50`, `p95`, `p99`) | `evidence.model` verbatim; null/empty buckets as `"none"` |
| `model_load` | `laya` / `gliner` (`probes`, `failures`, `p50`, `p95`, `p99`) | timed live probes owned by `laya_capabilities` |

Latency series keep a **bounded window** (`LATENCY_WINDOW_MAX = 256`
samples per series, oldest dropped first); counters are exact.
Exposure: `getMetricsSnapshot()` embedded additively as the optional
`metrics` field of the `laya_capabilities` report — no separate tool was
added because discovery already serves that read. `resetMetrics()`
exists for test isolation and operator resets. Metrics are mode-blind:
observe/shadow/enforce count identically.

## 6. Policies

Registry truth is `listPolicies()` (`src/policy/loader.ts`); every entry
is at `1.0.0`:

| Policy | Judged by | Decision vocabulary |
|---|---|---|
| `screen` | `laya_screen` | `ALLOW` / `REVIEW` / `DENY` / `ESCALATE` |
| `verify` | `laya_verify` | `ALLOW` / `REVIEW` / `DENY` / `ESCALATE` |
| `find` | `laya_find` | `ALLOW` / `ESCALATE` |
| `rerank` | `laya_rerank` | engine truth |
| `classify` | `laya_classify` | engine truth |
| `decide` | `laya_decide` | engine truth |
| `compare` | `laya_compare` | engine truth |
| `extract` | `laya_extract` | engine truth |
| `review` | `laya_review` | `ALLOW` / `REVIEW` / `ESCALATE` |
| `gate` | `laya_gate` | `ALLOW` / `REVIEW` / `ESCALATE` |
| `pii` | `laya_pii` | `ALLOW` / `REVIEW` / `DENY` / `ESCALATE` |
| `code-review` | (workflow alias of `review` cuts) | `ALLOW` / `REVIEW` / `ESCALATE` |
| `security` | (registry entry) | engine truth |
| `normal` | (registry entry) | engine truth |

Every decision records `policy` + `policy_version` both top-level and
inside `decision.policy`. `getPolicy` takes no caller input: each handler
calls it with two string literals pinned to its own policy, and the
loader exports no mutation API. External/LLM content can never move
policy, config, mode, thresholds, or permissions (proven by the T5
immutability battery).

## 7. Integration contract

What Gentle must honor:

1. Call hook tools only at their lifecycle points, only when announced.
2. In `enforce` mode, honor the decision (allow/review/deny/escalate).
3. Supply all required tool inputs at wire time (hook arg maps are
   templates; e.g. `laya_gate` needs `request`).
4. Forward one `trace_id`/`span_id` pair per workflow on `_meta` for
   correlation; never send sensitive content inside trace fields (only
   opaque ids travel).
5. Parse the text-JSON envelope (`content[0].text`); treat unknown keys
   as ignorable.

What laya-mcp guarantees:

1. Every success returns one non-empty text block with the full JSON
   envelope **and** `structuredContent` carrying the **same object**.
2. Envelope metadata on every call: `decision_id`, `trace_id`,
   `span_id`, `timestamp`, `effective_mode`, `model`, `model_revision`,
   `revision_source`, `primitive`, `policy`, `policy_version`,
   `schema_version` (`1.0.0`) — all additive/optional, stored old outputs
   keep validating.
3. Backend down degrades identically in every mode: `tools/list` is
   exactly `[laya_capabilities]`; judgment calls fail `isError` with a
   recovery hint; errors carry no `structuredContent`.
4. `laya_capabilities` is always advertised and reports modes, policies,
   features, versions, and metrics from code truth — one call is the
   whole discovery surface.
5. Immutability: no input path (args, `_meta`, text content) can change
   policy/config/mode/thresholds/permissions.

What laya-mcp does NOT guarantee:

1. No action execution, no orchestration, no call forcing — invocation is
   Gentle-side configuration.
2. No cross-process metric aggregation (in-process window only).
3. No PII redaction of the *decision content* itself: envelopes carry
   evidence by design; `laya_pii` findings are candidates for the
   reviewer, and metrics/traces stay content-free instead.
4. No live OpenCode/Gentle verification in this repo (see §9).

## 8. Tests (mapping)

| Area | Battery | Checks |
|---|---|---|
| Trace correlation + metrics + exposure | `tests/fase6_t3_trace_metrics.mjs` | 13 |
| Modes + declarative hooks table | `tests/fase6_t4_modes.mjs` | 15 |
| Immutability + single-source discovery + degradation | `tests/fase6_t5_security_discovery.mjs` | 16 |
| MCP↔Gentle integration contract (this doc): hook→tool routing + default modes, arg-template check, per-hook modes, simulated trace propagation, decision correlation, per-mode failure handling, text-JSON back-compat, orchestrator-policy `--check` predicate | `tests/fase6_t6_gentle_integration.mjs` | 29 + 1 skip |

The T6 battery simulates the Gentle side against stub laya/GLiNER
backends: hook-order calls per hook, one shared `trace_id` across hooks,
shadow/enforce runs of every hook tool against the observe-run oracle,
and down-backend runs in all three modes.

## 9. Limitations

1. **OpenCode/Gentle absent.** Only contract + stub tests are possible;
   no live-judgment integration run is claimed. The T6 battery documents
   each simulated step as simulated.
2. **No live judgments here.** Stub backends answer fixed signals
   (`noul` 0.85, `choice` none, `score` 2, one email span); verdicts
   under real models are the backends' business, not this contract's.
3. **`tests/test_tools_offline.sh` pending bash.** No WSL distro and no
   `python3` on the verification host, so `.sh` scripts
   (`test_tools_offline.sh`, `apply-orchestrator-policy.sh --check`)
   cannot execute here; expectations are read-verified and the `--check`
   predicate is replicated against fixtures in the T6 battery (1 skip).
4. **Revision unpinned.** `model_revision` is the honest `null` with
   `revision_source: "unpinned"` unless the operator pins
   `LAYA_MODEL_REVISION` / `GLINER_MODEL_REVISION` or the backend
   supplies one; a hash is never invented.
