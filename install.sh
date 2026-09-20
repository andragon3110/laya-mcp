#!/usr/bin/env bash
# laya-mcp installer
#
# Idempotent. Re-running is safe. Does NOT touch your existing OpenCode,
# Claude Code, Codex, Pi, or Gentle-AI configuration unless you opt in
# at the end. This script only installs laya-mcp into $HOME/laya-mcp.

set -euo pipefail

INSTALL_DIR="${LAYA_MCP_HOME:-$HOME/laya-mcp}"
PYTHON_BIN="${PYTHON:-python3}"
PORT="${LAYA_PORT:-8765}"
HOST="${LAYA_HOST:-127.0.0.1}"

say() { printf '\033[1;34m[laya-mcp]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[laya-mcp]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[laya-mcp]\033[0m %s\n' "$*" >&2; }

# -- preflight -------------------------------------------------------------

command -v "$PYTHON_BIN" >/dev/null 2>&1 || { err "python3 not found (set PYTHON env var to override)"; exit 1; }
command -v node >/dev/null 2>&1 || { err "Node.js 20+ required (https://nodejs.org)"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm required"; exit 1; }

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then err "Node 20+ required (have $(node -v))"; exit 1; fi

# -- install directory ------------------------------------------------------

if [ -d "$INSTALL_DIR" ]; then
  say "laya-mcp already installed at $INSTALL_DIR"
  say "  -> run $INSTALL_DIR/uninstall.sh first to reinstall"
  exit 0
fi

say "installing into $INSTALL_DIR"

# -- python venv + dependencies --------------------------------------------

mkdir -p "$INSTALL_DIR"
"$PYTHON_BIN" -m venv "$INSTALL_DIR/.venv"
# shellcheck disable=SC1091
source "$INSTALL_DIR/.venv/bin/activate"
pip install --upgrade pip --quiet
pip install --quiet -r "$INSTALL_DIR/py/requirements.txt"

# -- node deps -------------------------------------------------------------

cd "$INSTALL_DIR"
if [ ! -f package.json ]; then
  err "package.json missing -- did you clone the repo into $INSTALL_DIR?"
  exit 1
fi
npm install --silent
npm run build --silent

# -- pre-download Laya model(s) ---------------------------------------------

LAYA_MODEL="${LAYA_MODEL:-convaiinnovations/laya-typed-decisions}"
say "pre-downloading Laya checkpoint: $LAYA_MODEL"
if ! "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/py/download_models.py" --model "$LAYA_MODEL"; then
  warn "model download failed (will retry on first laya-server start)"
fi

# Offer to also pull the multilingual + base checkpoints.
if [ -z "${LAYA_MCP_NO_ALL:-}" ]; then
  say "also pulling base + multilingual checkpoints (~ +1 GB) so the multilingual model is ready offline"
  if "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/py/download_models.py" --model convaiinnovations/laya >/dev/null 2>&1 \
    && "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/py/download_models.py" --model convaiinnovations/laya-multilingual >/dev/null 2>&1; then
    say "all three checkpoints ready in the HuggingFace cache"
  else
    warn "one or more auxiliary checkpoints failed to download -- only $LAYA_MODEL is local"
  fi
fi

# -- helper scripts ---------------------------------------------------------

cat > "$INSTALL_DIR/start_laya.sh" <<EOF
#!/usr/bin/env bash
# Start the laya-server (Python HTTP wrapper).
set -euo pipefail
INSTALL_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
HOST="\${LAYA_HOST:-${HOST}}"
PORT="\${LAYA_PORT:-${PORT}}"
exec "\$INSTALL_DIR/.venv/bin/python" "\$INSTALL_DIR/py/laya_server.py"
EOF
chmod +x "$INSTALL_DIR/start_laya.sh"

cat > "$INSTALL_DIR/start_mcp.sh" <<EOF
#!/usr/bin/env bash
# Start the MCP server (stdio) -- normally your agent launches this.
set -euo pipefail
INSTALL_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
exec node "\$INSTALL_DIR/dist/index.js"
EOF
chmod +x "$INSTALL_DIR/start_mcp.sh"

cat > "$INSTALL_DIR/uninstall.sh" <<'EOF'
#!/usr/bin/env bash
# Uninstall laya-mcp. Removes the install dir and any opencode.json MCP entry.
set -euo pipefail
INSTALL_DIR="${LAYA_MCP_HOME:-$HOME/laya-mcp}"
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "[laya-mcp] removed $INSTALL_DIR"
fi
CFG="$HOME/.config/opencode/opencode.json"
if [ -f "$CFG" ]; then
  cp "$CFG" "$CFG.backup.$(date +%s)"
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<PY
import json, pathlib
cfg_path = pathlib.Path("$CFG")
cfg = json.loads(cfg_path.read_text())
if "mcp" in cfg and "laya" in cfg.get("mcp", {}):
    del cfg["mcp"]["laya"]
cfg_path.write_text(json.dumps(cfg, indent=2))
PY
    echo "[laya-mcp] removed 'laya' from $CFG"
  fi
fi
echo "[laya-mcp] uninstall complete"
EOF
chmod +x "$INSTALL_DIR/uninstall.sh"

# -- snippet for the user ---------------------------------------------------

mkdir -p "$INSTALL_DIR/examples"
cat > "$INSTALL_DIR/examples/opencode.snippet.json" <<EOF
{
  "mcp": {
    "laya": {
      "type": "local",
      "command": ["node", "$INSTALL_DIR/dist/index.js"],
      "environment": {
        "LAYA_URL": "http://${HOST}:${PORT}",
        "LAYA_MODEL": "${LAYA_MODEL}",
        "LAYA_SUBFOLDER": "typed-decisions"
      },
      "enabled": true
    }
  }
}
EOF

# -- done -------------------------------------------------------------------

cat <<MSG

$(printf '\033[1;32m✓\033[0m') laya-mcp installed to $INSTALL_DIR

  Start the laya-server (terminal 1):
    $INSTALL_DIR/start_laya.sh

  Then register laya-mcp with your agent:
    Edit ~/.config/opencode/opencode.json and merge examples/opencode.snippet.json
    into its "mcp" object. See README.md for one-line merge examples for each agent.

  Verify with:
    curl $HOST:$PORT/health

  Uninstall at any time:
    $INSTALL_DIR/uninstall.sh

  Your existing setup was NOT touched. laya-mcp is fully optional.

MSG
