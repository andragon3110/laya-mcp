#!/usr/bin/env python3
"""thx-server: classifier sidecar for laya-mcp (bench-ronda3 G1).

Thin HTTP wrapper around doofz/THX-01, a fast non-autoregressive System 1
decision model (choice/noul/score + number/excerpt/cite) served here for
the classify primitive only; Laya remains the judge for prod paths.

Control-surface template: py/gliclass_server.py (read-only). Mirrored
contract: GET /live (never loads), non-warming GET /ready (200/503
snapshot), GET /models (always 200, never loads), POST /predict. CPU only,
revision reporting, single-flight lazy load. Honesty vocabulary: revision
is null + revision_source="unpinned" because no pin is resolvable here;
never invent a hash. The actually-resolved repo sha (observed via the HF
API at setup time) is recorded in odd/tasks/spike-g1-arc-zesyde-thx.md,
not claimed by this server.

Process independence: own OS process, own port (8776), own holder, no
shared state with laya-server (:8765) or any other sidecar. All sidecars
may run concurrently.

HTTP contract (defined here):

  POST /predict {text, labels, threshold?} -> 200
    {"scores": [{"label": str, "score": float}], "flagged": [str],
     "latency_ms": float, "model": str, "count": int}
    - text: required non-empty string (refused past MAX_TEXT_CHARS with 413).
    - labels: required 1..25 non-empty strings (past that -> 413, never
      silently cut). One label is answered as a choice against an "other"
      contrast (a 1-option choice is degenerate p=[1.0]); only requested
      labels are reported.
    - threshold: optional 0..1 (default 0.5); labels scoring >= threshold
      are listed in flagged.
    - scores are within-call only: never probabilities across calls, no
      cutoff on them is meaningful downstream beyond the echoed threshold.
      (THX-01 ships temperature scaling + reliability plots, but no
      reliability diagram + ECE under OUR harness exists yet, so no
      probability is claimed here.)

  GET /ready (non-warming 200/503 snapshot), GET /models (always 200, never
  loads), GET /live: same shapes as the gliclass sidecar, only `service`
  differs ("thx-server").

Backend note: inference goes through the `thx01` PyPI package
(thx01.load + Agent.predict with a single choice question). Weights
resolve into the HF cache via snapshot_download inside the package
(never git). THX_HALF=0 by default (fp32 on CPU: fp16 matmuls are poorly
supported on torch CPU); set THX_HALF=1 to restore the package default.
When the backend is unavailable the holder records an honest load error
and /ready answers 503 -- a missing backend is never hidden.

Env: THX_MODEL (default doofz/THX-01), THX_SUBFOLDER (default: none, root
English checkpoint; the repo bundles sibling checkpoints incl.
"multilingual" -- set THX_SUBFOLDER=multilingual to probe it),
THX_DEVICE, THX_HALF (0|1, default 0), THX_HOST, THX_PORT (default 8776),
THX_LOG_LEVEL, THX_LIMITS_MAX_TEXT_CHARS (2000),
THX_LIMITS_MAX_LABELS (25), THX_LIMITS_MAX_BODY_CHARS (100000),
THX_MAX_INFLIGHT (2).

Default port 8776. stdlib only (http.server): no extra deps.
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
    level=os.getenv("THX_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("thx-server")

DEFAULT_MODEL = os.getenv("THX_MODEL", "doofz/THX-01")
DEFAULT_SUBFOLDER = os.getenv("THX_SUBFOLDER") or None
DEFAULT_THRESHOLD = 0.5
_SINGLE_CONTRAST = "other"

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _half() -> bool:
    return os.getenv("THX_HALF", "0") not in ("0", "false", "False")


def _device() -> Optional[str]:
    return os.getenv("THX_DEVICE") or None


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_text_chars": _i("THX_LIMITS_MAX_TEXT_CHARS", 2000),
        "max_labels": _i("THX_LIMITS_MAX_LABELS", 25),
        "max_body_chars": _i("THX_LIMITS_MAX_BODY_CHARS", 100000),
    }


def _max_inflight() -> int:
    try:
        return max(1, int(os.getenv("THX_MAX_INFLIGHT", "2")))
    except ValueError:
        return 2


class _Holder:
    """Lazy THX-01 loader so the HTTP server boots even when weights or the
    `thx01` package are missing. A failed construction records
    {error, at, attempts} instead of a permanent error; later callers fail
    fast until a retry is allowed. Any success clears error+attempts."""

    def __init__(self) -> None:
        self._agent = None
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._loaded_at: Optional[float] = None
        self._mutex = threading.Lock()
        self._inflight = threading.Semaphore(_max_inflight())

    def _do_load(self) -> None:
        try:
            import thx01
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"thx01 backend unavailable (needs the `thx01` package): {exc!r}"
            ) from exc
        log.info(
            "loading THX-01 model=%s subfolder=%s half=%s device=%s",
            DEFAULT_MODEL, DEFAULT_SUBFOLDER, _half(), _device() or "auto",
        )
        self._agent = thx01.load(
            DEFAULT_MODEL,
            device=_device(),
            subfolder=DEFAULT_SUBFOLDER,
            half=_half(),
        )
        log.info("THX-01 ready")

    def ensure(self) -> Any:
        if self._agent is not None:
            return self._agent
        with self._mutex:
            if self._agent is not None:
                return self._agent
            try:
                self._do_load()
            except Exception as exc:  # noqa: BLE001
                self._load_attempts += 1
                self._load_error = f"thx01 not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning(
                    "THX-01 load failed (attempt %d): %s",
                    self._load_attempts,
                    self._load_error,
                )
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._agent

    def classify_sync(self, text: str, labels: List[str]) -> List[Dict[str, float]]:
        assert self._agent is not None
        options = list(labels)
        if len(options) == 1:
            # A 1-option choice is degenerate (p=[1.0]); contrast against
            # "other" and report only the requested label (documented).
            options = options + [_SINGLE_CONTRAST]
        questions = {
            "classify": {
                "type": "choice",
                "instructions": "Select the label that best fits the text.",
                "criteria": {name: "" for name in options},
            }
        }
        res = self._agent.predict(text, questions)
        answers = res.get("answers", {}) if isinstance(res, dict) else {}
        ans = answers.get("classify", {}) if isinstance(answers, dict) else {}
        probs = ans.get("probabilities", {}) if isinstance(ans, dict) else {}
        return [{"label": lab, "score": float(probs.get(lab, 0.0))} for lab in labels]

    def snapshot(self) -> Dict[str, Any]:
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION}
        if self._agent is None and self._load_error is None:
            return {
                "ready": False, "reason": "not loaded yet (no load attempted)",
                "loaded": [],
                "failed": [{"name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
                            "error": "not loaded yet"}],
                "device": _device() or "auto", "versions": versions,
                "uptime_seconds": uptime, "load_attempts": self._load_attempts,
                "retry_after_seconds": 0.0,
            }
        if self._load_error is not None:
            return {
                "ready": False, "reason": self._load_error, "loaded": [],
                "failed": [{"name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
                            "error": self._load_error}],
                "device": _device() or "auto", "versions": versions,
                "uptime_seconds": uptime, "load_attempts": self._load_attempts,
                "retry_after_seconds": 1.0,
            }
        return {
            "ready": True, "reason": None, "loaded": [DEFAULT_MODEL], "failed": [],
            "device": _device() or "auto", "versions": versions,
            "uptime_seconds": uptime, "load_attempts": self._load_attempts,
            "retry_after_seconds": 0.0,
        }

    def models_info(self) -> List[Dict[str, Any]]:
        # revision is null + unpinned: no pin is resolvable offline here.
        return [{
            "name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
            "loaded": self._agent is not None,
            "revision": None, "revision_source": "unpinned",
            "device": _device() or "auto",
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
    server_version = "thx-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:  # keep stderr for load events
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "thx-server",
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
                "service": "thx-server",
                "device": _device() or "auto",
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
                              "hint": "shorten text to within THX_LIMITS_MAX_TEXT_CHARS chars"})
            return
        if (not isinstance(labels, list) or not labels
                or not all(isinstance(l, str) and l for l in labels)):
            _send(self, 400, {"code": "bad_request", "field": "labels",
                              "hint": "labels must be a non-empty list of non-empty strings"})
            return
        if len(labels) > limits["max_labels"]:
            _send(self, 413, {"code": "input_too_large", "field": "labels",
                              "limit": limits["max_labels"], "actual": len(labels),
                              "hint": "send at most THX_LIMITS_MAX_LABELS labels per request"})
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
        if not holder._inflight.acquire(blocking=False):
            _send(self, 503, {"code": "inflight_saturated",
                              "detail": "thx01 busy; retry shortly",
                              "retry_after_seconds": 1.0},
                  _retry_after(1.0))
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
        finally:
            holder._inflight.release()
        flagged = [s["label"] for s in scores if s["score"] >= threshold]
        _send(self, 200, {"scores": scores, "flagged": flagged,
                          "threshold": threshold,
                          "latency_ms": (time.perf_counter() - start) * 1000.0,
                          "model": DEFAULT_MODEL, "count": len(labels)})


def main() -> None:
    host = os.getenv("THX_HOST", "127.0.0.1")
    port = int(os.getenv("THX_PORT", "8776"))
    log.info("thx-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
