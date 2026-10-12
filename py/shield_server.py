#!/usr/bin/env python3
"""shield-server: classifier sidecar for laya-mcp (spike-guards S4 lane).

Thin HTTP wrapper around ZeroLeaks/shield-small, a binary BENIGN/INJECTION
prompt-injection classifier (118M int8 ONNX). It answers *whether a text* is
a prompt attack (screen/gate pre-filter primitive); Laya remains the judge
for prod paths. No handler or policy is touched by this process: it only
scores text over HTTP.

Control-surface template: py/qwen_rerank_server.py (contract style) via
py/promptguard_server.py (stdlib classifier shape, read-only). Mirrored
contract: GET /live (never loads), non-warming GET /ready (200/503
snapshot), GET /models (always 200, never loads), POST /predict plus POST
/screen (screen-compatible alias, identical body and shape). CPU only
(ONNX CPUExecutionProvider, matching the card). Honesty vocabulary:
revision is null + revision_source="unpinned" because no pin is resolvable
here; never invent a hash.

Process independence: own OS process, own port (8777), own holder, no shared
state with laya-server (:8765), the GLiNER sidecars, qwen-rerank (:8768),
gliclass (:8770), horizon-rerank (:8774) or jevk5 (:8775). All sidecars may
run concurrently.

HTTP contract (defined here):

  POST /predict {text} -> 200
    {"label": "SAFE" | "INJECTION", "score": float P(INJECTION),
     "scores": {"SAFE": float, "INJECTION": float},
     "latency_ms": float, "model": str}
    - text: required non-empty string (refused past MAX_TEXT_CHARS with
      413, never silently cut -- a cut text changes the verdict).
    - label maps the model head BENIGN->SAFE, INJECTION->INJECTION at the
      card-default threshold 0.5 (unmoved; SHIELD_THRESHOLD only exposes it).
      Scores are within-call only.
  POST /screen: identical request and response (screen-compatible alias).

INTERPRETER WARNING (load-bearing): this sidecar must run on a python that
carries onnxruntime + tokenizers + numpy (here: system python3, which has
onnxruntime 1.29.0). The repo venvs (py/.venv-r1, /home/andragon/laya-mcp/
.venv) do NOT carry onnxruntime, and this task installs nothing. Run with:
  python3 py/shield_server.py   (SHIELD_PORT=8777 default)
Weights stay in the HF cache; the snapshot classify.py is imported
read-only (sys.path append, no copy in the repo).

Env: SHIELD_MODEL (default ZeroLeaks/shield-small, informational),
SHIELD_MODEL_DIR (default: the HF-cache snapshot holding
onnx/model_quantized.onnx), SHIELD_THRESHOLD (default 0.5, card default),
SHIELD_HOST, SHIELD_PORT (default 8777),
SHIELD_LOG_LEVEL, SHIELD_LIMITS_MAX_TEXT_CHARS (2000),
SHIELD_LIMITS_MAX_BODY_CHARS (100000).

Default port 8777 (:8774 :8775 :8768 verified taken, :8776 free but the
task pins 8777 when free; 2026-10-11 probe). stdlib only (http.server):
this task adds no deps.
"""
from __future__ import annotations

import glob
import json
import logging
import math
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

logging.basicConfig(
    level=os.getenv("SHIELD_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("shield-server")

DEFAULT_MODEL = os.getenv("SHIELD_MODEL", "ZeroLeaks/shield-small")

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _default_model_dir() -> str:
    """Locate the HF-cache snapshot holding onnx/model_quantized.onnx.

    Env SHIELD_MODEL_DIR wins. Otherwise glob the hub cache for a snapshot
    of the ZeroLeaks/shield-small repo containing the quantized ONNX
    artifact (2026-10-11: snapshot 6637b21f...; the older snapshot has no
    onnx/ dir). Never invent a path: empty string when nothing matches, so
    the holder records an honest load error instead of crashing at import.
    """
    explicit = os.getenv("SHIELD_MODEL_DIR")
    if explicit:
        return explicit
    hub = os.path.expanduser("~/.cache/huggingface/hub/models--ZeroLeaks--shield-small/snapshots")
    candidates = sorted(glob.glob(os.path.join(hub, "*", "onnx", "model_quantized.onnx")))
    if candidates:
        return os.path.dirname(os.path.dirname(candidates[0]))
    return ""


DEFAULT_MODEL_DIR = _default_model_dir()


def _threshold() -> float:
    try:
        t = float(os.getenv("SHIELD_THRESHOLD", "0.5"))
    except ValueError:
        return 0.5
    if not math.isfinite(t) or not 0.0 <= t <= 1.0:
        return 0.5
    return t


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_text_chars": _i("SHIELD_LIMITS_MAX_TEXT_CHARS", 2000),
        "max_body_chars": _i("SHIELD_LIMITS_MAX_BODY_CHARS", 100000),
    }


class _Holder:
    """Lazy Shield-Small loader so the HTTP server boots even when weights
    are missing.

    A failed construction records {error, at, attempts} instead of a
    permanent error; later callers fail fast. Any success clears
    error+attempts. The loaded unit is a ShieldSmall instance (imported
    read-only from the HF snapshot's classify.py); inference runs on the
    calling thread pool (ONNX intra_op=2 per the card)."""

    def __init__(self) -> None:
        self._model = None
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._loaded_at: Optional[float] = None
        self._model_dir: Optional[str] = None
        self._mutex = threading.Lock()

    def _do_load(self) -> None:
        model_dir = os.getenv("SHIELD_MODEL_DIR", DEFAULT_MODEL_DIR)
        if not model_dir or not os.path.isfile(os.path.join(model_dir, "onnx", "model_quantized.onnx")):
            raise RuntimeError(
                f"shield not loaded: no snapshot with onnx/model_quantized.onnx "
                f"(SHIELD_MODEL_DIR={model_dir!r}); weights live in the HF cache only")
        # Import the card's own classifier read-only: no copy in the repo,
        # no rewrite of its windowing/threshold logic.
        if model_dir not in sys.path:
            sys.path.insert(0, model_dir)
        try:
            from classify import ShieldSmall  # type: ignore  # noqa: E402
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"shield not loaded: snapshot classify.py unimportable: {exc!r}") from exc
        try:
            model = ShieldSmall(model_dir)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"shield not loaded: {exc!r}") from exc
        self._model = model
        self._model_dir = model_dir
        log.info("Shield ready: %s (dir=%s)", DEFAULT_MODEL, model_dir)

    def ensure(self) -> Any:
        if self._model is not None:
            return self._model
        with self._mutex:
            if self._model is not None:
                return self._model
            try:
                self._do_load()
            except Exception as exc:  # noqa: BLE001
                self._load_attempts += 1
                self._load_error = f"shield not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning("Shield load failed (attempt %d): %s",
                            self._load_attempts, self._load_error)
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._model

    def reset(self) -> Dict[str, Any]:
        """Operational (non-destructive) reset of load failure-tracking.

        Clears the cached {error, at, attempts} so the next use retries
        construction immediately. Never unloads a healthy model.
        """
        had_error = self._load_error is not None
        cleared_attempts = self._load_attempts
        self._load_error = None
        self._load_error_at = None
        self._load_attempts = 0
        return {
            "cleared_error": had_error,
            "cleared_attempts": cleared_attempts,
            "loaded": self._model is not None,
        }

    def classify_sync(self, text: str) -> Dict[str, Any]:
        assert self._model is not None
        out = self._model.classify(text, _threshold())
        raw = str(out.get("label", "BENIGN"))
        score = float(out.get("score", 0.0))
        # Contract mapping (S4 lane): model BENIGN -> SAFE; INJECTION stays.
        # score is P(INJECTION) either way (1-score for the benign side).
        label = "INJECTION" if raw == "INJECTION" else "SAFE"
        return {
            "label": label,
            "score": score,
            "scores": {"INJECTION": score, "SAFE": 1.0 - score},
        }

    def snapshot(self) -> Dict[str, Any]:
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION}
        if self._model is None and self._load_error is None:
            return {
                "ready": False, "reason": "not loaded yet (no load attempted)",
                "loaded": [],
                "failed": [{"name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
                            "error": "not loaded yet"}],
                "device": "cpu", "versions": versions,
                "uptime_seconds": uptime, "load_attempts": self._load_attempts,
                "retry_after_seconds": 0.0,
            }
        if self._load_error is not None:
            return {
                "ready": False, "reason": self._load_error, "loaded": [],
                "failed": [{"name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
                            "error": self._load_error}],
                "device": "cpu", "versions": versions,
                "uptime_seconds": uptime, "load_attempts": self._load_attempts,
                "retry_after_seconds": 1.0,
            }
        return {
            "ready": True, "reason": None, "loaded": [DEFAULT_MODEL], "failed": [],
            "device": "cpu", "versions": versions,
            "uptime_seconds": uptime, "load_attempts": self._load_attempts,
            "retry_after_seconds": 0.0,
        }

    def models_info(self) -> List[Dict[str, Any]]:
        # revision is null + unpinned: no pin is resolvable offline here.
        return [{
            "name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
            "loaded": self._model is not None,
            "revision": None, "revision_source": "unpinned",
            "device": "cpu",
        }]


holder = _Holder()


def _send(handler: BaseHTTPRequestHandler, status: int, obj: Dict[str, Any],
          headers: Optional[Dict[str, str]] = None) -> None:
    body = json.dumps(obj).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    for k, v in (headers or {}).items():
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(body)


def _retry_after(seconds: float) -> Dict[str, str]:
    return {"Retry-After": str(max(1, math.ceil(seconds)))}


def _handle_predict(handler: BaseHTTPRequestHandler) -> None:
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    limits = _limits_cfg()
    if length > limits["max_body_chars"]:
        _send(handler, 413, {"code": "input_too_large", "field": "body",
                             "limit": limits["max_body_chars"], "actual": length,
                             "hint": "shorten the text or split the request"})
        return
    try:
        payload = json.loads(handler.rfile.read(length) or b"{}")
    except Exception as exc:  # noqa: BLE001
        _send(handler, 400, {"code": "bad_json", "detail": repr(exc)})
        return
    text = payload.get("text")
    if not isinstance(text, str) or not text:
        _send(handler, 400, {"code": "bad_request", "field": "text",
                             "hint": "text must be a non-empty string"})
        return
    if len(text) > limits["max_text_chars"]:
        _send(handler, 413, {"code": "input_too_large", "field": "text",
                             "limit": limits["max_text_chars"], "actual": len(text),
                             "hint": "shorten text to within SHIELD_LIMITS_MAX_TEXT_CHARS chars"})
        return
    start = time.perf_counter()
    try:
        holder.ensure()
        out = holder.classify_sync(text)
    except RuntimeError as exc:
        _send(handler, 503, {"code": "model_not_ready", "detail": str(exc)},
              _retry_after(1.0))
        return
    except Exception as exc:  # noqa: BLE001
        _send(handler, 500, {"code": "predict_error", "detail": repr(exc)})
        return
    _send(handler, 200, {**out,
                         "latency_ms": (time.perf_counter() - start) * 1000.0,
                         "model": DEFAULT_MODEL})


class _Handler(BaseHTTPRequestHandler):
    server_version = "shield-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "shield-server",
                              "version": SERVER_VERSION,
                              "uptime_seconds": time.time() - _SERVER_START})
        elif path == "/ready":
            info = holder.snapshot()
            if not info.get("ready"):
                _send(self, 503, {"status": "not_ready", **info},
                      _retry_after(float(info.get("retry_after_seconds") or 0.0)))
            else:
                _send(self, 200, {"status": "ready", **info})
        elif path == "/models":
            _send(self, 200, {
                "service": "shield-server",
                "device": "cpu",
                "versions": {"server": SERVER_VERSION},
                "uptime_seconds": time.time() - _SERVER_START,
                "models": holder.models_info()})
        else:
            _send(self, 404, {"code": "not_found", "path": path})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/predict" or path == "/screen":
            _handle_predict(self)
            return
        if path == "/reload":
            _send(self, 200, {"status": "reloaded", "service": "shield-server",
                              **holder.reset()})
            return
        _send(self, 404, {"code": "not_found", "path": path})


def main() -> None:
    host = os.getenv("SHIELD_HOST", "127.0.0.1")
    port = int(os.getenv("SHIELD_PORT", "8777"))
    log.info("shield-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
