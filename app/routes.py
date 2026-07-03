import asyncio
import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from .analysis import OllamaModelMissingError, OllamaUnavailableError, analyze
from .groq import GroqError
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
ERR_GROQ = "האצת הענן (Groq) נכשלה: {reason}. בדקו את המפתח, או הסירו את GROQ_API_KEY כדי לחזור לעיבוד מקומי."


@router.get("/health")
async def health(request: Request):
    state = request.app.state
    return {
        "status": "ok",
        "whisper_model": state.settings.whisper_model,
        "whisper_loaded": state.engine.loaded,
        "groq": {"enabled": state.groq.enabled, "model": state.settings.groq_llm_model},
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
    # Speed: pull the analysis model into memory while whisper is transcribing,
    # so the analysis stage starts with a hot model (skipped in cloud mode).
    if not state.groq.enabled:
        warmup_task = asyncio.create_task(state.ollama.warmup())
        warmup_task.add_done_callback(lambda t: t.exception())
    try:
        def push_threadsafe(event: str, data: dict) -> None:
            loop.call_soon_threadsafe(job.emit, event, data)

        try:
            if state.groq.enabled:
                job.emit("status", {"stage": "uploading_cloud"})
                segments, info = await state.groq.transcribe(tmp_path)
                job.emit("status", {
                    "stage": "transcribing",
                    "language": info.get("language"),
                    "duration": info.get("duration"),
                    "cloud": True,
                })
                for seg in segments:
                    job.emit("segment", seg)
            else:
                if state.semaphore.locked():
                    job.emit("status", {"stage": "queued"})
                async with state.semaphore:
                    segments = await loop.run_in_executor(
                        None, state.engine.transcribe_streaming, tmp_path, push_threadsafe
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
            groq=state.groq,
        )
        job.emit("analysis", result.model_dump())
        job.emit("done", {})
        log.info("job %s completed", job.id)

    except GroqError as exc:
        log.info("job %s: groq failed (%s)", job.id, exc.reason)
        job.emit("error", {"code": "groq_failed", "message": ERR_GROQ.format(reason=exc.reason)})
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


@router.get("/jobs/{job_id}")
async def job_status(job_id: str, request: Request):
    job = request.app.state.registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "העבודה לא נמצאה."})
    return {"id": job.id, "events": len(job.history), "done": job.done}


@router.get("/jobs/{job_id}/stream")
async def stream_job(job_id: str, request: Request):
    registry = request.app.state.registry
    job = registry.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "העבודה לא נמצאה."})

    # Resume support: EventSource sends Last-Event-ID automatically on
    # reconnect; a reloaded page passes ?after=<last id it stored>.
    after = -1
    for raw in (request.query_params.get("after"), request.headers.get("last-event-id")):
        if raw is not None:
            try:
                after = max(after, int(raw))
            except ValueError:
                pass

    async def event_stream():
        idx = after + 1
        while True:
            if idx < len(job.history):
                event, data = job.history[idx]
                yield sse(event, data, event_id=idx)
                idx += 1
                if event in ("done", "error"):
                    break
                continue
            if job.done or registry.get(job_id) is None:
                break
            job.updated.clear()
            if idx < len(job.history):
                continue
            try:
                await asyncio.wait_for(job.updated.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                # Heartbeat so proxies don't drop the connection while the
                # whisper model loads or a long LLM call runs.
                yield ": ping\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
