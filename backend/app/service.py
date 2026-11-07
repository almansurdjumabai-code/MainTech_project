"""Бизнес-логика API: чек-листы, оценка, batch, апелляции и пересмотр (тот же aggregator)."""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from datetime import datetime

from ml.judges import answer_label, make_judge
from ml.pipeline import _to_contract, evaluate_conversation
from scoring import aggregate, normalize_answer
from scoring.checklist import Checklist, slugify

from . import config, db

log = logging.getLogger("cqa.service")


class NotFound(LookupError):
    pass


class BadRequest(ValueError):
    pass


# ---------------- checklists ----------------

def seed_checklists() -> None:
    for path in sorted(config.CHECKLIST_DIR.glob("*.json")):
        if path.name.endswith(".schema.json"):
            continue
        body = json.loads(path.read_text(encoding="utf-8"))
        Checklist.model_validate(body)
        db.insert_checklist(body)


def create_checklist(payload: dict) -> dict:
    model = Checklist.model_validate(payload)
    family = model.family or (payload.get("id", "").rsplit("-v", 1)[0] if payload.get("id") else "") or slugify(model.name)
    version = db.next_version(family)
    body = model.model_dump(exclude_none=False)
    body.update({"id": f"{family}-v{version}", "family": family, "version": version})
    # секции без указанного section у критерия: проставим из sections
    sec_of = {cid: s["id"] for s in body.get("sections", []) for cid in s["criteria"]}
    for c in body["criteria"]:
        c["section"] = c.get("section") or sec_of.get(c["id"])
    db.insert_checklist(body)
    try:  # версионированный JSON рядом с seed-файлами (удобно коммитить)
        (config.CHECKLIST_DIR / f"{body['id']}.json").write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        log.warning("could not write checklist file %s", body["id"])
    return db.get_checklist(body["id"])


def get_checklist_or_404(checklist_id: str | None) -> dict:
    cid = checklist_id or config.DEFAULT_CHECKLIST_ID
    body = db.get_checklist(cid)
    if not body:
        raise NotFound(f"checklist {cid} not found")
    return body


# ---------------- conversations ----------------

def _parse_iso(ts: str) -> datetime | None:
    """ISO 8601 звонков; 7 знаков дробной части (.6388245) python не парсит — режем до 6."""
    ts = ts.replace("Z", "+00:00")
    head, dot, rest = ts.partition(".")
    if dot:
        digits = "".join(ch for ch in rest if ch.isdigit())
        ts = f"{head}.{digits[:6]}{rest[len(digits):]}"
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return None


def _mmss_seconds(ts: str) -> float | None:
    try:
        nums = [float(p) for p in ts.split(":")]
    except ValueError:
        return None
    sec = 0.0
    for n in nums:
        sec = sec * 60 + n
    return sec


def conversation_view(conv: dict) -> dict:
    """Добавляет index и offset_sec — для перехода к реплике / позиции в записи звонка.
    Исходные timestamp не трогаем."""
    turns = conv["transcript"]
    isos = [_parse_iso(t.get("timestamp") or "") if "T" in (t.get("timestamp") or "") else None for t in turns]
    first = next((d for d in isos if d), None)
    out = []
    for i, t in enumerate(turns):
        ts = t.get("timestamp") or ""
        if isos[i] and first:
            off = round((isos[i] - first).total_seconds(), 2)
        else:
            off = _mmss_seconds(ts) if ts and "T" not in ts else None
        out.append({"index": i, **t, "offset_sec": off})
    return {**conv, "transcript": out}


# ---------------- evaluate ----------------

def _adhoc_conversation(payload) -> dict:
    transcript = [t.model_dump() for t in payload.transcript]
    digest = hashlib.sha1(json.dumps(transcript, ensure_ascii=False).encode()).hexdigest()[:10]
    cid = payload.conversation_id or f"adhoc-{digest}"
    rec = {"conversation_id": cid, "channel": payload.channel or "agent chat", "language": payload.language or "RU",
           "audio_url": None, "transcript": transcript}
    db.upsert_conversation(rec, "ADHOC")
    return rec


def evaluate_one(conversation: dict, checklist: dict, mode: str | None = None, judge=None) -> dict:
    result = evaluate_conversation(conversation, checklist, judge or make_judge(mode))
    return db.save_result(result)


def evaluate_request(payload) -> dict:
    checklist = get_checklist_or_404(payload.checklist_id)
    if payload.transcript:
        conv = _adhoc_conversation(payload)
    else:
        conv = db.get_conversation(payload.conversation_id)
        if not conv:
            raise NotFound(f"conversation {payload.conversation_id} not found (сначала POST /ingest)")
    if not payload.force:
        existing = db.get_results_for_conversation(conv["conversation_id"], checklist["id"])
        if existing:
            return existing[0]
    return evaluate_one(conv, checklist, payload.mode)


# ---------------- batch ----------------

JOBS: dict[str, dict] = {}


def _run_batch(job: dict, ids: list[str], checklist: dict, mode: str | None, force: bool) -> None:
    judge = make_judge(mode)
    job["judge"], job["model"] = judge.name, judge.model
    for cid in ids:
        try:
            if not force and db.result_exists(cid, checklist["id"]):
                job["skipped"] += 1  # идемпотентность / resume
                continue
            conv = db.get_conversation(cid)
            res = evaluate_one(conv, checklist, judge=judge)
            job["done"] += 1
            job["cost_usd"] = round(job["cost_usd"] + res["pipeline"]["cost_usd"], 6)
        except Exception as exc:  # noqa: BLE001 — batch не должен падать целиком
            job["failed"] += 1
            job["errors"].append(f"{cid}: {type(exc).__name__}: {str(exc)[:200]}")
            log.exception("batch item failed %s", cid)
    job["status"] = "finished"
    job["finished_at"] = db.now()


def start_batch(payload) -> dict:
    checklist = get_checklist_or_404(payload.checklist_id)
    ids = db.conversation_ids(payload.group_id)
    if not ids:
        raise NotFound(f"no conversations for group_id={payload.group_id} (сначала POST /ingest?group_id=...)")
    job = {"job_id": uuid.uuid4().hex[:12], "group_id": payload.group_id, "checklist_id": checklist["id"], "status": "running",
           "total": len(ids), "done": 0, "skipped": 0, "failed": 0, "errors": [], "cost_usd": 0.0,
           "started_at": db.now(), "finished_at": None}
    JOBS[job["job_id"]] = job
    if payload.background:
        threading.Thread(target=_run_batch, args=(job, ids, checklist, payload.mode, payload.force), daemon=True).start()
    else:
        _run_batch(job, ids, checklist, payload.mode, payload.force)
    return job


# ---------------- results / appeals / review ----------------

def get_result_or_404(rid: int) -> dict:
    res = db.get_result_by_id(rid)
    if not res:
        raise NotFound(f"result {rid} not found")
    return res


def _criterion(result: dict, cid: str) -> dict:
    c = next((c for c in result["final"]["criteria"] if c["id"] == cid), None)
    if not c:
        raise BadRequest(f"criterion {cid} not in result")
    return c


def add_appeal(rid: int, criterion_id: str, comment: str) -> dict:
    result = get_result_or_404(rid)
    crit = _criterion(result, criterion_id)
    appeal = db.insert_appeal(rid, criterion_id, comment)
    appeal["disputed"] = {"answer": crit["answer"], "points": crit["points"], "explanation": crit["explanation"],
                          "evidence": crit.get("evidence"), "evidence_all": crit.get("evidence_all")}
    result.setdefault("appeals", []).append(appeal)
    result["status"] = "appealed"
    db.update_result(rid, result)
    return {"appeal": appeal, "result": result}


def review(rid: int, payload) -> dict:
    result = get_result_or_404(rid)
    checklist = get_checklist_or_404(result["checklist_id"])
    crit_def = next((c for c in checklist["criteria"] if c["id"] == payload.criterion_id), None)
    if not crit_def:
        raise BadRequest(f"criterion {payload.criterion_id} not in checklist {checklist['id']}")
    current = _criterion(result, payload.criterion_id)
    old = current["answer"]

    if payload.decision == "change":
        try:
            new = normalize_answer(crit_def, payload.new_value)
        except ValueError as exc:
            raise BadRequest(str(exc)) from exc
    else:
        new = old

    # judgments из текущего final -> тот же aggregator, что и при автооценке
    judgments = {}
    for c in result["final"]["criteria"]:
        j = {k: v for k, v in c.items() if k not in ("id", "name", "section", "type", "answer", "raw_score", "max_score",
                                                    "weight", "effective_weight", "points", "na", "evidence", "evidence_all", "expected_span")}
        j.update({"answer": c["answer"], "evidence_list": c.get("evidence_all") or [], "expected": c.get("expected_span")})
        judgments[c["id"]] = j
    j = judgments[payload.criterion_id]
    j["reviewed"] = True
    j.setdefault("original_answer", old)
    j["review_reason"] = payload.reason
    if payload.decision == "change":
        j["answer"] = new
        j["source"] = "review"
        j["explanation"] = f"{crit_def['name']} — {answer_label(new)} (изменено проверяющим, было: {answer_label(old)}). Причина: {payload.reason}"
        if str(new) == "NA":
            j["na_reason"] = payload.reason

    agg = aggregate(checklist, judgments)
    final = {"criteria": [_to_contract(c) for c in agg["criteria"]], "sections": agg["sections"], "overall": agg["overall"],
             "max_overall": agg["max_overall"], "critical_error": agg["critical_error"], "critical_criteria": agg["critical_criteria"]}

    resolved = db.resolve_open_appeals(rid, payload.criterion_id)
    appeal_id = payload.appeal_id or (resolved[0] if resolved else None)
    rev = db.insert_review(rid, appeal_id, payload.criterion_id, payload.decision, old, new if payload.decision == "change" else None, payload.reason)
    rev.update({"overall_before": result["final"]["overall"], "overall_after": final["overall"]})

    for a in result.get("appeals", []):
        if a["criterion_id"] == payload.criterion_id and a["status"] == "open":
            a["status"], a["resolved_at"] = "resolved", rev["created_at"]
    result.setdefault("reviews", []).append(rev)
    result["final"] = final
    result.update({k: final[k] for k in ("criteria", "sections", "overall", "max_overall", "critical_error", "critical_criteria")})
    result["status"] = "reviewed" if not any(a["status"] == "open" for a in result.get("appeals", [])) else "appealed"
    db.update_result(rid, result)
    return {"review": rev, "result": result}
