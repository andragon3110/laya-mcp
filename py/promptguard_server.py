#!/usr/bin/env python3
"""promptguard-server: classifier sidecar for laya-mcp (benchmark-ronda1 T5a).

Thin HTTP wrapper around meta-llama/Llama-Prompt-Guard-2-86M, a binary
benign/malicious prompt-injection classifier. It answers *whether a text* is
a prompt attack (gate primitive); Laya remains the judge for prod paths.

Control-surface template: py/qwen_rerank_server.py (read-only). Mirrored
contract: GET /live (never loads), non-warming GET /ready (200/503 snapshot),
GET /models (always 200, never loads), POST /predict. CPU default, device /
revision reporting, single-flight lazy load. Honesty vocabulary: revision is
null + revision_source="unpinned" because no pin is resolvable here; never
invent a hash.

Process independence: own OS process, own port (8772), own holder, no shared
state with laya-server (:8765), the GLiNER sidecars, qwen-rerank (:8768),
gliclass (:8770) or policylm (:8771). All sidecars may run concurrently.

HTTP contract (defined here):

  POST /predict {text} -> 200
    {"label": str, "score": float, "scores": {label: float},
     "latency_ms": float, "model": str}
    - text: required non-empty string (refused past MAX_TEXT_CHARS with
      413, never silently cut -- a cut text changes the verdict).
    - label is the argmax class of the sequence-classification head;
      score is its softmax probability. Scores are within-call only.

GATING WARNING (load-bearing): this repo is gated on the Hugging Face Hub.
Without an authenticated HF token the download and the first load fail
with 401/403. The holder records that as an honest load error
(BLOCKED-gated) and /ready answers 503 -- a gated backend is never hidden
and no credentials are ever requested. The server file keeps the standard
load-on-start shape so it works unmodified once access is granted.

Env: PROMPTGUARD_MODEL (default meta-llama/Llama-Prompt-Guard-2-86M),
PROMPTGUARD_DEVICE (cpu|cuda|auto, default cpu), PROMPTGUARD_HOST,
PROMPTGUARD_PORT (default 8772), PROMPTGUARD_LOG_LEVEL,
PROMPTGUARD_LIMITS_MAX_TEXT_CHARS (2000),
PROMPTGUARD_LIMITS_MAX_BODY_CHARS (100000).

Default port 8772. stdlib only (http.server): the benchmark venv carries
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
    level=os.getenv("PROMPTGUARD_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("promptguard-server")

DEFAULT_MODEL = os.getenv("PROMPTGUARD_MODEL", "meta-llama/Llama-Prompt-Guard-2-86M")
DEFAULT_DEVICE_SETTING = os.getenv("PROMPTGUARD_DEVICE", "cpu")  # cpu|cuda|auto

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
        "max_text_chars": _i("PROMPTGUARD_LIMITS_MAX_TEXT_CHARS", 2000),
        "max_body_chars": _i("PROMPTGUARD_LIMITS_MAX_BODY_CHARS", 100000),
    }


class _Holder:
    """Lazy Prompt Guard loader so the HTTP server boots even when weights
    are missing or the repo is gated (401/403). A failed construction
    records {error, at, attempts} instead of a permanent error; later
    callers fail fast. Any success clears error+attempts. The loaded unit is
    a (tokenizer, model, id2label) triple; inference runs under
    inference_mode on the calling thread pool."""

    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._id2label: List[str] = []
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._device: Optional[str] = None
        self._loaded_at: Optional[float] = None
        self._mutex = threading.Lock()

    def _do_load(self) -> None:
        import torch
        from transformers import (AutoModelForSequenceClassification,
                                  AutoTokenizer)

        device = _resolve_device()
        log.info("loading Prompt Guard model=%s device=%s", DEFAULT_MODEL, device)
        try:
            tokenizer = AutoTokenizer.from_pretrained(DEFAULT_MODEL)
            model = AutoModelForSequenceClassification.from_pretrained(
                DEFAULT_MODEL, dtype=torch.float32)
        except Exception as exc:  # noqa: BLE001
            msg = repr(exc)
            if "401" in msg or "403" in msg or "gated" in msg.lower():
                raise RuntimeError(
                    f"BLOCKED-gated: {DEFAULT_MODEL} requires HF access "
                    f"(401/403 without a token): {exc!r}") from exc
            raise RuntimeError(f"promptguard not loaded: {exc!r}") from exc
        if device != "cpu":
            model = model.to(device)
        model.eval()
        cfg = getattr(model, "config", None)
        id2label = getattr(cfg, "id2label", None) or {}
        ordered = [id2label[k] for k in sorted(id2label, key=int)] if id2label else []
        self._tokenizer = tokenizer
        self._model = model
        self._id2label = ordered or [f"LABEL_{i}" for i in range(
            int(getattr(cfg, "num_labels", 2) or 2))]
        self._device = device
        log.info("Prompt Guard ready: %s on %s labels=%s",
                 type(model).__name__, device, self._id2label)

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
                self._load_error = f"promptguard not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning("Prompt Guard load failed (attempt %d): %s",
                            self._load_attempts, self._load_error)
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._model

    def classify_sync(self, text: str) -> Dict[str, Any]:
        import torch

        assert self._model is not None and self._tokenizer is not None
        inputs = self._tokenizer(text, return_tensors="pt", truncation=True,
                                 max_length=512)
        target = self._device or "cpu"
        inputs = {k: v.to(target) if hasattr(v, "to") else v
                  for k, v in inputs.items()}
        with torch.inference_mode():
            logits = self._model(**inputs).logits[0]
            probs = torch.softmax(logits.float(), dim=-1).tolist()
        best = max(range(len(probs)), key=lambda i: probs[i])
        return {"label": self._id2label[best] if best < len(self._id2label) else str(best),
                "score": float(probs[best]),
                "scores": {self._id2label[i] if i < len(self._id2label) else str(i): float(p)
                           for i, p in enumerate(probs)}}

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
        # revision is null + unpinned: no pin is resolvable for a gated repo here.
        return [{
            "name": DEFAULT_MODEL, "repo": DEFAULT_MODEL,
            "loaded": self._model is not None,
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
    server_version = "promptguard-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "promptguard-server",
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
                "service": "promptguard-server",
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
                              "hint": "shorten the text or split the request"})
            return
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            _send(self, 400, {"code": "bad_json", "detail": repr(exc)})
            return
        text = payload.get("text")
        if not isinstance(text, str) or not text:
            _send(self, 400, {"code": "bad_request", "field": "text",
                              "hint": "text must be a non-empty string"})
            return
        if len(text) > limits["max_text_chars"]:
            _send(self, 413, {"code": "input_too_large", "field": "text",
                              "limit": limits["max_text_chars"], "actual": len(text),
                              "hint": "shorten text to within PROMPTGUARD_LIMITS_MAX_TEXT_CHARS chars"})
            return
        start = time.perf_counter()
        try:
            holder.ensure()
            out = holder.classify_sync(text)
        except RuntimeError as exc:
            _send(self, 503, {"code": "model_not_ready", "detail": str(exc)},
                  _retry_after(1.0))
            return
        except Exception as exc:  # noqa: BLE001
            _send(self, 500, {"code": "predict_error", "detail": repr(exc)})
            return
        _send(self, 200, {**out,
                          "latency_ms": (time.perf_counter() - start) * 1000.0,
                          "model": DEFAULT_MODEL})


def main() -> None:
    host = os.getenv("PROMPTGUARD_HOST", "127.0.0.1")
    port = int(os.getenv("PROMPTGUARD_PORT", "8772"))
    log.info("promptguard-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
