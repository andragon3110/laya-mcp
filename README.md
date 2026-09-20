# laya-mcp

> **MCP server that exposes Laya's typed decisions to coding agents.**
> Optional by design. Your existing setup runs unchanged if Laya or this
> server are missing.

`laya-mcp` is a [Model Context Protocol](https://modelcontextprotocol.org)
server that gives your coding agent ten typed-decision tools backed by a
local [Laya](https://huggingface.co/convaiinnovations/laya) instance.
Every tool returns **calibrated probabilities** so the agent can branch,
sort, and gate on real confidence instead of vibe-checking its own
output.

```
┌──────────────────┐  stdio JSON-RPC  ┌────────────────────┐  HTTP  ┌────────────────────┐
│ OpenCode CLI     │ ───────────────▶ │ laya-mcp (Node/TS) │ ─────▶ │ laya-server (Py)   │
│ Claude Code      │                  │  - 10 tools        │        │  - FastAPI         │
│ Codex            │                  │  - health watcher  │        │  - Laya SDK        │
│ Pi              │ ◀─────────────── │  - graceful fail   │ ◀───── │  - HuggingFace model│
└──────────────────┘                  └────────────────────┘        └────────────────────┘
```

The ten tools (one per file under `src/tools/`):

| Tool                | What it does                                                                 | Laya primitive |
|---------------------|------------------------------------------------------------------------------|----------------|
| `laya_screen`       | Prompt-injection / substance / relevance guard before content enters context | `noul` × 3     |
| `laya_verify`       | Verify one or more claims against supplied evidence                          | `noul` per claim |
| `laya_find`         | Pick the best candidate id for a query (or `none`)                            | `choice`       |
| `laya_rerank`       | Score and sort all candidates by relevance                                   | `noul` per candidate |
| `laya_classify`     | Batch-classify items against a shared catalog                                 | `choice` per item |
| `laya_decide`       | Pick one of 2-6 bounded options + optional per-requirement checks              | `choice` + `noul` |
| `laya_compare`      | Compare two passages overall and per aspect                                   | `choice` per aspect |
| `laya_extract`      | Pull structured field values from a document (regex + judgment)                | `choice` over regex matches |
| `laya_review`       | Score a proposed diff against the original request before merging             | `score` + `noul` |
| `laya_gate`         | Completion gate: `laya_review` plus per-claim verification                     | combined       |

The shape and purpose of each tool is modeled after
[`jkudish/jev-mcp`](https://github.com/jkudish/jev-mcp) (155 ★, the
reference Jev MCP server) and
[`itsmostafa/typesafe-mcp`](https://github.com/itsmostafa/typesafe-mcp)
(133 ★). Replace Jev with self-hosted Laya and keep the same ergonomics.

---

## Why this exists

Jev is a hosted decision model from [TypeSafe AI](https://typesafe.ai)
($0.042/M input tokens, ~264 ms p50, English-only, closed weights).
Laya is the open-source answer ([NandhaKishorM/laya](https://github.com/NandhaKishorM/laya),
Apache 2.0, $0 self-hosted, ~38 ms p50, 100+ languages, open weights).
`laya-mcp` is the glue: it lets any MCP-compatible coding agent use Laya
the same way it would use Jev, with the same ten tools and the same
typed outputs, but locally, cheaply, and multilingual.

The MCP server is **completely independent**:

- If `laya-mcp` is not installed, your agent runs exactly as it does today.
- If `laya-server` (the Python process) is down, the MCP server advertises
  **zero tools** and every call returns a structured error. The agent
  keeps working.
- If Laya itself is missing, the Python wrapper exits with a clear error
  at startup time -- nothing silently breaks.

---

## Install

The installer is **idempotent** and does **not** touch any of your
existing agent configuration. It only creates `$HOME/laya-mcp/`.

### Requirements

- **Python 3.10+** with `pip`
- **Node.js 20+** with `npm`
- **~1 GB disk** for the Laya model weights (downloaded on first run)
- Optional: **NVIDIA GPU with CUDA** for ~30 ms inference. CPU works
  too (~200 ms per call).

### One-command install

```bash
git clone https://github.com/andragon3110/laya-mcp.git
cd laya-mcp
./install.sh
```

The script:

1. Creates a Python venv at `$HOME/laya-mcp/.venv/`
2. Installs `laya`, `fastapi`, `uvicorn`
3. Runs `npm install` and `tsc`
4. Generates `start_laya.sh`, `start_mcp.sh`, `uninstall.sh`,
   `examples/opencode.snippet.json`

You can override paths with `LAYA_MCP_HOME`, `LAYA_HOST`, `LAYA_PORT`,
`PYTHON`. See `install.sh`.

### Start the laya-server

In one terminal:

```bash
$HOME/laya-mcp/start_laya.sh
# -> [laya-server] laya-server starting on http://127.0.0.1:8765
```

First startup downloads the Laya weights (~1 GB) and warms up. Subsequent
starts are seconds.

### Verify

```bash
curl http://127.0.0.1:8765/health
# -> {"status":"ok","ready":true,"model":"convaiinnovations/laya",...}
```

If you see `ready: true`, the MCP server will advertise all ten tools.

---

## Wire into your agent

`laya-mcp` is an optional MCP server. Your agent only sees its tools if
you register it. None of the snippets below modify anything you already
have -- they only **add** an `mcp.laya` entry.

### OpenCode

Edit `~/.config/opencode/opencode.json` and merge the snippet:

```bash
SNIPPET="$HOME/laya-mcp/examples/opencode.snippet.json"
python3 - <<PY
import json, pathlib
cfg = json.loads(pathlib.Path("$HOME/.config/opencode/opencode.json").read_text())
cfg.setdefault("mcp", {}).setdefault("laya", json.loads("""$SNIPPET""")["mcp"]["laya"])
pathlib.Path("$HOME/.config/opencode/opencode.json").write_text(json.dumps(cfg, indent=2))
PY
```

Restart OpenCode. The ten `laya_*` tools now appear in the agent's tool
palette (only when the Python server is reachable).

### Claude Code

Add to `~/.claude.json` (or the project's `.mcp.json`):

```json
{
  "mcpServers": {
    "laya": {
      "command": "node",
      "args": ["$HOME/laya-mcp/dist/index.js"],
      "env": { "LAYA_URL": "http://127.0.0.1:8765" }
    }
  }
}
```

Restart Claude Code.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.laya]
command = "node"
args = ["$HOME/laya-mcp/dist/index.js"]
env = { LAYA_URL = "http://127.0.0.1:8765" }
```

Restart Codex.

### Pi

Pi has no MCP client. The reference companion is
[`gentle-pi`](https://github.com/Gentleman-Programming/gentle-pi) which
ships its own native extensions. To wire `laya-mcp` into Pi today, run
the server as a child process via Pi's extension API (see Pi docs), or
expose `laya-server`'s HTTP endpoint to whatever script wraps Pi.

---

## Optional: integrate with Gentle-AI sub-agents

Gentle-AI orchestrates SDD/Odd/RDD workflows across many sub-agents on
top of OpenCode/Pi/Claude Code. Two opt-in patterns make sense:

1. **`sdd-apply` -> `laya_review`**: Before declaring an SDD task done,
   the orchestrator (or the `sdd-apply` agent) calls `laya_review` on
   the diff against the original task. A contradicted `safe_to_apply`
   (probability < 0.5) escalates instead of auto-archiving.
2. **GitHub issues -> `laya_classify`**: A webhook action calls
   `laya_classify` against your label set with each new issue body.
   Auto-label only when confidence >= 0.85.

Both patterns are documented in
[`examples/gentle-ai-integration.md`](examples/gentle-ai-integration.md).
**None of these are enabled by default** -- you wire them by editing
your agent's skill files (e.g. `.opencode/agents/sdd-apply.md`).

---

## Test the install

After installing and starting `start_laya.sh`:

```bash
# Sanity-check the Python wrapper
$HOME/laya-mcp/tests/test_health.sh

# End-to-end smoke (loads Laya and runs one /predict call)
$HOME/laya-mcp/.venv/bin/python $HOME/laya-mcp/tests/smoke.py

# MCP-level smoke (uses the official inspector)
cd $HOME/laya-mcp && npm run inspect
```

Expected: the inspector shows **10 tools** in the left panel. With the
Python server down, it shows **0 tools**.

---

## Uninstall

```bash
$HOME/laya-mcp/uninstall.sh
```

Removes `$HOME/laya-mcp` and the `mcp.laya` entry from
`~/.config/opencode/opencode.json` (with timestamped backup). The rest
of your setup is untouched.

---

## Configuration

All env vars (with defaults):

| Var                          | Default                          | Purpose                                                   |
|------------------------------|----------------------------------|-----------------------------------------------------------|
| `LAYA_URL`                   | `http://127.0.0.1:8765`          | Where the Python server listens                           |
| `LAYA_HOST` / `LAYA_PORT`    | `127.0.0.1` / `8765`             | Bind address for the Python server                        |
| `LAYA_MODEL`                 | `convaiinnovations/laya`         | HuggingFace model id                                       |
| `LAYA_DEVICE`                | `auto`                           | `auto` / `cpu` / `cuda`                                  |
| `LAYA_TIMEOUT_MS`            | `5000`                           | Per-call HTTP timeout from MCP to Python                  |
| `LAYA_TOOL_TIMEOUT_MS`       | `8000`                           | Per-tool MCP timeout                                      |
| `LAYA_HEALTH_INTERVAL_MS`    | `10000`                          | Background watcher poll interval                         |
| `LAYA_LOG_LEVEL`             | `WARNING`                        | uvicorn log level                                         |

---

## Architecture & guarantees

- **Three independent layers**: laya-mcp (Node stdio) → laya-server (FastAPI HTTP) → Laya (Python SDK). Any layer can be restarted without restarting the others.
- **No silent degradation**: if Laya is unreachable, the MCP server advertises **zero tools** so the agent sees nothing rather than tools that always fail.
- **Hard timeouts**: every HTTP call has a bounded timeout. The agent never hangs because of `laya-mcp`.
- **Structured errors**: when a tool does fail, the response is `{isError: true, content: [{type: "text", text: ...}]}` with a `hint` describing how to recover.
- **Stateless**: the MCP server holds no conversation state. Each tool call is independent.

---

## License

MIT. See [`LICENSE`](LICENSE).

The Laya model itself is Apache 2.0
([NandhaKishorM/laya](https://github.com/NandhaKishorM/laya)) and the
TypeSafe AI patterns this server is patterned on are theirs.

[mc