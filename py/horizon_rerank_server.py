#!/usr/bin/env python3
"""
horizon-rerank-server: spike sidecar for laya-mcp (spike-horizon-rerank S1).

Thin HTTP wrapper around Horizon-Labs/multilingual-reranker-base, a 308M
mmBERT (ModernBertForSequenceClassification) cross-encoder distilled from
Qwen3-Reranker-4B. It answers *in what order* (rerank/find primitives) with
the SAME HTTP contract as py/qwen_rerank_server.py, so the duel runs the
identical oracles through the identical lane (`liveRerankPredictFactory`,
scores within-call).

SCORING (model-card pattern, verified in S1 smoke): tokenizer([query]*N,
docs, padding/truncation) -> AutoModelForSequenceClassification forward ->
logits[:, 0].sigmoid() per pair. One output logit per (query, passage) pair;
higher = more relevant. No instruction framing (unlike the Qwen CausalLM
yes/no pattern); the pair IS the question.

Process independence mirrors the template: own OS process, own port (8774),
own holder, no shared state with qwen-rerank-server (:8768) or any other
sidecar. Both may run concurrently for the duel.

HTTP contract: IDENTICAL shapes to py/qwen_rerank_server.py, only `service`
differs ("horizon-rerank-server"):

  POST /rerank {query, candidates, instruction?, top_k?} -> 200
    {
      "ranked": [{"id": str, "rank": 1-based int, "score": sigmoid float}],
      "latency_ms": float, "model": str, "instruction": str (effective),
      "truncated": bool, "truncated_ids": [str], "count": int (pool size),
    }
    - instruction is ACCEPTED but IGNORED (cross-encoder takes raw pairs;
      echoed back as "" so callers can tell no framing was applied).
    - every other guard mirrors qwen: 413 past HORIZON_LIMITS_* (query
      refused, candidates refused past 64, per-candidate truncation with
      truncated_ids, body guard), 503 + Retry-After on backoff/circuit and
      on inflight saturation (never queues). Scores within-call only.
  GET /ready (non-warming 200/503 snapshot), GET /models (always 200, never
  loads), GET /live, GET /health, POST /reload: IDENTICAL shapes to the
  Qwen sidecar, only `service` differs.

Env tuning is intentionally NOT shared with the Qwen sidecar (independent
failure domains). Same defaults, HORIZON_ prefix:
  HORIZON_LOAD_RETRY_BASE_S=1.0, HORIZON_LOAD_RETRY_FACTOR=2.0,
  HORIZON_LOAD_RETRY_CAP_S=60.0, HORIZON_LOAD_RETRY_MAX=5,
  HORIZON_LOAD_CIRCUIT_THRESHOLD=3, HORIZON_LOAD_CIRCUIT_COOLDOWN_S=30.0,
  HORIZON_LOAD_ERROR_TTL_S=300.0, HORIZON_MAX_INFLIGHT=2,
  HORIZON_LIMITS_MAX_QUERY_CHARS=2000, HORIZON_LIMITS_MAX_CANDIDATES=64,
  HORIZON_LIMITS_MAX_CANDIDATE_CHARS=2000,
  HORIZON_LIMITS_MAX_BODY_CHARS=100000.
Identity envs: HORIZON_MODEL, HORIZON_DEVICE (auto|cpu|cuda, default auto),
  HORIZON_HOST, HORIZON_PORT (default 8774), HORIZON_LOG_LEVEL,
  HORIZON_MAX_LENGTH (tokenizer window per pair, default 384 -- the card
  states the model was TRAINED with 384 tokens per pair; longer passages
  are truncated, never refused).

Default port 8774 (qwen 8768 stays UP for the duel; never touched).
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import random
import sys
import threading
import time
from typing import Any, Dict, List, Optional

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

logging.basicConfig(
    level=os.getenv("HORIZON_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("horizon-rerank-server")

DEFAULT_MODEL = os.getenv("HORIZON_MODEL", "Horizon-Labs/multilingual-reranker-base")
DEFAULT_DEVICE_SETTING = os.getenv("HORIZON_DEVICE", "auto")  # auto|cpu|cuda

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _max_length() -> int:
    try:
        return max(128, int(os.getenv("HORIZON_MAX_LENGTH", "384")))
    except ValueError:
        return 384


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


class _LoadNotReady(RuntimeError):
    """Fail-fast refusal from the backoff/circuit gate (see qwen sidecar)."""

    def __init__(self, message: str, retry_after_seconds: float) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(0.0, retry_after_seconds)


def _load_retry_cfg() -> Dict[str, float]:
    def _f(name: str, default: float) -> float:
        try:
            return float(os.getenv(name, str(default)))
        except ValueError:
            return default

    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "base_s": max(0.0, _f("HORIZON_LOAD_RETRY_BASE_S", 1.0)),
        "factor": max(1.0, _f("HORIZON_LOAD_RETRY_FACTOR", 2.0)),
        "cap_s": max(0.0, _f("HORIZON_LOAD_RETRY_CAP_S", 60.0)),
        "max_attempts": _i("HORIZON_LOAD_RETRY_MAX", 5),
        "circuit_threshold": _i("HORIZON_LOAD_CIRCUIT_THRESHOLD", 3),
        "circuit_cooldown_s": max(0.0, _f("HORIZON_LOAD_CIRCUIT_COOLDOWN_S", 30.0)),
        "error_ttl_s": max(0.0, _f("HORIZON_LOAD_ERROR_TTL_S", 300.0)),
    }


def _backoff_delay_s(attempts: int, cfg: Dict[str, float]) -> float:
    delay = min(cfg["cap_s"], cfg["base_s"] * (cfg["factor"] ** max(0, attempts - 1)))
    return max(0.0, delay * (1.0 + random.uniform(-0.25, 0.25)))


def _retry_after_header(seconds: float) -> Dict[str, str]:
    return {"Retry-After": str(max(1, math.ceil(seconds)))}


def _limits_cfg() -> Dict[str, int]:
    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_query_chars": _i("HORIZON_LIMITS_MAX_QUERY_CHARS", 2000),
        "max_candidates": _i("HORIZON_LIMITS_MAX_CANDIDATES", 64),
        "max_candidate_chars": _i("HORIZON_LIMITS_MAX_CANDIDATE_CHARS", 2000),
        "max_body_chars": _i("HORIZON_LIMITS_MAX_BODY_CHARS", 100000),
    }


class _InputTooLarge(Exception):
    def __init__(self, field: str, limit: int, actual: int, hint: str) -> None:
        super().__init__(f"input too large: {field} actual={actual} limit={limit}: {hint}")
        self.field = field
        self.limit = limit
        self.actual = actual
        self.hint = hint


def _too_large_response(exc: _InputTooLarge) -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={
            "code": "input_too_large",
            "field": exc.field,
            "limit": exc.limit,
            "actual": exc.actual,
            "hint": exc.hint,
        },
    )


def _check_body(payload: Dict[str, Any]) -> None:
    limit = _limits_cfg()["max_body_chars"]
    try:
        actual = len(json.dumps(payload, default=str))
    except Exception:  # noqa: BLE001
        return
    if actual > limit:
        raise _InputTooLarge(
            "body",
            limit,
            actual,
            "total JSON body exceeds HORIZON_LIMITS_MAX_BODY_CHARS chars; shorten texts or split the request",
        )


class _InflightSaturated(RuntimeError):
    def __init__(self, message: str, retry_after_seconds: float = 1.0) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(0.0, retry_after_seconds)


def _max_inflight(env_name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(env_name, str(default))))
    except ValueError:
        return default


class _RerankerHolder:
    """Lazy Horizon cross-encoder loader. Same failure-tracking contract as
    the Qwen sidecar holder (backoff/circuit/TTL, single-flight sync+async,
    inflight-bounded inference). The loaded unit is a (tokenizer, model)
    pair; the model stays in eval mode and inference runs under
    inference_mode in a worker thread (see run_bounded)."""

    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._load_error: str | None = None
        self._load_error_at: float | None = None
        self._load_attempts = 0
        self._consecutive_failures = 0
        self._device: str | None = None
        self._loaded_at: float | None = None
        self._load_mutex = threading.Lock()
        self._load_lock: asyncio.Lock | None = None
        self._inflight: asyncio.Semaphore | None = None
        self._inflight_limit = 0

    def circuit_state(self, now: float | None = None) -> str:
        cfg = _load_retry_cfg()
        if self._consecutive_failures < cfg["circuit_threshold"]:
            return "closed"
        if self._load_error_at is None:
            return "closed"
        now = time.time() if now is None else now
        if now - self._load_error_at >= cfg["circuit_cooldown_s"]:
            return "half-open"
        return "open"

    def retry_after_seconds(self, now: float | None = None) -> float:
        if self._model is not None:
            return 0.0
        if self._load_error_at is None or self._load_attempts <= 0:
            return 0.0
        now = time.time() if now is None else now
        cfg = _load_retry_cfg()
        elapsed = now - self._load_error_at
        if self._load_attempts >= cfg["max_attempts"]:
            return max(0.0, cfg["circuit_cooldown_s"] - elapsed)
        return max(0.0, _backoff_delay_s(self._load_attempts, cfg) - elapsed)

    def _clear_failure(self) -> None:
        self._load_error = None
        self._load_error_at = None
        self._load_attempts = 0
        self._consecutive_failures = 0

    def reset(self) -> Dict[str, Any]:
        had_error = self._load_error is not None
        cleared_attempts = self._load_attempts
        self._clear_failure()
        return {
            "cleared_error": had_error,
            "cleared_attempts": cleared_attempts,
            "circuit": self.circuit_state(),
            "loaded": self._model is not None,
        }

    def _check_retry_allowed(self, now: float) -> None:
        if self._model is not None:
            return
        cfg = _load_retry_cfg()
        if (
            self._load_error_at is not None
            and cfg["error_ttl_s"] > 0
            and now - self._load_error_at >= cfg["error_ttl_s"]
        ):
            self._clear_failure()
            return
        if self._load_attempts <= 0 or self._load_error_at is None:
            return
        if self._load_attempts >= cfg["max_attempts"]:
            if now - self._load_error_at < cfg["circuit_cooldown_s"]:
                raise _LoadNotReady(
                    f"reranker not loaded: retry budget exhausted "
                    f"({self._load_attempts} attempts): {self._load_error}",
                    cfg["circuit_cooldown_s"] - (now - self._load_error_at),
                )
            return
        delay = _backoff_delay_s(self._load_attempts, cfg)
        if now - self._load_error_at < delay:
            raise _LoadNotReady(
                f"reranker not loaded: backing off "
                f"(attempt {self._load_attempts}): {self._load_error}",
                delay - (now - self._load_error_at),
            )

    def _record_failure(self, exc: BaseException, now: float) -> None:
        self._load_attempts += 1
        self._consecutive_failures += 1
        self._load_error = f"reranker not loaded: {exc!r}"
        self._load_error_at = now
        log.warning(
            "Horizon reranker load failed (attempt %d, circuit=%s): %s",
            self._load_attempts,
            self.circuit_state(now),
            self._load_error,
        )

    def _record_success(self, now: float) -> None:
        self._clear_failure()
        self._loaded_at = now

    def _do_load(self) -> None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        device = _resolve_device()
        log.info("loading Horizon reranker model=%s device=%s", DEFAULT_MODEL, device)
        tokenizer = AutoTokenizer.from_pretrained(DEFAULT_MODEL)
        if device == "cpu":
            model = AutoModelForSequenceClassification.from_pretrained(
                DEFAULT_MODEL, dtype=torch.float32
            )
        else:
            model = AutoModelForSequenceClassification.from_pretrained(
                DEFAULT_MODEL, dtype=torch.float32
            )
            model = model.to(device)
        model.eval()
        self._tokenizer = tokenizer
        self._model = model
        self._device = device
        log.info("Horizon reranker ready: %s on %s", type(model).__name__, device)

    def _ensure(self) -> Any:
        if self._model is not None:
            return self._model
        with self._load_mutex:
            if self._model is not None:
                return self._model
            self._check_retry_allowed(time.time())
            try:
                self._do_load()
            except Exception as exc:  # noqa: BLE001
                self._record_failure(exc, time.time())
                raise
            self._record_success(time.time())
            return self._model

    def _async_load_lock(self) -> asyncio.Lock:
        if self._load_lock is None:
            self._load_lock = asyncio.Lock()
        return self._load_lock

    async def ensure_async(self) -> Any:
        if self._model is not None:
            return self._model
        async with self._async_load_lock():
            if self._model is not None:
                return self._model
            return await asyncio.to_thread(self._ensure)

    def _inflight_sem(self) -> "tuple[asyncio.Semaphore, int]":
        limit = _max_inflight("HORIZON_MAX_INFLIGHT", 2)
        if self._inflight is None or self._inflight_limit != limit:
            self._inflight = asyncio.Semaphore(limit)
            self._inflight_limit = limit
        return self._inflight, limit

    async def run_bounded(self, func: Any, *args: Any, **kwargs: Any) -> Any:
        sem, limit = self._inflight_sem()
        if sem.locked():
            raise _InflightSaturated(
                f"horizon-rerank-server saturated ({limit} inflight, limit {limit}): "
                "retry shortly",
                1.0,
            )
        await sem.acquire()
        try:
            return await asyncio.to_thread(func, *args, **kwargs)
        finally:
            sem.release()

    def score_sync(self, query: str, docs: List[str]) -> List[float]:
        """Score one query against N docs in a SINGLE batched forward pass.

        Model-card pattern: tok([query]*N, docs, padding+truncation) ->
        logits[:, 0].sigmoid(). Scores are within-call only (no calibration
        claimed). Must run in a worker thread (blocking torch compute).
        """
        import torch

        assert self._model is not None and self._tokenizer is not None
        max_length = _max_length()
        enc = self._tokenizer(
            [query] * len(docs),
            docs,
            padding=True,
            truncation=True,
            max_length=max_length,
            return_tensors="pt",
        )
        target = self._device or "cpu"
        enc = {k: v.to(target) if hasattr(v, "to") else v for k, v in enc.items()}
        with torch.inference_mode():
            logits = self._model(**enc).logits[:, 0]
            return logits.sigmoid().tolist()

    def health(self) -> Dict[str, Any]:
        if self._model is None:
            try:
                self._ensure()
            except Exception as exc:  # noqa: BLE001
                return {"ready": False, "error": str(exc)}
        return {
            "ready": True,
            "model": DEFAULT_MODEL,
            "device": self._device,
            "uptime_seconds": (time.time() - self._loaded_at) if self._loaded_at else 0.0,
        }

    def snapshot(self) -> Dict[str, Any]:
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION}
        circuit = self.circuit_state()
        if self._model is None and self._load_error is None:
            return {
                "ready": False,
                "reason": "not loaded yet (no load attempted)",
                "loaded": [],
                "failed": [
                    {
                        "name": DEFAULT_MODEL,
                        "repo": DEFAULT_MODEL,
                        "error": "not loaded yet",
                    }
                ],
                "device": self._device,
                "versions": versions,
                "uptime_seconds": uptime,
                "circuit": circuit,
                "load_attempts": self._load_attempts,
                "retry_after_seconds": 0.0,
            }
        if self._load_error is not None:
            return {
                "ready": False,
                "reason": self._load_error,
                "loaded": [],
                "failed": [
                    {
                        "name": DEFAULT_MODEL,
                        "repo": DEFAULT_MODEL,
                        "error": self._load_error,
                    }
                ],
                "device": self._device,
                "versions": versions,
                "uptime_seconds": uptime,
                "circuit": circuit,
                "load_attempts": self._load_attempts,
                "retry_after_seconds": self.retry_after_seconds(),
            }
        return {
            "ready": True,
            "reason": None,
            "loaded": [DEFAULT_MODEL],
            "failed": [],
            "device": self._device,
            "versions": versions,
            "uptime_seconds": uptime,
            "circuit": circuit,
            "load_attempts": self._load_attempts,
            "retry_after_seconds": 0.0,
        }

    def models_info(self) -> List[Dict[str, Any]]:
        circuit = self.circuit_state()
        return [
            {
                "name": DEFAULT_MODEL,
                "repo": DEFAULT_MODEL,
                "loaded": self._model is not None,
                "revision": None,
                "revision_source": "unpinned",
                "device": self._device if self._device is not None else DEFAULT_DEVICE_SETTING,
                "circuit": circuit,
            }
        ]


holder = _RerankerHolder()


class RerankCandidate(BaseModel):
    id: str = Field(..., min_length=1, description="Candidate identifier, echoed back in ranked[].")
    text: str = Field(..., description="Candidate text (truncated past HORIZON_LIMITS_MAX_CANDIDATE_CHARS).")


class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Query the candidates are ranked against.")
    candidates: List[RerankCandidate] = Field(..., description="Pool to rank (1..HORIZON_LIMITS_MAX_CANDIDATES).")
    instruction: Optional[str] = Field(
        default=None,
        description="Accepted but IGNORED: the cross-encoder scores raw (query, passage) pairs with no task framing.",
    )
    top_k: Optional[int] = Field(
        default=None,
        ge=1,
        description="Return only the top rows (default: the whole pool).",
    )

    @field_validator("query")
    @classmethod
    def _cap_query(cls, v: str) -> str:
        limit = _limits_cfg()["max_query_chars"]
        if len(v) > limit:
            raise _InputTooLarge(
                "query",
                limit,
                len(v),
                "reduce query to within HORIZON_LIMITS_MAX_QUERY_CHARS chars",
            )
        return v

    @field_validator("candidates")
    @classmethod
    def _cap_candidates(cls, v: List[RerankCandidate]) -> List[RerankCandidate]:
        limit = _limits_cfg()["max_candidates"]
        if len(v) > limit:
            raise _InputTooLarge(
                "candidates",
                limit,
                len(v),
                "send at most HORIZON_LIMITS_MAX_CANDIDATES candidates per request; page larger pools caller-side",
            )
        if len(v) == 0:
            raise ValueError("candidates must be non-empty (an empty pool has no ranking)")
        return v

    @model_validator(mode="after")
    def _cap_body(self) -> "RerankRequest":
        _check_body(
            {
                "query": self.query,
                "candidates": [{"id": c.id, "text": c.text} for c in self.candidates],
                "instruction": self.instruction,
                "top_k": self.top_k,
            }
        )
        return self


app = FastAPI(title="horizon-rerank-server", version=SERVER_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(_InputTooLarge)
async def _input_too_large_handler(_request: Any, exc: _InputTooLarge) -> JSONResponse:
    return _too_large_response(exc)


@app.get("/live")
async def live() -> Dict[str, Any]:
    return {
        "alive": True,
        "service": "horizon-rerank-server",
        "version": SERVER_VERSION,
        "uptime_seconds": time.time() - _SERVER_START,
    }


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", **holder.health()}


@app.get("/ready")
async def ready() -> Dict[str, Any]:
    info = holder.snapshot()
    if not info.get("ready"):
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", **info},
            headers=_retry_after_header(float(info.get("retry_after_seconds") or 0.0)),
        )
    return {"status": "ready", **info}


@app.get("/models")
async def models() -> Dict[str, Any]:
    return {
        "service": "horizon-rerank-server",
        "device": holder._device if holder._device is not None else DEFAULT_DEVICE_SETTING,
        "versions": {"server": SERVER_VERSION},
        "uptime_seconds": time.time() - _SERVER_START,
        "circuit": holder.circuit_state(),
        "models": holder.models_info(),
    }


@app.post("/reload")
async def reload() -> Dict[str, Any]:
    return {"status": "reloaded", "service": "horizon-rerank-server", **holder.reset()}


@app.post("/rerank")
async def rerank(req: RerankRequest) -> Dict[str, Any]:
    """Score every candidate's relevance to the query, return them sorted.

    One batched cross-encoder forward pass over the whole pool. Scores are
    sigmoid(logit) floats, within-call only. `instruction`, when supplied,
    is ignored (no task framing in this architecture) and echoed as "".
    """
    start = time.perf_counter()
    char_limit = _limits_cfg()["max_candidate_chars"]
    docs: List[str] = []
    truncated_ids: List[str] = []
    for c in req.candidates:
        if len(c.text) > char_limit:
            truncated_ids.append(c.id)
            docs.append(c.text[:char_limit])
        else:
            docs.append(c.text)
    try:
        await holder.ensure_async()
        scores = await holder.run_bounded(holder.score_sync, req.query, docs)
    except _LoadNotReady as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers=_retry_after_header(exc.retry_after_seconds),
        ) from exc
    except _InflightSaturated as exc:
        return JSONResponse(
            status_code=503,
            content={
                "error": str(exc),
                "code": "inflight_saturated",
                "retry_after_seconds": exc.retry_after_seconds,
                "limit": holder._inflight_limit,
            },
            headers=_retry_after_header(exc.retry_after_seconds),
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers=_retry_after_header(holder.retry_after_seconds()),
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"rerank error: {exc!r}") from exc
    order = sorted(range(len(docs)), key=lambda i: (-scores[i], i))
    if req.top_k is not None:
        order = order[: min(req.top_k, len(order))]
    ranked = [
        {"id": req.candidates[i].id, "rank": rank + 1, "score": float(scores[i])}
        for rank, i in enumerate(order)
    ]
    return {
        "ranked": ranked,
        "latency_ms": (time.perf_counter() - start) * 1000.0,
        "model": DEFAULT_MODEL,
        "instruction": "",
        "truncated": len(truncated_ids) > 0,
        "truncated_ids": truncated_ids,
        "count": len(req.candidates),
    }


def main() -> None:
    import uvicorn

    host = os.getenv("HORIZON_HOST", "127.0.0.1")
    port = int(os.getenv("HORIZON_PORT", "8774"))
    log.info("horizon-rerank-server starting on http://%s:%d", host, port)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
