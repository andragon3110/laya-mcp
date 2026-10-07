#!/usr/bin/env python3
"""
qwen-rerank-server: spike sidecar for laya-mcp (S3 of spike-gliner-qwen3).

Thin HTTP wrapper around Qwen3-Reranker-0.6B (Qwen/Qwen3-Reranker-0.6B),
the relevance-scoring sibling of the GLiNER sidecars. It answers *in what
order* (rerank/find primitives); GLiNER2.5-multi-Decide (:8767, S2) covers
classify/gate/screen; Laya remains the judge for prod paths.

CAUSALLM WARNING (S1 finding, load-bearing): this checkpoint has NO
classification head (architectures=[Qwen3ForCausalLM], no score/classifier
tensors). AutoModelForSequenceClassification would init a random head and
return garbage scores. Scoring ALWAYS uses the official model-card pattern:
CausalLM forward pass, logits of the last position restricted to the
"yes"/"no" token ids, P(yes) = softmax([no, yes])[1]. Verified in S1
(/tmp/opencode/spike-s1/smoke_qwen.py, outside the repo, read-only):
correct ranking (top 0.9996 vs rest) on a Spanish 4-doc probe.

Process independence mirrors the template: own OS process, own port (8768),
own holder, no shared state with laya-server (:8765), gliner-server (:8766)
or gliner-decide-server (:8767). All four sidecars may run concurrently.

HTTP contract (defined here, S3):

  POST /rerank {query, candidates, instruction?, top_k?} -> 200
    {
      "ranked": [{"id": str, "rank": 1-based int, "score": P(yes) float}],
      "latency_ms": float, "model": str, "instruction": str (effective),
      "truncated": bool, "truncated_ids": [str], "count": int (pool size),
    }
    - query: required non-empty string (refused past
      RERANK_LIMITS_MAX_QUERY_CHARS with 413 + structured body).
    - candidates: required [{id: str, text: str}], 1..64 entries. Past 64
      -> 413 input_too_large (mirrors the TS 64 transport cap; never
      silently cut). Each text past RERANK_LIMITS_MAX_CANDIDATE_CHARS
      (default 2000, mirrors the TS per-candidate truncation) is TRUNCATED,
      not refused, and reported in truncated_ids.
    - instruction: optional per-request override of the retrieval task
      string; default RERANK_INSTRUCTION (the S1-verified web-search task).
    - top_k: optional 1..pool-size; only the top rows are returned (ranks
      stay 1-based over the returned rows).
    - ranked is sorted by score desc; exact ties keep input order (stable
      sort, no invented order). Scores are within-call only by contract
      (same vocabulary as the TS rerank tool): never probabilities across
      calls, no cutoff on them is meaningful downstream.
  GET /ready (non-warming 200/503 snapshot), GET /models (always 200, never
  loads), GET /live, GET /health, POST /reload: IDENTICAL shapes to the
  GLiNER sidecars, only `service` differs ("qwen-rerank-server").

Env tuning is intentionally NOT shared with the GLiNER sidecars
(independent failure domains: different model family, different failure
modes). Same defaults, RERANK_ prefix:
  RERANK_LOAD_RETRY_BASE_S=1.0, RERANK_LOAD_RETRY_FACTOR=2.0,
  RERANK_LOAD_RETRY_CAP_S=60.0, RERANK_LOAD_RETRY_MAX=5,
  RERANK_LOAD_CIRCUIT_THRESHOLD=3, RERANK_LOAD_CIRCUIT_COOLDOWN_S=30.0,
  RERANK_LOAD_ERROR_TTL_S=300.0, RERANK_MAX_INFLIGHT=2,
  RERANK_LIMITS_MAX_QUERY_CHARS=2000, RERANK_LIMITS_MAX_CANDIDATES=64,
  RERANK_LIMITS_MAX_CANDIDATE_CHARS=2000,
  RERANK_LIMITS_MAX_BODY_CHARS=100000.
Identity envs: RERANK_MODEL, RERANK_DEVICE (auto|cpu|cuda, default auto ->
cuda when torch sees one, else cpu; S1 verified cpu/float32, S3 verifies
the cuda path live below), RERANK_HOST,
RERANK_PORT (default 8768), RERANK_LOG_LEVEL, RERANK_MAX_LENGTH (tokenizer
window, default 2048; the card uses 8192 but short spike docs never need
it on CPU), RERANK_INSTRUCTION (retrieval task string).

Default port 8768 (laya 8765, gliner 8766, decide 8767).
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
    level=os.getenv("RERANK_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("qwen-rerank-server")

DEFAULT_MODEL = os.getenv("RERANK_MODEL", "Qwen/Qwen3-Reranker-0.6B")
DEFAULT_DEVICE_SETTING = os.getenv("RERANK_DEVICE", "auto")  # auto|cpu|cuda
DEFAULT_INSTRUCTION = os.getenv(
    "RERANK_INSTRUCTION",
    "Given a web search query, retrieve relevant passages that answer the query",
)

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()

# Prompt framing: verbatim the official Qwen3-Reranker model-card pattern
# (S1 smoke, ranking verified). Only the <Instruct> line is configurable.
_PROMPT_PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements "
    "based on the Query and the Instruct provided. Note that the answer "
    'can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
)
_PROMPT_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


def _max_length() -> int:
    try:
        return max(512, int(os.getenv("RERANK_MAX_LENGTH", "2048")))
    except ValueError:
        return 2048


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
    """Fail-fast refusal from the backoff/circuit gate.

    Raised WITHOUT touching the model constructor, so a burst of requests
    against a failing backend costs one cheap timestamp check each instead
    of N expensive construction attempts. Carries `retry_after_seconds` so
    endpoints can answer 503 + Retry-After.
    """

    def __init__(self, message: str, retry_after_seconds: float) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(0.0, retry_after_seconds)


def _load_retry_cfg() -> Dict[str, float]:
    """Load retry/backoff/circuit tuning, all via env with sane defaults.

    RERANK_ namespace (NOT shared with GLINER_LOAD_* by design: independent
    failure domains). Same defaults as the GLiNER sidecars:
      RERANK_LOAD_RETRY_BASE_S=1.0      first backoff delay after 1 failure
      RERANK_LOAD_RETRY_FACTOR=2.0      exponential growth per failure
      RERANK_LOAD_RETRY_CAP_S=60.0      ceiling for any single backoff delay
      RERANK_LOAD_RETRY_MAX=5           attempts before only probes may pass
      RERANK_LOAD_CIRCUIT_THRESHOLD=3   consecutive failures to open circuit
      RERANK_LOAD_CIRCUIT_COOLDOWN_S=30.0 open -> half-open probe delay
      RERANK_LOAD_ERROR_TTL_S=300.0     cached error expiry (transients must
                                        not poison the holder until restart)
    """

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
        "base_s": max(0.0, _f("RERANK_LOAD_RETRY_BASE_S", 1.0)),
        "factor": max(1.0, _f("RERANK_LOAD_RETRY_FACTOR", 2.0)),
        "cap_s": max(0.0, _f("RERANK_LOAD_RETRY_CAP_S", 60.0)),
        "max_attempts": _i("RERANK_LOAD_RETRY_MAX", 5),
        "circuit_threshold": _i("RERANK_LOAD_CIRCUIT_THRESHOLD", 3),
        "circuit_cooldown_s": max(0.0, _f("RERANK_LOAD_CIRCUIT_COOLDOWN_S", 30.0)),
        "error_ttl_s": max(0.0, _f("RERANK_LOAD_ERROR_TTL_S", 300.0)),
    }


def _backoff_delay_s(attempts: int, cfg: Dict[str, float]) -> float:
    """Exponential backoff with +/-25% jitter: base * factor^(attempts-1)."""
    delay = min(cfg["cap_s"], cfg["base_s"] * (cfg["factor"] ** max(0, attempts - 1)))
    return max(0.0, delay * (1.0 + random.uniform(-0.25, 0.25)))


def _retry_after_header(seconds: float) -> Dict[str, str]:
    # Retry-After takes whole seconds; always at least 1 on a 503.
    return {"Retry-After": str(max(1, math.ceil(seconds)))}


# -- Input limits -------------------------------------------------------------
# Defaults are documented HERE (module, not README — single source of truth).
#   - MAX_CANDIDATES=64: mirrors the TS 64 transport cap (one forward pass
#     per candidate inside a single batched call; larger pools are refused,
#     never silently cut — S4 pages them caller-side).
#   - MAX_CANDIDATE_CHARS=2000: mirrors the TS per-candidate truncation
#     (handleRerank truncates to 2000 before judging); the server truncates
#     again idempotently and reports truncated_ids instead of refusing.
#   - MAX_QUERY_CHARS=2000: queries are short; anything past this is a caller
#     bug -> 413 with a hint, not silent truncation (a cut query changes the
#     ranking question silently).
#   - MAX_BODY_CHARS=100000: total-JSON DoS guard, same scale as the GLiNER
#     sidecars.


def _limits_cfg() -> Dict[str, int]:
    """Size guards for /rerank, all via env. Read dynamically per validation
    (like _load_retry_cfg) so tests tune via env without a module reload."""

    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_query_chars": _i("RERANK_LIMITS_MAX_QUERY_CHARS", 2000),
        "max_candidates": _i("RERANK_LIMITS_MAX_CANDIDATES", 64),
        "max_candidate_chars": _i("RERANK_LIMITS_MAX_CANDIDATE_CHARS", 2000),
        "max_body_chars": _i("RERANK_LIMITS_MAX_BODY_CHARS", 100000),
    }


class _InputTooLarge(Exception):
    """Size-guard refusal. Answered as 413 (not 422): the payload is
    syntactically valid but exceeds the admitted size — the fix is to shrink
    it, not to correct the schema. Identical structured body {code, field,
    limit, actual, hint}, no Retry-After (retrying the same payload can
    never succeed)."""

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
        return  # unmeasurable here: endpoint serialization decides
    if actual > limit:
        raise _InputTooLarge(
            "body",
            limit,
            actual,
            "total JSON body exceeds RERANK_LIMITS_MAX_BODY_CHARS chars; shorten texts or split the request",
        )


class _InflightSaturated(RuntimeError):
    """Inference bound hit: fail fast instead of queueing (never enqueues).

    Carries `retry_after_seconds` so the endpoint answers 503 + Retry-After.
    """

    def __init__(self, message: str, retry_after_seconds: float = 1.0) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(0.0, retry_after_seconds)


def _max_inflight(env_name: str, default: int) -> int:
    """Inference concurrency bound from env (validated >= 1)."""
    try:
        return max(1, int(os.getenv(env_name, str(default))))
    except ValueError:
        return default


class _RerankerHolder:
    """Lazy Qwen3-Reranker loader so the HTTP server boots even when weights
    are missing.

    Failure-tracking mirrors the GLiNER sidecars: a failed construction
    records {error, at, attempts} instead of a permanent error. Later callers
    fail fast (no constructor call) until the backoff delay elapses; after
    MAX attempts only a post-cooldown half-open probe may pass; a cached
    error older than TTL expires on its own. Any success clears
    error+attempts. The process is never blocked by a model: no sleep, no
    retry loop in the request path -- the *client* retries after Retry-After.

    The loaded unit is a (tokenizer, model, yes/no token ids) triple; the
    model stays in eval mode and inference runs under inference_mode in a
    worker thread (see run_bounded).
    """

    def __init__(self) -> None:
        self._model = None
        self._tokenizer = None
        self._yes_id: int | None = None
        self._no_id: int | None = None
        self._prefix_ids: List[int] | None = None
        self._suffix_ids: List[int] | None = None
        self._load_error: str | None = None
        self._load_error_at: float | None = None
        self._load_attempts = 0
        self._consecutive_failures = 0
        self._device: str | None = None
        self._loaded_at: float | None = None
        # Concurrency guards (same justification as the GLiNER sidecars, no
        # global locks): _load_mutex serializes sync constructions,
        # _load_lock serializes async load dispatches, _inflight bounds
        # concurrent inference workers (saturation -> 503 + Retry-After).
        self._load_mutex = threading.Lock()
        self._load_lock: asyncio.Lock | None = None
        self._inflight: asyncio.Semaphore | None = None
        self._inflight_limit = 0

    # -- circuit breaker ------------------------------------------------
    def circuit_state(self, now: float | None = None) -> str:
        """closed | open | half-open. Closed below threshold; open while the
        cooldown after threshold failures has not elapsed; half-open when a
        probe may pass (post-cooldown)."""
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
        """Seconds until the next construction attempt may pass (0 if now)."""
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
        """Operational (non-destructive) reset for POST /reload.

        Clears failure-tracking so the next use retries construction.
        Never unloads a healthy model: if loaded, next use just works.
        """
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
        """Fail-fast gate. Raises _LoadNotReady without touching the
        constructor when a retry would be aggressive. Gate refusals never
        count as attempts. A cached error older than TTL expires first."""
        if self._model is not None:
            return
        cfg = _load_retry_cfg()
        if (
            self._load_error_at is not None
            and cfg["error_ttl_s"] > 0
            and now - self._load_error_at >= cfg["error_ttl_s"]
        ):
            # A transient failure (VRAM pressure, HF network blip) must not
            # poison the holder until restart: expire the cached error.
            self._clear_failure()
            return
        if self._load_attempts <= 0 or self._load_error_at is None:
            return  # never attempted (or reset): a probe may pass
        if self._load_attempts >= cfg["max_attempts"]:
            # Budget exhausted: only a post-cooldown half-open probe passes.
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
            "Qwen reranker load failed (attempt %d, circuit=%s): %s",
            self._load_attempts,
            self.circuit_state(now),
            self._load_error,
        )

    def _record_success(self, now: float) -> None:
        self._clear_failure()
        self._loaded_at = now

    def _do_load(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        device = _resolve_device()
        log.info("loading Qwen reranker model=%s device=%s", DEFAULT_MODEL, device)
        tokenizer = AutoTokenizer.from_pretrained(DEFAULT_MODEL, padding_side="left")
        if device == "cpu":
            # S1-verified path: float32 on CPU. Do NOT switch dtype without
            # re-verifying the yes/no ranking on the smoke probe.
            model = AutoModelForCausalLM.from_pretrained(DEFAULT_MODEL, dtype=torch.float32)
        else:
            # GPU path (S3-verified on RTX 3050): float32 like S1, no dtype
            # confound in the spike numbers (0.6B ~= 2.4 GB, fits 6 GB VRAM);
            # batch tensors are moved to this device in score_sync (a
            # CPU-side batch against a CUDA model fails loudly instead of
            # silently misscoring).
            model = AutoModelForCausalLM.from_pretrained(DEFAULT_MODEL, dtype=torch.float32)
            model = model.to(device)
        model.eval()
        yes_id = tokenizer.convert_tokens_to_ids("yes")
        no_id = tokenizer.convert_tokens_to_ids("no")
        if not isinstance(yes_id, int) or not isinstance(no_id, int):
            raise RuntimeError(f"tokenizer of {DEFAULT_MODEL} has no single yes/no ids (yes={yes_id!r}, no={no_id!r})")
        self._tokenizer = tokenizer
        self._model = model
        self._yes_id = yes_id
        self._no_id = no_id
        self._prefix_ids = tokenizer.encode(_PROMPT_PREFIX, add_special_tokens=False)
        self._suffix_ids = tokenizer.encode(_PROMPT_SUFFIX, add_special_tokens=False)
        self._device = device
        log.info("Qwen reranker ready: %s on %s (yes=%d no=%d)", type(model).__name__, device, yes_id, no_id)

    def _ensure(self) -> Any:
        if self._model is not None:
            return self._model
        # Single-flight (sync side): concurrent threads collapse onto one
        # construction; the double-check after acquiring avoids a second
        # build when a waiter finds the model already loaded.
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
        # Lazily created in the running loop: asyncio primitives must not be
        # shared across loops, and this server runs a single loop.
        if self._load_lock is None:
            self._load_lock = asyncio.Lock()
        return self._load_lock

    async def ensure_async(self) -> Any:
        """Single-flight async load: N concurrent requests -> ONE blocking
        construction in a worker thread; the rest await the same result.
        Funnels through the sync _ensure (and its mutex), so a sync load
        racing an async one still builds only once."""
        if self._model is not None:
            return self._model
        async with self._async_load_lock():
            if self._model is not None:
                return self._model
            return await asyncio.to_thread(self._ensure)

    def _inflight_sem(self) -> "tuple[asyncio.Semaphore, int]":
        """Inference semaphore, sized from RERANK_MAX_INFLIGHT.

        Trade-off (documented): each inflight inference holds a worker
        thread + transient memory for a batched CausalLM forward pass over
        up to 64 candidates x 2048 tokens of a 0.6B model on CPU. Default 2:
        rerank forwards are heavier than GLiNER span passes, so overlap stays
        minimal; raise only with measured headroom. Saturation is
        backpressure, not a bug.
        """
        limit = _max_inflight("RERANK_MAX_INFLIGHT", 2)
        if self._inflight is None or self._inflight_limit != limit:
            self._inflight = asyncio.Semaphore(limit)
            self._inflight_limit = limit
        return self._inflight, limit

    async def run_bounded(self, func: Any, *args: Any, **kwargs: Any) -> Any:
        """Run blocking inference in a worker thread under the inflight
        bound. Raises _InflightSaturated immediately when saturated -- never
        queues. The locked() check + acquire() below are atomic within one
        event-loop task (no await between them), so no hidden queue forms."""
        sem, limit = self._inflight_sem()
        if sem.locked():
            raise _InflightSaturated(
                f"qwen-rerank-server saturated ({limit} inflight, limit {limit}): "
                "retry shortly",
                1.0,
            )
        await sem.acquire()
        try:
            return await asyncio.to_thread(func, *args, **kwargs)
        finally:
            sem.release()

    def score_sync(self, instruction: str, query: str, docs: List[str]) -> List[float]:
        """Score one query against N docs in a SINGLE batched forward pass.

        Official model-card pattern (S1-verified): wrap each
        (instruction, query, doc) pair in the system/user/assistant framing,
        run the CausalLM once over the padded batch, take the last-position
        logits at the yes/no token ids, return P(yes) = softmax([no, yes])[1]
        per doc. Scores are within-call only (no calibration claimed).
        Must run in a worker thread (blocking torch compute).
        """
        import torch

        assert self._model is not None and self._tokenizer is not None
        assert self._yes_id is not None and self._no_id is not None
        assert self._prefix_ids is not None and self._suffix_ids is not None
        max_length = _max_length()
        inner_budget = max_length - len(self._prefix_ids) - len(self._suffix_ids)
        pairs = [
            f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {doc}"
            for doc in docs
        ]
        inputs = self._tokenizer(
            pairs,
            padding=False,
            truncation="longest_first",
            return_attention_mask=False,
            max_length=inner_budget,
        )
        for i, ele in enumerate(inputs["input_ids"]):
            inputs["input_ids"][i] = self._prefix_ids + ele + self._suffix_ids
        batch = self._tokenizer.pad(inputs, padding=True, return_tensors="pt", max_length=max_length)
        # The model may live on cuda (auto device when a GPU is present);
        # the freshly padded batch is always CPU-side until moved here.
        target = self._device or "cpu"
        batch = {k: v.to(target) if hasattr(v, "to") else v for k, v in batch.items()}
        with torch.inference_mode():
            logits = self._model(**batch).logits[:, -1, :]
            pair = torch.stack([logits[:, self._no_id], logits[:, self._yes_id]], dim=1)
            return torch.nn.functional.log_softmax(pair, dim=1)[:, 1].exp().tolist()

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
        """Non-warming readiness snapshot. Never triggers a model load.

        Failure-tracking state is surfaced as `circuit`
        (closed|open|half-open), `load_attempts` and `retry_after_seconds`
        so operators can tell a backing-off backend from a dead one.
        """
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
        """Single-model inventory. Never triggers a model load.

        `revision` is null + revision_source="unpinned" because the pin is
        not resolvable offline here; never invent a hash.
        """
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


# Process-independence note (verified by construction): this holder lives in
# the qwen-rerank-server OS process only. laya-server, gliner-server and
# gliner-decide-server are separate processes (own FastAPI apps, own ports,
# own holders, no shared state or locks), so a failure in one cannot crash
# the others. The spike harness treats this sidecar as opt-in
# (evals/live-client.mjs --live + RERANK_URL).
holder = _RerankerHolder()


# -- HTTP contract ----------------------------------------------------------


class RerankCandidate(BaseModel):
    id: str = Field(..., min_length=1, description="Candidate identifier, echoed back in ranked[].")
    text: str = Field(..., description="Candidate text (truncated past RERANK_LIMITS_MAX_CANDIDATE_CHARS).")


class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Query the candidates are ranked against.")
    candidates: List[RerankCandidate] = Field(..., description="Pool to rank (1..RERANK_LIMITS_MAX_CANDIDATES).")
    instruction: Optional[str] = Field(
        default=None,
        description="Per-request retrieval-task override (default RERANK_INSTRUCTION).",
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
                "reduce query to within RERANK_LIMITS_MAX_QUERY_CHARS chars",
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
                "send at most RERANK_LIMITS_MAX_CANDIDATES candidates per request; page larger pools caller-side",
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


app = FastAPI(title="qwen-rerank-server", version=SERVER_VERSION)

# CORS is permissive because this process binds to 127.0.0.1 only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(_InputTooLarge)
async def _input_too_large_handler(_request: Any, exc: _InputTooLarge) -> JSONResponse:
    # Custom exceptions raised inside pydantic validators propagate unwrapped
    # (verified on the GLiNER sidecars: only ValueError/AssertionError become
    # 422), so the size guards above land here as structured 413s.
    return _too_large_response(exc)


@app.get("/live")
async def live() -> Dict[str, Any]:
    """Liveness only. Immediate: never touches the holder, never loads models.

    Safe to poll aggressively; works with the model down or never loaded.
    """
    return {
        "alive": True,
        "service": "qwen-rerank-server",
        "version": SERVER_VERSION,
        "uptime_seconds": time.time() - _SERVER_START,
    }


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Legacy liveness + readiness. WARNING: may warm up (lazy-load) the model
    on first call -- but never aggressively: inside the backoff/cooldown
    window it fails fast without touching the constructor. Prefer /live
    (liveness) + /ready (readiness) for probes."""
    return {"status": "ok", **holder.health()}


@app.get("/ready")
async def ready() -> Dict[str, Any]:
    """Readiness only (non-warming snapshot). 200 when ready, else 503 with a
    structured body {ready:false, reason, loaded, failed, device, versions,
    uptime_seconds, circuit, load_attempts, retry_after_seconds} plus a
    Retry-After header -- a not-ready backend is never hidden."""
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
    """Model inventory. Always 200, never triggers a model load."""
    return {
        "service": "qwen-rerank-server",
        "device": holder._device if holder._device is not None else DEFAULT_DEVICE_SETTING,
        "versions": {"server": SERVER_VERSION},
        "uptime_seconds": time.time() - _SERVER_START,
        "circuit": holder.circuit_state(),
        "models": holder.models_info(),
    }


@app.post("/reload")
async def reload() -> Dict[str, Any]:
    """Operational (non-destructive) reset of load failure-tracking.

    Clears the cached {error, at, attempts} and closes the circuit so the
    next use retries construction immediately instead of waiting out the
    backoff/cooldown. Never unloads a healthy model. Always 200 -- the
    body reports what was cleared. Use after fixing the underlying cause
    (RAM freed, HF reachable again); without a fix the next attempt will
    simply fail and re-enter backoff.
    """
    return {"status": "reloaded", "service": "qwen-rerank-server", **holder.reset()}


@app.post("/rerank")
async def rerank(req: RerankRequest) -> Dict[str, Any]:
    """Score every candidate's relevance to the query, return them sorted.

    One batched CausalLM forward pass over the whole pool (no per-candidate
    round trips). Scores are P(yes) floats, within-call only.
    """
    start = time.perf_counter()
    instruction = req.instruction or DEFAULT_INSTRUCTION
    # Server-side truncation (idempotent with the TS 2000-char cut):
    # truncate, never refuse — the ranking question stays answerable and the
    # response reports exactly what was cut.
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
        # Single-flight load, then bound inference (503 + Retry-After when
        # saturated, never an unbounded queue).
        await holder.ensure_async()
        scores = await holder.run_bounded(holder.score_sync, instruction, req.query, docs)
    except _LoadNotReady as exc:
        # Backoff/circuit fail-fast: 503 with Retry-After, no retry loop.
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
        "instruction": instruction,
        "truncated": len(truncated_ids) > 0,
        "truncated_ids": truncated_ids,
        "count": len(req.candidates),
    }


def main() -> None:
    import uvicorn

    host = os.getenv("RERANK_HOST", "127.0.0.1")
    port = int(os.getenv("RERANK_PORT", "8768"))
    log.info("qwen-rerank-server starting on http://%s:%d", host, port)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
