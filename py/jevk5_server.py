#!/usr/bin/env python3
"""jevk5-server: classifier sidecar for laya-mcp (spike-jevk5 S1).

Thin HTTP wrapper around alibiserikbay/JevK5-Lite, a 437M DeBERTa-v3-large
CPU zero-shot classifier (multi-head, one encoder pass, calibrated
probabilities per head; runtime jevk5 0.3.1). It answers *which labels* fit
a text (classify primitive) and 3-way NLI-style verdicts for gate claims
(premise/hypothesis text vs entailment/contradiction/neutral labels; the
verdict mapping lives in the measurement client, never here).

Control-surface template: py/gliclass_server.py (read-only). Mirrored
contract: GET /live (never loads), non-warming GET /ready (200/503 snapshot),
GET /models (always 200, never loads), POST /predict. CPU default, device /
revision reporting, single-flight lazy load. Honesty vocabulary: revision is
null + revision_source="unpinned" because no pin is resolvable here; never
invent a hash.

Process independence: own OS process, own port (8775), own holder, no shared
state with laya-server (:8765), the GLiNER sidecars, qwen-rerank (:8768),
gliclass (:8770), policylm (:8771), promptguard (:8772), gte (:8773), or
horizon-rerank (:8774). All sidecars may run concurrently.

HTTP contract (defined here):

  POST /predict {text, labels, threshold?, multi_label?} -> 200
    {"scores": [{"label": str, "score": float}], "flagged": [str],
     "threshold": float, "latency_ms": float, "model": str, "count": int}
    - text: required non-empty string (refused past MAX_TEXT_CHARS with 413).
    - labels: required 1..25 non-empty strings (past that -> 413, never
      silently cut).
    - threshold: optional 0..1 (default 0.5); labels scoring >= threshold
      are listed in flagged. Single-label heads return top-1 in flagged
      only when it clears the threshold (argmax routing is the client's
      business, never this server's).
    - multi_label: optional bool (default false). False -> single-label
      head (softmax within head, temperature_single 1.87). True ->
      multi-label head (sigmoid per label, temperature_multi 1.32;
      flagged = every label with p >= threshold).
    - scores are within-call only: never probabilities across calls, no
      cutoff on them is meaningful downstream beyond the echoed threshold.
      Calibration note: temperatures were fitted on held-out synthetic
      data; the model card reports ECE 0.035-0.103 on six neutral
      single-label sets but 0.255 (overconfident) on fast-decisions dev.
      Treat every score as uncalibrated until measured HERE (spike S2).

  GET /ready (non-warming 200/503 snapshot), GET /models (always 200, never
  loads), GET /live: same shapes as the gliclass sidecar, only `service`
  differs ("jevk5-server").

Backend note: inference goes through the `jevk5` PyPI/git package
(JevK5Lite.from_pretrained + .classify, jevk5 0.3.1). When that package is
not installed the holder records an honest load error and /ready answers
503 -- a missing backend is never hidden.

Env: JEVK5_MODEL (default alibiserikbay/JevK5-Lite),
JEVK5_DEVICE (cpu|cuda, default cpu), JEVK5_DTYPE (bf16|fp32, default bf16
with fp32 fallback when bf16 is unsupported), JEVK5_THREADS (default 8),
JEVK5_HOST, JEVK5_PORT (default 8775), JEVK5_LOG_LEVEL,
JEVK5_LIMITS_MAX_TEXT_CHARS (2000), JEVK5_LIMITS_MAX_LABELS (25),
JEVK5_LIMITS_MAX_BODY_CHARS (100000).

Default port 8775. stdlib only (http.server): this task adds no deps
beyond the jevk5 runtime installed in py/.venv-r1.
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
    level=os.getenv("JEVK5_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("jevk5-server")

DEFAULT_MODEL = os.getenv("JEVK5_MODEL", "alibiserikbay/JevK5-Lite")
DEFAULT_DEVICE_SETTING = os.getenv("JEVK5_DEVICE", "cpu")  # cpu|cuda
DEFAULT_DTYPE_SETTING = os.getenv("JEVK5_DTYPE", "bf16")  # bf16|fp32
DEFAULT_THREADS = int(os.getenv("JEVK5_THREADS", "8"))
DEFAULT_THRESHOLD = 0.5
HEAD_NAME = "head"

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_text_chars": _i("JEVK5_LIMITS_MAX_TEXT_CHARS", 2000),
        "max_labels": _i("JEVK5_LIMITS_MAX_LABELS", 25),
        "max_body_chars": _i("JEVK5_LIMITS_MAX_BODY_CHARS", 100000),
    }


class _Holder:
    """Lazy JevK5-Lite loader so the HTTP server boots even when weights or
    the `jevk5` package are missing. A failed construction records
    {error, at, attempts} instead of a permanent error; later callers fail
    fast until a retry is allowed. Any success clears error+attempts."""

    def __init__(self) -> None:
        self._lite = None
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._device: Optional[str] = None
        self._dtype: Optional[str] = None
        self._loaded_at: Optional[float] = None
        self._mutex = threading.Lock()

    def _do_load(self) -> None:
        try:
            import torch  # noqa: F401
            from jevk5 import JevK5Lite
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"jevk5 backend unavailable (needs the `jevk5` package in "
                f"py/.venv-r1): {exc!r}"
            ) from exc
        import torch

        device = DEFAULT_DEVICE_SETTING.lower()
        want = DEFAULT_DTYPE_SETTING.lower()
        dtype = torch.float32
        dtype_name = "fp32"
        if want == "bf16":
            try:
                probe = torch.zeros(2, dtype=torch.bfloat16)
                _ = probe + probe
                dtype = torch.bfloat16
                dtype_name = "bf16"
            except Exception as exc:  # noqa: BLE001
                log.warning("bf16 probe failed, falling back to fp32: %r", exc)
        log.info("loading JevK5 model=%s device=%s dtype=%s threads=%d",
                 DEFAULT_MODEL, device, dtype_name, DEFAULT_THREADS)
        self._lite = JevK5Lite.from_pretrained(
            DEFAULT_MODEL, device=device, dtype=dtype,
            threads=DEFAULT_THREADS,
        )
        self._device = device
        self._dtype = dtype_name
        log.info("JevK5 ready on %s (%s)", device, dtype_name)

    def ensure(self) -> Any:
        if self._lite is not None:
            return self._lite
        with self._mutex:
            if self._lite is not None:
                return self._lite
            try:
                self._do_load()
            except Exception as exc:  # noqa: BLE001
                self._load_attempts += 1
                self._load_error = f"jevk5 not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning(
                    "JevK5 load failed (attempt %d): %s",
                    self._load_attempts,
                    self._load_error,
                )
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._lite

    def classify_sync(self, text: str, labels: List[str],
                      multi_label: bool) -> List[Dict[str, float]]:
        assert self._lite is not None
        if multi_label:
            tasks = {HEAD_NAME: {"labels": labels, "multi_label": True}}
        else:
            tasks = {HEAD_NAME: labels}
        out = self._lite.classify(text, tasks)
        probs = out[HEAD_NAME]["probabilities"]
        return [{"label": lab, "score": float(probs.get(lab, 0.0))}
                for lab in labels]

    def snapshot(self) -> Dict[str, Any]:
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION, "jevk5_runtime": "0.3.1"}
        if self._lite is None and self._load_error is None:
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
            "device": self._device, "dtype": self._dtype,
            "versions": versions,
            "uptime_seconds": uptime, "load_attempts": self._load_attempts,
            "retry_after_seconds": 0.0,
        }

    def models_info(self) -> List[Dict[str, Any]]:
        # revision is null + unpinned: no pin is resolvable offline here.
        return [{
            "name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
            "loaded": self._lite is not None,
            "revision": None, "revision_source": "unpinned",
            "device": self._device if self._device is not None else DEFAULT_DEVICE_SETTING,
            "dtype": self._dtype,
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
    server_version = "jevk5-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:  # keep stderr for load events
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "jevk5-server",
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
                "service": "jevk5-server",
                "device": holder._device if holder._device is not None else DEFAULT_DEVICE_SETTING,
                "versions": {"server": SERVER_VERSION, "jevk5_runtime": "0.3.1"},
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
        multi_label = payload.get("multi_label", False)
        if not isinstance(text, str) or not text:
            _send(self, 400, {"code": "bad_request", "field": "text",
                              "hint": "text must be a non-empty string"})
            return
        if len(text) > limits["max_text_chars"]:
            _send(self, 413, {"code": "input_too_large", "field": "text",
                              "limit": limits["max_text_chars"], "actual": len(text),
                              "hint": "shorten text to within JEVK5_LIMITS_MAX_TEXT_CHARS chars"})
            return
        if (not isinstance(labels, list) or not labels
                or not all(isinstance(l, str) and l for l in labels)):
            _send(self, 400, {"code": "bad_request", "field": "labels",
                              "hint": "labels must be a non-empty list of non-empty strings"})
            return
        if len(labels) > limits["max_labels"]:
            _send(self, 413, {"code": "input_too_large", "field": "labels",
                              "limit": limits["max_labels"], "actual": len(labels),
                              "hint": "send at most JEVK5_LIMITS_MAX_LABELS labels per request"})
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
        if not isinstance(multi_label, bool):
            _send(self, 400, {"code": "bad_request", "field": "multi_label",
                              "hint": "multi_label must be a boolean"})
            return
        start = time.perf_counter()
        try:
            holder.ensure()
            scores = holder.classify_sync(text, labels, multi_label)
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
                          "multi_label": multi_label,
                          "latency_ms": (time.perf_counter() - start) * 1000.0,
                          "model": DEFAULT_MODEL, "count": len(labels)})


def main() -> None:
    host = os.getenv("JEVK5_HOST", "127.0.0.1")
    port = int(os.getenv("JEVK5_PORT", "8775"))
    log.info("jevk5-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
