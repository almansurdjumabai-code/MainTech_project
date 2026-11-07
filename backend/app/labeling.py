"""Независимая ручная разметка (eval): слепая разметка тестового сплита человеком.

Ответы системы по диалогу из сплита отдаются только ПОСЛЕ сохранения разметки (иначе человек
подстраивается под машину и разметка перестаёт быть независимой). Разметка пишется в eval/gold_human.json
в формате eval/run_eval.py --gold.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from scoring import ScoringError, normalize_answer

from . import config, db, service

router = APIRouter(prefix="/labeling", tags=["labeling"])
_lock = threading.Lock()

SPLIT_PATH = config.ROOT / "eval" / "split_test.json"


def gold_path() -> Path:
    return Path(os.getenv("CQA_GOLD_HUMAN_PATH") or (config.ROOT / "eval" / "gold_human.json"))


def _split() -> dict:
    return json.loads(SPLIT_PATH.read_text(encoding="utf-8"))


def _load_gold() -> dict:
    p = gold_path()
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    s = _split()
    return {"checklist_id": s["checklist_id"], "group_id": s["group_id"], "split": s["name"],
            "labeled_by": "human (кто и когда — в meta)",
            "note": "null = разметчик не уверен, в метрику не идёт. Размечено вслепую: ответы системы скрыты до сохранения.",
            "labels": {}, "meta": {}}


def _save_gold(gold: dict) -> None:
    p = gold_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(gold, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)  # атомарно: при сбое не остаётся полузаписанного файла


class LabelIn(BaseModel):
    labels: dict[str, Optional[Any]]
    labeler: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=4000)


@router.get("/split")
def split():
    s = _split()
    gold = _load_gold()
    items = []
    for cid in s["conversation_ids"]:
        conv = db.get_conversation(cid)
        items.append({"conversation_id": cid, "ingested": bool(conv),
                      "language": conv and conv.get("language"), "channel": conv and conv.get("channel"),
                      "turns": conv and conv.get("turns"), "labeled": cid in gold["labels"],
                      "labeler": gold["meta"].get(cid, {}).get("labeler")})
    return {**{k: v for k, v in s.items() if k != "conversation_ids"}, "items": items,
            "labeled": sum(i["labeled"] for i in items), "total": len(items)}


@router.get("/labels")
def labels():
    return _load_gold()


@router.put("/labels/{conversation_id}")
def put_label(conversation_id: str, payload: LabelIn):
    s = _split()
    if conversation_id not in s["conversation_ids"]:
        raise HTTPException(400, "conversation is not in the test split")
    checklist = service.get_checklist_or_404(s["checklist_id"])
    crits = {c["id"]: c for c in checklist["criteria"]}
    missing = set(crits) - set(payload.labels)
    if missing:
        raise HTTPException(422, f"no answer for {sorted(missing)} (null = не уверен)")
    clean = {}
    for cid, crit in crits.items():
        v = payload.labels[cid]
        try:
            clean[cid] = None if v is None else normalize_answer(crit, v)
        except ScoringError as exc:
            raise HTTPException(422, str(exc)) from exc
    with _lock:
        gold = _load_gold()
        gold["labels"][conversation_id] = clean
        gold["meta"][conversation_id] = {"labeler": payload.labeler, "notes": payload.notes, "labeled_at": db.now()}
        _save_gold(gold)
    return {"conversation_id": conversation_id, "labels": clean}


@router.get("/compare/{conversation_id}")
def compare(conversation_id: str):
    """Разметка человека vs автооценка. Для диалогов сплита — только после разметки (слепота)."""
    s = _split()
    gold = _load_gold()
    human = gold["labels"].get(conversation_id)
    if conversation_id in s["conversation_ids"] and human is None:
        raise HTTPException(409, "сначала сохраните разметку: ответы системы скрыты до этого")
    results = db.get_results_for_conversation(conversation_id, s["checklist_id"])
    res = results[0] if results else None
    rows = []
    for c in (res or {}).get("criteria", []):
        h = None if human is None else human.get(c["id"])
        rows.append({"id": c["id"], "name": c["name"], "human": h, "system": c["answer"],
                     "match": None if h is None else str(h) == str(c["answer"]),
                     "points": c["points"], "effective_weight": c["effective_weight"], "na_reason": c.get("na_reason"),
                     "explanation": c["explanation"], "evidence": c.get("evidence"), "expected_span": c.get("expected_span"),
                     "confidence": c.get("confidence"), "needs_review": c.get("needs_review"),
                     "review_reasons": c.get("review_reasons")})
    return {"conversation_id": conversation_id, "human": human, "meta": gold["meta"].get(conversation_id),
            "has_result": bool(res), "overall": res and res["overall"], "critical_error": res and res["critical_error"],
            "sections": res and res["sections"], "judge": res and res["pipeline"]["judge"], "rows": rows}
