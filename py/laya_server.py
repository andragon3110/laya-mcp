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
import os
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


class _RouterHolder:
    """Lazy Router loader so the HTTP server boots even when Laya is missing."""

    def __init__(self) -> None:
        self._router = None
        self._load_error: str | None = None
        self._loaded_at: float | None = None

    def _ensure(self) -> Any:
        if self._router is not None:
            return self._router
        if self._load_error is not None:
            raise RuntimeError(self._load_error)
        try:
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
            self._loaded_at = time.time()
            log.info(
                "Laya Router ready: loaded=%s, laya_sdk=%s",
                self._router.loaded,
                _laya_version(),
            )
        except Exception as exc:  # noqa: BLE001
            self._load_error = f"laya not loaded: {exc!r}"
            log.exception("Laya load failed")
            raise
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

        T3: breaks the opaque _load_error into a per-checkpoint `failed`
        list in the *body* of /ready and /models only. The permanent-failure
        behaviour itself is unchanged (retry/backoff/recovery is T4).
        """
        uptime = time.time() - _SERVER_START
        versions = {"server": SERVER_VERSION, "laya_sdk": _laya_version()}
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
        }

    def models_info(self) -> list[Dict[str, Any]]:
        """Per-checkpoint inventory. Never triggers a model load.

        `revision` is null + revision_source="unpinned" because pins are not
        resolvable offline here; resolving them (cache/manifest lookup) is
        future work, not T3.
        """
        loaded_set = set(self._router.loaded) if self._router is not None else set()
        return [
            {
                "name": c["name"],
                "repo": c["repo"],
                "loaded": c["name"] in loaded_set,
                "revision": None,
                "revision_source": "unpinned",
                "device": ROUTER_DEVICE,
            }
            for c in LAYA_CHECKPOINTS
        ]


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
    via the holder on first call. Prefer /live (liveness) + /ready (readiness)
    for k8s-style probes; the TS health watcher still polls here in T3 and
    migrates in T4."""
    return {"status": "ok", **router.health()}


@app.get("/ready")
async def ready() -> Dict[str, Any]:
    """Readiness only (non-warming snapshot). 200 when ready, else 503 with a
    structured body {ready:false, reason, loaded, failed, device, versions,
    uptime_seconds} -- a not-ready backend is never hidden."""
    info = router.snapshot()
    if not info.get("ready"):
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", **info},
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
        "models": router.models_info(),
    }


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
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
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
