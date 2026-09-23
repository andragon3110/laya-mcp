# MCP Contract — laya-mcp

This document is the typed MCP contract for the `laya-mcp` server:
protocol version, SDK, the 12 advertised tools with their input/output
shapes, the `tools/call` output convention, envelope versioning, and
compatibility guarantees. Every claim below is verified against the
shipped code and its contract batteries
(`tests/fase5_t3_contract.mjs`, `tests/fase5_t4_envelope.mjs`,
`tests/fase5_t5_capabilities.mjs`, `tests/fase5_t6_contract_gaps.mjs`)
plus the Fase 6 additions (`tests/fase6_t3_trace_metrics.mjs`,
`tests/fase6_t4_modes.mjs`, `tests/fase6_t5_security_discovery.mjs`,
`tests/fase6_t6_gentle_integration.mjs`; full cross-layer contract in
`GENTLE_INTEGRATION.md`).

## 1. MCP version

- **Protocol:** `2025-11-25` (latest). The server negotiates through the
  SDK; the supported set is `2025-11-25`, `2025-06-18`, `2025-03-26`,
  `2024-11-05`, `2024-10-07`.
  - Source: `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:2`
    (`LATEST_PROTOCOL_VERSION = '2025-11-25'`) and `:4`
    (`SUPPORTED_PROTOCOL_VERSIONS`, which includes `'2024-10-07'`).
- **SDK:** `@modelcontextprotocol/sdk` `1.30.0` (verified installed;
  `package.json` declares `^1.0.0`).

## 2. SDK

- Runtime: Node.js 20+, ESM, stdio transport (`src/index.ts`).
- `tools/list` publishes each tool as name + description + `inputSchema`
  + `outputSchema` + `annotations` (`src/index.ts:109-123`,
  function `toListEntry`).
- `outputSchema` is optional in the SDK schema
  (`node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:2388`,
  `z.ZodOptional`), so publishing it is purely additive: clients that
  ignore it keep working.
- `structuredContent` is optional in the SDK result schema
  (`types.d.ts:2601`, `z.ZodOptional`), so returning it alongside the
  text block is purely additive.
- Enforcement note (verified in
  `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js`):
  the SDK server does **not** validate handler input against
  `inputSchema` and does **not** validate `structuredContent` against
  `outputSchema`. Input validation lives in this repo's tool builders
  (oversized/malformed arguments resolve to `isError` results with
  builder vocabulary, never raw throws). `outputSchema` is therefore an
  announcement for clients, not a server-side gate.

## 3. Tools (12)

All 12 tools carry read-only annotations
(`{readOnlyHint: true, destructiveHint: false, idempotentHint: true}`,
shared `READONLY_TOOL_ANNOTATIONS` in `src/tool.ts:53-57`;
`openWorldHint` deliberately omitted — the tools reach a local HTTP
backend and the server claims nothing about world scope). Every tool is
read-only inference: no side effects, no mutation.

`input_required` / `output_required` below are the literal `required`
arrays from the shipped schemas (dumped from `dist/`); optional inputs
are listed where they exist. Primitives come from `TOOL_PRIMITIVES`
(`src/envelope.ts:151-163`).

| Tool | Primitive | Input (required + optional) | Output (required keys) |
|---|---|---|---|
| `laya_screen` | `noul` | required: `text`, `purpose` | `signals`, `assessment`, `decision`, `latency_ms`, `evidence`, `abstention`, `authority_note` |
| `laya_verify` | `noul` | required: `claims`, `evidence` | `verdicts`, `decision`, `latency_ms`, `evidence`, `abstention` |
| `laya_find` | `choice` | required: `query`, `candidates`; optional: `top_k` (max 250), `min_score` | `winner`, `exists`, `distribution`, `winner_probability`, `decision`, `latency_ms`, `evidence`, `abstention`, `pruned`, `pruning` |
| `laya_rerank` | `noul` | required: `query`, `candidates`; optional: `top_k` (max 64) | `ranked`, `truncated`, `truncated_ids`, `decision`, `latency_ms`, `evidence`, `abstention`, `pruned`, `pruning` |
| `laya_classify` | `choice` | required: `purpose`, `items`, `classes` | `classifications`, `decision`, `latency_ms`, `evidence`, `abstention` |
| `laya_decide` | `choice` | required: `decision`, `candidates`; optional: `evidence`, `requirements` (2–6 candidates; two-stage: stage 1 selects, stage 2 checks each requirement against the winner; 1 `/predict` call with no requirements, 2 with) | `selected`, `distribution`, `winner_probability`, `requirements`, `decision`, `latency_ms`, `evidence`, `abstention` |
| `laya_compare` | `choice` | required: `passage_a`, `passage_b`; optional: `aspects` | `overall`, `decision`, `latency_ms`, `evidence`, `abstention` |
| `laya_extract` | `choice` | required: `document`, `fields`; optional: `source` (`auto` default, `regex`, `entities`), `top_k`, `max_candidates`, `min_gliner_score` | `results`, `source`, `truncated`, `dropped`, `latency_ms`, `decision`, `evidence`, `abstention` |
| `laya_review` | `score` | required: `request`, `diff`; optional: `tests` | `rubric`, `decision`, `latency_ms`, `evidence`, `abstention` |
| `laya_gate` | `score` | required: `request`, `diff`, `claims`; optional: `evidence`, `context`, `risk` | `review`, `claims`, `decision`, `context`, `risk`, `latency_ms`, `evidence`, `abstention` |
| `laya_pii` | `spans` | required: `text`; optional: `extra_types`. Served only while the GLiNER sidecar is live-ready. | `pipeline`, `findings`, `counts`, `secrets_found`, `decision`, `latency_ms`, `recommendation`, `evidence`, `abstention` |
| `laya_capabilities` | none (`null`) | optional: `timeout_ms` (integer, 100–30000, default 2000) | `models`, `backend`, `gliner`, `primitives`, `tools`, `policies`, `features`, `mode`, `schema_version`, `latency_ms` — plus OPTIONAL (never required) `modes`, `metrics` (Fase 6, §10) |

Notes:

- `laya_capabilities` (tool 12, `src/tools/capabilities.ts`) judges
  nothing: it probes `GET /models` + `GET /ready` live on every call
  (never a cached snapshot) and reports models, backend readiness,
  GLiNER sidecar state, primitives, currently servable tools (with a
  summarized per-tool contract), the full policy registry, real feature
  flags (`top_k`, `pruning`, `two_stage`, `structured`, `revision`),
  `mode: "observe"`, plus the Fase 6 additions `modes` and `metrics`
  (both OPTIONAL outputSchema keys, `src/tools/capabilities.ts:359-391`;
  stored pre-Fase-6 outputs keep validating).
- `modes` (`supported` from `SUPPORTED_MODES`, `effective` from live
  `effectiveMode()`, `default` = `DEFAULT_MODE`, plus a semantics note)
  reports the policy-decision modes `observe`/`shadow`/`enforce`
  (`src/policy/mode.ts:52-66`). The legacy `mode: "observe"` field is
  untouched: the MCP layer itself never acts, under every policy mode.
- `metrics` embeds `getMetricsSnapshot()` (`src/metrics.ts:261-309`):
  per-tool `requests_total`/`requests_failed`/`inference_latency_ms`
  (`count` + `p50`/`p95`/`p99` over a bounded 256-sample window,
  `LATENCY_WINDOW_MAX`, `src/metrics.ts:66`)/`policy_decisions`/
  `abstentions`/`escalations`, per-model latency (`by_model`), and
  probe `model_load` stats — aggregates only, never content.
- `laya_capabilities` is **always advertised**, even when laya-server is
  down (explicit exemption in `src/index.ts:133-139`). A call while the
  backend is down fails with `isError` carrying the backend diagnosis
  plus GLiNER reachability and a recovery hint.
- When laya-server is up but GLiNER is down, `laya_pii` is absent from
  the list and `gliner.reachable` is `false` in the capabilities report.

## 4. Schemas

- Every tool declares an explicit `inputSchema` (`type: "object"`;
  `additionalProperties` handling per tool) and an explicit
  `outputSchema` (`type: "object"`, `required ⊆ properties` — asserted
  per tool by `tests/fase5_t3_contract.mjs`).
- Every judgment `outputSchema` spreads the shared envelope-metadata
  fragment (`envelopeMetadataProperties()`, `src/tool.ts:114-149`):
  `decision_id`, `timestamp`, `model`, `model_revision`,
  `revision_source`, `primitive`, `policy`, `policy_version`,
  `schema_version`. All nine are **optional** (never in `required`) so
  stored pre-contract outputs keep validating.
- `laya_capabilities` declares the same nine keys as optional on top of
  its ten required report keys.
- `decision` objects are `{decision, reason_codes, policy: {name,
  version}}` (`decisionSchema()`, `src/tool.ts:64-79`).
- Output schemas faithfully reject what handlers never emit and accept
  the faithful envelope (both directions asserted per tool by the T3/T6
  batteries, including nullable-`selected` for abstained decide picks,
  optional verify `summary`, free-form compare aspect keys, and the
  find/rerank/extract/decide/gate limit mirrors).

## 5. Outputs (`tools/call`)

- Every success returns **one non-empty text block** with the full JSON
  envelope **and** `structuredContent` carrying the **same object**:
  `structuredContent` deep-equals `JSON.parse(content[0].text)`
  (asserted per tool, live and offline, by the T4/T6 batteries;
  builder: `buildCallResult`, `src/envelope.ts:258-281`).
- No `_meta` field is set on the wire result; the contract surface is
  text + `structuredContent` only.
- The envelope is the handler payload **plus additive metadata only**
  (pre-existing keys preserved verbatim, `latency_ms` conserved, never
  recomputed). Metadata per envelope:
  - `decision_id` — unique per call, `dec_<16 lowercase hex>`
    (8 random bytes; an id, never a content hash).
  - `trace_id` / `span_id` (Fase 6, OPTIONAL keys) — inbound trace
    correlation from the request `_meta` (validated, generated when
    absent; `src/trace.ts`), threaded by `augmentEnvelope`
    (`src/envelope.ts:236-242`). Live envelopes (via `index.ts`,
    which always passes a context) always carry both; callers that
    pass none get the envelope without the keys. Opaque ids only,
    never content. Old readers ignore them; stored pre-Fase-6 outputs
    still validate (minor-additive).
  - `timestamp` — ISO-8601 creation time.
  - `model` — judging backend label from `evidence.model` (`null` when
    no backend judged: `laya_pii`, `laya_capabilities`).
  - `model_revision` — operator pin, backend value, or honest `null`.
  - `revision_source` — `env:LAYA_MODEL_REVISION` |
    `env:GLINER_MODEL_REVISION` | `backend` | `unpinned`.
  - `primitive` — `noul` | `choice` | `score` | `spans`
    (`null` for `laya_capabilities`, which judges nothing).
  - `policy` / `policy_version` — top-level mirror of
    `decision.policy.{name, version}` (`null` without a decision).
  - `effective_mode` (Fase 6, OPTIONAL key) — the policy-decision mode
    this call ran under (`observe`/`shadow`/`enforce`, resolved per
    call from `LAYA_MODE` / `LAYA_MODE_<TOOL>`, default `observe`;
    `src/policy/mode.ts:82-92`, stamped by `augmentEnvelope`,
    `src/envelope.ts:244-248,270`). Same minor-additive promise.
  - `shadow` (Fase 6, handler-emitted, shadow mode only) —
    `{ would_decide, under_policy }`: the same input evaluated under
    the explicit candidate policy, without altering `decision`
    (`src/policy/mode.ts:148-162`; declared OPTIONAL in every
    judgment `outputSchema` via `shadowSchema()`, `src/tool.ts:81-99`).
    Flows through the envelope untouched (spread preserves it).
  - `schema_version` — `"1.0.0"`.
  - Twelve known additive envelope keys in total
    (`envelopeMetadataProperties()`, `src/tool.ts:138-189` — eleven
    pre-Fase-6-T4 keys plus `effective_mode`; asserted by
    `tests/fase5_t6_contract_gaps.mjs:407-412`).
- Degenerate path: if handler text is not a JSON object (never happens
  with the shipped handlers), the text returns intact with **no**
  `structuredContent`, plus a one-line stderr note; the call never
  throws for this.
- Errors (unknown tool, backend down, invalid arguments, throwing
  handler) resolve to serializable `isError` results with builder
  vocabulary — never a raw throw, never an empty content block.

## 6. Versioning

- **Envelope:** `ENVELOPE_SCHEMA_VERSION = "1.0.0"`
  (`src/envelope.ts:65`), stamped as `schema_version` on every success
  envelope. It versions the whole `tools/call` contract (envelope keys
  + output schemas + list behaviour), not just one file.
- **Policy:** `SCHEMA_VERSION_POLICY` (`src/envelope.ts:67-137`) with
  the executable classifier `classifyContractChange`
  (`src/envelope.ts:126-137`):
  - **Minor (additive, old clients keep working):** new optional
    envelope/output key; new tool with its own schemas; new policy
    version registered alongside the old; new optional input parameter.
  - **Major (breaking, old clients may fail):** removing/emptying the
    text block; renaming a field; adding a required key (or making an
    optional key required); removing a property/tool/input or narrowing
    a type/enum; newly rejecting a previously valid input.
  - Any single breaking flag forces `major`, even combined with additive
    flags; only-additive (or empty) change sets are `minor`.
- **Policies:** 14 entries, all at `1.0.0` (`listPolicies()` from
  `src/policy/loader.ts`): `classify`, `code-review`, `compare`,
  `decide`, `extract`, `find`, `gate`, `normal`, `pii`, `rerank`,
  `review`, `screen`, `security`, `verify`. Every decision records
  `policy` + `policy_version` both top-level and inside
  `decision.policy`.
- **`model_revision` honesty:** resolved by
  `resolveEnvelopeRevision` (`src/envelope.ts:194-211`) from the
  operator env pin (`LAYA_MODEL_REVISION` for Laya tools,
  `GLINER_MODEL_REVISION` for `laya_pii`; blank counts as unset), else
  the backend-supplied `evidence.revision`, else the honest `null` with
  `revision_source: "unpinned"`. A hash is never invented.

## 7. Compatibility

- **Old clients:** every success keeps the full JSON in non-empty
  `content[0].text`. Clients that ignore `outputSchema` and
  `structuredContent` read exactly what pre-contract clients read,
  plus only unknown additive keys (which old readers ignore). The T6
  battery strips each live envelope back to the pre-contract payload
  and asserts the legacy keys are all present with only known additive
  keys.
- **Protocol `2024-10-07`:** supported by the SDK
  (`SUPPORTED_PROTOCOL_VERSIONS`, `types.js:4`); the text block is never
  emptied, so clients pinned to that version keep reading text.
- **Backend down (`tools/list` without Laya):** the list returns
  **only** `laya_capabilities` — never zero tools, never a crash, the
  server stays alive. Rationale: with zero tools a host cannot tell
  MCP-dead apart from MCP-alive/backend-down; with the meta tool
  present, the failure surfaces as a call-time `isError` with the
  diagnosis. Expectation pinned by `tests/test_tools_offline.sh`
  (execution requires bash; logic verified equivalent via stdio probe).
- **GLiNER down:** `laya_capabilities` still succeeds; `laya_pii` is
  absent from the servable set; `gliner.reachable` is `false`.

## 8. Examples

### Capabilities call (truncated)

```json
// tools/call laya_capabilities {}
{
  "models": [{ "name": "laya", "loaded": true, "revision": null, "revision_source": "unpinned" }],
  "backend": { "ready": true },
  "gliner": { "reachable": true, "ready": true, "models": [] },
  "primitives": [{ "name": "noul", "tools": ["laya_screen", "laya_verify", "laya_rerank"] }],
  "tools": [{ "name": "laya_screen", "primitive": "noul",
              "input_required": ["text", "purpose"],
              "output_required": ["signals", "assessment", "decision", "latency_ms", "evidence", "abstention", "authority_note"] }],
  "policies": [{ "name": "screen", "version": "1.0.0" }],
  "features": { "top_k": { "supported": true }, "structured": { "text_compat": true } },
  "mode": "observe",
  "modes": { "supported": ["observe", "shadow", "enforce"], "effective": "observe", "default": "observe" },
  "metrics": { "requests_total": {}, "requests_failed": {} },
  "schema_version": "1.0.0",
  "latency_ms": 12,
  "decision_id": "dec_9f2c41ab77d03e10",
  "timestamp": "2026-09-23T00:40:00.000Z",
  "model": null,
  "model_revision": null,
  "revision_source": "unpinned",
  "primitive": null,
  "policy": null,
  "policy_version": null
}
```

(`model`/`policy`/`policy_version` are `null` here because capabilities
makes no judgment; `primitive` is `null` because it judges nothing.)

### Judgment call with metadata (truncated)

```json
// tools/call laya_screen {"text": "...", "purpose": "..."} — text and structuredContent carry this same object
{
  "signals": {},
  "assessment": {},
  "decision": { "decision": "ALLOW", "reason_codes": [],
                "policy": { "name": "screen", "version": "1.0.0" } },
  "latency_ms": 33,
  "evidence": {},
  "abstention": { "abstained": false },
  "decision_id": "dec_41cd0e9b58a2f771",
  "timestamp": "2026-09-23T00:40:01.000Z",
  "model": "laya",
  "model_revision": null,
  "revision_source": "unpinned",
  "primitive": "noul",
  "policy": "screen",
  "policy_version": "1.0.0",
  "schema_version": "1.0.0"
}
```

## 9. Breaking changes

**None in Fase 5** (historic verdict, kept verbatim): Fase 5 is
additive-only (`minor` class per `SCHEMA_VERSION_POLICY`): new
`outputSchema` announcements, new `structuredContent` alongside
unchanged text, nine optional envelope keys, one new tool.
Documented behaviour changes (not breakings — old text readers keep
working):

1. `tools/list` with laya-server down returns `[laya_capabilities]`
   instead of `[]` (previously empty). `tests/test_tools_offline.sh`
   expectation updated accordingly.
2. `tools/list` entries now include `outputSchema` + `annotations`
   keys that were previously stripped to name/description/inputSchema.
3. `tools/call` success text now includes the nine additive metadata
   keys (it previously carried the bare handler payload).
4. Unknown/malformed tool arguments keep resolving to `isError` with
   builder vocabulary (unchanged semantics; now additionally covered by
   the T6 malformed-args battery for all 12 tools).

## 10. Fase 6 additions (also `minor`, also non-breaking)

Fase 6 adds the following, each optional/additive per
`SCHEMA_VERSION_POLICY` (old readers ignore unknown keys; stored
pre-Fase-6 outputs keep validating — asserted by the Fase 6
batteries listed in the intro):

1. **Trace correlation** (`trace_id` / `span_id`, Fase-6 T3): inbound
   `_meta` ids threaded into every live envelope (§5). Absent input
   yields generated ids on live calls, no keys on direct/test calls
   without a context.
2. **`effective_mode`** (Fase-6 T4): stamped on every live envelope
   (§5); twelve known additive envelope keys total
   (`tests/fase5_t6_contract_gaps.mjs:407-412`).
3. **`shadow`** (Fase-6 T4): handler-emitted, shadow mode only (§5);
   OPTIONAL in every judgment `outputSchema`.
4. **`modes` + `metrics`** on the `laya_capabilities` report (§3):
   OPTIONAL outputSchema keys (never in `required`), so stored
   pre-Fase-6 capability reports keep validating
   (`tests/fase5_t6_contract_gaps.mjs:380-399`).
5. **Degradation identical in every mode**: backend down still yields
   exactly `[laya_capabilities]` on `tools/list` and `isError`
   judgment calls with a recovery hint, in `observe`, `shadow`, and
   `enforce` alike
   (`tests/fase6_t5_security_discovery.mjs`,
   `GENTLE_INTEGRATION.md` §7).
6. **Immutability**: no input path (args, `_meta`, text content) can
   change policy/config/mode/thresholds/permissions
   (`tests/fase6_t5_security_discovery.mjs`, 16 checks).
