"""Optional free-tier cloud boost: when GROQ_API_KEY is set, transcription and
analysis run on Groq's GPU/LPU servers (whisper-large-v3-turbo + a 120B LLM)
instead of locally — much faster and more accurate. The audio is sent to Groq
for processing only; nothing is stored by this app."""
import asyncio
import logging
import os

import httpx

from .config import Settings

log = logging.getLogger("call_analyzer.groq")


class GroqError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class GroqClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def enabled(self) -> bool:
        return bool(self._settings.groq_api_key)

    @property
    def llm_model(self) -> str:
        return self._settings.groq_llm_model

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._settings.groq_api_key}"}

    @staticmethod
    def _reason(status: int) -> str:
        if status == 401:
            return "המפתח אינו תקין"
        if status == 413:
            return "הקובץ גדול ממגבלת החינם (25MB)"
        if status == 429:
            return "חריגה ממכסת החינם"
        return f"שגיאת שירות ({status})"

    async def transcribe(self, path: str) -> tuple[list[dict], dict]:
        try:
            async with httpx.AsyncClient(timeout=self._settings.ollama_timeout_seconds) as client:
                with open(path, "rb") as f:
                    resp = await client.post(
                        f"{self._settings.groq_base_url}/audio/transcriptions",
                        headers=self._headers(),
                        data={"model": self._settings.groq_asr_model, "response_format": "verbose_json"},
                        files={"file": (os.path.basename(path), f, "application/octet-stream")},
                    )
        except httpx.HTTPError as exc:
            raise GroqError("אין חיבור לשרת הענן") from exc
        if resp.status_code != 200:
            raise GroqError(self._reason(resp.status_code))

        payload = resp.json()
        segments = [
            {
                "start": round(float(seg.get("start", 0)), 2),
                "end": round(float(seg.get("end", 0)), 2),
                "text": (seg.get("text") or "").strip(),
            }
            for seg in payload.get("segments", [])
            if (seg.get("text") or "").strip()
        ]
        if not segments and (payload.get("text") or "").strip():
            segments = [{"start": 0.0, "end": 0.0, "text": payload["text"].strip()}]
        info = {"language": payload.get("language"), "duration": payload.get("duration")}
        return segments, info

    async def chat(self, system: str, user: str, _retried: bool = False) -> str:
        body = {
            "model": self._settings.groq_llm_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        }
        try:
            async with httpx.AsyncClient(timeout=self._settings.ollama_timeout_seconds) as client:
                resp = await client.post(
                    f"{self._settings.groq_base_url}/chat/completions",
                    headers=self._headers(),
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise GroqError("אין חיבור לשרת הענן") from exc

        if resp.status_code == 429 and not _retried:
            wait = min(20, int(resp.headers.get("retry-after", "10") or 10))
            log.info("groq rate-limited, retrying in %ss", wait)
            await asyncio.sleep(wait)
            return await self.chat(system, user, _retried=True)
        if resp.status_code != 200:
            raise GroqError(self._reason(resp.status_code))
        return resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
