#!/usr/bin/env python3
"""
d1-server: spike sidecar for laya-mcp (benchmark-ronda1 T5b).

Thin HTTP wrapper around LiquidAI/d1-3B-GGUF (smallest Q4_K_M quant),
loaded via transformers NATIVE GGUF (from_pretrained(gguf_file=...) with
trust_remote_code=True: d1 ships custom system_one code). It answers typed
questions over a caller-supplied state (answer/extract primitives); the
rerank sidecars (:8768 qwen, :8773 gte) cover ordering, GLiNER covers
classify/gate/screen. Laya remains the judge for prod paths.

Process independence mirrors the template: own OS process, own port (8769),
own holder, no shared state with the other sidecars. All sidecars may run
concurrently.

KNOWN LIMITATION (recorded, not worked around): transformers 5.19.0 native
GGUF supports only GGUF architectures ['qwen35', 'qwen35moe'] while the
d1-3B-Q4_K_M.gguf header declares general.architecture='lfm2', so the load
fails with ValueError("GGUF architecture 'lfm2' is not supported yet.
Supported: ['qwen35', 'qwen35moe']."). Per task instructions no other
backend (llama-cpp etc.) is installed: this sidecar stays BLOCKED and
surfaces the exact error via /ready (503) and /predict (503). If a future
transformers adds 'lfm2', the _do_load path below is already the intended
one (verify the smoke probes again then).

HTTP contract (defined here, mirrors the template control surface):

  POST /predict {state, questions} -> 200
    {
      "answers": [{"id": str, "type": str, "answer": str|float|None,
                   "choice": str|None, "score": float|None}],
      "latency_ms": float, "model": str, "file": str,
      "truncated": bool, "count": int,
    }
    - state: required object or string (the context questions are asked
      over). Past D1_LIMITS_MAX_STATE_CHARS -> 413 structured body.
    - questions: required [{id: str, type: "noul"|"choice"|"score",
      prompt: str, choices?: [str]}], 1..D1_LIMITS_MAX_QUESTIONS. Past the
      cap -> 413 (never silently cut). Each prompt past
      D1_LIMITS_MAX_PROMPT_CHARS is TRUNCATED, not refused. "choice"
      requires 2..16 non-empty choices (422 otherwise); "noul"/"score"
      ignore choices.
      - noul: open generation over the state (free text / extraction).
      - choice: generation constrained to the listed choices; the response
        echoes the matched entry in `choice` (None when nothing matches).
      - score: generation parsed to a float in `score` (None when no
        number is produced); the raw text stays in `answer`.
  GET /ready (non-warming 200/503 snapshot), GET /models (always 200, never
  loads), GET /live, GET /health, POST /reload: IDENTICAL shapes to the
  template sidecars, only `service` differs ("d1-server"). /models reports
  the backing file (D1_GGUF_FILE) alongside the repo.

Env tuning lives in its own D1_ namespace (independent failure domain).
Same defaults as the template, D1_ prefix:
  D1_LOAD_RETRY_BASE_S=1.0, D1_LOAD_RETRY_FACTOR=2.0,
  D1_LOAD_RETRY_CAP_S=60.0, D1_LOAD_RETRY_MAX=5,
  D1_LOAD_CIRCUIT_THRESHOLD=3, D1_LOAD_CIRCUIT_COOLDOWN_S=30.0,
  D1_LOAD_ERROR_TTL_S=300.0, D1_MAX_INFLIGHT=2,
  D1_LIMITS_MAX_STATE_CHARS=8000, D1_LIMITS_MAX_QUESTIONS=16,
  D1_LIMITS_MAX_PROMPT_CHARS=2000, D1_LIMITS_MAX_BODY_CHARS=100000.
Identity envs: D1_MODEL (default LiquidAI/d1-3B-GGUF), D1_GGUF_FILE
(default d1-3B-Q4_K_M.gguf, the smallest Q4_K_M file in the repo),
D1_DEVICE (auto|cpu|cuda, default auto -> cuda when torch sees one, else
cpu; CPU default on this box), D1_HOST, D1_PORT (default 8769),
D1_LOG_LEVEL, D1_MAX_LENGTH (default 2048), D1_MAX_NEW_TOKENS (default
256 per question).

Default port 8769.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import random
import re
import sys
import threading
import time
from typing import Any, Dict, List, Literal, Optional

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

logging.basicConfig(
    level=os.getenv("D1_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("d1-server")

DEFAULT_MODEL = os.getenv("D1_MODEL", "LiquidAI/d1-3B-GGUF")
DEFAULT_GGUF_FILE = os.getenv("D1_GGUF_FILE", "d1-3B-Q4_K_M.gguf")
DEFAULT_DEVICE_SETTING = os.getenv("D1_DEVICE", "auto")  # auto|cpu|cuda

SERVER_VERSION = "0.1.0"
_SERVER_START = time.time()


def _max_length() -> int:
    try:
        return max(512, int(os.getenv("D1_MAX_LENGTH", "2048")))
    except ValueError:
        return 2048


def _max_new_tokens() -> int:
    try:
        return max(16, int(os.getenv("D1_MAX_NEW_TOKENS", "256")))
    except ValueError:
        return 256


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
    """Fail-fast refusal from the backoff/circuit gate (see template)."""

    def __init__(self, message: str, retry_after_seconds: float) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(0.0, retry_after_seconds)


def _load_retry_cfg() -> Dict[str, float]:
    """Load retry/backoff/circuit tuning, all via env with sane defaults."""

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
        "base_s": max(0.0, _f("D1_LOAD_RETRY_BASE_S", 1.0)),
        "factor": max(1.0, _f("D1_LOAD_RETRY_FACTOR", 2.0)),
        "cap_s": max(0.0, _f("D1_LOAD_RETRY_CAP_S", 60.0)),
        "max_attempts": _i("D1_LOAD_RETRY_MAX", 5),
        "circuit_threshold": _i("D1_LOAD_CIRCUIT_THRESHOLD", 3),
        "circuit_cooldown_s": max(0.0, _f("D1_LOAD_CIRCUIT_COOLDOWN_S", 30.0)),
        "error_ttl_s": max(0.0, _f("D1_LOAD_ERROR_TTL_S", 300.0)),
    }


def _backoff_delay_s(attempts: int, cfg: Dict[str, float]) -> float:
    """Exponential backoff with +/-25% jitter: base * factor^(attempts-1)."""
    delay = min(cfg["cap_s"], cfg["base_s"] * (cfg["factor"] ** max(0, attempts - 1)))
    return max(0.0, delay * (1.0 + random.uniform(-0.25, 0.25)))


def _retry_after_header(seconds: float) -> Dict[str, str]:
    return {"Retry-After": str(max(1, math.ceil(seconds)))}


def _limits_cfg() -> Dict[str, int]:
    """Size guards for /predict, all via env."""

    def _i(name: str, default: int) -> int:
        try:
            return max(1, int(os.getenv(name, str(default))))
        except ValueError:
            return default

    return {
        "max_state_chars": _i("D1_LIMITS_MAX_STATE_CHARS", 8000),
        "max_questions": _i("D1_LIMITS_MAX_QUESTIONS", 16),
        "max_prompt_chars": _i("D1_LIMITS_MAX_PROMPT_CHARS", 2000),
        "max_body_chars": _i("D1_LIMITS_MAX_BODY_CHARS", 100000),
    }


class _InputTooLarge(Exception):
    """Size-guard refusal, answered as 413 (see template)."""

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
            "total JSON body exceeds D1_LIMITS_MAX_BODY_CHARS chars; shorten state/prompts or split the request",
        )


class _InflightSaturated(RuntimeError):
    """Inference bound hit: fail fast instead of queueing (never enqueues)."""

    def __init__(self, message: str, retry_after_seconds: float = 1.0) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(0.0, retry_after_seconds)


def _max_inflight(env_name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(env_name, str(default))))
    except ValueError:
        return default


class _D1Holder:
    """Lazy d1 GGUF loader; failure-tracking mirrors the template."""

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
                    f"d1 not loaded: retry budget exhausted "
                    f"({self._load_attempts} attempts): {self._load_error}",
                    cfg["circuit_cooldown_s"] - (now - self._load_error_at),
                )
            return
        delay = _backoff_delay_s(self._load_attempts, cfg)
        if now - self._load_error_at < delay:
            raise _LoadNotReady(
                f"d1 not loaded: backing off "
                f"(attempt {self._load_attempts}): {self._load_error}",
                delay - (now - self._load_error_at),
            )

    def _record_failure(self, exc: BaseException, now: float) -> None:
        self._load_attempts += 1
        self._consecutive_failures += 1
        self._load_error = f"d1 not loaded: {exc!r}"
        self._load_error_at = now
        log.warning(
            "d1 load failed (attempt %d, circuit=%s): %s",
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
        log.info(
            "loading d1 model=%s file=%s device=%s",
            DEFAULT_MODEL,
            DEFAULT_GGUF_FILE,
            device,
        )
        # NATIVE GGUF via transformers (no llama-cpp): the gguf_file selects
        # the quant inside the repo; trust_remote_code allows d1's custom
        # system_one modeling code.
        model = AutoModelForCausalLM.from_pretrained(
            DEFAULT_MODEL,
            gguf_file=DEFAULT_GGUF_FILE,
            trust_remote_code=True,
            dtype=torch.float32,
        )
        try:
            tokenizer = AutoTokenizer.from_pretrained(
                DEFAULT_MODEL,
                gguf_file=DEFAULT_GGUF_FILE,
                trust_remote_code=True,
            )
        except Exception:
            # GGUF repos often ship no tokenizer files; fall back to the
            # tokenizer embedded alongside the model load.
            tokenizer = AutoTokenizer.from_pretrained(
                DEFAULT_MODEL, trust_remote_code=True
            )
        if device != "cpu":
            model = model.to(device)
        model.eval()
        self._tokenizer = tokenizer
        self._model = model
        self._device = device
        log.info("d1 ready: %s on %s", type(model).__name__, device)

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
        limit = _max_inflight("D1_MAX_INFLIGHT", 2)
        if self._inflight is None or self._inflight_limit != limit:
            self._inflight = asyncio.Semaphore(limit)
            self._inflight_limit = limit
        return self._inflight, limit

    async def run_bounded(self, func: Any, *args: Any, **kwargs: Any) -> Any:
        sem, limit = self._inflight_sem()
        if sem.locked():
            raise _InflightSaturated(
                f"d1-server saturated ({limit} inflight, limit {limit}): retry shortly",
                1.0,
            )
        await sem.acquire()
        try:
            return await asyncio.to_thread(func, *args, **kwargs)
        finally:
            sem.release()

    def predict_sync(
        self, state: str, prompts: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Answer typed questions over the state (blocking; worker thread).

        Each entry of `prompts` is {id, type, prompt, choices?}. Generation
        is greedy plain-text; the typed fields are derived afterwards:
          noul -> {"answer": text}
          choice -> {"answer": text, "choice": matched entry or None}
          score -> {"answer": text, "score": first float in text or None}
        """
        import torch

        assert self._model is not None and self._tokenizer is not None
        out: List[Dict[str, Any]] = []
        for p in prompts:
            qtype = p["type"]
            prompt = p["prompt"]
            if qtype == "choice":
                listed = "\n".join(f"- {c}" for c in p.get("choices") or [])
                full = (
                    f"Context:\n{state}\n\nQuestion: {prompt}\n"
                    f"Answer with exactly one of these choices:\n{listed}\nAnswer:"
                )
            elif qtype == "score":
                full = (
                    f"Context:\n{state}\n\nQuestion: {prompt}\n"
                    "Answer with a single number only.\nAnswer:"
                )
            else:
                full = f"Context:\n{state}\n\nQuestion: {prompt}\nAnswer:"
            toks = self._tokenizer(
                full,
                return_tensors="pt",
                truncation=True,
                max_length=_max_length() - _max_new_tokens(),
            )
            target = self._device or "cpu"
            toks = {k: v.to(target) if hasattr(v, "to") else v for k, v in toks.items()}
            with torch.inference_mode():
                gen = self._model.generate(
                    **toks, max_new_tokens=_max_new_tokens(), do_sample=False
                )
            text = self._tokenizer.decode(
                gen[0][toks["input_ids"].shape[1]:], skip_special_tokens=True
            ).strip()
            row: Dict[str, Any] = {"id": p["id"], "type": qtype, "answer": text}
            if qtype == "choice":
                match = next(
                    (c for c in (p.get("choices") or []) if c.lower() in text.lower()),
                    None,
                )
                row["choice"] = match
                row["score"] = None
            elif qtype == "score":
                m = re.search(r"-?\d+(?:\.\d+)?", text)
                row["choice"] = None
                row["score"] = float(m.group(0)) if m else None
            else:
                row["choice"] = None
                row["score"] = None
            out.append(row)
        return out

    def health(self) -> Dict[str, Any]:
        if self._model is None:
            try:
                self._ensure()
            except Exception as exc:  # noqa: BLE001
                return {"ready": False, "error": str(exc)}
        return {
            "ready": True,
            "model": DEFAULT_MODEL,
            "file": DEFAULT_GGUF_FILE,
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
                        "file": DEFAULT_GGUF_FILE,
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
                        "file": DEFAULT_GGUF_FILE,
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
                "file": DEFAULT_GGUF_FILE,
                "loaded": self._model is not None,
                "revision": None,
                "revision_source": "unpinned",
                "device": self._device if self._device is not None else DEFAULT_DEVICE_SETTING,
                "circuit": circuit,
            }
        ]


holder = _D1Holder()


class PredictQuestion(BaseModel):
    id: str = Field(..., min_length=1)
    type: Literal["noul", "choice", "score"] = Field(
        ..., description="noul: open generation; choice: constrained to choices; score: numeric."
    )
    prompt: str = Field(..., min_length=1)
    choices: Optional[List[str]] = Field(
        default=None, description="Required for choice (2..16 non-empty entries); ignored otherwise."
    )

    @field_validator("choices")
    @classmethod
    def _check_choices(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return v
        cleaned = [c for c in (c.strip() for c in v) if c]
        if len(cleaned) > 16:
            raise _InputTooLarge(
                "choices", 16, len(cleaned), "send at most 16 choices per question"
            )
        return cleaned


class PredictRequest(BaseModel):
    state: Any = Field(..., description="Context object or string the questions are asked over.")
    questions: List[PredictQuestion] = Field(..., description="Questions to answer (1..D1_LIMITS_MAX_QUESTIONS).")

    @field_validator("questions")
    @classmethod
    def _cap_questions(cls, v: List[PredictQuestion]) -> List[PredictQuestion]:
        limit = _limits_cfg()["max_questions"]
        if len(v) > limit:
            raise _InputTooLarge(
                "questions",
                limit,
                len(v),
                "send at most D1_LIMITS_MAX_QUESTIONS questions per request; split larger batches caller-side",
            )
        if len(v) == 0:
            raise ValueError("questions must be non-empty (nothing to answer)")
        for q in v:
            if q.type == "choice" and (not q.choices or len(q.choices) < 2):
                raise ValueError(
                    f"question {q.id!r}: type 'choice' requires at least 2 non-empty choices"
                )
        return v

    @model_validator(mode="after")
    def _cap_body(self) -> "PredictRequest":
        if isinstance(self.state, str):
            text = self.state
        else:
            try:
                text = json.dumps(self.state, default=str)
            except Exception:  # noqa: BLE001
                text = ""
        limit = _limits_cfg()["max_state_chars"]
        if len(text) > limit:
            raise _InputTooLarge(
                "state",
                limit,
                len(text),
                "reduce state to within D1_LIMITS_MAX_STATE_CHARS chars",
            )
        _check_body(
            {
                "state": text,
                "questions": [
                    {"id": q.id, "type": q.type, "prompt": q.prompt} for q in self.questions
                ],
            }
        )
        return self


app = FastAPI(title="d1-server", version=SERVER_VERSION)

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
        "service": "d1-server",
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
        "service": "d1-server",
        "device": holder._device if holder._device is not None else DEFAULT_DEVICE_SETTING,
        "versions": {"server": SERVER_VERSION},
        "uptime_seconds": time.time() - _SERVER_START,
        "circuit": holder.circuit_state(),
        "models": holder.models_info(),
    }


@app.post("/reload")
async def reload() -> Dict[str, Any]:
    return {"status": "reloaded", "service": "d1-server", **holder.reset()}


@app.post("/predict")
async def predict(req: PredictRequest) -> Dict[str, Any]:
    start = time.perf_counter()
    state = req.state if isinstance(req.state, str) else json.dumps(req.state, default=str)
    char_limit = _limits_cfg()["max_prompt_chars"]
    prompts: List[Dict[str, Any]] = []
    truncated = False
    for q in req.questions:
        prompt = q.prompt
        if len(prompt) > char_limit:
            prompt = prompt[:char_limit]
            truncated = True
        prompts.append({"id": q.id, "type": q.type, "prompt": prompt, "choices": q.choices})
    try:
        await holder.ensure_async()
        answers = await holder.run_bounded(holder.predict_sync, state, prompts)
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
        raise HTTPException(status_code=500, detail=f"predict error: {exc!r}") from exc
    return {
        "answers": answers,
        "latency_ms": (time.perf_counter() - start) * 1000.0,
        "model": DEFAULT_MODEL,
        "file": DEFAULT_GGUF_FILE,
        "truncated": truncated,
        "count": len(req.questions),
    }


def main() -> None:
    import uvicorn

    host = os.getenv("D1_HOST", "127.0.0.1")
    port = int(os.getenv("D1_PORT", "8769"))
    log.info("d1-server starting on http://%s:%d", host, port)
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
