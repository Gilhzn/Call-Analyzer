import json
import logging
import re
from typing import Awaitable, Callable

import httpx

from .config import Settings
from .schemas import AnalysisMeta, AnalysisResult

log = logging.getLogger("call_analyzer.analysis")


class OllamaUnavailableError(Exception):
    pass


class OllamaModelMissingError(Exception):
    pass


SYSTEM_PROMPT = """אתה אנליסט עסקי מומחה. תקבל תמליל של שיחה עסקית מוקלטת. נתח אותה ביסודיות והשב בעברית בלבד.

השב אך ורק באובייקט JSON תקין במבנה הבא:
{
  "summary": "פסקת סיכום עסקית תמציתית של השיחה — מה מטרתה, מה סוכם ומה התוצאה",
  "key_points": ["נקודה עסקית חשובה", "כולל שמות, סכומים, תאריכים והתחייבויות שהוזכרו במפורש"],
  "action_items": [{"task": "משימה לביצוע", "owner": "נציג / לקוח / לא ידוע", "due": "מועד יעד אם הוזכר, אחרת מחרוזת ריקה"}],
  "participants": "אפיון הדוברים: מי הם, תפקידם והקשר ביניהם",
  "sentiment": "חיובי / ניטרלי / שלילי / מעורב",
  "topics": ["נושא מרכזי", "נושא נוסף"]
}

כללים מחייבים:
- השב ב-JSON תקין בלבד, ללא טקסט לפני או אחרי וללא גדרות קוד.
- כל הערכים בעברית.
- אם מידע חסר — השתמש במחרוזת ריקה או ברשימה ריקה. אל תמציא פרטים שלא נאמרו.
"""

RETRY_SUFFIX = "\n\nהתשובה הקודמת לא הייתה JSON תקין. השב אך ורק ב-JSON תקין לפי המבנה שהוגדר, ללא כל טקסט נוסף."

MAP_SYSTEM_PROMPT = (
    "אתה מסכם קטעי שיחה עסקית. סכם את קטע השיחה שתקבל ב-5 עד 8 נקודות עובדתיות בעברית, "
    "כולל שמות, סכומים, תאריכים והתחייבויות שהוזכרו במפורש. אל תמציא מידע. השב בנקודות בלבד."
)


class OllamaClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def chat(self, system: str, user: str, json_format: bool = True) -> str:
        payload = {
            "model": self._settings.ollama_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "options": {
                "num_ctx": self._settings.ollama_num_ctx,
                "temperature": 0.2,
            },
        }
        if json_format:
            payload["format"] = "json"

        try:
            async with httpx.AsyncClient(timeout=self._settings.ollama_timeout_seconds) as client:
                resp = await client.post(f"{self._settings.ollama_base_url}/api/chat", json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise OllamaUnavailableError(str(exc)) from exc
        except httpx.TimeoutException as exc:
            raise OllamaUnavailableError(f"timeout: {exc}") from exc

        if resp.status_code == 404:
            raise OllamaModelMissingError(self._settings.ollama_model)
        resp.raise_for_status()
        return resp.json().get("message", {}).get("content", "")

    async def probe(self) -> dict:
        """Health probe: is Ollama reachable and is the configured model pulled?"""
        info = {"reachable": False, "model": self._settings.ollama_model, "model_available": False}
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{self._settings.ollama_base_url}/api/tags")
                resp.raise_for_status()
        except httpx.HTTPError:
            return info
        info["reachable"] = True
        wanted = self._settings.ollama_model
        names = [m.get("name", "") for m in resp.json().get("models", [])]
        info["model_available"] = any(
            name == wanted or name.split(":")[0] == wanted for name in names
        )
        return info


def format_timestamp(seconds: float) -> str:
    total = int(seconds)
    if total >= 3600:
        return f"{total // 3600}:{(total % 3600) // 60:02d}:{total % 60:02d}"
    return f"{total // 60:02d}:{total % 60:02d}"


def build_transcript_text(segments: list[dict]) -> str:
    return "\n".join(f"[{format_timestamp(s['start'])}] {s['text']}" for s in segments)


def chunk_segments(segments: list[dict], chunk_chars: int) -> list[str]:
    """Split the transcript into chunks at segment boundaries."""
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for seg in segments:
        line = f"[{format_timestamp(seg['start'])}] {seg['text']}"
        if current and size + len(line) > chunk_chars:
            chunks.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def parse_analysis_json(raw: str) -> dict | None:
    """Lenient parse for small local models: direct → strip code fences →
    outermost {...}. Returns None if nothing parseable is found."""
    if not raw or not raw.strip():
        return None
    text = raw.strip()

    for candidate in _json_candidates(text):
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _json_candidates(text: str):
    yield text
    fenced = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    if fenced != text:
        yield fenced
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        yield text[start : end + 1]


async def analyze(
    segments: list[dict],
    client: OllamaClient,
    settings: Settings,
    progress: Callable[[int, int], None] | None = None,
) -> AnalysisResult:
    """Full analysis: single-shot when the transcript fits the chunk budget,
    otherwise map (per-chunk digests) → reduce (final structured analysis)."""
    transcript = build_transcript_text(segments)
    meta = AnalysisMeta(model=settings.ollama_model)

    if len(transcript) <= settings.analysis_chunk_chars:
        user_msg = f"תמליל השיחה (עם חותמות זמן):\n\n{transcript}"
    else:
        meta.chunked = True
        chunks = chunk_segments(segments, settings.analysis_chunk_chars)
        if len(chunks) > settings.analysis_max_chunks:
            meta.truncated = True
            chunks = chunks[: settings.analysis_max_chunks]
            log.info("transcript truncated to %d chunks", len(chunks))

        digests: list[str] = []
        for i, chunk in enumerate(chunks, start=1):
            if progress:
                progress(i, len(chunks))
            digest = await client.chat(
                MAP_SYSTEM_PROMPT,
                f"קטע {i} מתוך {len(chunks)} של השיחה:\n\n{chunk}",
                json_format=False,
            )
            digests.append(f"--- קטע {i} ---\n{digest.strip()}")
        user_msg = "תקצירי קטעי השיחה לפי סדר כרונולוגי:\n\n" + "\n\n".join(digests)

    raw = await client.chat(SYSTEM_PROMPT, user_msg)
    parsed = parse_analysis_json(raw)
    if parsed is None:
        log.info("analysis JSON parse failed, retrying once")
        raw = await client.chat(SYSTEM_PROMPT + RETRY_SUFFIX, user_msg)
        parsed = parse_analysis_json(raw)

    if parsed is None:
        # Last resort: show the model's raw text as the summary so the user
        # still gets something copyable.
        meta.degraded = True
        result = AnalysisResult(summary=raw.strip())
    else:
        result = AnalysisResult.model_validate({k: v for k, v in parsed.items() if k != "meta"})

    result.meta = meta
    return result
