#!/usr/bin/env bash
# laya-mcp installer
#
# Idempotent. Re-running is safe. Does NOT touch your existing OpenCode,
# Claude Code, Codex, Pi, or Gentle-AI configuration unless you opt in
# at the end. This script only installs laya-mcp into $HOME/laya-mcp.

set -euo pipefail

WITH_GLINER=0
for arg in "$@"; do
  case "$arg" in
    --with-gliner) WITH_GLINER=1 ;;
    -h|--help)
      echo "Usage: ./install.sh [--with-gliner]"
      echo "  --with-gliner  also install the GLiNER2.5 sidecar (span extraction + PII, ~594 MB, CPU-friendly)"
      exit 0
      ;;
    *) err "unknown argument: $arg (see --help)"; exit 1 ;;
  esac
done

INSTALL_DIR="${LAYA_MCP_HOME:-$HOME/laya-mcp}"
PYTHON_BIN="${PYTHON:-python3}"
PORT="${LAYA_PORT:-8765}"
HOST="${LAYA_HOST:-127.0.0.1}"
GLINER_PORT="${GLINER_PORT:-8766}"
GLINER_HOST="${GLINER_HOST:-127.0.0.1}"

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
#
# Two supported flows:
#   1. Clone anywhere, run ./install.sh [--with-gliner] -> files are copied
#      into $INSTALL_DIR, then installed there.
#   2. Clone directly into $HOME/laya-mcp and run ./install.sh there.
# Re-running after a completed install is a no-op (sentinel file); edit or
# remove $INSTALL_DIR/.installed to force a reinstall step.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$INSTALL_DIR/.installed" ]; then
  say "laya-mcp already installed at $INSTALL_DIR"
  say "  -> run $INSTALL_DIR/uninstall.sh first to reinstall"
  exit 0
fi

mkdir -p "$INSTALL_DIR"
if [ ! -f "$INSTALL_DIR/package.json" ]; then
  if [ -f "$SCRIPT_DIR/package.json" ]; then
    say "copying sources $SCRIPT_DIR -> $INSTALL_DIR"
    # rsync when available (preserves perms, skips build artefacts), else cp.
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude=node_modules --exclude=dist --exclude=.venv --exclude=.git --exclude=py/__pycache__ "$SCRIPT_DIR/" "$INSTALL_DIR/"
    else
      rm -rf /tmp/laya-mcp-stage && mkdir -p /tmp/laya-mcp-stage
      cp -r "$SCRIPT_DIR/." /tmp/laya-mcp-stage/
      rm -rf /tmp/laya-mcp-stage/node_modules /tmp/laya-mcp-stage/dist /tmp/laya-mcp-stage/.venv /tmp/laya-mcp-stage/.git /tmp/laya-mcp-stage/py/__pycache__
      cp -r /tmp/laya-mcp-stage/. "$INSTALL_DIR/"
      rm -rf /tmp/laya-mcp-stage
    fi
  else
    err "no sources found: neither $INSTALL_DIR nor $SCRIPT_DIR contain package.json"
    exit 1
  fi
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

# laya-mcp uses laya.Router with auto_task_detection=True, which loads all
# three checkpoints (english, multilingual, typed-decisions) so script
# detection + workflow auto-detection work for both English and Spanish
# (and any other language Router can classify). Total disk: ~1.7 GB.
say "Router mode requires all 3 Laya checkpoints (english + multilingual + typed-decisions)"
if [ -z "${LAYA_MCP_NO_ALL:-}" ]; then
  if "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/py/download_models.py" --all-checkpoints 2>&1 | sed "s/^/  /"; then
    say "all 3 checkpoints (~1.7 GB) ready in the HuggingFace cache"
  else
    warn "one or more checkpoints failed to download -- the server will retry on first start"
  fi
else
  warn "LAYA_MCP_NO_ALL=1 -- only the default checkpoint will be downloaded; Router will download the others on first request"
  LAYA_MODEL="${LAYA_MODEL:-convaiinnovations/laya-typed-decisions}"
  "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/py/download_models.py" --model "$LAYA_MODEL" || true
fi

# -- optional GLiNER sidecar --------------------------------------------------

if [ "$WITH_GLINER" = 1 ]; then
  say "installing GLiNER sidecar dependencies (gliner2 + protobuf + torch, shared venv)"
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/.venv/bin/activate"
  pip install --quiet -r "$INSTALL_DIR/py/requirements-gliner.txt"
  say "pre-downloading GLiNER2.5 multilingual checkpoint (~594 MB)"
  if "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/py/download_models.py" --gliner 2>&1 | sed "s/^/  /"; then
    say "gliner2.5-multi-v1 ready in the HuggingFace cache"
  else
    warn "GLiNER checkpoint download failed -- gliner-server will retry on first start"
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

cat > "$INSTALL_DIR/start_gliner.sh" <<EOF
#!/usr/bin/env bash
# Start the gliner-server sidecar (optional span extraction + PII).
set -euo pipefail
INSTALL_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
HOST="\${GLINER_HOST:-${GLINER_HOST}}"
PORT="\${GLINER_PORT:-${GLINER_PORT}}"
exec "\$INSTALL_DIR/.venv/bin/python" "\$INSTALL_DIR/py/gliner_server.py"
EOF
chmod +x "$INSTALL_DIR/start_gliner.sh"

cat > "$INSTALL_DIR/doctor.sh" <<EOF
#!/usr/bin/env bash
# Run laya-mcp's diagnostic report. JSON output via --json.
set -euo pipefail
INSTALL_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
HOST="\${LAYA_HOST:-${HOST}}"
PORT="\${LAYA_PORT:-${PORT}}"
GHOST="\${GLINER_HOST:-${GLINER_HOST}}"
GPORT="\${GLINER_PORT:-${GLINER_PORT}}"
exec "\$INSTALL_DIR/.venv/bin/python" "\$INSTALL_DIR/py/doctor.py" --host "\$HOST" --port "\$PORT" --gliner-host "\$GHOST" --gliner-port "\$GPORT" "\$@"
EOF
chmod +x "$INSTALL_DIR/doctor.sh"

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
        "GLINER_URL": "http://${GLINER_HOST}:${GLINER_PORT}"
      },
      "enabled": true
    }
  }
}
EOF

# -- done -------------------------------------------------------------------

touch "$INSTALL_DIR/.installed"

cat <<MSG

$(printf '\033[1;32m✓\033[0m') laya-mcp installed to $INSTALL_DIR

  Start the laya-server (terminal 1):
    $INSTALL_DIR/start_laya.sh

$(if [ "$WITH_GLINER" = 1 ]; then printf '  Start the gliner-server sidecar (terminal 2, optional):\n    %s/start_gliner.sh\n\n' "$INSTALL_DIR"; fi)
  Then register laya-mcp with your agent:
    Edit ~/.config/opencode/opencode.json and merge examples/opencode.snippet.json
    into its "mcp" object. See README.md for one-line merge examples for each agent.

  Verify with:
    curl http://$HOST:$PORT/health
    $INSTALL_DIR/doctor.sh

  Uninstall at any time:
    $INSTALL_DIR/uninstall.sh

  Your existing setup was NOT touched. laya-mcp is fully optional.

MSG
