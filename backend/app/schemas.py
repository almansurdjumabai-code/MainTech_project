"""Pydantic v2 модели запросов API."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class TurnIn(BaseModel):
    timestamp: str = ""
    speaker: Literal["client", "operator", "bot", "system"]
    text: str


class EvaluateIn(BaseModel):
    conversation_id: Optional[str] = None
    transcript: Optional[list[TurnIn]] = None
    language: Optional[Literal["RU", "KZ", "EN"]] = None
    channel: Optional[str] = "agent chat"
    checklist_id: Optional[str] = None
    mode: Optional[Literal["auto", "anthropic", "rules"]] = None
    force: bool = True

    @model_validator(mode="after")
    def _one_source(self):
        if not self.conversation_id and not self.transcript:
            raise ValueError("pass conversation_id or transcript")
        return self


class BatchIn(BaseModel):
    group_id: str
    checklist_id: Optional[str] = None
    mode: Optional[Literal["auto", "anthropic", "rules"]] = None
    force: bool = False  # False = идемпотентно, уже оценённые пропускаем
    background: bool = True


class AppealIn(BaseModel):
    criterion_id: str
    comment: str = Field(min_length=1, max_length=4000)


class ReviewIn(BaseModel):
    criterion_id: str
    decision: Literal["confirm", "change"]
    new_value: Optional[Any] = None
    reason: str = Field(min_length=1, max_length=4000)
    appeal_id: Optional[int] = None

    @model_validator(mode="after")
    def _need_value(self):
        if self.decision == "change" and self.new_value is None:
            raise ValueError("new_value is required when decision=change")
        return self
