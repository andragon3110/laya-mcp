#!/usr/bin/env python3
"""
laya-mcp Python server.

Minimal HTTP wrapper around the Laya decision engine. Exposes a single
`/predict` endpoint that accepts a state + typed questions JSON payload
and returns the same probability-shaped response Laya emits natively.

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
from pydantic import BaseModel, Field

logging.basicConfig(
    level=os.getenv("LAYA_LOG_LEVEL", "WARNING"),
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("laya-server")

DEFAULT_MODEL = os.getenv("LAYA_MODEL", "convaiinnovations/laya")
DEFAULT_DEVICE = os.getenv("LAYA_DEVICE", "auto")  # auto|cpu|cuda
DEFAULT_LANGUAGE = os.getenv("LAYA_LANGUAGE", "english")  # english|multilingual


class _Router:
    """Lazy Laya loader so the HTTP server boots even when Laya is missing."""

    def __init__(self) -> None:
        self._router = None
        self._load_error: str | None = None
        self._loaded_model: str | None = None

    def _ensure(self) -> Any:
        if self._router is not None:
            return self._router
        if self._load_error is not None:
            raise RuntimeError(self._load_error)
        try:
            from laya import Router

            log.info("loading Laya router model=%s device=%s", DEFAULT_MODEL, DEFAULT_DEVICE)
            self._router = Router(
                model=DEFAULT_MODEL,
                device=DEFAULT_DEVICE if DEFAULT_DEVICE != "auto" else None,
            )
            self._loaded_model = DEFAULT_MODEL
            log.info("Laya router ready")
        except Exception as exc:  # noqa: BLE001
            self._load_error = f"laya not loaded: {exc!r}"
            log.exception("Laya load failed")
            raise
        return self._router

    def predict(self, state: Any, questions: Dict[str, Any]) -> Dict[str, Any]:
        return self._ensure().predict(state, questions)

    def health(self) -> Dict[str, Any]:
        if self._router is None:
            try:
                self._ensure()
            except Exception as exc:  # noqa: BLE001
                return {"ready": False, "error": str(exc)}
        return {
            "ready": True,
            "model": self._loaded_model or DEFAULT_MODEL,
            "device": DEFAULT_DEVICE,
            "language": DEFAULT_LANGUAGE,
        }


router = _Router()


# -- HTTP contract ----------------------------------------------------------

class PredictRequest(BaseModel):
    state: Any = Field(..., description="State (string or JSON object) to evaluate.")
    questions: Dict[str, Any] = Field(
        ..., description="Map of question_id to {type, instructions, criteria?}"
    )
    model: str | None = Field(
        default=None, description="Override the model checkpoint (English/multilingual/typed-decisions)."
    )


class PredictResponse(BaseModel):
    answers: Dict[str, Any]
    confidence: Dict[str, float] = Field(default_factory=dict)
    model: str
    latency_ms: float
    usage: Dict[str, int] = Field(default_factory=dict)


app = FastAPI(title="laya-mcp", version="0.1.0")

# CORS is permissive because this process binds to 127.0.0.1 only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Liveness + readiness. The MCP server polls this to decide which tools to advertise."""
    return {"status": "ok", **router.health()}


@app.get("/ready")
async def ready() -> Dict[str, Any]:
    """Readiness only. 200 if Laya is loaded, 503 otherwise."""
    info = router.health()
    if not info.get("ready"):
        raise HTTPException(status_code=503, detail=info)
    return {"status": "ready", **info}


@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest) -> PredictResponse:
    """Run Laya on state + questions and return typed answers with confidence."""
    start = time.perf_counter()
    try:
        result = await asyncio.to_thread(router.predict, req.state, req.questions)
    except RuntimeError as exc:
        # Laya failed to load (or predict failed) -- surface a structured error.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"prediction error: {exc!r}") from exc

    answers = result.get("answers", {})
    confidence = {
        qid: float(answer.get("confidence", 0.0))
        for qid, answer in answers.items()
        if isinstance(answer, dict)
    }
    latency_ms = (time.perf_counter() - start) * 1000.0
    usage = result.get("usage", {}) if isinstance(result, dict) else {}

    return PredictResponse(
        answers=answers,
        confidence=confidence,
        model=req.model or DEFAULT_MODEL,
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
