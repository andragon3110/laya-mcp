#!/usr/bin/env python3
"""policylm-server: classifier sidecar for laya-mcp (benchmark-ronda1 T5a).

Thin HTTP wrapper around musubilabs/policylm-1.7b at revision v1.2, an
open-weights moderation classifier that scores one message against caller
supplied policy categories. It answers *which policy rules* a message breaks
(classify primitive); Laya remains the judge for prod paths.

Control-surface template: py/qwen_rerank_server.py (read-only). Mirrored
contract: GET /live (never loads), non-warming GET /ready (200/503 snapshot),
GET /models (always 200, never loads), POST /predict. CPU default, device /
revision reporting, single-flight lazy load. Revision is pinned: "v1.2"
(revision_source="pinned").

Process independence: own OS process, own port (8771), own holder, no shared
state with laya-server (:8765), the GLiNER sidecars, qwen-rerank (:8768),
gliclass (:8770) or promptguard (:8772). All sidecars may run concurrently.

HTTP contract (defined here):

  POST /predict {message, categories?, policy?} -> 200
    {"flagged": bool, "score": float, "cutoff": float, "violations": [str],
     "categories": {title: {"score": float, "flagged": bool}},
     "latency_ms": float, "model": str, "revision": "v1.2"}
    - message: required non-empty string (refused past MAX_MESSAGE_CHARS
      with 413, never silently cut -- a cut message changes the verdict).
    - categories: list of 1..16 entries, each a plain string (title only)
      or {title, violation_rule?, not_violation_rule?,
      exception_override?}. Title-only categories are outside what the
      cutoffs were fitted on (the helper warns once); pass rules for
      calibrated explicit-mode decisions.
    - policy: the string "aegis" selects the 23 built-in Aegis 2.0
      categories instead of explicit ones; "aegis" and categories are
      mutually exclusive.
    - Scores are within-call only: the helper packs rows per forward pass,
      so scores can move with batch composition; no cutoff on raw scores is
      meaningful downstream beyond the returned decision.

Backend note: PolicyLM is self-contained (no trust_remote_code, no second
download). The release's inference helper (inference/policylm_infer.py plus
its vendored inference/bidirlm/ encoder) is imported from the v1.2 snapshot
in the default HF cache; weights load from that snapshot. Verified release
layout: model.safetensors, config.json, threshold_manifest.json,
tokenizer/.

Env: POLICYLM_MODEL (default musubilabs/policylm-1.7b), POLICYLM_REVISION
(default v1.2), POLICYLM_DEVICE (auto|cpu|cuda|mps, default cpu),
POLICYLM_HOST, POLICYLM_PORT (default 8771), POLICYLM_LOG_LEVEL,
POLICYLM_LIMITS_MAX_MESSAGE_CHARS (32000), POLICYLM_LIMITS_MAX_BODY_CHARS
(100000).

Default port 8771. stdlib only (http.server): the benchmark venv carries
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
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

logging.basicConfig(
    level=os.getenv("POLICYLM_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("policylm-server")

DEFAULT_MODEL = os.getenv("POLICYLM_MODEL", "musubilabs/policylm-1.7b")
DEFAULT_REVISION = os.getenv("POLICYLM_REVISION", "v1.2")
DEFAULT_DEVICE_SETTING = os.getenv("POLICYLM_DEVICE", "cpu")  # auto|cpu|cuda|mps

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()
_MAX_CATEGORIES = 16  # the helper's training-range ceiling (calls="together")


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_message_chars": _i("POLICYLM_LIMITS_MAX_MESSAGE_CHARS", 32000),
        "max_body_chars": _i("POLICYLM_LIMITS_MAX_BODY_CHARS", 100000),
    }


def _import_helper() -> Any:
    """Import policylm_infer from the cached v1.2 snapshot's inference dir.

    The helper must run from beside its vendored inference/bidirlm/ encoder
    (it verifies that code against sha256 pins before any download), so the
    snapshot directory -- not an arbitrary copy -- goes on sys.path.
    Prefers the exact pinned revision; falls back to any cached snapshot.
    """
    from huggingface_hub import snapshot_download

    try:
        snap = Path(snapshot_download(DEFAULT_MODEL, revision=DEFAULT_REVISION,
                                       allow_patterns=["inference/*"]))
    except Exception:
        snap = Path(snapshot_download(DEFAULT_MODEL, allow_patterns=["inference/*"]))
    infer_dir = snap / "inference"
    if str(infer_dir) not in sys.path:
        sys.path.insert(0, str(infer_dir))
    import policylm_infer  # noqa: E402

    return policylm_infer


class _Holder:
    """Lazy PolicyLM loader so the HTTP server boots even when weights are
    missing. A failed construction records {error, at, attempts}; later
    callers fail fast. Any success clears error+attempts."""

    def __init__(self) -> None:
        self._model = None
        self._helper = None
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._device: Optional[str] = None
        self._loaded_at: Optional[float] = None
        self._mutex = threading.Lock()

    def _do_load(self) -> None:
        helper = _import_helper()
        log.info("loading PolicyLM model=%s revision=%s device=%s",
                 DEFAULT_MODEL, DEFAULT_REVISION, DEFAULT_DEVICE_SETTING)
        self._model = helper.PolicyLM.from_pretrained(
            DEFAULT_MODEL, revision=DEFAULT_REVISION,
            device=DEFAULT_DEVICE_SETTING)
        self._helper = helper
        self._device = str(getattr(self._model, "device", DEFAULT_DEVICE_SETTING))
        log.info("PolicyLM ready on %s", self._device)

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
                self._load_error = f"policylm not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning("PolicyLM load failed (attempt %d): %s",
                            self._load_attempts, self._load_error)
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._model

    def classify_sync(self, message: str, policy: Any) -> Dict[str, Any]:
        assert self._model is not None
        result = self._model.classify(message, policy)
        return result.to_dict()

    def snapshot(self) -> Dict[str, Any]:
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION}
        if self._model is None and self._load_error is None:
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
        return [{
            "name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
            "loaded": self._model is not None,
            "revision": DEFAULT_REVISION, "revision_source": "pinned",
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


def _build_policy(helper: Any, payload: Dict[str, Any]) -> Any:
    policy_name = payload.get("policy")
    categories = payload.get("categories")
    if policy_name is not None and categories is not None:
        raise ValueError("pass either 'policy: aegis' or 'categories', not both")
    if isinstance(policy_name, str) and policy_name == "aegis":
        return "aegis"
    if policy_name is not None:
        raise ValueError("policy must be the string 'aegis' (or omit it and pass 'categories')")
    if (not isinstance(categories, list) or not categories
            or len(categories) > _MAX_CATEGORIES):
        raise ValueError(
            f"categories must be a non-empty list of at most {_MAX_CATEGORIES} entries")
    built = []
    for entry in categories:
        if isinstance(entry, str):
            if not entry:
                raise ValueError("category titles must be non-empty strings")
            built.append(helper.Category(entry))
        elif isinstance(entry, dict):
            title = entry.get("title")
            if not isinstance(title, str) or not title:
                raise ValueError("each category dict needs a non-empty 'title'")
            built.append(helper.Category(
                title,
                violation_rule=entry.get("violation_rule", ""),
                not_violation_rule=entry.get("not_violation_rule", ""),
                exception_override=entry.get("exception_override", "")))
        else:
            raise ValueError("each category must be a string or a {title, ...} dict")
    return helper.Policy(built)


class _Handler(BaseHTTPRequestHandler):
    server_version = "policylm-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "policylm-server",
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
                "service": "policylm-server",
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
                              "hint": "shorten the message or split the request"})
            return
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            _send(self, 400, {"code": "bad_json", "detail": repr(exc)})
            return
        message = payload.get("message")
        if not isinstance(message, str) or not message:
            _send(self, 400, {"code": "bad_request", "field": "message",
                              "hint": "message must be a non-empty string"})
            return
        if len(message) > limits["max_message_chars"]:
            _send(self, 413, {"code": "input_too_large", "field": "message",
                              "limit": limits["max_message_chars"], "actual": len(message),
                              "hint": "shorten the message to within POLICYLM_LIMITS_MAX_MESSAGE_CHARS chars"})
            return
        start = time.perf_counter()
        try:
            holder.ensure()
            assert holder._helper is not None
            policy = _build_policy(holder._helper, payload)
            out = holder.classify_sync(message, policy)
        except ValueError as exc:
            _send(self, 400, {"code": "bad_request", "detail": str(exc)})
            return
        except RuntimeError as exc:
            _send(self, 503, {"code": "model_not_ready", "detail": str(exc)},
                  _retry_after(1.0))
            return
        except Exception as exc:  # noqa: BLE001
            _send(self, 500, {"code": "predict_error", "detail": repr(exc)})
            return
        cats = out.get("categories", {})
        flat = {t: {"score": float(c.get("score", 0.0)),
                    "flagged": bool(c.get("flagged", False))}
                for t, c in cats.items()} if isinstance(cats, dict) else cats
        _send(self, 200, {"flagged": bool(out.get("flagged", False)),
                          "score": float(out.get("score", 0.0)),
                          "cutoff": float(out.get("cutoff", 0.0)),
                          "violations": list(out.get("violations", [])),
                          "categories": flat,
                          "latency_ms": (time.perf_counter() - start) * 1000.0,
                          "model": DEFAULT_MODEL, "revision": DEFAULT_REVISION})


def main() -> None:
    host = os.getenv("POLICYLM_HOST", "127.0.0.1")
    port = int(os.getenv("POLICYLM_PORT", "8771"))
    log.info("policylm-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
