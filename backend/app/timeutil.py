"""Метки времени: MM:SS у чатов, ISO 8601 с часовым поясом у звонков. Исходные строки не меняем —
только считаем offset_sec (секунды от начала) для перехода к реплике / позиции в записи."""
from __future__ import annotations

from datetime import datetime


def parse_iso(ts: str) -> datetime | None:
    # 7 знаков дробной части (.6388245) python не парсит — режем до 6
    ts = ts.replace("Z", "+00:00")
    head, dot, rest = ts.partition(".")
    if dot:
        digits = "".join(ch for ch in rest if ch.isdigit())
        ts = f"{head}.{digits[:6]}{rest[len(digits):]}"
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def mmss_seconds(ts: str) -> float | None:
    try:
        nums = [float(p) for p in ts.split(":")]
    except ValueError:
        return None
    sec = 0.0
    for n in nums:
        sec = sec * 60 + n
    return sec


def offsets(transcript: list[dict]) -> list[float | None]:
    isos = [parse_iso(t.get("timestamp") or "") if "T" in (t.get("timestamp") or "") else None for t in transcript]
    first = next((d for d in isos if d), None)
    out: list[float | None] = []
    for t, iso in zip(transcript, isos):
        ts = t.get("timestamp") or ""
        if iso and first:
            out.append(round((iso - first).total_seconds(), 2))
        elif ts and "T" not in ts:
            out.append(mmss_seconds(ts))
        else:
            out.append(None)
    return out
