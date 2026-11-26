import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import os
from pathlib import Path
from threading import Lock
from time import perf_counter
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse
from .contracts import ScoreRequest, ScoreResponse
from .model import InputTooLong, load_embedder
from .probes import ProbeBank, load_artifacts


class BodyLimit:
    """Bound bytes before Pydantic sees the body, including chunked requests."""
    def __init__(self, app, limit=65536):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/v1/score":
            return await self.app(scope, receive, send)
        parts, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.limit:
                return await JSONResponse({"detail": "PAYLOAD_TOO_LARGE"}, 413)(scope, receive, send)
            parts.append(chunk)
            if not message.get("more_body", False):
                break
        async def replay():
            if parts:
                body = b"".join(parts)
                parts.clear()
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()
        await self.app(scope, replay, send)


def production_bank():
    embedder = load_embedder()
    artifacts = load_artifacts(Path(os.getenv("PROBE_DIR", "artifacts")))
    expected = os.getenv("EXPECTED_PROBE_VERSION")
    if expected and not any(p.version == expected for p in artifacts):
        raise ValueError("expected probe version missing")
    bank = ProbeBank(embedder, artifacts)
    embedder.embed('warmup')
    return bank


def create_app(bank_factory=production_bank):
    @asynccontextmanager
    async def lifespan(app):
        bank = bank_factory()
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="probe")
        app.state.bank, app.state.pool, app.state.slot = bank, pool, Lock()
        try:
            yield
        finally:
            await asyncio.to_thread(pool.shutdown, wait=True, cancel_futures=True)
            close = getattr(bank.embedder, "close", None)
            if close:
                close()

    app = FastAPI(title="Agent guardrail inference", lifespan=lifespan)
    app.add_middleware(BodyLimit)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request, _exc):
        # Pydantic defaults can echo input values; keep customer text out of errors.
        return JSONResponse({"detail": "INVALID_SCORE_REQUEST"}, status_code=422)

    @app.get("/health/live")
    async def live():
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready():
        return {"status": "ready", "modelVersion": app.state.bank.embedder.model_version,
                "probeIds": sorted(app.state.bank.indices)}

    @app.post("/v1/score", response_model=ScoreResponse)
    async def score(request: ScoreRequest):
        start = perf_counter()
        bank = app.state.bank
        if any(key not in bank.indices for key in request.probeIds):
            raise HTTPException(422, "UNKNOWN_PROBE_VERSION")
        if not app.state.slot.acquire(blocking=False):
            raise HTTPException(503, "INFERENCE_BUSY")

        def work():
            try:
                return bank.score(request.text, request.probeIds)
            finally:
                # A cancelled HTTP request must not free the slot while PyTorch is still running.
                app.state.slot.release()
        try:
            future = asyncio.get_running_loop().run_in_executor(app.state.pool, work)
        except BaseException:
            app.state.slot.release()
            raise
        try:
            scores = await asyncio.shield(future)
        except InputTooLong:
            raise HTTPException(422, "TOKEN_LIMIT_EXCEEDED") from None
        except Exception:
            raise HTTPException(503, "INFERENCE_FAILED") from None
        return ScoreResponse(scores=scores, modelVersion=bank.embedder.model_version,
                             latencyMs=(perf_counter() - start) * 1000)

    return app


app = create_app()
