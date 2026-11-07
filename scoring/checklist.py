"""Pydantic-модель чек-листа: валидация при POST /checklists и при загрузке seed-файлов."""
from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class Criterion(BaseModel):
    id: str = Field(min_length=1, max_length=32)
    name: str
    section: Optional[str] = None
    type: Literal["binary", "scale", "flag"]
    weight: float = Field(default=0, ge=0)
    scale: Optional[list[int]] = None
    scale_descriptions: Optional[dict[str, str]] = None
    na_allowed: bool = False
    na_condition: Optional[str] = None
    description: str
    rule: Optional[str] = None
    keywords: Optional[list[str]] = None
    ai_guidance: Optional[str] = None  # подсказка модели из UI — добавляется в промпт критерия

    @model_validator(mode="after")
    def _check(self):
        if self.type == "scale":
            if not self.scale or len(self.scale) < 2:
                raise ValueError(f"{self.id}: scale criterion needs >=2 steps")
            if min(self.scale) != 0 or len(set(self.scale)) != len(self.scale):
                raise ValueError(f"{self.id}: scale must start at 0 and be unique")
            self.scale = sorted(self.scale)
        elif self.scale:
            raise ValueError(f"{self.id}: scale only allowed for type=scale")
        if self.type == "flag":
            self.weight = 0
        if self.na_allowed and not self.na_condition:
            raise ValueError(f"{self.id}: na_allowed requires na_condition (условие N/A из PDF)")
        return self


class Section(BaseModel):
    id: str
    name: str
    criteria: list[str]


class Checklist(BaseModel):
    id: Optional[str] = None
    family: Optional[str] = None
    version: Optional[int] = None
    name: str
    source: Optional[str] = None
    note: Optional[str] = None
    rounding: int = 2
    ignore: list[str] = []
    sections: list[Section] = []
    criteria: list[Criterion] = Field(min_length=1)

    @model_validator(mode="after")
    def _check(self):
        ids = [c.id for c in self.criteria]
        if len(ids) != len(set(ids)):
            raise ValueError("criterion ids must be unique")
        known = set(ids)
        for s in self.sections:
            unknown = set(s.criteria) - known
            if unknown:
                raise ValueError(f"section {s.id} references unknown criteria {sorted(unknown)}")
        if self.family and not re.fullmatch(r"[a-z0-9][a-z0-9-]*", self.family):
            raise ValueError("family must be kebab-case")
        return self


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "checklist"
