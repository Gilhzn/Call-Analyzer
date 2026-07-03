"""Unit tests for the pure logic: JSON fallback parsing, transcript chunking,
timestamp formatting, and lenient schema coercion. Run with: pytest tests/"""
from app.analysis import chunk_segments, format_timestamp, parse_analysis_json
from app.schemas import AnalysisResult


def test_parse_direct_json():
    assert parse_analysis_json('{"summary": "סיכום"}') == {"summary": "סיכום"}


def test_parse_fenced_json():
    raw = '```json\n{"summary": "סיכום"}\n```'
    assert parse_analysis_json(raw) == {"summary": "סיכום"}


def test_parse_json_with_surrounding_chatter():
    raw = 'הנה הניתוח המבוקש: {"summary": "סיכום", "key_points": []} מקווה שעזרתי!'
    assert parse_analysis_json(raw) == {"summary": "סיכום", "key_points": []}


def test_parse_garbage_returns_none():
    assert parse_analysis_json("סתם טקסט חופשי בלי JSON") is None
    assert parse_analysis_json("") is None
    assert parse_analysis_json('["רשימה", "ולא", "אובייקט"]') is None


def test_schema_lenient_coercion():
    result = AnalysisResult.model_validate({
        "summary": None,
        "key_points": "נקודה בודדת כמחרוזת",
        "action_items": ["משימה כמחרוזת", {"task": "משימה רגילה", "owner": None, "due": 3}],
        "topics": [{"topic": "נושא מתוך אובייקט"}],
        "sentiment": ["חיובי"],
    })
    assert result.summary == ""
    assert result.key_points == ["נקודה בודדת כמחרוזת"]
    assert result.action_items[0].task == "משימה כמחרוזת"
    assert result.action_items[1].due == "3"
    assert result.topics == ["נושא מתוך אובייקט"]
    assert result.sentiment == "חיובי"


def test_schema_defaults_when_keys_missing():
    result = AnalysisResult.model_validate({})
    assert result.summary == "" and result.key_points == [] and result.meta.degraded is False


def test_chunking_respects_budget_and_keeps_all_segments():
    segments = [
        {"start": i * 10.0, "end": i * 10 + 9.0, "text": "משפט ארוך למדי לבדיקת חלוקה " * 5}
        for i in range(40)
    ]
    chunks = chunk_segments(segments, chunk_chars=1500)
    assert len(chunks) > 1
    # every segment line appears exactly once across chunks
    assert sum(chunk.count("[") for chunk in chunks) == 40
    # chunks stay near the budget (one segment line of slack)
    assert all(len(chunk) <= 1500 + 200 for chunk in chunks)


def test_format_timestamp():
    assert format_timestamp(0) == "00:00"
    assert format_timestamp(75) == "01:15"
    assert format_timestamp(3675) == "1:01:15"
