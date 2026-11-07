"""Бизнес-логика API: чек-листы, оценка, batch, апелляции и пересмотр (тот же aggregator)."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import threading
import uuid
from collections import Counter, defaultdict

from ml.judges import answer_label, make_judge
from ml.pipeline import _to_contract, evaluate_conversation
from ml.review import summarize as review_summary
from scoring import aggregate, normalize_answer
from scoring.checklist import Checklist, slugify

from . import config, db, timeutil

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

def conversation_view(conv: dict) -> dict:
    """Добавляет index и offset_sec — для перехода к реплике / позиции в записи звонка.
    Исходные timestamp не трогаем."""
    offs = timeutil.offsets(conv["transcript"])
    out = [{"index": i, **t, "offset_sec": offs[i]} for i, t in enumerate(conv["transcript"])]
    view = {**conv, "transcript": out}
    if conv.get("audio_url"):
        view["audio_stream_url"] = f"/conversations/{conv['conversation_id']}/audio/stream"
    return view


def attach_offsets(result: dict, conv: dict) -> dict:
    """offset_sec в каждой evidence — фронт сразу перематывает запись к фрагменту."""
    offs = timeutil.offsets(conv["transcript"])

    def fix(e):
        if isinstance(e, dict) and isinstance(e.get("index"), int) and 0 <= e["index"] < len(offs):
            e["offset_sec"] = offs[e["index"]]

    for block in (result, result.get("original", {}), result.get("final", {})):
        for c in block.get("criteria", []):
            fix(c.get("evidence"))
            fix(c.get("expected_span"))
            for e in c.get("evidence_all") or []:
                fix(e)
    return result


def transcript_fragment(conv: dict, index: int | None, radius: int = 2) -> list[dict]:
    if index is None:
        return []
    view = conversation_view(conv)["transcript"]
    lo, hi = max(0, index - radius), min(len(view), index + radius + 1)
    return [{**t, "focus": t["index"] == index} for t in view[lo:hi]]


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
    attach_offsets(result, conversation)
    saved = db.save_result(result)
    # переоценка заменяет результат: открытые апелляции к старой версии больше не актуальны
    db.supersede_open_appeals(saved["result_id"])
    return saved


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

def run_batch(job: dict, ids: list[str], checklist: dict, mode: str | None, force: bool, on_progress=None) -> dict:
    """Идемпотентно: уже оценённые (conversation_id, checklist_id) пропускаются -> повторный запуск = resume."""
    judge = make_judge(mode)
    job["judge"], job["model"] = judge.name, judge.model
    db.save_job(job)
    for cid in ids:
        try:
            if not force and db.result_exists(cid, checklist["id"]):
                job["skipped"] += 1
            else:
                conv = db.get_conversation(cid)
                if not conv:
                    raise NotFound(f"conversation {cid} not found")
                res = evaluate_one(conv, checklist, judge=judge)
                job["done"] += 1
                job["cost_usd"] = round(job["cost_usd"] + res["pipeline"]["cost_usd"], 6)
                job["llm_fallbacks"] += res["pipeline"]["llm_fallbacks"]
        except Exception as exc:  # noqa: BLE001 — batch не должен падать целиком
            job["failed"] += 1
            job["errors"].append(f"{cid}: {type(exc).__name__}: {str(exc)[:200]}")
            log.exception("batch item failed %s", cid)
        db.save_job(job)
        if on_progress:
            on_progress(job, cid)
    job["status"] = "finished"
    job["finished_at"] = db.now()
    db.save_job(job)
    return job


def new_job(group_id: str, checklist_id: str, ids: list[str]) -> dict:
    return {"job_id": uuid.uuid4().hex[:12], "group_id": group_id, "checklist_id": checklist_id, "status": "running",
            "total": len(ids), "done": 0, "skipped": 0, "failed": 0, "llm_fallbacks": 0, "errors": [], "cost_usd": 0.0,
            "started_at": db.now(), "finished_at": None}


_batch_lock = threading.Lock()


def _running_job(group_id: str, checklist_id: str) -> dict | None:
    alive = {t.name for t in threading.enumerate()}
    for job in db.list_jobs(limit=50):
        if (job.get("group_id") == group_id and job.get("checklist_id") == checklist_id
                and job.get("status") == "running" and f"batch-{job['job_id']}" in alive):
            return job
    return None


def start_batch(payload) -> dict:
    checklist = get_checklist_or_404(payload.checklist_id)
    ids = db.conversation_ids(payload.group_id)
    if not ids:
        raise NotFound(f"no conversations for group_id={payload.group_id} (сначала POST /ingest?group_id=...)")
    with _batch_lock:
        # повторный клик «Оценить всё» не запускает второй платный прогон того же набора
        running = _running_job(payload.group_id, checklist["id"])
        if running:
            return {**running, "deduplicated": True}
        job = new_job(payload.group_id, checklist["id"], ids)
        if payload.background:
            db.save_job(job)
            threading.Thread(target=run_batch, args=(job, ids, checklist, payload.mode, payload.force),
                             name=f"batch-{job['job_id']}", daemon=True).start()
            return job
    return run_batch(job, ids, checklist, payload.mode, payload.force)


def get_job_or_404(job_id: str) -> dict:
    job = db.get_job(job_id)
    if not job:
        raise NotFound(f"job {job_id} not found")
    if job["status"] == "running" and f"batch-{job_id}" not in {t.name for t in threading.enumerate()}:
        # поток умер вместе с процессом (рестарт сервера) — повторный batch досчитает остаток
        job["status"] = "interrupted"
        job["hint"] = "Перезапустите POST /evaluate/batch с теми же параметрами: оценённые диалоги будут пропущены."
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


def appeal_card(appeal: dict) -> dict:
    """Что видит проверяющий: спорная оценка, комментарий, фрагмент диалога вокруг доказательства."""
    result = db.get_result_by_id(appeal["result_id"]) or {}
    crit = next((c for c in result.get("final", {}).get("criteria", []) if c["id"] == appeal["criterion_id"]), None)
    orig = next((c for c in result.get("original", {}).get("criteria", []) if c["id"] == appeal["criterion_id"]), None)
    conv = db.get_conversation(result["conversation_id"]) if result else None
    focus = (crit or {}).get("evidence") or {}
    return {
        **appeal,
        "conversation_id": result.get("conversation_id"),
        "checklist_id": result.get("checklist_id"),
        "language": result.get("language"),
        "channel": result.get("channel"),
        "criterion": None if not crit else {
            "id": crit["id"], "name": crit["name"], "type": crit["type"], "answer": crit["answer"], "points": crit["points"],
            "weight": crit["weight"], "na": crit["na"], "explanation": crit["explanation"],
            "evidence": crit.get("evidence"), "evidence_all": crit.get("evidence_all"),
            "original_answer": (orig or {}).get("answer"),
        },
        "overall": result.get("overall"),
        "fragment": transcript_fragment(conv, focus.get("index")) if conv else [],
    }


def list_appeal_cards(status: str | None = None, result_id: int | None = None) -> list[dict]:
    return [appeal_card(a) for a in db.list_appeals(status, result_id)]


def get_appeal_card_or_404(aid: int) -> dict:
    a = db.get_appeal(aid)
    if not a:
        raise NotFound(f"appeal {aid} not found")
    return appeal_card(a)


def add_appeal(rid: int, criterion_id: str, comment: str) -> dict:
    result = get_result_or_404(rid)
    crit = _criterion(result, criterion_id)
    appeal = db.insert_appeal(rid, criterion_id, comment)
    appeal["disputed"] = {"answer": crit["answer"], "points": crit["points"], "explanation": crit["explanation"],
                          "evidence": crit.get("evidence"), "evidence_all": crit.get("evidence_all")}
    result.setdefault("appeals", []).append(appeal)
    result["status"] = "appealed"
    db.update_result(rid, result)
    return {"appeal": appeal, "card": appeal_card(appeal), "result": result}


# ---------------- stats / export ----------------

def stats(group_id: str | None = None, checklist_id: str | None = None) -> dict:
    convs = db.list_conversations(group_id=group_id)
    results = db.all_result_bodies(group_id, checklist_id)
    scored = [r for r in results if r.get("overall") is not None]

    def avg(xs):
        xs = [x for x in xs if x is not None]
        return round(sum(xs) / len(xs), 2) if xs else None

    by = {"language": defaultdict(list), "channel": defaultdict(list)}
    per_crit: dict[str, dict] = {}
    for r in results:
        by["language"][r.get("language")].append(r.get("overall"))
        by["channel"][r.get("channel")].append(r.get("overall"))
        for c in r["criteria"]:
            d = per_crit.setdefault(c["id"], {"id": c["id"], "name": c["name"], "answers": Counter(), "points": []})
            d["answers"][str(c["answer"])] += 1
            if c["points"] is not None:
                d["points"].append(c["points"])
    return {
        "group_id": group_id, "checklist_id": checklist_id,
        "conversations": len(convs),
        "conversations_by_language": dict(Counter(c["language"] for c in convs)),
        "conversations_by_channel": dict(Counter(c["channel"] for c in convs)),
        "evaluated": len(results),
        "avg_overall": avg([r["overall"] for r in scored]),
        "critical_errors": sum(1 for r in results if r.get("critical_error")),
        "status": dict(Counter(r.get("status") for r in results)),
        "avg_overall_by_language": {k: avg(v) for k, v in by["language"].items()},
        "avg_overall_by_channel": {k: avg(v) for k, v in by["channel"].items()},
        "criteria": [{"id": d["id"], "name": d["name"], "answers": dict(d["answers"]),
                      "na_rate": round(d["answers"].get("NA", 0) / max(1, sum(d["answers"].values())), 3),
                      "avg_points": avg(d["points"])} for d in per_crit.values()],
        "review_required": sum(1 for r in results if r.get("review_required")),
        "review_rate": round(sum(1 for r in results if r.get("review_required")) / len(results), 3) if results else None,
        "review_reasons": dict(sum((Counter(r.get("review_reasons") or {}) for r in results), Counter())),
        "agreement_rate": avg([r.get("agreement_rate") for r in results]),
        "open_appeals": len(db.list_appeals("open")),
        "llm_cost_usd": round(sum(r.get("pipeline", {}).get("cost_usd", 0) for r in results), 4),
    }


def export_csv(group_id: str | None = None, checklist_id: str | None = None) -> str:
    results = db.all_result_bodies(group_id, checklist_id)
    crit_ids: list[str] = []
    for r in results:
        for c in r["criteria"]:
            if c["id"] not in crit_ids:
                crit_ids.append(c["id"])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["result_id", "conversation_id", "checklist_id", "language", "channel", "status", "overall", "overall_original",
                "critical_error"] + [f"{cid}_answer" for cid in crit_ids] + [f"{cid}_points" for cid in crit_ids])
    for r in results:
        cm = {c["id"]: c for c in r["criteria"]}
        w.writerow([r.get("result_id"), r["conversation_id"], r["checklist_id"], r.get("language"), r.get("channel"), r.get("status"),
                    r.get("overall"), r.get("original", {}).get("overall"), int(bool(r.get("critical_error")))]
                   + [cm[c]["answer"] if c in cm else "" for c in crit_ids]
                   + [cm[c]["points"] if c in cm and cm[c]["points"] is not None else "" for c in crit_ids])
    return "﻿" + buf.getvalue()  # BOM — чтобы Excel открыл кириллицу


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
    final.update(review_summary(final["criteria"]))  # проверенный человеком критерий больше не требует проверки

    resolved = db.resolve_open_appeals(rid, payload.criterion_id)
    appeal_id = payload.appeal_id or (resolved[0] if resolved else None)
    rev = db.insert_review(rid, appeal_id, payload.criterion_id, payload.decision, old, new if payload.decision == "change" else None, payload.reason)
    rev.update({"overall_before": result["final"]["overall"], "overall_after": final["overall"]})

    for a in result.get("appeals", []):
        if a["criterion_id"] == payload.criterion_id and a["status"] == "open":
            a["status"], a["resolved_at"] = "resolved", rev["created_at"]
    result.setdefault("reviews", []).append(rev)
    result["final"] = final
    result.update({k: final[k] for k in ("criteria", "sections", "overall", "max_overall", "critical_error", "critical_criteria",
                                         "review_required", "review_criteria", "agreement_rate", "review_reasons")})
    result["status"] = "reviewed" if not any(a["status"] == "open" for a in result.get("appeals", [])) else "appealed"
    db.update_result(rid, result)
    return {"review": rev, "result": result}
