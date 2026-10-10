# redact-tool — `laya_redact` pure transform (tool 14)

## Why
`laya_pii` detects, `laya_extract` locates, but nothing redacts: pipelines
that clean PII before logging must hand-roll slicing (off-by-one + unicode
bugs). A deterministic, backend-independent transform closes the
detect→redact loop inside the MCP. User authorized ("haz lo que recomiendas")
with the contract stretch documented, not smuggled.

## Design (frozen)
- Pure function of its arguments: NO backend, NO policy decision, NO state.
  Annotations stay read-only (`readOnlyHint:true`, destructive:false,
  idempotent:true — same input → same output). What stretches is the
  *judgment-only* design principle: this is a transform. MCP_CONTRACT §3
  says so explicitly (13→14 tools).
- Input: `text` (required) + `findings [{start, end, entity_type?}]`
  (required, non-empty) + `strategy` (`label` default `[REDACTED:<type>]`,
  or `placeholder` `[REDACTED]`).
- Offset semantics: Unicode CODE POINTS (matches the Python GLiNER producer
  and the pii `(chars s-e)` vocabulary). Converted internally to UTF-16 for
  slicing; emoji test pins it. Previously ambiguous — this contract settles it.
- Overlap rule (deterministic): sort by start asc, end desc; drop any span
  starting before the previous span's end (earliest wins, longest wins ties).
- Validation: start/end integers, 0 ≤ start < end ≤ text length in code
  points; violations → `invalid_argument` (isError). Empty findings →
  `invalid_argument` (redacting nothing is a caller bug, not a success).
- Wiring: HANDLERS + always-advertised (no backend): down-list
  `[capabilities, escalations, redact]`; up-list appends redact last. NOT in
  TOOL_PRIMITIVES/JUDGMENT_TOOLS (envelope `primitive:null`).
- Count updates: t3 gliner-down 12→13; t4 13→14; t5 false/true/live/down
  lists +1; t6 wait 13→14 + VALID + INVALID fixtures (B1 needs a FIXTURES
  entry for the valid call); mcp_smoke comment; index.ts:9 comment; README
  (Fourteen, inspect line 13/12/3); MCP_CONTRACT §3 (14 + row); OPERATOR
  redact section.

## Allowed edit surfaces
- `src/tools/redact.ts` (new), `src/index.ts` (wiring),
  `src/tools/capabilities.ts` (servableTools only).
- `tests/redact.mjs` (new), count updates in t3/t4/t5/t6.
- `MCP_CONTRACT.md`, `README.md`, `OPERATOR.md`,
  `odd/tasks/redact-tool.md` (this file).
- Forbidden: judgment behavior, lane code, corpus, push/PR/merge.

## Acceptance criteria
- Test-first RED (missing module) → GREEN: strategies, overlap rule, emoji
  offsets, empty/bad-span rejections, backend-down MCP round-trip,
  structured==text.
- t3/t4/t5/t6 green; typecheck+build; stub 98/98, r1 158/158.
- Live smoke 4/4 + matrix `/tmp/v16` == `/tmp/v15` row-identical (transform
  touches no lane).
- Native review: preflight at close (monolith expected — decline per
  standing disposition, report).
