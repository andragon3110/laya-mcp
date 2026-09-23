#!/usr/bin/env python3
"""
laya-mcp Python server.

Thin HTTP wrapper around the Laya Router. The server boots one `Router`
that loads (or will load) up to three Laya checkpoints and routes each
request to the best fit:

  - `english`          (convaiinnovations/laya,                 ModernBERT-large, 512 ctx)
  - `multilingual`     (convaiinnovations/laya-multilingual,    mmBERT-base,        1024 ctx, 100+ langs)
  - `typed-decisions`  (convaiinnovations/laya-typed-decisions, ModernBERT-large, 1024 ctx, fine-tuned)

This process is intentionally decoupled from the TypeScript MCP server:
either layer can be restarted independently. If this process is not
running, the MCP server reports zero tools and OpenCode continues
without interruption.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import sys
import time
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(
    level=os.getenv("LAYA_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("laya-server")

# Configuration via env vars. The default loads the Router with all three
# checkpoints so script detection + typed-decisions auto-detection work
# out of the box.
ROUTER_DEVICE = os.getenv("LAYA_DEVICE", "auto")  # auto|cpu|cuda
ROUTER_MAX_LOADED = int(os.getenv("LAYA_MAX_LOADED", "3"))
ROUTER_PRELOAD = os.getenv("LAYA_PRELOAD", "1") not in ("0", "false", "False")
ROUTER_AUTO_TASK = os.getenv("LAYA_AUTO_TASK_DETECTION", "1") not in ("0", "false", "False")
ROUTER_STANDALONE_REPOS = os.getenv("LAYA_STANDALONE_REPOS", "0") in ("1", "true", "True")

SERVER_VERSION = "0.4.0"
_SERVER_START = time.time()

# Known Router checkpoints. Repo ids are informational (used by /models);
# per-model revision pins are NOT resolved here (offline-safe: revision=null
# + revision_source="unpinned"). Never invent a hash (T3).
LAYA_CHECKPOINTS = (
    {"name": "english", "repo": "convaiinnovations/laya"},
    {"name": "multilingual", "repo": "convaiinnovations/laya-multilingual"},
    {"name": "typed-decisions", "repo": "convaiinnovations/laya-typed-decisions"},
)


def _laya_version() -> str:
    try:
        from importlib.metadata import version

        return version("laya")
    except Exception:  # noqa: BLE001
        return "unknown"


class _LoadNotReady(RuntimeError):
    """Fail-fast refusal from the backoff/circuit gate.

    Raised WITHOUT touching the model constructor, so a burst of requests
    against a failing backend costs one cheap timestamp check each instead
    of N expensive (and possibly VRAM-crashing) construction attempts.
    Carries `retry_after_seconds` so endpoints can answer 503 + Retry-After.
    """

    def __init__(self, message: str, retry_after_seconds: float) -> None:
        super().__init__(message)
        self.retry_after_seconds = max(0.0, retry_after_seconds)


def _load_retry_cfg() -> Dict[str, float]:
    """Load retry/backoff/circuit tuning, all via env with sane defaults.

    Read dynamically (per load decision, never per request hot path) so
    tests can tune via env without a module reload; production cost is a
    few os.getenv calls per construction attempt only.

    Defaults (documented, T4):
      LAYA_LOAD_RETRY_BASE_S=1.0        first backoff delay after 1 failure
      LAYA_LOAD_RETRY_FACTOR=2.0        exponential growth per failure
      LAYA_LOAD_RETRY_CAP_S=60.0        ceiling for any single backoff delay
      LAYA_LOAD_RETRY_MAX=5             attempts before only probes may pass
      LAYA_LOAD_CIRCUIT_THRESHOLD=3     consecutive failures to open circuit
      LAYA_LOAD_CIRCUIT_COOLDOWN_S=30.0 open -> half-open probe delay
      LAYA_LOAD_ERROR_TTL_S=300.0       cached error expiry (transients must
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
        "base_s": max(0.0, _f("LAYA_LOAD_RETRY_BASE_S", 1.0)),
        "factor": max(1.0, _f("LAYA_LOAD_RETRY_FACTOR", 2.0)),
        "cap_s": max(0.0, _f("LAYA_LOAD_RETRY_CAP_S", 60.0)),
        "max_attempts": _i("LAYA_LOAD_RETRY_MAX", 5),
        "circuit_threshold": _i("LAYA_LOAD_CIRCUIT_THRESHOLD", 3),
        "circuit_cooldown_s": max(0.0, _f("LAYA_LOAD_CIRCUIT_COOLDOWN_S", 30.0)),
        "error_ttl_s": max(0.0, _f("LAYA_LOAD_ERROR_TTL_S", 300.0)),
    }


def _backoff_delay_s(attempts: int, cfg: Dict[str, float]) -> float:
    """Exponential backoff with +/-25% jitter: base * factor^(attempts-1)."""
    delay = min(cfg["cap_s"], cfg["base_s"] * (cfg["factor"] ** max(0, attempts - 1)))
    return max(0.0, delay * (1.0 + random.uniform(-0.25, 0.25)))


def _retry_after_header(seconds: float) -> Dict[str, str]:
    # Retry-After takes whole seconds; always at least 1 on a 503.
    return {"Retry-After": str(max(1, math.ceil(seconds)))}


class _RouterHolder:
    """Lazy Router loader so the HTTP server boots even when Laya is missing.

    T4 failure-tracking: a failed construction records {error, at,
    attempts} instead of a permanent _load_error. Later callers fail fast
    (no constructor call) until the backoff delay elapses; after MAX
    attempts only a post-cooldown half-open probe may pass; a cached error
    older than TTL expires on its own. Any success clears error+attempts.
    The process is never blocked by a model: no sleep, no retry loop in
    the request path -- the *client* retries after Retry-After.
    """

    def __init__(self) -> None:
        self._router = None
        self._load_error: str | None = None
        self._load_error_at: float | None = None
        self._load_attempts = 0
        self._consecutive_failures = 0
        self._loaded_at: float | None = None

    # -- circuit breaker (T4) -------------------------------------------
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
        if self._router is not None:
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
        Never unloads a healthy Router: if loaded, next use just works.
        """
        had_error = self._load_error is not None
        cleared_attempts = self._load_attempts
        self._clear_failure()
        return {
            "cleared_error": had_error,
            "cleared_attempts": cleared_attempts,
            "circuit": self.circuit_state(),
            "loaded": self._router is not None,
        }

    def _check_retry_allowed(self, now: float) -> None:
        """Fail-fast gate. Raises _LoadNotReady without touching the
        constructor when a retry would be aggressive. Gate refusals never
        count as attempts. A cached error older than TTL expires first."""
        if self._router is not None:
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
                    f"laya not loaded: retry budget exhausted "
                    f"({self._load_attempts} attempts): {self._load_error}",
                    cfg["circuit_cooldown_s"] - (now - self._load_error_at),
                )
            return
        delay = _backoff_delay_s(self._load_attempts, cfg)
        if now - self._load_error_at < delay:
            raise _LoadNotReady(
                f"laya not loaded: backing off "
                f"(attempt {self._load_attempts}): {self._load_error}",
                delay - (now - self._load_error_at),
            )

    def _record_failure(self, exc: BaseException, now: float) -> None:
        self._load_attempts += 1
        self._consecutive_failures += 1
        self._load_error = f"laya not loaded: {exc!r}"
        self._load_error_at = now
        log.warning(
            "Laya load failed (attempt %d, circuit=%s): %s",
            self._load_attempts,
            self.circuit_state(now),
            self._load_error,
        )

    def _record_success(self, now: float) -> None:
        self._clear_failure()
        self._loaded_at = now

    def _do_load(self) -> None:
        from laya import Router

        log.info(
            "loading Laya Router (device=%s, preload=%s, auto_task_detection=%s, "
            "max_loaded=%d, standalone_repos=%s)",
            ROUTER_DEVICE,
            ROUTER_PRELOAD,
            ROUTER_AUTO_TASK,
            ROUTER_MAX_LOADED,
            ROUTER_STANDALONE_REPOS,
        )
        self._router = Router(
            device=None if ROUTER_DEVICE == "auto" else ROUTER_DEVICE,
            max_loaded=ROUTER_MAX_LOADED,
            auto_task_detection=ROUTER_AUTO_TASK,
            standalone_repos=ROUTER_STANDALONE_REPOS,
            preload=ROUTER_PRELOAD,
        )
        log.info(
            "Laya Router ready: loaded=%s, laya_sdk=%s",
            self._router.loaded,
            _laya_version(),
        )

    def _ensure(self) -> Any:
        if self._router is not None:
            return self._router
        self._check_retry_allowed(time.time())
        try:
            self._do_load()
        except Exception as exc:  # noqa: BLE001
            self._record_failure(exc, time.time())
            raise
        self._record_success(time.time())
        return self._router

    def predict(self, state: Any, questions: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
        # kwargs passes Router routing overrides straight through:
        # model="typed-decisions", task="typed_decisions", lang="es", ...
        router = self._ensure()
        return router.predict(state, questions, **kwargs) if kwargs else router.predict(state, questions)

    def health(self) -> Dict[str, Any]:
        if self._router is None:
            try:
                self._ensure()
            except Exception as exc:  # noqa: BLE001
                return {"ready": False, "error": str(exc), "laya_sdk_version": _laya_version()}
        return {
            "ready": True,
            "loaded": list(self._router.loaded),
            "auto_task_detection": ROUTER_AUTO_TASK,
            "max_loaded": ROUTER_MAX_LOADED,
            "device": ROUTER_DEVICE,
            "laya_sdk_version": _laya_version(),
            "uptime_seconds": (time.time() - self._loaded_at) if self._loaded_at else 0.0,
        }

    def snapshot(self) -> Dict[str, Any]:
        """Non-warming readiness snapshot. Never triggers a model load.

        T4: failure-tracking state is surfaced as `circuit`
        (closed|open|half-open), `load_attempts` and `retry_after_seconds`
        so operators can tell a backing-off backend from a dead one.
        """
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION, "laya_sdk": _laya_version()}
        circuit = self.circuit_state()
        if self._router is None and self._load_error is None:
            return {
                "ready": False,
                "reason": "not loaded yet (no load attempted)",
                "loaded": [],
                "failed": [
                    {"name": c["name"], "repo": c["repo"], "error": "not loaded yet"}
                    for c in LAYA_CHECKPOINTS
                ],
                "device": ROUTER_DEVICE,
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
                "loaded": list(self._router.loaded) if self._router is not None else [],
                # Global Router failure attributed per-checkpoint in the body
                # only; per-checkpoint load tracking lands in T4.
                "failed": [
                    {"name": c["name"], "repo": c["repo"], "error": self._load_error}
                    for c in LAYA_CHECKPOINTS
                ],
                "device": ROUTER_DEVICE,
                "versions": versions,
                "uptime_seconds": uptime,
                "circuit": circuit,
                "load_attempts": self._load_attempts,
                "retry_after_seconds": self.retry_after_seconds(),
            }
        loaded = list(self._router.loaded)
        loaded_set = set(loaded)
        return {
            "ready": True,
            "reason": None,
            "loaded": loaded,
            "failed": [
                {"name": c["name"], "repo": c["repo"], "error": "not loaded"}
                for c in LAYA_CHECKPOINTS
                if c["name"] not in loaded_set
            ],
            "device": ROUTER_DEVICE,
            "versions": versions,
            "uptime_seconds": uptime,
            "circuit": circuit,
            "load_attempts": self._load_attempts,
            "retry_after_seconds": 0.0,
        }

    def models_info(self) -> list[Dict[str, Any]]:
        """Per-checkpoint inventory. Never triggers a model load.

        `revision` is null + revision_source="unpinned" because pins are not
        resolvable offline here; resolving them (cache/manifest lookup) is
        future work, not T3. `circuit` mirrors the holder breaker state.
        """
        loaded_set = set(self._router.loaded) if self._router is not None else set()
        circuit = self.circuit_state()
        return [
            {
                "name": c["name"],
                "repo": c["repo"],
                "loaded": c["name"] in loaded_set,
                "revision": None,
                "revision_source": "unpinned",
                "device": ROUTER_DEVICE,
                "circuit": circuit,
            }
            for c in LAYA_CHECKPOINTS
        ]


# Process-independence note (T4, verified by construction): this holder lives
# in the laya-server OS process only. gliner-server is a separate process
# (own FastAPI app, own port, own holder, no shared state or locks), so a
# GLiNER failure cannot crash this process and vice versa. The MCP layer
# already degrades when either side is down (src/index.ts).
router = _RouterHolder()


# -- HTTP contract ----------------------------------------------------------

class PredictRequest(BaseModel):
    state: Any = Field(..., description="State (string or JSON object) to evaluate.")
    questions: Dict[str, Any] = Field(
        ..., description="Map of question_id to {type, instructions, criteria?}"
    )
    model: str | None = Field(
        default=None,
        description=(
            "Force a specific checkpoint: 'english', 'multilingual', 'typed-decisions' "
            "(or alias 'typed'). With auto_task_detection on, leave unset to let the Router decide."
        ),
    )
    task: str | None = Field(
        default=None,
        description="Force a task family. With auto_task_detection, leave unset.",
    )
    lang: str | None = Field(
        default=None,
        description="Force a language hint (e.g. 'en', 'es', 'fr').",
    )


class PredictResponse(BaseModel):
    answers: Dict[str, Any]
    confidence: Dict[str, float] = Field(default_factory=dict)
    routing: Dict[str, Any] = Field(default_factory=dict)
    latency_ms: float
    usage: Dict[str, int] = Field(default_factory=dict)


app = FastAPI(title="laya-mcp", version=SERVER_VERSION)

# CORS is permissive because this process binds to 127.0.0.1 only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/live")
async def live() -> Dict[str, Any]:
    """Liveness only. Immediate: never touches the holder, never loads models.

    Safe to poll aggressively; works with models down or never loaded.
    """
    return {
        "alive": True,
        "service": "laya-server",
        "version": SERVER_VERSION,
        "uptime_seconds": time.time() - _SERVER_START,
    }


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Legacy liveness + readiness. WARNING: may warm up (lazy-load) models
    via the holder on first call -- but never aggressively: inside the
    backoff/cooldown window it fails fast without touching the constructor
    (T4). Prefer /live (liveness) + /ready (readiness) for k8s-style probes;
    the TS health watcher polls those since T4."""
    return {"status": "ok", **router.health()}


@app.get("/ready")
async def ready() -> Dict[str, Any]:
    """Readiness only (non-warming snapshot). 200 when ready, else 503 with a
    structured body {ready:false, reason, loaded, failed, device, versions,
    uptime_seconds, circuit, load_attempts, retry_after_seconds} plus a
    Retry-After header -- a not-ready backend is never hidden."""
    info = router.snapshot()
    if not info.get("ready"):
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", **info},
            headers=_retry_after_header(float(info.get("retry_after_seconds") or 0.0)),
        )
    return {"status": "ready", **info}


@app.get("/models")
async def models() -> Dict[str, Any]:
    """Per-checkpoint inventory. Always 200, never triggers a model load."""
    return {
        "service": "laya-server",
        "device": ROUTER_DEVICE,
        "versions": {"server": SERVER_VERSION, "laya_sdk": _laya_version()},
        "uptime_seconds": time.time() - _SERVER_START,
        "circuit": router.circuit_state(),
        "models": router.models_info(),
    }


@app.post("/reload")
async def reload() -> Dict[str, Any]:
    """Operational (non-destructive) reset of load failure-tracking.

    Clears the cached {error, at, attempts} and closes the circuit so the
    next use retries construction immediately instead of waiting out the
    backoff/cooldown. Never unloads a healthy Router. Always 200 -- the
    body reports what was cleared. Use after fixing the underlying cause
    (VRAM freed, HF reachable again); without a fix the next attempt will
    simply fail and re-enter backoff.
    """
    return {"status": "reloaded", "service": "laya-server", **router.reset()}


@app.get("/doctor")
async def doctor(live: bool = True) -> Dict[str, Any]:
    """Run the full laya-mcp diagnostic report.

    Re-uses the same checks as `py/doctor.py` so the HTTP endpoint and
    the CLI are guaranteed to agree. Pass `?live=false` to skip the
    /health and /predict probes (useful when the server itself is down
    or you want a fast read-only check).
    """
    # Import locally so the doctor module can be patched without restarting
    # the server, and so its transitive imports (psutil, torch) are not
    # required for the server to start.
    import doctor

    host = os.getenv("LAYA_HOST", "127.0.0.1")
    port = int(os.getenv("LAYA_PORT", "8765"))
    gliner_host = os.getenv("GLINER_HOST", "127.0.0.1")
    gliner_port = int(os.getenv("GLINER_PORT", "8766"))
    report = doctor.run_doctor(
        laya_host=host,
        laya_port=port,
        include_live_calls=live,
        gliner_host=gliner_host,
        gliner_port=gliner_port,
    )
    # Always 200 -- the report carries the verdict. The MCP host and CLI
    # can branch on report["ok"].
    return report


@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest) -> PredictResponse:
    """Run Laya on state + questions. Routing is decided by the Router unless caller forces it."""
    start = time.perf_counter()
    try:
        kwargs: Dict[str, Any] = {}
        if req.model is not None:
            kwargs["model"] = req.model
        if req.task is not None:
            kwargs["task"] = req.task
        if req.lang is not None:
            kwargs["lang"] = req.lang
        result = await asyncio.to_thread(
            lambda: router.predict(req.state, req.questions, **kwargs)
            if kwargs
            else router.predict(req.state, req.questions)
        )
    except _LoadNotReady as exc:
        # Backoff/circuit fail-fast: 503 with Retry-After, no retry loop.
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers=_retry_after_header(exc.retry_after_seconds),
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers=_retry_after_header(router.retry_after_seconds()),
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"prediction error: {exc!r}") from exc

    answers = result.get("answers", {})
    confidence = {
        qid: float(answer.get("confidence", 0.0))
        for qid, answer in answers.items()
        if isinstance(answer, dict)
    }
    routing = result.get("routing", {}) if isinstance(result, dict) else {}
    latency_ms = (time.perf_counter() - start) * 1000.0
    usage = result.get("usage", {}) if isinstance(result, dict) else {}

    return PredictResponse(
        answers=answers,
        confidence=confidence,
        routing=routing,
        latency_ms=latency_ms,
        usage=usage,
    )


def main() -> None:
    import uvicorn

    host = os.getenv("LAYA_HOST", "127.0.0.1")
    port = int(os.getenv("LAYA_PORT", "8765"))
    log.info("laya-server starting on http://%s:%d", host, port)
    uvicorn.run(app, host=host, port=port, log_level=os.getenv("LAYA_LOG_LEVEL", "warning").lower())


if __name__ == "__main__":
    main()
