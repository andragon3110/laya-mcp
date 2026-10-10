#!/usr/bin/env python3
"""gliclass-server: classifier sidecar for laya-mcp (benchmark-ronda1 T5a).

Thin HTTP wrapper around knowledgator/gliclass-multilang-mini, a multilingual
GLiClass zero-shot classifier. It answers *which labels* fit a text
(classify primitive); Laya remains the judge for prod paths.

Control-surface template: py/qwen_rerank_server.py (read-only). Mirrored
contract: GET /live (never loads), non-warming GET /ready (200/503 snapshot),
GET /models (always 200, never loads), POST /predict. CPU default, device /
revision reporting, single-flight lazy load. Honesty vocabulary: revision is
null + revision_source="unpinned" because no pin is resolvable here; never
invent a hash.

Process independence: own OS process, own port (8770), own holder, no shared
state with laya-server (:8765), the GLiNER sidecars, qwen-rerank (:8768),
policylm (:8771) or promptguard (:8772). All sidecars may run concurrently.

HTTP contract (defined here):

  POST /predict {text, labels, threshold?} -> 200
    {"scores": [{"label": str, "score": float}], "flagged": [str],
     "latency_ms": float, "model": str, "count": int}
    - text: required non-empty string (refused past MAX_TEXT_CHARS with 413).
    - labels: required 1..25 non-empty strings (the checkpoint caps
      max_num_classes at 25; past that -> 413, never silently cut).
    - threshold: optional 0..1 (default 0.5); labels scoring >= threshold
      are listed in flagged.
    - scores are within-call only: never probabilities across calls, no
      cutoff on them is meaningful downstream beyond the echoed threshold.

  GET /ready (non-warming 200/503 snapshot), GET /models (always 200, never
  loads), GET /live: same shapes as the rerank sidecar, only `service`
  differs ("gliclass-server").

Backend note: GLiClass has no modeling code in transformers 5.19.0
(model_type `GLiClass` is unrecognised) and the checkpoint ships no remote
code, so inference goes through the `gliclass` PyPI package
(GLiClassModel + ZeroShotClassificationPipeline). When that package is not
installed the holder records an honest load error and /ready answers 503 --
a missing backend is never hidden.

Env: GLICLASS_MODEL (default knowledgator/gliclass-multilang-mini),
GLICLASS_DEVICE (cpu|cuda|auto, default cpu), GLICLASS_HOST, GLICLASS_PORT
(default 8770), GLICLASS_LOG_LEVEL, GLICLASS_LIMITS_MAX_TEXT_CHARS (2000),
GLICLASS_LIMITS_MAX_LABELS (25), GLICLASS_LIMITS_MAX_BODY_CHARS (100000).

Default port 8770. stdlib only (http.server): the benchmark venv carries
torch + transformers but no fastapi/uvicorn, and this task adds no deps.
"""
from __future__ import annotations

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
    level=os.getenv("GLICLASS_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("gliclass-server")

DEFAULT_MODEL = os.getenv("GLICLASS_MODEL", "knowledgator/gliclass-multilang-mini")
DEFAULT_DEVICE_SETTING = os.getenv("GLICLASS_DEVICE", "cpu")  # cpu|cuda|auto
DEFAULT_THRESHOLD = 0.5

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _resolve_device() -> str:
    req = DEFAULT_DEVICE_SETTING.lower()
    if req != "auto":
        return req
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_text_chars": _i("GLICLASS_LIMITS_MAX_TEXT_CHARS", 2000),
        "max_labels": _i("GLICLASS_LIMITS_MAX_LABELS", 25),
        "max_body_chars": _i("GLICLASS_LIMITS_MAX_BODY_CHARS", 100000),
    }


class _Holder:
    """Lazy GLiClass loader so the HTTP server boots even when weights or
    the `gliclass` package are missing. A failed construction records
    {error, at, attempts} instead of a permanent error; later callers fail
    fast until a retry is allowed. Any success clears error+attempts."""

    def __init__(self) -> None:
        self._pipe = None
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._device: Optional[str] = None
        self._loaded_at: Optional[float] = None
        self._mutex = threading.Lock()

    def _do_load(self) -> None:
        try:
            from gliclass import GLiClassModel, ZeroShotClassificationPipeline
            from transformers import AutoTokenizer
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"gliclass backend unavailable (needs the `gliclass` package): {exc!r}"
            ) from exc
        device = _resolve_device()
        log.info("loading GLiClass model=%s device=%s", DEFAULT_MODEL, device)
        model = GLiClassModel.from_pretrained(DEFAULT_MODEL)
        tokenizer = AutoTokenizer.from_pretrained(DEFAULT_MODEL)
        # The gliclass pipeline takes a torch-style device string.
        self._pipe = ZeroShotClassificationPipeline(
            model, tokenizer, classification_type="multi-label", device=device
        )
        self._device = device
        log.info("GLiClass ready on %s", device)

    def ensure(self) -> Any:
        if self._pipe is not None:
            return self._pipe
        with self._mutex:
            if self._pipe is not None:
                return self._pipe
            try:
                self._do_load()
            except Exception as exc:  # noqa: BLE001
                self._load_attempts += 1
                self._load_error = f"gliclass not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning(
                    "GLiClass load failed (attempt %d): %s",
                    self._load_attempts,
                    self._load_error,
                )
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._pipe

    def classify_sync(self, text: str, labels: List[str]) -> List[Dict[str, float]]:
        assert self._pipe is not None
        out = self._pipe(text, labels, threshold=0.0)
        # The pipeline returns a list of per-text result lists.
        rows = out[0] if isinstance(out, list) and out else out
        scores = {r["label"]: float(r["score"]) for r in rows}
        return [{"label": lab, "score": float(scores.get(lab, 0.0))} for lab in labels]

    def snapshot(self) -> Dict[str, Any]:
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION}
        if self._pipe is None and self._load_error is None:
            return {
                "ready": False, "reason": "not loaded yet (no load attempted)",
                "loaded": [],
                "failed": [{"name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
                            "error": "not loaded yet"}],
                "device": self._device, "versions": versions,
                "uptime_seconds": uptime, "load_attempts": self._load_attempts,
                "retry_after_seconds": 0.0,
            }
        if self._load_error is not None:
            return {
                "ready": False, "reason": self._load_error, "loaded": [],
                "failed": [{"name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
                            "error": self._load_error}],
                "device": self._device, "versions": versions,
                "uptime_seconds": uptime, "load_attempts": self._load_attempts,
                "retry_after_seconds": 1.0,
            }
        return {
            "ready": True, "reason": None, "loaded": [DEFAULT_MODEL], "failed": [],
            "device": self._device, "versions": versions,
            "uptime_seconds": uptime, "load_attempts": self._load_attempts,
            "retry_after_seconds": 0.0,
        }

    def models_info(self) -> List[Dict[str, Any]]:
        # revision is null + unpinned: no pin is resolvable offline here.
        return [{
            "name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
            "loaded": self._pipe is not None,
            "revision": None, "revision_source": "unpinned",
            "device": self._device if self._device is not None else DEFAULT_DEVICE_SETTING,
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


class _Handler(BaseHTTPRequestHandler):
    server_version = "gliclass-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:  # keep stderr for load events
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "gliclass-server",
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
                "service": "gliclass-server",
                "device": holder._device if holder._device is not None else DEFAULT_DEVICE_SETTING,
                "versions": {"server": SERVER_VERSION},
                "uptime_seconds": time.time() - _SERVER_START,
                "models": holder.models_info()})
        else:
            _send(self, 404, {"code": "not_found", "path": path})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/predict":
            _send(self, 404, {"code": "not_found", "path": path})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        limits = _limits_cfg()
        if length > limits["max_body_chars"]:
            _send(self, 413, {"code": "input_too_large", "field": "body",
                              "limit": limits["max_body_chars"], "actual": length,
                              "hint": "shorten text/labels or split the request"})
            return
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            _send(self, 400, {"code": "bad_json", "detail": repr(exc)})
            return
        text = payload.get("text")
        labels = payload.get("labels")
        threshold = payload.get("threshold", DEFAULT_THRESHOLD)
        if not isinstance(text, str) or not text:
            _send(self, 400, {"code": "bad_request", "field": "text",
                              "hint": "text must be a non-empty string"})
            return
        if len(text) > limits["max_text_chars"]:
            _send(self, 413, {"code": "input_too_large", "field": "text",
                              "limit": limits["max_text_chars"], "actual": len(text),
                              "hint": "shorten text to within GLICLASS_LIMITS_MAX_TEXT_CHARS chars"})
            return
        if (not isinstance(labels, list) or not labels
                or not all(isinstance(l, str) and l for l in labels)):
            _send(self, 400, {"code": "bad_request", "field": "labels",
                              "hint": "labels must be a non-empty list of non-empty strings"})
            return
        if len(labels) > limits["max_labels"]:
            _send(self, 413, {"code": "input_too_large", "field": "labels",
                              "limit": limits["max_labels"], "actual": len(labels),
                              "hint": "send at most GLICLASS_LIMITS_MAX_LABELS labels per request"})
            return
        try:
            threshold = float(threshold)
        except (TypeError, ValueError):
            _send(self, 400, {"code": "bad_request", "field": "threshold",
                              "hint": "threshold must be a number in [0, 1]"})
            return
        if not 0.0 <= threshold <= 1.0:
            _send(self, 400, {"code": "bad_request", "field": "threshold",
                              "hint": "threshold must be a number in [0, 1]"})
            return
        start = time.perf_counter()
        try:
            holder.ensure()
            scores = holder.classify_sync(text, labels)
        except RuntimeError as exc:
            _send(self, 503, {"code": "model_not_ready", "detail": str(exc)},
                  _retry_after(1.0))
            return
        except Exception as exc:  # noqa: BLE001
            _send(self, 500, {"code": "predict_error", "detail": repr(exc)})
            return
        flagged = [s["label"] for s in scores if s["score"] >= threshold]
        _send(self, 200, {"scores": scores, "flagged": flagged,
                          "threshold": threshold,
                          "latency_ms": (time.perf_counter() - start) * 1000.0,
                          "model": DEFAULT_MODEL, "count": len(labels)})


def main() -> None:
    host = os.getenv("GLICLASS_HOST", "127.0.0.1")
    port = int(os.getenv("GLICLASS_PORT", "8770"))
    log.info("gliclass-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
