import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import logging
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

logger = logging.getLogger("inference_lab")


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
                return await JSONResponse({"detail": "PAYLOAD_TOO_LARGE"}, 413)(
                    scope, receive, send
                )
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
    embedder.embed("warmup")
    return bank


def artifact_fingerprint(directory: Path) -> tuple:
    """Names, sizes and modification times: cheap to compute, changes when a file is replaced."""
    return tuple(
        sorted((p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in directory.glob("*.json"))
    )


class ArtifactReloader:
    """Swaps in a new ProbeBank when the artifact directory changes, without a restart.

    The new bank is fully built and validated before the swap; if any artifact is invalid or
    incompatible, the current bank keeps serving. Requests read app.state.bank once, so an
    in-flight request finishes on the bank it started with.
    """

    def __init__(self, app, directory: Path):
        self.app, self.directory = app, directory
        self.seen = artifact_fingerprint(directory) if directory.exists() else ()

    def reload(self) -> bool:
        fingerprint = artifact_fingerprint(self.directory)
        if fingerprint == self.seen:
            return False
        # Remember failures too, so a bad file is reported once rather than every interval.
        self.seen = fingerprint
        try:
            current = self.app.state.bank
            self.app.state.bank = ProbeBank(current.embedder, load_artifacts(self.directory))
        except Exception:
            logger.warning("Probe artifacts changed but failed validation; keeping current set")
            return False
        logger.info("Reloaded probe artifacts: %s", sorted(self.app.state.bank.indices))
        return True


def create_app(bank_factory=production_bank, probe_dir: Path | None = None, reload_interval_s=0.0):
    async def watch(reloader: ArtifactReloader):
        while True:
            await asyncio.sleep(reload_interval_s)
            await asyncio.to_thread(reloader.reload)

    @asynccontextmanager
    async def lifespan(app):
        bank = bank_factory()
        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="probe")
        app.state.bank, app.state.pool, app.state.slot = bank, pool, Lock()
        app.state.reloader = ArtifactReloader(app, probe_dir) if probe_dir else None
        watcher = None
        if app.state.reloader and reload_interval_s > 0:
            watcher = asyncio.create_task(watch(app.state.reloader))
        try:
            yield
        finally:
            if watcher:
                watcher.cancel()
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
        return {
            "status": "ready",
            "modelVersion": app.state.bank.embedder.model_version,
            "probeIds": sorted(app.state.bank.indices),
        }

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
        return ScoreResponse(
            scores=scores,
            modelVersion=bank.embedder.model_version,
            latencyMs=(perf_counter() - start) * 1000,
        )

    return app


app = create_app(
    probe_dir=Path(os.getenv("PROBE_DIR", "artifacts")),
    reload_interval_s=float(os.getenv("PROBE_RELOAD_INTERVAL_S", "5")),
)
