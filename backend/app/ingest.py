"""Загрузка набора у организаторов (GET по group_id) — только с сервера, из-за CORS."""
from __future__ import annotations

from collections import Counter
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from . import config, db


class IngestError(RuntimeError):
    pass


def build_url(base_url: str, group_id: str) -> str:
    """Подставляет group_id в URL организаторов (существующий group_id заменяется)."""
    parts = urlsplit(base_url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "group_id"]
    query.append(("group_id", group_id))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def fetch_group(group_id: str, base_url: str | None = None, timeout: float = 90.0) -> dict:
    base = base_url or config.DATASET_URL
    if not base:
        raise IngestError("DATASET_URL is not set (см. .env.example)")
    try:
        resp = httpx.get(build_url(base, group_id), timeout=timeout)
    except httpx.HTTPError as exc:
        raise IngestError(f"organizers API unreachable: {type(exc).__name__}") from exc
    if resp.status_code != 200:
        raise IngestError(f"organizers API HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise IngestError("organizers API returned non-JSON") from exc
    if not payload.get("isSuccess"):
        raise IngestError(f"organizers API error: {payload.get('error') or 'isSuccess=false'}")
    data = payload.get("data") or {}
    if not isinstance(data.get("records"), list):
        raise IngestError("organizers API: data.records missing")
    return data


def validate_record(rec: dict) -> dict:
    if not rec.get("conversation_id"):
        raise IngestError("record without conversation_id")
    transcript = rec.get("transcript")
    if not isinstance(transcript, list):
        raise IngestError(f"{rec['conversation_id']}: transcript is not a list")
    # Метки времени сохраняем как пришли (MM:SS у чатов, ISO 8601 у звонков)
    clean = [{"timestamp": t.get("timestamp"), "speaker": (t.get("speaker") or "").lower(), "text": t.get("text") or ""}
             for t in transcript]
    return {**rec, "transcript": clean}


def ingest_group(group_id: str) -> dict:
    data = fetch_group(group_id)
    records = [validate_record(r) for r in data["records"]]
    for rec in records:
        db.upsert_conversation(rec, group_id)
    return {
        "group_id": group_id,
        "dataset_group_id": data.get("dataset_group_id"),
        "total_records": data.get("total_records"),
        "ingested": len(records),
        "languages": dict(Counter(r.get("language") for r in records)),
        "channels": dict(Counter(r.get("channel") for r in records)),
        "speakers": dict(Counter(t["speaker"] for r in records for t in r["transcript"])),
    }
