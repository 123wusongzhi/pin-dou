"""Authenticated loopback service for the local NVIDIA GPU."""

from __future__ import annotations

import asyncio
import base64
import binascii
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
import secrets
import threading
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from quantizer import ALGORITHM, GpuQuantizer, PALETTE_INDEX

MAX_BODY_BYTES = 300 * 1024
MAX_PIXELS = 192 * 192
logger = logging.getLogger("pindou.gpu")


class QuantizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    width: Annotated[int, Field(ge=1, le=192)]
    height: Annotated[int, Field(ge=1, le=192)]
    pixels: Annotated[str, Field(min_length=4, max_length=MAX_PIXELS * 4 * 4 // 3)]
    maxColors: Annotated[int, Field(ge=1, le=291)]
    paletteIds: Annotated[list[str], Field(min_length=1, max_length=291)]
    processingMode: Literal["edge", "dominant", "average"]

    @field_validator("paletteIds")
    @classmethod
    def valid_palette(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("paletteIds must not contain duplicate color IDs.")
        if any(color_id not in PALETTE_INDEX for color_id in values):
            raise ValueError("paletteIds must contain only fixed MARD 291 color IDs.")
        return values

    def decoded_pixels(self):
        try:
            raw = base64.b64decode(self.pixels, validate=True)
        except (ValueError, binascii.Error):
            raise HTTPException(422, "pixels must be valid base64 RGBA8 data.") from None
        if len(raw) != self.width * self.height * 4:
            raise HTTPException(422, "RGBA8 byte length does not match width and height.")
        return raw


def read_token():
    path = os.environ.get("GPU_SERVICE_TOKEN_FILE")
    if not path:
        raise RuntimeError("GPU_SERVICE_TOKEN_FILE must point to a private token file.")
    token = Path(path).read_text(encoding="utf-8").strip()
    if len(token) < 32 or len(token) > 256:
        raise RuntimeError("GPU service token must contain 32 to 256 characters.")
    return token


def create_app(engine_factory=GpuQuantizer):
    @asynccontextmanager
    async def lifespan(app):
        app.state.token = read_token()
        app.state.busy = threading.Lock()
        app.state.engine = None
        app.state.error = None
        app.state.active_task = None
        try:
            app.state.engine = await asyncio.to_thread(engine_factory)
        except Exception:
            logger.exception("CUDA initialization or warmup failed.")
            app.state.error = "CUDA initialization failed. Check the GPU service log."
        yield

    app = FastAPI(
        title="Pin Dou local GPU service", lifespan=lifespan,
        docs_url=None, redoc_url=None, openapi_url=None,
    )

    def authorize(request):
        authorization = request.headers.get("authorization", "")
        expected = f"Bearer {app.state.token}"
        if not secrets.compare_digest(authorization.encode(), expected.encode()):
            raise HTTPException(401, "Invalid GPU service credentials.")

    @app.get("/health")
    async def health(request: Request):
        authorize(request)
        if app.state.engine is None or app.state.error:
            return JSONResponse(status_code=503, content={
                "available": False, "device": None, "algorithm": ALGORITHM,
                "error": app.state.error or "CUDA is not initialized.",
            })
        return {
            "available": True, "device": app.state.engine.device,
            "algorithm": ALGORITHM, "busy": app.state.busy.locked(),
        }

    @app.post("/v1/quantize")
    async def quantize(request: Request):
        authorize(request)
        if app.state.engine is None or app.state.error:
            raise HTTPException(503, "CUDA is unavailable. Check /health and restart the GPU service.")
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_size = int(content_length)
            except ValueError:
                raise HTTPException(400, "Invalid Content-Length.") from None
            if declared_size > MAX_BODY_BYTES:
                raise HTTPException(413, "GPU request exceeds the 300 KiB limit.")
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                raise HTTPException(413, "GPU request exceeds the 300 KiB limit.")
            body.extend(chunk)
        try:
            payload = QuantizeRequest.model_validate_json(body)
        except ValidationError:
            # Avoid reflecting image payloads into errors or logs.
            raise HTTPException(422, "Invalid GPU quantization request.") from None
        raw = payload.decoded_pixels()
        if not app.state.busy.acquire(blocking=False):
            raise HTTPException(429, "The GPU is busy. Retry after the current conversion finishes.",
                                headers={"Retry-After": "1"})

        def compute():
            import numpy as np

            try:
                return app.state.engine.quantize(
                    np.frombuffer(raw, dtype=np.uint8),
                    payload.width, payload.height, payload.maxColors,
                    payload.paletteIds, payload.processingMode,
                )
            except Exception:
                logger.exception("CUDA quantization failed.")
                app.state.error = "CUDA computation failed. Restart the GPU service."
                raise HTTPException(503, app.state.error) from None
            finally:
                # A disconnected HTTP client does not release the lock while CUDA still runs.
                app.state.busy.release()

        job = asyncio.create_task(asyncio.to_thread(compute))
        app.state.active_task = job

        def completed(task):
            app.state.active_task = None
            if not task.cancelled():
                task.exception()

        job.add_done_callback(completed)
        return await asyncio.shield(job)

    return app


app = create_app()
