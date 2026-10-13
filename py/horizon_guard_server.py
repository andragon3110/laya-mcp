#!/usr/bin/env python3
"""horizon-guard-server: classifier sidecar for laya-mcp (bench-ronda3 G2).

Thin HTTP wrapper around Horizon-Labs/prompt-injection-guard-small (141M,
mmBERT-small ModernBERT sequence classifier, labels SAFE/INJECTION). It
answers *whether a text looks like a prompt injection* (screen primitive);
Laya remains the judge for prod paths.

Control-surface template: py/zesyde_server.py (read-only G1 sidecar).
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
(AutoModelForSequenceClassification + AutoTokenizer, fp32 CPU). Weights
resolve into the HF cache via the transformers hub loader (never git).
When the backend is unavailable the holder records an honest load error
and /ready answers 503 -- a missing backend is never hidden.

Windowing (documented): the card advertises 8k context with windowing, so
texts are tokenized up to 8192 tokens and split into non-overlapping
512-token chunks (at most 16); each chunk scores p(INJECTION) and the
overall score is the chunk MAXIMUM (any window firing counts, a priori,
never tuned). Backend-truncating models (Galvanize/mDeBERTa, 512) differ;
each sidecar documents its own rule.

Label mapping (documented, honest): the head is a pure SAFE/INJECTION
binary, so requested labels ride a synonym axis -- injection synonyms
score p(INJECTION), safe synonyms score 1-p, everything else scores 0.0
(no semantic axis exists for it). In particular the screen lane's
"suspicious" always scores 0.0, so lane-side argmax over
[benign, suspicious, malicious] reduces to a benign/malicious binary --
a binary guard cannot emit a middle verdict, and this sidecar does not
pretend otherwise. Gate/classify/rerank/find labels (SUPPORTED, refund,
...) likewise score 0.0: those primitives are NOT covered by this
sidecar (recorded as gaps in the spike, never faked here).

Env: HORIZON_MODEL (default Horizon-Labs/prompt-injection-guard-small),
HORIZON_HOST, HORIZON_PORT (default 8777), HORIZON_LOG_LEVEL,
HORIZON_LIMITS_MAX_TEXT_CHARS (8000), HORIZON_LIMITS_MAX_LABELS (25),
HORIZON_LIMITS_MAX_BODY_CHARS (100000), HORIZON_MAX_INFLIGHT (1).

Default port 8777. stdlib only (http.server): no extra deps.
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
    level=os.getenv("HORIZON_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("horizon-guard-server")

DEFAULT_MODEL = os.getenv(
    "HORIZON_MODEL", "Horizon-Labs/prompt-injection-guard-small"
)
DEFAULT_THRESHOLD = 0.5
_CHUNK_TOKENS = 512
_MAX_TOKENS = 8192

# Synonym axis for the binary head (normalised: lowercase, alnum only).
_INJECTION_LABELS = {
    "injection", "promptinjection", "malicious", "attack", "jailbreak",
    "unsafe", "harmful", "dangerous", "exploit", "hijack", "adversarial",
}
_SAFE_LABELS = {
    "safe", "benign", "legitimate", "clean", "trusted", "harmless",
    "normal",
}

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _norm(label: str) -> str:
    return re.sub(r"[^a-z0-9]", "", label.lower())


def _map_scores(p_injection: float, labels: List[str]) -> List[Dict[str, float]]:
    out = []
    for lab in labels:
        n = _norm(lab)
        if n in _INJECTION_LABELS:
            out.append({"label": lab, "score": float(p_injection)})
        elif n in _SAFE_LABELS:
            out.append({"label": lab, "score": float(1.0 - p_injection)})
        else:
            # No semantic axis (suspicious / SUPPORTED / refund / ...):
            # 0.0, documented above. Lanes must not judge these.
            out.append({"label": lab, "score": 0.0})
    return out


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_text_chars": _i("HORIZON_LIMITS_MAX_TEXT_CHARS", 8000),
        "max_labels": _i("HORIZON_LIMITS_MAX_LABELS", 25),
        "max_body_chars": _i("HORIZON_LIMITS_MAX_BODY_CHARS", 100000),
    }


def _max_inflight() -> int:
    try:
        return max(1, int(os.getenv("HORIZON_MAX_INFLIGHT", "1")))
    except ValueError:
        return 1


class _Holder:
    """Lazy Horizon loader so the HTTP server boots even when weights or
    torch/transformers are missing. A failed construction records
    {error, at, attempts} instead of a permanent error; later callers fail
    fast until a retry is allowed. Any success clears error+attempts."""

    def __init__(self) -> None:
        self._tok = None
        self._model = None
        self._inj_id: int = 1
        self._load_error: Optional[str] = None
        self._load_error_at: Optional[float] = None
        self._load_attempts = 0
        self._loaded_at: Optional[float] = None
        self._mutex = threading.Lock()
        self._inflight = threading.Semaphore(_max_inflight())

    def _do_load(self) -> None:
        try:
            import torch
            from transformers import (
                AutoModelForSequenceClassification,
                AutoTokenizer,
            )
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "horizon backend unavailable (needs torch + transformers): "
                f"{exc!r}"
            ) from exc
        log.info("loading Horizon model=%s (fp32 CPU)", DEFAULT_MODEL)
        self._tok = AutoTokenizer.from_pretrained(DEFAULT_MODEL)
        self._model = AutoModelForSequenceClassification.from_pretrained(
            DEFAULT_MODEL, dtype=torch.float32
        )
        self._model.eval()
        # Resolve the INJECTION id from config (fallback: index 1).
        inj = 1
        try:
            cfg = self._model.config
            l2id = getattr(cfg, "label2id", None) or {}
            for name, idx in l2id.items():
                if "INJ" in str(name).upper():
                    inj = int(idx)
                    break
        except Exception:  # noqa: BLE001
            pass
        self._inj_id = inj
        log.info("Horizon ready (inj_id=%d)", self._inj_id)

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
                self._load_error = f"horizon not loaded: {exc!r}"
                self._load_error_at = time.time()
                log.warning(
                    "Horizon load failed (attempt %d): %s",
                    self._load_attempts,
                    self._load_error,
                )
                raise
            self._load_error = None
            self._load_error_at = None
            self._load_attempts = 0
            self._loaded_at = time.time()
            return self._model

    def p_injection(self, text: str) -> float:
        import torch

        assert self._model is not None and self._tok is not None
        enc = self._tok(
            text, add_special_tokens=True, truncation=False,
            return_attention_mask=False,
        )["input_ids"][:_MAX_TOKENS]
        chunks = [
            enc[i:i + _CHUNK_TOKENS]
            for i in range(0, len(enc), _CHUNK_TOKENS)
        ] or [[]]
        best = 0.0
        with torch.no_grad():
            for ch in chunks[: _MAX_TOKENS // _CHUNK_TOKENS]:
                ids = torch.tensor([ch], dtype=torch.long)
                mask = torch.ones_like(ids)
                logits = self._model(
                    input_ids=ids, attention_mask=mask
                ).logits[0]
                prob = float(
                    torch.softmax(logits, dim=-1)[self._inj_id].item()
                )
                best = max(best, prob)
        return best

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
    server_version = "horizon-guard-server/" + SERVER_VERSION

    def log_message(self, *args: Any) -> None:  # keep stderr for load events
        pass

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/live":
            _send(self, 200, {"alive": True, "service": "horizon-guard-server",
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
                "service": "horizon-guard-server",
                "device": "cpu",
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
                              "hint": "shorten text to within HORIZON_LIMITS_MAX_TEXT_CHARS chars"})
            return
        if (not isinstance(labels, list) or not labels
                or not all(isinstance(l, str) and l for l in labels)):
            _send(self, 400, {"code": "bad_request", "field": "labels",
                              "hint": "labels must be a non-empty list of non-empty strings"})
            return
        if len(labels) > limits["max_labels"]:
            _send(self, 413, {"code": "input_too_large", "field": "labels",
                              "limit": limits["max_labels"], "actual": len(labels),
                              "hint": "send at most HORIZON_LIMITS_MAX_LABELS labels per request"})
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
                              "detail": "horizon busy; retry shortly",
                              "retry_after_seconds": 1.0},
                  _retry_after(1.0))
            return
        start = time.perf_counter()
        try:
            holder.ensure()
            scores = _map_scores(holder.p_injection(text), labels)
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
    host = os.getenv("HORIZON_HOST", "127.0.0.1")
    port = int(os.getenv("HORIZON_PORT", "8777"))
    log.info("horizon-guard-server starting on http://%s:%d", host, port)
    ThreadingHTTPServer((host, port), _Handler).serve_forever()


if __name__ == "__main__":
    main()
