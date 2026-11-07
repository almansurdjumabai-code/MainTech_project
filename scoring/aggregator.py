"""Детерминированный расчёт итога по чек-листу. LLM сюда не ходит.

Порядок (PDF «Как выставлять баллы»):
1. применимость (N/A только если разрешён);
2. оценка: Да = полный вес, Нет = 0, шкала = одна из ступеней;
3. points = weight * step / max_step (верхняя ступень = полный вес);
4. N/A исключаются, их вес пропорционально раздаётся применимым -> максимум 100;
5. итог округляется до 2 знаков; нет применимых весовых -> overall = None;
   грубые ошибки (type=flag) отмечаются отдельно и в сумму не входят.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Any

YES, NO, NA = "YES", "NO", "NA"

_YES_ALIASES = {"YES", "Y", "ДА", "TRUE", "1", "ИӘ", "IA"}
_NO_ALIASES = {"NO", "N", "НЕТ", "FALSE", "ЖОҚ", "JOQ"}
_NA_ALIASES = {"NA", "N/A", "N\\A", "НЕПРИМЕНИМО", "NOT_APPLICABLE", "NONE", "NULL"}


class ScoringError(ValueError):
    pass


def allowed_answers(criterion: dict) -> list[str]:
    """Допустимые ответы критерия как строки (для промпта и валидации)."""
    ctype = criterion["type"]
    if ctype in ("binary", "flag"):
        values = [YES, NO]
    elif ctype == "scale":
        values = [str(s) for s in criterion["scale"]]
    else:
        raise ScoringError(f"unknown criterion type {ctype!r}")
    if criterion.get("na_allowed"):
        values.append(NA)
    return values


def normalize_answer(criterion: dict, value: Any) -> str | int:
    """Приводит ответ к каноническому виду: 'YES'/'NO'/'NA' или int-ступень шкалы."""
    if value is None:
        raise ScoringError(f"{criterion['id']}: empty answer")
    raw = str(value).strip().upper()
    if raw in _NA_ALIASES:
        if not criterion.get("na_allowed"):
            raise ScoringError(f"{criterion['id']}: N/A is not allowed")
        return NA
    ctype = criterion["type"]
    if ctype in ("binary", "flag"):
        if raw in _YES_ALIASES or value is True:
            return YES
        if raw in _NO_ALIASES or value is False:
            return NO
        raise ScoringError(f"{criterion['id']}: answer {value!r} not in YES/NO")
    # scale
    try:
        step = int(float(raw))
    except ValueError as exc:
        raise ScoringError(f"{criterion['id']}: answer {value!r} is not a scale step") from exc
    if step not in criterion["scale"]:
        raise ScoringError(f"{criterion['id']}: step {step} not in scale {criterion['scale']}")
    return step


def _raw_and_max(criterion: dict, answer: str | int) -> tuple[Decimal, Decimal]:
    if criterion["type"] == "scale":
        return Decimal(int(answer)), Decimal(max(criterion["scale"]))
    return (Decimal(1) if answer == YES else Decimal(0)), Decimal(1)


def _q(value: Decimal, places: int) -> float:
    return float(value.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def aggregate(checklist: dict, judgments: dict[str, dict]) -> dict:
    """judgments: {criterion_id: {"answer": ..., ...любые доп. поля (explanation, evidence)}}.

    Возвращает criteria[], sections[], overall, critical_error. Доп. поля судьи
    переносятся в критерий как есть — фронту не нужно склеивать.
    """
    places = int(checklist.get("rounding", 2))
    criteria_out: list[dict] = []
    applicable_weight = Decimal(0)
    staged: list[tuple[dict, dict, Decimal, bool]] = []

    for crit in checklist["criteria"]:
        cid = crit["id"]
        if cid not in judgments:
            raise ScoringError(f"missing judgment for {cid}")
        j = judgments[cid]
        answer = normalize_answer(crit, j.get("answer"))
        weight = Decimal(str(crit.get("weight", 0) if crit["type"] != "flag" else 0))
        na = answer == NA
        if na:
            base = Decimal(0)
        else:
            raw, max_step = _raw_and_max(crit, answer)
            base = weight * raw / max_step if max_step else Decimal(0)
            if weight > 0:
                applicable_weight += weight
        staged.append((crit, {**j, "answer": answer}, base, na))

    factor = (Decimal(100) / applicable_weight) if applicable_weight > 0 else None
    total = Decimal(0)
    critical = False
    critical_ids: list[str] = []

    for crit, j, base, na in staged:
        weight = crit.get("weight", 0) if crit["type"] != "flag" else 0
        answer = j["answer"]
        if crit["type"] == "flag":
            is_hit = answer == YES
            critical = critical or is_hit
            if is_hit:
                critical_ids.append(crit["id"])
        raw_score = None if na else (int(answer) if crit["type"] == "scale" else (1 if answer == YES else 0))
        max_score = max(crit["scale"]) if crit["type"] == "scale" else 1
        if crit["type"] == "flag":
            points, eff_w = None, 0.0  # грубая ошибка: без баллов
        elif factor is None or na or weight == 0:
            points = None if (na or factor is None) and weight else 0.0
            eff_w = 0.0
        else:
            pts = base * factor
            total += pts
            points = _q(pts, places)
            eff_w = _q(Decimal(str(weight)) * factor, places)
        criteria_out.append({
            **{k: v for k, v in j.items() if k not in ("answer",)},
            "id": crit["id"],
            "name": crit.get("name"),
            "section": crit.get("section"),
            "type": crit["type"],
            "answer": answer,
            "raw_score": raw_score,
            "max_score": max_score,
            "weight": weight,
            "effective_weight": eff_w,
            "points": points,
            "na": na,
        })

    overall = _q(total, places) if factor is not None else None

    sections_out = []
    for sec in checklist.get("sections", []):
        members = [c for c in criteria_out if c["id"] in sec.get("criteria", [])]
        weighted = [c for c in members if c["type"] != "flag" and c["weight"]]
        applicable = [c for c in weighted if not c["na"]]
        if factor is None or not applicable:
            pts, mx, pct = None, None, None
        else:
            pts = round(sum(c["points"] or 0 for c in applicable), places)
            mx = round(sum(c["effective_weight"] for c in applicable), places)
            pct = round(pts / mx * 100, places) if mx else None
        sections_out.append({
            "id": sec["id"], "name": sec.get("name"), "criteria": sec.get("criteria", []),
            "points": pts, "max_points": mx, "percent": pct,
        })

    return {
        "criteria": criteria_out,
        "sections": sections_out,
        "overall": overall,
        "max_overall": 100 if factor is not None else None,
        "critical_error": critical,
        "critical_criteria": critical_ids,
    }
