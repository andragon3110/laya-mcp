# Operator runbook — sidecars, pins, fallbacks, escalations

This is the one home for running the backends. Commands below are verified
against server sources (ports/envs); the gliclass bring-up was boot-verified
2026-10-10. Anything marked UNVERIFIED was read from source, not booted here.

## Sidecar inventory

| Backend | Server | Port (env) | venv |
|---|---|---|---|
| laya (judge) | `py/laya_server.py` | 8765 (`LAYA_URL`) | `py/.venv-r1-laya` |
| gliner (spans) | `py/gliner_server.py` | 8766 (`GLINER_URL`) | UNVERIFIED — see server header |
| qwen-rerank | `py/qwen_rerank_server.py` | 8768 (`RERANK_URL`) | UNVERIFIED — see server header |
| d1 | `py/d1_server.py` | 8769 | UNVERIFIED — see server header |
| gliclass (r3a) | `py/gliclass_server.py` | 8770 (`GLICLASS_MODEL`, `GLICLASS_PORT`) | `py/.venv-r1` |
| policylm | `py/policylm_server.py` | 8771 | `py/.venv-r1-policylm` |
| gte | `py/gte_server.py` | 8773 | UNVERIFIED — see server header |

## Bring-up (verified: gliclass)

```bash
GLICLASS_MODEL=/home/andragon/Documents/GitHub/laya-mcp-finetune-gliclass/artifacts-ft/run-20261009T055724Z-r3a/checkpoint \
  py/.venv-r1/bin/python py/gliclass_server.py
# ready check: curl -s http://127.0.0.1:8770/ready
# model loads lazily on first POST /predict (~7s CPU for the 557M checkpoint)
```

Other sidecars follow the same shape (`<VENV>/bin/python py/<name>_server.py`,
port via `*_PORT` env); confirm against each file's header before running.

## Checkpoint pins (never invent a hash)

- gliclass r3a: run-dir + `GLICLASS_MODEL` path + computed sha256 of
  `model.safetensors` land in the eval manifest (`evals/smoke-r3a-lanes.mjs`
  computes it). The server itself reports revision null+unpinned by contract.
- Operator revision pins (evidence vocabulary, blank = unset):
  `LAYA_MODEL_REVISION`, `GLINER_MODEL_REVISION`, `RERANK_MODEL_REVISION`,
  `D1_MODEL_REVISION`, `GLICLASS_MODEL_REVISION`, `POLICYLM_MODEL_REVISION`,
  `GTE_MODEL_REVISION`, `PROMPTGUARD_MODEL_REVISION`.

## Fallback routing (lane envs win, else shared env, else default)

- Rerank: `LAYA_BENCH_RERANK_URL` → `RERANK_URL` → `:8768` (qwen).
  Recommended where available: gliclass r3a `:8770` (12/12 measured).
  If `:8770` is down, lanes refuse (exit-2 style, never stubbed) — point the
  env at `:8768` to keep measuring with qwen instead of failing.
- Find: `LAYA_BENCH_FIND_URL` → `RERANK_URL` → `:8768`. Parked on qwen.
- Judge lanes: `LAYA_BENCH_<CLASSIFY|SCREEN|GATE>_URL` → `LAYA_URL` → `:8765`.

## Down-procedures

- One sidecar down: its lanes refuse loudly; the rest measure normally.
  `laya_capabilities` always answers (even all-down) with the diagnosis.
- `laya_escalations` needs NO backend — log/ack during outages works.
- Full matrix cost reference: 48 r1 cases ≈ 12s + ~10s model load on CPU.

## Escalation workflow (the learning loop)

1. Agents `log` every ESCALATE/abstain with `case_id` when from a run.
2. Human triages `list` (status open) — suggested cadence: open queue to
   zero weekly; nothing acked = nothing learned.
  Store: `var/escalations.jsonl` (gitignored) or `LAYA_ESCALATIONS_FILE`.
  Acked records are training data: export the acked cases before each
  micro-train (see `odd/tasks/phase2-data-templates.md` rule zero).
