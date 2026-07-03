from typing import Any

from pydantic import BaseModel, Field, field_validator


class ActionItem(BaseModel):
    task: str = ""
    owner: str = ""
    due: str = ""

    @field_validator("task", "owner", "due", mode="before")
    @classmethod
    def _coerce_str(cls, v: Any) -> str:
        if v is None:
            return ""
        return str(v).strip()


class AnalysisMeta(BaseModel):
    model: str = ""
    chunked: bool = False
    truncated: bool = False
    degraded: bool = False


class AnalysisResult(BaseModel):
    """Structured business analysis of a call. All fields optional with defaults —
    small local models may omit keys and the UI must still render."""

    summary: str = ""
    key_points: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    participants: str = ""
    sentiment: str = ""
    topics: list[str] = Field(default_factory=list)
    meta: AnalysisMeta = Field(default_factory=AnalysisMeta)

    @field_validator("summary", "participants", "sentiment", mode="before")
    @classmethod
    def _coerce_str(cls, v: Any) -> str:
        if v is None:
            return ""
        if isinstance(v, list):
            return " ".join(str(x).strip() for x in v if x)
        return str(v).strip()

    @field_validator("key_points", "topics", mode="before")
    @classmethod
    def _coerce_str_list(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if isinstance(v, str):
            return [v.strip()] if v.strip() else []
        if isinstance(v, list):
            out: list[str] = []
            for item in v:
                if isinstance(item, dict):
                    # models sometimes emit [{"point": "..."}]
                    text = " ".join(str(x).strip() for x in item.values() if x)
                else:
                    text = str(item).strip()
                if text:
                    out.append(text)
            return out
        return [str(v)]

    @field_validator("action_items", mode="before")
    @classmethod
    def _coerce_action_items(cls, v: Any) -> list[Any]:
        if v is None:
            return []
        if isinstance(v, str):
            return [{"task": v}] if v.strip() else []
        if isinstance(v, list):
            return [{"task": item} if isinstance(item, str) else item for item in v if item]
        return []
