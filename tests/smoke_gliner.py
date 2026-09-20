#!/usr/bin/env python3
"""
End-to-end smoke test for the gliner-server sidecar.

Spawns py/gliner_server.py, waits for /health, then runs:
  1. Spanish entity extraction (persona / organización / lugar)
  2. PII scan (email + phone + secret)
  3. Zero-shot classification in Spanish

All assertions match behavior verified 2026-09-20 against
fastino/gliner2.5-multi-v1 on CUDA and CPU.

Usage:
    python tests/smoke_gliner.py
    GLINER_PORT=8767 python tests/smoke_gliner.py   # custom port
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = os.getenv("GLINER_PORT", "8766")
BASE = f"http://127.0.0.1:{PORT}"


def post(path: str, payload: dict, timeout: int = 30) -> tuple[int, dict]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read())


def main() -> int:
    env = os.environ.copy()
    env.setdefault("GLINER_PORT", PORT)
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "py" / "gliner_server.py")],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.time() + 180
        ready = False
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{BASE}/health", timeout=2) as r:
                    body = json.loads(r.read())
                    if r.status == 200 and body.get("ready"):
                        ready = True
                        print(f"OK -- gliner-server ready (device={body.get('device')})")
                        break
            except Exception:
                time.sleep(2)
        if not ready:
            print("FAIL -- gliner-server did not become ready in 180s")
            return 1

        # 1. Spanish entities with offsets
        status, body = post(
            "/extract_entities",
            {
                "text": "María García trabaja en Acme España en Madrid.",
                "labels": ["persona", "organización", "lugar"],
            },
        )
        assert status == 200, f"extract_entities HTTP {status}"
        found = {k for k, v in body["entities"].items() if v}
        assert {"persona", "organización", "lugar"} <= found, f"missing types: {found}"
        for spans in body["entities"].values():
            for s in spans:
                assert s["start"] is not None and s["end"] is not None, "offsets required"
        print(f"OK -- Spanish entities {sorted(found)} in {body['latency_ms']:.0f}ms")

        # 2. PII scan
        status, body = post(
            "/pii_scan",
            {"text": "Escribí a juan.perez@acme.com o llamá al +34 612 345 678. Token: ghp_AbC123xYz."},
        )
        assert status == 200, f"pii_scan HTTP {status}"
        types = {f["type"] for f in body["findings"]}
        assert "email" in types and "telefono" in types, f"PII missed: {types}"
        assert any(f["type"] == "token_secreto" for f in body["findings"]), "secret missed"
        print(f"OK -- PII findings {body['counts']} in {body['latency_ms']:.0f}ms")

        # 3. Spanish classification
        status, body = post(
            "/classify",
            {
                "text": "Me cobraron dos veces la factura de marzo, quiero un reembolso.",
                "tasks": {"intencion": ["facturacion", "soporte_tecnico", "ventas"]},
            },
        )
        assert status == 200, f"classify HTTP {status}"
        assert body["result"] == {"intencion": "facturacion"}, f"wrong class: {body['result']}"
        print(f"OK -- Spanish classify -> facturacion in {body['latency_ms']:.0f}ms")

        print("ALL GLINER SMOKE TESTS PASSED")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
