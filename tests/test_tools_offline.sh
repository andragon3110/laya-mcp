#!/usr/bin/env bash
# Verify the MCP server behaves correctly when laya-server is DOWN.
# Expects: tools/list returns ONLY laya_capabilities (fase-5 T5 exemption:
# the meta tool stays advertised so hosts can tell MCP-alive/backend-down
# apart from MCP-dead), no crash, server stays alive.

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# Make sure no laya-server is reachable on the default port
curl --max-time 1 -fsS http://127.0.0.1:8765/health 2>/dev/null && {
  echo "laya-server is up -- this test expects it down. Stop it first."
  exit 1
} || echo "  -> confirmed: laya-server NOT running"

# Build first so dist/ exists.
npm run build --silent

# Run the server, send a tools/list via stdin JSON-RPC, expect only laya_capabilities.
node dist/index.js <<'JSON' 2>&1 | tee /tmp/laya-mcp-out.log
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
JSON

if grep -q '"name":"laya_capabilities"' /tmp/laya-mcp-out.log && ! grep -q '"name":"laya_screen"' /tmp/laya-mcp-out.log; then
  echo "OK -- tools/list returned only laya_capabilities (fase-5 T5 exemption)"
else
  echo "FAIL -- did not see the capabilities-only tools list"
  cat /tmp/laya-mcp-out.log
  exit 1
fi
