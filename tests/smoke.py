#!/usr/bin/env python3
"""
End-to-end smoke test for laya-mcp.

Spawns the laya-server in a subprocess, runs a few /predict calls against
each workflow builder, and asserts the response shape. Useful in CI and
for local debugging -- run after `pip install -r py/requirements.txt`.

Usage:
    python tests/smoke.py            # requires Laya installed (pip install laya)
    LAYA_SKIP=1 python tests/smoke.py  # skips the load check, still tests builders
    LAYA_PORT=8770 python tests/smoke.py  # spawn/wait on another port

Env:
    LAYA_PORT  port for the spawned laya-server (default 8766,
               backward-compatible). NOTE: 8766 is also the prescribed
               gliner-server port (GLINER_PORT) -- set LAYA_PORT to a free
               port whenever the gliner sidecar is up to avoid the bind
               collision (cierre-pendientes T7).
    LAYA_SKIP  "1" to skip the live /predict checks.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "py"))

from workflows import build_questions  # noqa: E402

TOOLS = [
    ("laya_screen", {"purpose": "extract pricing"}),
    ("laya_verify", {}),
    ("laya_find", {"query": "how to rotate API keys"}),
    ("laya_rerank", {"query": "why did bandwidth triple"}),
    ("laya_classify", {"purpose": "route support", "classes": [{"id": "billing", "description": "billing"}, {"id": "sales", "description": "sales"}]}),
    ("laya_decide", {"decision": "pick channel", "requirements": ["no paid service"]}),
    ("laya_compare", {"aspects": ["price"]}),
    ("laya_extract", {"field_descriptions": {"price_pro": "Pro plan price"}}),
    ("laya_review", {}),
    ("laya_gate", {"claims": ["tests pass"]}),
]

# 1. Sanity-check the workflow builders.
for name, args in TOOLS:
    q = build_questions(name, args)
    assert q, f"{name} returned empty questions payload"
print(f"OK -- all {len(TOOLS)} workflow builders returned non-empty payloads")

if os.getenv("LAYA_SKIP") == "1":
    print("LAYA_SKIP=1 -- skipping live /predict checks.")
    sys.exit(0)

# 2. Try to spawn laya-server and exercise one tool.
# Cierre-pendientes T7: single explicit PORT honors LAYA_PORT (default 8766,
# backward-compatible) for BOTH the spawned server env and the /health wait
# base below -- they must never diverge.
PORT = os.getenv("LAYA_PORT", "8766")
env = os.environ.copy()
env["LAYA_PORT"] = PORT  # spawned laya_server.py binds $LAYA_PORT (own default 8765)
env.setdefault("LAYA_MODEL", "convaiinnovations/laya-typed-decisions")
env.setdefault("LAYA_SUBFOLDER", "typed-decisions")
proc = subprocess.Popen(
    [sys.executable, str(ROOT / "py" / "laya_server.py")],
    cwd=str(ROOT),
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)

try:
    # Wait for /health
    base = f"http://127.0.0.1:{PORT}"
    deadline = time.time() + 60
    ready = False
    while time.time() < deadline:
        try:
            import urllib.request

            with urllib.request.urlopen(f"{base}/health", timeout=2) as r:
                if r.status == 200:
                    ready = True
                    break
        except Exception:
            time.sleep(1)
    if not ready:
        print("FAIL -- laya-server did not become ready in 60s")
        proc.terminate()
        sys.exit(1)

    print("OK -- laya-server ready")

    # Exercise one workflow
    import json
    import urllib.request

    payload = {
        "state": {"text": "Test ticket: please refund my duplicate charge."},
        "questions": build_questions(
            "laya_screen", {"purpose": "extract intent"}
        ),
    }
    req = urllib.request.Request(
        f"{base}/predict",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        body = json.loads(r.read())
    assert "answers" in body and body["answers"], "predict returned no answers"
    print(f"OK -- /predict returned {len(body['answers'])} answers in {body.get('latency_ms', 0):.1f}ms")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
