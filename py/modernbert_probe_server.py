#!/usr/bin/env python3
"""modernbert-probe-server: finetune-probe sidecar for laya-mcp (bench-ronda3 G3).

Thin HTTP wrapper around answerdotai/ModernBERT-base (149M, masked-LM
backbone, EN+code, 8k ctx). It is a PROBE, not a judge: ModernBERT-base
ships no classification head and no NLI finetune, so it CANNOT do
zero-shot lanes -- POST /predict always answers 409 with an explicit
gap statement (never a fake mapping). The honest evidence this probe
provides is: the backbone LOADS (GET /ready 200) and RUNS one
masked-LM forward pass (GET /probe: mask-fill top token + shapes +
latency). Laya remains the judge for prod paths.

Control-surface template: py/horizon_guard_server.py (read-only G2 sidecar).
Mirrored contract: GET /live (never loads), non-warming GET /ready
(200/503 snapshot), GET /models (always 200, never loads), POST /predict.
CPU only, revision reporting, single-flight lazy load. Honesty vocabulary:
revision is null + revision_source="unpinned" because no pin is resolvable
here; never invent a hash. The actually-resolved repo sha (observed via the
HF API at setup time) is recorded in odd/tasks/spike-g2-guards.md S1, not
claimed by this server.

Process independence: own OS process, own port (8777), own holder, no
shared state with laya-server (:8765) or any other sidecar. All sidecars
may run concurrently.

HTTP contract (defined here):

  POST /predict {text, labels, threshold?} -> 200
    {"scores": [{"label": str, "score": float}], "flagged": [str],
     "latency_ms": float, "model": str, "count": int}
    - text: required non-empty string (refused past MAX_TEXT_CHARS with 413).
    - labels: required 1..25 non-empty strings (past that -> 413, never
      silently cut).
    - threshold: optional 0..1 (default 0.5); labels scoring >= threshold
      are listed in flagged.
    - scores are within-call only: never probabilities across calls, no
      cutoff on them is meaningful downstream beyond the echoed threshold.
      (No reliability diagram + ECE under our harness exists, so no
      probability is claimed here.)

  GET /ready (non-warming 200/503 snapshot), GET /models (always 200, never
  loads), GET /live: same shapes as the G1 sidecars, only `service`
  differs ("horizon-guard-server").

Backend note: inference goes through transformers
(AutoModelForMaskedLM + AutoTokenizer, fp32 CPU). Weights resolve into
the HF cache via the transformers hub loader (never git). When the
backend is unavailable the holder records an honest load error and
/ready answers 503 -- a missing backend is never hidden.

Probe semantics (documented, honest): GET /probe tokenizes one fixed
sentence with the checkpoint's own mask token, runs a single no-grad
forward pass, and reports the argmax filler + logits shape + latency.
That proves load+run and nothing else. POST /predict validates its
payload guards (400/413, same ceilings as the G2 template) and then
refuses with 409 no_zero_shot -- there is no label axis to score, so
any score would be invented. Lanes must record the gap, never call
this backend for judgments.

Env: MODERNBERT_MODEL (default answerdotai/ModernBERT-base),
MODERNBERT_HOST, MODERNBERT_PORT (default 8781), MODERNBERT_LOG_LEVEL,
MODERNBERT_LIMITS_MAX_TEXT_CHARS (8000),
MODERNBERT_LIMITS_MAX_BODY_CHARS (100000), MODERNBERT_MAX_INFLIGHT (1).

Default port 8781. stdlib only (http.server): no extra deps.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

logging.basicConfig(
    level=os.getenv("MODERNBERT_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("modernbert-probe-server")

DEFAULT_MODEL = os.getenv("MODERNBERT_MODEL", "answerdotai/ModernBERT-base")
DEFAULT_THRESHOLD = 0.5

# (No label axis: this backbone has no classification head to map onto.)

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_text_chars": _i("MODERNBERT_LIMITS_MAX_TEXT_CHARS", 8000),
        "max_body_chars": _i("MODERNBERT_LIMITS_MAX_BODY_CHARS", 100000),
    }


def _max_inflight() -> int:
    try:
        return max(1, int(os.getenv("MODERNBERT_MAX_INFLIGHT", "1")))
    except ValueError:
        return 1


class _Holder:
    """Lazy ModernBERT (MLM probe) loader so the HTTP server boots even when weights or
    torch/transformers are missing. A failed construction records
    {error, at, attempts} instead of a permanent error; later callers fail
    fast until a retry is allowed. Any success clears error+attempts."""

    def __init__(self) -> None:
        self._tok = None
        self._model = None
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._loaded_at: Optional[float] = None
        self._mutex = threading.Lock()
        self._inflight = threading.Semaphore(_max_inflight())

    def _do_load(self) -> None:
        try:
            import torch
            from transformers import AutoModelForMaskedLM, AutoTokenizer
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "modernbert backend unavailable (needs torch + transformers): "
                f"{exc!r}"
            ) from exc
        log.info("loading ModernBERT model=%s (fp32 CPU)", DEFAULT_MODEL)
        self._tok = AutoTokenizer.from_pretrained(DEFAULT_MODEL)
        self._model = AutoModelForMaskedLM.from_pretrained(
            DEFAULT_MODEL, dtype=torch.float32
        )
        self._model.eval()
        log.info("ModernBERT ready (mlm probe, no classification head)")

    def mlm_probe(self) -> Dict[str, Any]:
        import torch

        assert self._model is not None and self._tok is not None
        mask = self._tok.mask_token or "[MASK]"
        text = f"The capital of France is {mask}."
        start = time.perf_counter()
        with torch.no_grad():
            enc = self._tok(text, return_tensors="pt")
            ids = enc["input_ids"][0].tolist()
            try:
                mpos = ids.index(self._tok.mask_token_id)
            except ValueError:
                raise RuntimeError(
                    "modernbert probe: mask token missing from tokenized input"
                )
            feed = {k: v for k, v in enc.items()
                    if k in ("input_ids", "attention_mask")}
            logits = self._model(**feed).logits
            shape = [int(x) for x in logits.shape]
            top = int(torch.argmax(logits[0, mpos]).item())
        return {
            "probe": "mlm-forward-pass",
            "input": text,
            "mask_token": mask,
            "sequence_length": len(ids),
            "logits_shape": shape,
            "top_id": top,
            "top_token": self._tok.decode([top]),
            "latency_ms": (time.perf_counter() - start) * 1000.0,
        }

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
                self._load_error = f"modernbert not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning(
                    "ModernBERT load failed (attempt %d): %s",
                    self._load_attempts,
                    self._load_error,
                )
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._model

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
            "ready": True, "reason": None, "loaded": [DEFAULT_MODEL],
            "failed": [], "device": "cpu", "versions": versions,
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


class _Handler(BaseHTTPRequestHandler):
    server_version = "modernbert-probe-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:  # keep stderr for load events
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "modernbert-probe-server",
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
                "service": "modernbert-probe-server",
                "device": "cpu",
                "versions": {"server": SERVER_VERSION},
                "uptime_seconds": time.time() - _SERVER_START,
                "models": holder.models_info()})
        elif path == "/probe":
            try:
                holder.ensure()
            except RuntimeError as exc:
                _send(self, 503, {"code": "model_not_ready", "detail": str(exc)},
                      _retry_after(1.0))
                return
            except Exception as exc:  # noqa: BLE001
                _send(self, 500, {"code": "probe_error", "detail": repr(exc)})
                return
            try:
                result = holder.mlm_probe()
            except Exception as exc:  # noqa: BLE001
                _send(self, 500, {"code": "probe_error", "detail": repr(exc)})
                return
            _send(self, 200, {"service": "modernbert-probe-server", **result})
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
                              "hint": "shorten text to within MODERNBERT_LIMITS_MAX_TEXT_CHARS chars"})
            return
        if (not isinstance(labels, list) or not labels
                or not all(isinstance(l, str) and l for l in labels)):
            _send(self, 400, {"code": "bad_request", "field": "labels",
                              "hint": "labels must be a non-empty list of non-empty strings"})
            return
        if len(labels) > 25:
            _send(self, 413, {"code": "input_too_large", "field": "labels",
                              "limit": 25, "actual": len(labels),
                              "hint": "send at most 25 labels per request"})
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
                              "detail": "modernbert busy; retry shortly",
                              "retry_after_seconds": 1.0},
                  _retry_after(1.0))
            return
        start = time.perf_counter()
        try:
            holder.ensure()
            _send(self, 409, {"code": "no_zero_shot",
                              "detail": ("ModernBERT-base is a masked-LM backbone "
                                         "with no classification head: it cannot score "
                                         "labels zero-shot. GET /probe carries the load+run "
                                         "evidence; lanes must record the gap, never judge."),
                              "gap": ("classify/screen/gate/rerank/find NOT served: "
                                      "no zero-shot axis exists (honest refusal, never a fake mapping)"),
                              "model": DEFAULT_MODEL, "loaded": True})
            return
        except RuntimeError as exc:
            _send(self, 503, {"code": "model_not_ready", "detail": str(exc)},
                  _retry_after(1.0))
            return
        except Exception as exc:  # noqa: BLE001
            _send(self, 500, {"code": "predict_error", "detail": repr(exc)})
            return
        finally:
            holder._inflight.release()
        # Unreachable: the 409 above always answers (kept try/finally only
        # to release the single-flight semaphore).


def main() -> None:
    host = os.getenv("MODERNBERT_HOST", "127.0.0.1")
    port = int(os.getenv("MODERNBERT_PORT", "8781"))
    log.info("modernbert-probe-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
