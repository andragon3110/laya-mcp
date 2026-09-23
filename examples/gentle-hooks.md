# Declarative Gentle hooks for laya-mcp (fase-6 T4)

The machine-readable table lives in [`gentle-hooks.yaml`](./gentle-hooks.yaml).
This document explains which hook calls which tool, in which default mode,
and how the modes are configured. Nothing here runs inside laya-mcp: the
executable part on this side is the per-tool mode (observe/shadow/enforce);
the wiring below is Gentle-side skill configuration, fully opt-in.

## Standing rules

- **Off by default.** Every hook first checks the host tool list: with no
  `laya_*` tool present the hook is a no-op (never wait, require, or mention).
- **Never on every request.** Each hook fires only at its lifecycle point.
- **Default mode `observe`.** Advisory and non-intrusive unless the operator
  opts a hook into `shadow` or `enforce`.

## Hook table

| Hook | Lifecycle point | Tool(s) | Default mode |
|------|-----------------|---------|--------------|
| `external_content.pre_context` | BEFORE external text enters context | `laya_screen` + `laya_pii` | `observe` |
| `implementation.post_write` | AFTER a writer finishes, BEFORE done | `laya_review` | `observe` |
| `completion.pre_complete` | WHEN a worker claims completion | `laya_gate` | `observe` |
| `retrieval.candidate_selection` | WHEN picking/ranking candidates | `laya_find` | `observe` |

- `external_content.pre_context`: screen the text (`block` refuses it,
  `review`/`escalate` escalates first); then PII-scan it (needs
  `--with-gliner`; on `block` redact the reported spans first).
- `implementation.post_write`: review the diff against the original task;
  on `escalate` hand to a human instead of closing the task.
- `completion.pre_complete`: verify each completion claim against the
  supplied evidence; never accept completion on a contradicted or
  unsupported claim.
- `retrieval.candidate_selection`: pick by meaning with no embeddings and
  no index; `find` always returns a winner, so check its existence verdict
  first.

## Mode semantics (exact)

- `observe`: execute and record; the decision is advisory evidence.
- `shadow`: the base decision is unchanged; the candidate policy outcome
  arrives in `shadow{would_decide, under_policy}` without altering the flow.
- `enforce`: the engine decision is authoritative -- Gentle must honor it.

## Configuration (laya-mcp server side)

| Scope | Variable | Example |
|-------|----------|---------|
| Global mode | `LAYA_MODE` | `LAYA_MODE=observe` (default) |
| Per-tool mode | `LAYA_MODE_<TOOL>` | `LAYA_MODE_LAYA_GATE=enforce` |
| Shadow candidate (global) | `LAYA_SHADOW_POLICY` | `LAYA_SHADOW_POLICY=review@1.0.0` |
| Shadow candidate (per tool) | `LAYA_SHADOW_POLICY_<TOOL>` | `LAYA_SHADOW_POLICY_LAYA_SCREEN=screen@1.0.0` |

Invalid modes fall back to `observe`; malformed or unknown shadow
candidates report no shadow (base decision intact). The effective mode of
each call is visible as `effective_mode` on the envelope; `laya_capabilities`
reports `modes{supported, effective, default}` (the legacy `mode:"observe"`
field is untouched: the MCP layer itself never acts).
