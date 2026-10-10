# mcp-completeness — escalation sink, measured capabilities, operator runbook

## Why
The 12 tools can say ESCALATE/abstain, but abstentions evaporate: no queue,
no ack, no learning loop (verified: no sink in `src/`). Capabilities reports
live inventory but not the measured track numbers agents need for routing.
Operators have bring-up knowledge scattered in smoke headers. Three
work-units; `redact` explicitly OUT (breaks the read-only contract — needs a
separate product decision).

## WU1: `laya_escalations` tool (test-first, RED already required)
- Actions: `log {primitive, tool, decision, reason, case_id?, context?}` →
  `{escalation_id}`; `list {status?, limit?}` → `{escalations, open, acked}`;
  `ack {escalation_id, verdict, reviewer?, note?}` → updated record.
- Store: append-only JSONL at `LAYA_ESCALATIONS_FILE` else
  `<repo>/var/escalations.jsonl` (event-sourced `logged`/`acknowledged`;
  no read-modify-write). IDs `esc-NNNN` from logged-count (stdio server is
  sequential). Unknown action/id/field → `invalid_argument` Error (isError,
  same precedent as `validateTimeoutMs`).
- Wiring: `HANDLERS` + always-advertised (no backend needed — same exemption
  rationale as capabilities): down-list `[capabilities, escalations]`;
  up-list appends escalations last. NOT in `TOOL_PRIMITIVES`/`JUDGMENT_TOOLS`
  (envelope `primitive:null` via `?? null`; derivations stay green).
- Annotations: `{readOnlyHint:false, destructiveHint:false, idempotentHint:false}`
  (first non-readonly tool — announced, not smuggled).
- Test/count updates (all hardcoded, all must move): t3 `11→12` (gliner down),
  t4-envelope `12→13`, t5 `servableTools(false)` names +`laya_escalations`,
  `servableTools(true)` length `12→13`, live list `12→13`; t6-gaps sweep
  auto-adapts if it iterates the list (verify); `src/index.ts:9` comment,
  README counts, MCP_CONTRACT §3 + new tool subsection.
- `.gitignore`: `/var/`.

## WU2: `measured` in capabilities (additive-optional pattern)
- New OPTIONAL `measured` key (never `required`: stored outputs keep
  validating — same promise as `metrics`/`modes`): track r3a, date,
  corpus, composed dec/task, per-lane strings, method, assistive-note +
  EVALUATION §13 pointer. Additive checks appended to fase5_t5.

## WU3: OPERATOR.md runbook
- Per-sidecar bring-up (ports, env, venvs), checkpoint pins, fallback
  routing table, down-procedures, escalation ack workflow + SLA suggestion.
  Docs-only.

## Acceptance criteria
- `npm run typecheck` + `npm run build` green.
- New `tests/escalations.mjs`: log→list→ack cycle, unknown-id/action
  rejections, file isolation via env, MCP round-trip with backends DOWN.
- t3/t4-envelope/t5/t6-gaps green after count updates; stub 98/98, r1 158/158.
- Live smoke 4/4 + matrix `/tmp/v15` == `/tmp/v14` exactly (lanes untouched).
- No push/PR/merge. Native review: preflight at close (monolith expected —
  decline per standing disposition, report).

## Applicable checks
- Test-first for the store+handler (deterministic, clear RED/GREEN).
- Contract batteries as the feature's own gate. No test-first exception.
