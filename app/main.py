import asyncio
import contextlib
import logging
import threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .analysis import OllamaClient
from .config import get_settings
from .groq import GroqClient
from .jobs import JobRegistry
from .routes import router
from .transcription import WhisperEngine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings
    app.state.registry = JobRegistry(settings.job_ttl_seconds)
    app.state.engine = WhisperEngine(settings)
    app.state.ollama = OllamaClient(settings)
    app.state.groq = GroqClient(settings)
    app.state.semaphore = asyncio.Semaphore(settings.max_concurrent_jobs)

    reaper_task = asyncio.create_task(app.state.registry.reaper())
    if settings.whisper_preload:
        threading.Thread(target=app.state.engine.get_model, daemon=True).start()

    yield

    reaper_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await reaper_task


app = FastAPI(title="מנתח שיחות — Call Analyzer", lifespan=lifespan)
app.include_router(router)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})
