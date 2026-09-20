#!/usr/bin/env bash
# Install (or refresh/remove) the laya-mcp policy block inside the
# Gentle-AI orchestrator prompt in opencode.json.
#
# The block is marker-delimited and fully optional: it tells the
# orchestrator to USE laya_* tools whenever they are present and to
# IGNORE this section entirely when they are not. If gentle-ai sync
# ever regenerates the orchestrator prompt, re-run this script.
#
# Usage:
#   ./scripts/apply-orchestrator-policy.sh            # install / refresh
#   ./scripts/apply-orchestrator-policy.sh --remove   # remove the block
#   ./scripts/apply-orchestrator-policy.sh --check    # exit 0 if present & current, 1 otherwise
#
# Env overrides: OPENCODE_JSON (default ~/.config/opencode/opencode.json)

set -euo pipefail

MODE="apply"
for arg in "$@"; do
  case "$arg" in
    --remove) MODE="remove" ;;
    --check) MODE="check" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 1 ;;
  esac
done

CFG="${OPENCODE_JSON:-$HOME/.config/opencode/opencode.json}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POLICY_FILE="$SCRIPT_DIR/../examples/gentle-orchestrator-policy.md"
ANCHOR="<!-- gentle-ai:sdd-model-assignments -->"
OPEN_MARK="<!-- laya-mcp:orchestrator-policy -->"
CLOSE_MARK="<!-- /laya-mcp:orchestrator-policy -->"

[ -f "$CFG" ] || { echo "config not found: $CFG" >&2; exit 1; }
[ -f "$POLICY_FILE" ] || { echo "policy file not found: $POLICY_FILE" >&2; exit 1; }

export CFG POLICY_FILE ANCHOR OPEN_MARK CLOSE_MARK MODE
python3 - <<'PY'
import json, os, re, sys, time, pathlib

cfg_path = pathlib.Path(os.environ["CFG"])
policy = pathlib.Path(os.environ["POLICY_FILE"]).read_text()
anchor = os.environ["ANCHOR"]
open_mark = os.environ["OPEN_MARK"]
close_mark = os.environ["CLOSE_MARK"]
mode = os.environ["MODE"]

data = json.loads(cfg_path.read_text())
try:
    prompt = data["agent"]["gentle-orchestrator"]["prompt"]
except KeyError:
    print("agent.gentle-orchestrator.prompt not found -- is Gentle-AI installed for opencode?", file=sys.stderr)
    sys.exit(1)

block_re = re.compile(re.escape(open_mark) + r".*?" + re.escape(close_mark) + r"\n*", re.S)
has_block = bool(block_re.search(prompt))

if mode == "check":
    if has_block and policy.strip() in prompt:
        print("orchestrator policy present and current")
        sys.exit(0)
    print("orchestrator policy missing or outdated", file=sys.stderr)
    sys.exit(1)

# Backup before any write.
backup = cfg_path.with_name(f"{cfg_path.name}.backup.{int(time.time())}")
backup.write_text(cfg_path.read_text())

if mode == "remove":
    if not has_block:
        print("no policy block present -- nothing to do")
        sys.exit(0)
    prompt = block_re.sub("", prompt)
else:  # apply / refresh
    if anchor not in prompt:
        print(f"anchor not found in orchestrator prompt: {anchor!r}", file=sys.stderr)
        print("Gentle-AI may have restructured the prompt -- refusing to guess a position.", file=sys.stderr)
        sys.exit(1)
    prompt = block_re.sub("", prompt)  # drop stale copy first (idempotent refresh)
    block = policy.rstrip("\n") + "\n"
    prompt = prompt.replace(anchor, block + "\n" + anchor, 1)

data["agent"]["gentle-orchestrator"]["prompt"] = prompt
cfg_path.write_text(json.dumps(data, indent=2))
print(f"done ({mode}); backup at {backup}")
PY
