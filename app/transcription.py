import logging
import os
import threading

from .config import Settings

log = logging.getLogger("call_analyzer.transcription")


class WhisperEngine:
    """Lazy singleton around faster-whisper. The model is loaded once, on the
    first job (or at startup with WHISPER_PRELOAD=true), under a lock."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model = None
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def get_model(self):
        if self._model is None:
            with self._lock:
                if self._model is None:
                    from faster_whisper import WhisperModel

                    log.info(
                        "loading whisper model=%s device=%s compute_type=%s",
                        self._settings.whisper_model,
                        self._settings.whisper_device,
                        self._settings.whisper_compute_type,
                    )
                    self._model = WhisperModel(
                        self._settings.whisper_model,
                        device=self._settings.whisper_device,
                        compute_type=self._settings.whisper_compute_type,
                        cpu_threads=self._settings.whisper_cpu_threads or (os.cpu_count() or 4),
                    )
                    log.info("whisper model loaded")
        return self._model

    def transcribe_streaming(self, path: str, push) -> list[dict]:
        """Runs in a worker thread. Streams segments through the (thread-safe)
        `push` callable as they are decoded and returns the full segment list."""

        if not self.loaded:
            push("status", {"stage": "loading_model", "model": self._settings.whisper_model})
        model = self.get_model()

        segments, info = model.transcribe(
            path,
            language=None,
            vad_filter=True,
            beam_size=self._settings.whisper_beam_size,
            condition_on_previous_text=False,
        )
        push(
            "status",
            {
                "stage": "transcribing",
                "language": info.language,
                "language_probability": round(info.language_probability, 2),
                "duration": round(info.duration, 1),
            },
        )

        collected: list[dict] = []
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            item = {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text}
            collected.append(item)
            push("segment", item)
        return collected
