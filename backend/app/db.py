"""SQLite-хранилище. Без ORM: 5 таблиц, JSON в TEXT-колонках."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from . import config

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    group_id        TEXT NOT NULL,
    channel         TEXT,
    language        TEXT,
    audio_url       TEXT,
    transcript      TEXT NOT NULL,
    turns           INTEGER,
    ingested_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_conv_group ON conversations(group_id);

CREATE TABLE IF NOT EXISTS checklists (
    checklist_id TEXT PRIMARY KEY,
    family       TEXT NOT NULL,
    version      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE(family, version)
);

CREATE TABLE IF NOT EXISTS results (
    result_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    checklist_id    TEXT NOT NULL,
    status          TEXT NOT NULL,
    overall         REAL,
    critical_error  INTEGER,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(conversation_id, checklist_id)
);

CREATE TABLE IF NOT EXISTS appeals (
    appeal_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id    INTEGER NOT NULL,
    criterion_id TEXT NOT NULL,
    comment      TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    resolved_at  TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    job_id     TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    review_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id    INTEGER NOT NULL,
    appeal_id    INTEGER,
    criterion_id TEXT NOT NULL,
    decision     TEXT NOT NULL,
    old_value    TEXT,
    new_value    TEXT,
    reason       TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_cache (
    cache_key    TEXT PRIMARY KEY,
    model        TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """Короткая транзакция; запись сериализуем локом (batch пишет из потоков)."""
    with _lock:
        conn = _connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_db() -> None:
    with tx() as c:
        c.executescript(SCHEMA)


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


def loads(s: str | None) -> Any:
    return json.loads(s) if s else None


# ---------- conversations ----------

def upsert_conversation(rec: dict, group_id: str) -> None:
    with tx() as c:
        c.execute(
            """INSERT INTO conversations(conversation_id, group_id, channel, language, audio_url, transcript, turns, ingested_at)
               VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(conversation_id) DO UPDATE SET group_id=excluded.group_id, channel=excluded.channel,
                 language=excluded.language, audio_url=excluded.audio_url, transcript=excluded.transcript,
                 turns=excluded.turns, ingested_at=excluded.ingested_at""",
            (rec["conversation_id"], group_id, rec.get("channel"), rec.get("language"), rec.get("audio_url"),
             dumps(rec.get("transcript") or []), len(rec.get("transcript") or []), now()),
        )


def _conv_row(r: sqlite3.Row, with_transcript: bool) -> dict:
    d = {k: r[k] for k in r.keys() if k != "transcript"}
    if with_transcript:
        d["transcript"] = loads(r["transcript"])
    return d


def get_conversation(cid: str) -> dict | None:
    with tx() as c:
        r = c.execute("SELECT * FROM conversations WHERE conversation_id=?", (cid,)).fetchone()
    return _conv_row(r, True) if r else None


def list_conversations(language: str | None = None, channel: str | None = None, group_id: str | None = None) -> list[dict]:
    q = """SELECT c.conversation_id, c.group_id, c.channel, c.language, c.audio_url, c.turns, c.ingested_at,
                  (SELECT r.overall FROM results r WHERE r.conversation_id=c.conversation_id ORDER BY r.updated_at DESC LIMIT 1) AS last_overall,
                  (SELECT r.critical_error FROM results r WHERE r.conversation_id=c.conversation_id ORDER BY r.updated_at DESC LIMIT 1) AS last_critical,
                  (SELECT r.status FROM results r WHERE r.conversation_id=c.conversation_id ORDER BY r.updated_at DESC LIMIT 1) AS last_status
           FROM conversations c WHERE 1=1"""
    args: list = []
    if language:
        q += " AND upper(c.language)=upper(?)"
        args.append(language)
    if channel:
        q += " AND lower(c.channel)=lower(?)"
        args.append(channel)
    if group_id:
        q += " AND c.group_id=?"
        args.append(group_id)
    q += " ORDER BY c.conversation_id"
    with tx() as c:
        rows = c.execute(q, args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["last_critical"] = None if d["last_critical"] is None else bool(d["last_critical"])
        out.append(d)
    return out


def conversation_ids(group_id: str) -> list[str]:
    with tx() as c:
        return [r[0] for r in c.execute(
            "SELECT conversation_id FROM conversations WHERE group_id=? ORDER BY conversation_id", (group_id,))]


# ---------- checklists ----------

def insert_checklist(body: dict) -> None:
    with tx() as c:
        c.execute(
            "INSERT OR IGNORE INTO checklists(checklist_id, family, version, name, body, created_at) VALUES(?,?,?,?,?,?)",
            (body["id"], body["family"], body["version"], body["name"], dumps(body), now()),
        )


def next_version(family: str) -> int:
    with tx() as c:
        r = c.execute("SELECT MAX(version) FROM checklists WHERE family=?", (family,)).fetchone()
    return (r[0] or 0) + 1


def get_checklist(checklist_id: str) -> dict | None:
    with tx() as c:
        r = c.execute("SELECT body, created_at FROM checklists WHERE checklist_id=?", (checklist_id,)).fetchone()
    if not r:
        return None
    body = loads(r["body"])
    body["created_at"] = r["created_at"]
    return body


def list_checklists() -> list[dict]:
    with tx() as c:
        rows = c.execute("SELECT checklist_id, family, version, name, body, created_at FROM checklists ORDER BY family, version").fetchall()
    latest: dict[str, int] = {}
    for r in rows:
        latest[r["family"]] = max(latest.get(r["family"], 0), r["version"])
    return [{
        "id": r["checklist_id"], "family": r["family"], "version": r["version"], "name": r["name"],
        "criteria_count": len(loads(r["body"])["criteria"]), "created_at": r["created_at"],
        "is_latest": r["version"] == latest[r["family"]],
    } for r in rows]


# ---------- results ----------

def save_result(body: dict) -> dict:
    """Upsert по (conversation_id, checklist_id). Возвращает body с result_id."""
    ts = now()
    with tx() as c:
        c.execute(
            """INSERT INTO results(conversation_id, checklist_id, status, overall, critical_error, body, created_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(conversation_id, checklist_id) DO UPDATE SET status=excluded.status, overall=excluded.overall,
                 critical_error=excluded.critical_error, body=excluded.body, updated_at=excluded.updated_at""",
            (body["conversation_id"], body["checklist_id"], body.get("status", "auto"), body.get("overall"),
             int(bool(body.get("critical_error"))), dumps(body), ts, ts),
        )
        rid = c.execute("SELECT result_id FROM results WHERE conversation_id=? AND checklist_id=?",
                        (body["conversation_id"], body["checklist_id"])).fetchone()[0]
        body["result_id"] = rid
        c.execute("UPDATE results SET body=? WHERE result_id=?", (dumps(body), rid))
    return body


def update_result(rid: int, body: dict) -> None:
    with tx() as c:
        c.execute("UPDATE results SET status=?, overall=?, critical_error=?, body=?, updated_at=? WHERE result_id=?",
                  (body.get("status"), body.get("overall"), int(bool(body.get("critical_error"))), dumps(body), now(), rid))


def get_result_by_id(rid: int) -> dict | None:
    with tx() as c:
        r = c.execute("SELECT body FROM results WHERE result_id=?", (rid,)).fetchone()
    return loads(r["body"]) if r else None


def result_exists(cid: str, checklist_id: str) -> bool:
    with tx() as c:
        return c.execute("SELECT 1 FROM results WHERE conversation_id=? AND checklist_id=?", (cid, checklist_id)).fetchone() is not None


def get_results_for_conversation(cid: str, checklist_id: str | None = None) -> list[dict]:
    q, args = "SELECT body FROM results WHERE conversation_id=?", [cid]
    if checklist_id:
        q += " AND checklist_id=?"
        args.append(checklist_id)
    q += " ORDER BY updated_at DESC"
    with tx() as c:
        return [loads(r["body"]) for r in c.execute(q, args).fetchall()]


def list_results(group_id: str | None = None, checklist_id: str | None = None, needs_review: bool | None = None) -> list[dict]:
    q = """SELECT r.result_id, r.conversation_id, r.checklist_id, r.status, r.overall, r.critical_error, r.updated_at,
                  c.language, c.channel, c.group_id,
                  coalesce(json_extract(r.body, '$.review_required'), 0) AS review_required,
                  json_extract(r.body, '$.review_criteria') AS review_criteria
           FROM results r LEFT JOIN conversations c ON c.conversation_id=r.conversation_id WHERE 1=1"""
    args: list = []
    if needs_review is not None:
        q += " AND coalesce(json_extract(r.body, '$.review_required'), 0)=?"
        args.append(int(needs_review))
    if group_id:
        q += " AND c.group_id=?"
        args.append(group_id)
    if checklist_id:
        q += " AND r.checklist_id=?"
        args.append(checklist_id)
    q += " ORDER BY r.conversation_id"
    with tx() as c:
        rows = c.execute(q, args).fetchall()
    return [{**dict(r), "critical_error": bool(r["critical_error"]), "review_required": bool(r["review_required"]),
             "review_criteria": loads(r["review_criteria"]) or []} for r in rows]


# ---------- appeals / reviews ----------

def insert_appeal(rid: int, criterion_id: str, comment: str) -> dict:
    ts = now()
    with tx() as c:
        cur = c.execute("INSERT INTO appeals(result_id, criterion_id, comment, status, created_at) VALUES(?,?,?,?,?)",
                        (rid, criterion_id, comment, "open", ts))
        aid = cur.lastrowid
    return {"appeal_id": aid, "result_id": rid, "criterion_id": criterion_id, "comment": comment,
            "status": "open", "created_at": ts, "resolved_at": None}


def list_appeals(status: str | None = None, result_id: int | None = None) -> list[dict]:
    q, args = "SELECT * FROM appeals WHERE 1=1", []
    if status:
        q += " AND status=?"
        args.append(status)
    if result_id is not None:
        q += " AND result_id=?"
        args.append(result_id)
    q += " ORDER BY appeal_id"
    with tx() as c:
        return [dict(r) for r in c.execute(q, args).fetchall()]


def resolve_open_appeals(rid: int, criterion_id: str) -> list[int]:
    with tx() as c:
        ids = [r[0] for r in c.execute(
            "SELECT appeal_id FROM appeals WHERE result_id=? AND criterion_id=? AND status='open'", (rid, criterion_id))]
        c.execute("UPDATE appeals SET status='resolved', resolved_at=? WHERE result_id=? AND criterion_id=? AND status='open'",
                  (now(), rid, criterion_id))
    return ids


def supersede_open_appeals(rid: int) -> int:
    with tx() as c:
        cur = c.execute("UPDATE appeals SET status='superseded', resolved_at=? WHERE result_id=? AND status='open'", (now(), rid))
        return cur.rowcount


def get_appeal(aid: int) -> dict | None:
    with tx() as c:
        r = c.execute("SELECT * FROM appeals WHERE appeal_id=?", (aid,)).fetchone()
    return dict(r) if r else None


def save_job(job: dict) -> None:
    with tx() as c:
        c.execute("INSERT INTO jobs(job_id, body, updated_at) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
                  (job["job_id"], dumps(job), now()))


def get_job(job_id: str) -> dict | None:
    with tx() as c:
        r = c.execute("SELECT body FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    return loads(r["body"]) if r else None


def list_jobs(limit: int = 20) -> list[dict]:
    with tx() as c:
        return [loads(r["body"]) for r in c.execute("SELECT body FROM jobs ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()]


def all_result_bodies(group_id: str | None = None, checklist_id: str | None = None) -> list[dict]:
    q = "SELECT r.body FROM results r LEFT JOIN conversations c ON c.conversation_id=r.conversation_id WHERE 1=1"
    args: list = []
    if group_id:
        q += " AND c.group_id=?"
        args.append(group_id)
    if checklist_id:
        q += " AND r.checklist_id=?"
        args.append(checklist_id)
    q += " ORDER BY r.conversation_id"
    with tx() as c:
        return [loads(r["body"]) for r in c.execute(q, args).fetchall()]


def llm_cache_get(key: str) -> dict | None:
    with tx() as c:
        r = c.execute("SELECT body FROM llm_cache WHERE cache_key=?", (key,)).fetchone()
    return loads(r["body"]) if r else None


def llm_cache_put(key: str, model: str, criterion_id: str, body: dict) -> None:
    with tx() as c:
        c.execute("INSERT OR REPLACE INTO llm_cache(cache_key, model, criterion_id, body, created_at) VALUES(?,?,?,?,?)",
                  (key, model, criterion_id, dumps(body), now()))


def insert_review(rid: int, appeal_id: int | None, criterion_id: str, decision: str,
                  old_value: Any, new_value: Any, reason: str) -> dict:
    ts = now()
    with tx() as c:
        cur = c.execute(
            "INSERT INTO reviews(result_id, appeal_id, criterion_id, decision, old_value, new_value, reason, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (rid, appeal_id, criterion_id, decision, str(old_value), None if new_value is None else str(new_value), reason, ts))
        return {"review_id": cur.lastrowid, "result_id": rid, "appeal_id": appeal_id, "criterion_id": criterion_id,
                "decision": decision, "old_value": old_value, "new_value": new_value, "reason": reason, "created_at": ts}


def setting_get(key: str, default: Any = None) -> Any:
    with tx() as c:
        r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return loads(r["value"]) if r else default


def setting_put(key: str, value: Any) -> None:
    with tx() as c:
        c.execute("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (key, dumps(value)))


def result_rows(where: str = "1=1", args: tuple = ()) -> list[tuple[dict, str, str]]:
    """(body, created_at, updated_at) — адаптеру фронтенда нужно время оценки. where — только константы из кода."""
    with tx() as c:
        rows = c.execute(f"SELECT body, created_at, updated_at FROM results r WHERE {where} ORDER BY created_at, result_id",
                         args).fetchall()
    return [(loads(r["body"]), r["created_at"], r["updated_at"]) for r in rows]


def checklist_created_at(checklist_id: str) -> str | None:
    with tx() as c:
        r = c.execute("SELECT created_at FROM checklists WHERE checklist_id=?", (checklist_id,)).fetchone()
    return r["created_at"] if r else None
