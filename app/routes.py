import asyncio
import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from .analysis import OllamaModelMissingError, OllamaUnavailableError, analyze
from .jobs import Job, sse

log = logging.getLogger("call_analyzer.routes")

router = APIRouter(prefix="/api")

ALLOWED_EXTENSIONS = {
    ".mp3", ".wav", ".m4a", ".mp4", ".aac", ".ogg", ".opus",
    ".flac", ".wma", ".webm", ".amr", ".mka", ".mkv", ".3gp",
}

ERR_UNSUPPORTED_FORMAT = "פורמט הקובץ אינו נתמך. יש להעלות קובץ שמע (mp3, wav, m4a, ogg ועוד)."
ERR_TOO_LARGE = "הקובץ גדול מדי. הגודל המרבי הוא {mb}MB."
ERR_EMPTY_FILE = "הקובץ שהועלה ריק."
ERR_TRANSCRIPTION_FAILED = "התמלול נכשל. ודאו שהקובץ הוא הקלטת שמע תקינה ונסו שוב."
ERR_EMPTY_TRANSCRIPT = "לא זוהה דיבור בהקלטה. ודאו שהקובץ מכיל שיחה ונסו שוב."
ERR_OLLAMA_UNREACHABLE = (
    "שירות Ollama אינו זמין ולכן לא הופק ניתוח עסקי. "
    "הפעילו את Ollama (הפקודה: ollama serve) ונסו שוב. התמליל המלא זמין למעלה."
)
ERR_OLLAMA_MODEL_MISSING = (
    "מודל הניתוח '{model}' אינו מותקן ב-Ollama. "
    "התקינו אותו עם הפקודה: ollama pull {model}. התמליל המלא זמין למעלה."
)
ERR_INTERNAL = "אירעה שגיאה בלתי צפויה בעיבוד השיחה. נסו שוב."


@router.get("/health")
async def health(request: Request):
    state = request.app.state
    return {
        "status": "ok",
        "whisper_model": state.settings.whisper_model,
        "whisper_loaded": state.engine.loaded,
        "ollama": await state.ollama.probe(),
    }


@router.post("/analyze", status_code=202)
async def create_analysis(request: Request, file: UploadFile = File(...)):
    state = request.app.state
    settings = state.settings

    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail={"code": "unsupported_format", "message": ERR_UNSUPPORTED_FORMAT})

    # Stream the upload to an ephemeral temp file. It is the only place the
    # audio ever touches disk, and it is deleted in process_job's finally block.
    tmp = tempfile.NamedTemporaryFile(delete=False, prefix="call_", suffix=ext)
    size = 0
    try:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > settings.max_upload_bytes:
                raise HTTPException(
                    status_code=413,
                    detail={"code": "too_large", "message": ERR_TOO_LARGE.format(mb=settings.max_upload_mb)},
                )
            tmp.write(chunk)
        tmp.close()
        if size == 0:
            raise HTTPException(status_code=400, detail={"code": "empty_file", "message": ERR_EMPTY_FILE})
    except BaseException:
        tmp.close()
        os.unlink(tmp.name)
        raise

    job = state.registry.create()
    log.info("job %s created (%d bytes)", job.id, size)
    asyncio.create_task(process_job(job, tmp.name, state))
    return {"job_id": job.id}


async def process_job(job: Job, tmp_path: str, state) -> None:
    settings = state.settings
    loop = asyncio.get_running_loop()
    segments: list[dict] | None = None
    try:
        try:
            if state.semaphore.locked():
                job.emit("status", {"stage": "queued"})
            async with state.semaphore:
                segments = await loop.run_in_executor(
                    None, state.engine.transcribe_to_queue, tmp_path, loop, job.queue
                )
        finally:
            try:
                os.unlink(tmp_path)
                log.info("job %s: temp audio deleted", job.id)
            except FileNotFoundError:
                pass

        job.emit("transcript_done", {"segments": len(segments)})
        if not segments:
            job.emit("error", {"code": "empty_transcript", "message": ERR_EMPTY_TRANSCRIPT})
            return

        job.emit("status", {"stage": "analyzing"})
        result = await analyze(
            segments,
            state.ollama,
            settings,
            progress=lambda i, n: job.emit("status", {"stage": "analyzing", "chunk": i, "chunks": n}),
        )
        job.emit("analysis", result.model_dump())
        job.emit("done", {})
        log.info("job %s completed", job.id)

    except OllamaUnavailableError:
        log.info("job %s: ollama unreachable", job.id)
        job.emit("error", {"code": "ollama_unreachable", "message": ERR_OLLAMA_UNREACHABLE})
    except OllamaModelMissingError:
        log.info("job %s: ollama model missing", job.id)
        job.emit(
            "error",
            {"code": "ollama_model_missing", "message": ERR_OLLAMA_MODEL_MISSING.format(model=settings.ollama_model)},
        )
    except Exception:
        # Never log content — only the error class and job id.
        log.exception("job %s failed", job.id)
        if segments is None:
            job.emit("error", {"code": "transcription_failed", "message": ERR_TRANSCRIPTION_FAILED})
        else:
            job.emit("error", {"code": "internal", "message": ERR_INTERNAL})


@router.get("/jobs/{job_id}/stream")
async def stream_job(job_id: str, request: Request):
    registry = request.app.state.registry
    job = registry.get(job_id)
    if job is None or job.consumed:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "המשרה לא נמצאה או שכבר נצרכה."})
    job.consumed = True

    async def event_stream():
        try:
            while True:
                try:
                    event, data = await asyncio.wait_for(job.queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # Heartbeat so proxies don't drop the connection while the
                    # whisper model loads or a long LLM call runs.
                    yield ": ping\n\n"
                    continue
                yield sse(event, data)
                if event in ("done", "error"):
                    break
        finally:
            registry.finish(job_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
