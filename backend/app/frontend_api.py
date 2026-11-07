"""Адаптер под контракт фронтенда (frontend/docs/API_CONTRACT.md), префикс /api.

Своей логики оценки здесь нет: только перевод форматов поверх service/db/ml.
Основной API (/conversations, /evaluate, /results, …) не меняется — им пользуются тесты, eval и CLI.

Соответствие:
  Evaluation.evaluationId = result_id; criteria — исходные ответы AI (original), overrides — решения проверяющего,
  total — финальный итог (final), originalTotal — итог AI. Ответы: YES/NO/NA/число <-> 'yes'/'no'/'na'/число.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ml.judges import is_llm, make_judge
from ml.pipeline import evaluate_conversation
from scoring.checklist import Checklist

from . import db, service, timeutil
from . import ingest as ingest_mod
from .ingest import IngestError, validate_record
from .schemas import ReviewIn

log = logging.getLogger("cqa.frontend_api")
router = APIRouter(prefix="/api", tags=["frontend"])

RULES_MODEL = "rule-based-v1"
REVIEWER = "Проверяющий"
# Уровень доверия из ml/review.py (по сигналам, не вероятность) -> число для порога LOW_CONFIDENCE=0.7 во фронте
CONFIDENCE = {"high": 0.9, "medium": 0.8, "low": 0.5}


def _err(status: int, message: str):
    # фронт показывает detail как есть — строка по-человечески, не список ошибок pydantic
    raise HTTPException(status_code=status, detail=message)


def _iso(ts: str | None) -> str | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError:
        return ts


def _now() -> str:
    return _iso(db.now())


# ---------------- ответы ----------------

def ans_ui(a: Any) -> Any:
    if a is None:
        return None
    s = str(a).upper()
    if s in ("YES", "NO", "NA"):
        return s.lower()
    try:
        return int(a)
    except (TypeError, ValueError):
        return a


def ans_backend(v: Any) -> Any:
    if isinstance(v, str) and v.lower() in ("yes", "no", "na"):
        return v.upper()
    return v


# ---------------- чек-листы ----------------

def _default_family() -> str:
    from . import config
    return config.DEFAULT_CHECKLIST_ID.rsplit("-v", 1)[0]


def active_checklist_id() -> str:
    cid = db.setting_get("active_checklist")
    if cid and db.get_checklist(cid):
        return cid
    latest = [c for c in db.list_checklists() if c["is_latest"] and c["family"] == _default_family()]
    cid = latest[0]["id"] if latest else service.get_checklist_or_404(None)["id"]
    db.setting_put("active_checklist", cid)  # фиксируем: новая версия активна только после явного «Активировать»
    return cid


def checklist_ui(cl: dict, active_id: str | None = None) -> dict:
    active_id = active_id or active_checklist_id()
    sec_name = {s["id"]: s["name"] for s in cl.get("sections") or []}
    return {
        "id": cl["id"], "version": cl.get("version") or 1, "name": cl["name"],
        "createdAt": _iso(db.checklist_created_at(cl["id"])), "active": cl["id"] == active_id,
        "note": cl.get("note") or (f"Источник: {cl['source']}" if cl.get("source") else ""),
        "sections": [s["name"] for s in cl.get("sections") or []],
        "criteria": [{
            "id": c["id"], "title": c["name"], "description": c.get("description") or "",
            "section": sec_name.get(c.get("section"), c.get("section") or ""),
            "weight": c.get("weight") or 0, "type": c["type"], "allowNA": bool(c.get("na_allowed")),
            "naCondition": c.get("na_condition") or "",
            "scale": [{"value": v, "label": (c.get("scale_descriptions") or {}).get(str(v), "")}
                      for v in sorted(c.get("scale") or [], reverse=True)],
            "aiGuidance": c.get("ai_guidance") or "",
        } for c in cl["criteria"]],
    }


def checklist_from_ui(payload: dict, base: dict) -> dict:
    """UI-чек-лист -> наш формат. Правила (rule/keywords) наследуются от критерия с тем же id,
    если тип и шкала не изменились — иначе критерий оценивает модель по тексту формулировки."""
    crits_in = payload.get("criteria") or []
    if not crits_in:
        _err(400, "В чек-листе нет критериев")
    names = [str(s) for s in payload.get("sections") or []]
    for c in crits_in:
        if c.get("section") and c["section"] not in names:
            names.append(c["section"])
    sec_id = {n: f"S{i + 1}" for i, n in enumerate(names)}
    prev = {c["id"]: c for c in base["criteria"]}
    out = []
    for i, c in enumerate(crits_in):
        cid = str(c.get("id") or f"c{i + 1}")[:32]
        ctype = c.get("type") or "binary"
        old = prev.get(cid, {})
        crit: dict[str, Any] = {
            "id": cid, "name": str(c.get("title") or cid), "section": sec_id.get(c.get("section")),
            "type": ctype, "weight": float(c.get("weight") or 0), "description": str(c.get("description") or c.get("title") or cid),
            "na_allowed": bool(c.get("allowNA")) and ctype != "flag", "ai_guidance": (c.get("aiGuidance") or None),
        }
        if crit["na_allowed"]:
            crit["na_condition"] = c.get("naCondition") or old.get("na_condition") or "Критерий неприменим к этому диалогу."
        if ctype == "scale":
            steps = c.get("scale") or []
            try:
                crit["scale"] = sorted({int(s["value"]) for s in steps})
            except (KeyError, TypeError, ValueError):
                _err(400, f"Критерий «{crit['name']}»: шкала должна состоять из целых чисел")
            crit["scale_descriptions"] = {str(int(s["value"])): s.get("label", "") for s in steps}
        same = old and old.get("type") == ctype and (ctype != "scale" or sorted(old.get("scale") or []) == crit.get("scale"))
        if same:
            crit["rule"], crit["keywords"] = old.get("rule"), old.get("keywords")
        out.append(crit)
    body = {
        "family": base.get("family"), "name": str(payload.get("name") or base["name"]), "note": payload.get("note") or None,
        "source": base.get("source"), "rounding": base.get("rounding", 2), "ignore": base.get("ignore", []),
        "sections": [{"id": sec_id[n], "name": n, "criteria": [c["id"] for c in out if c["section"] == sec_id[n]]} for n in names],
        "criteria": out,
    }
    return body


@router.get("/checklists")
def list_checklists():
    active = active_checklist_id()
    return [checklist_ui(service.get_checklist_or_404(c["id"]), active) for c in db.list_checklists()]


@router.post("/checklists")
def save_checklist(payload: dict):
    base = service.get_checklist_or_404(payload.get("baseId") or active_checklist_id())
    body = checklist_from_ui(payload, base)
    try:
        Checklist.model_validate(body)
    except ValueError as exc:
        _err(400, f"Чек-лист не прошёл проверку: {exc}")
    saved = service.create_checklist(body)
    return checklist_ui(saved)


@router.put("/checklists/{checklist_id}/activate")
def activate_checklist(checklist_id: str):
    cl = db.get_checklist(checklist_id)
    if not cl:
        _err(404, "Версия чек-листа не найдена")
    db.setting_put("active_checklist", checklist_id)
    return checklist_ui(cl, checklist_id)


# ---------------- диалоги ----------------

def _audio_src(request: Request | None, conv: dict) -> str | None:
    """Ссылка организаторов — страница плеера, а не mp3; в <audio> отдаём наш поток со свежей ссылкой."""
    if not conv.get("audio_url"):
        return None
    base = str(request.base_url) if request else "/"
    return f"{base}conversations/{conv['conversation_id']}/audio/stream"


def conversation_ui(conv: dict, request: Request | None = None) -> dict:
    return {"conversation_id": conv["conversation_id"], "channel": conv.get("channel"), "language": conv.get("language"),
            "transcript": conv.get("transcript") or [], "audio_url": _audio_src(request, conv), "dataset": conv.get("group_id")}


def _duration(conv: dict) -> float:
    offs = [o for o in timeutil.offsets(conv.get("transcript") or []) if o is not None]
    return round(max(offs) - min(offs), 1) if offs else 0


# ---------------- оценки ----------------

def _evidence(c: dict) -> list[dict]:
    items = c.get("evidence_all") or ([c["evidence"]] if c.get("evidence") else [])
    seen, out = set(), []
    for e in items:
        if isinstance(e, dict) and isinstance(e.get("index"), int) and e["index"] not in seen:
            seen.add(e["index"])
            out.append({"messageIndex": e["index"], "quote": e.get("text") or ""})  # вся реплика — точная подстрока
    return out


def criterion_ui(c: dict) -> dict:
    answer = ans_ui(c["answer"])
    exp = c.get("expected_span")
    conf = CONFIDENCE.get(c.get("confidence"))
    if conf is not None and c.get("needs_review"):
        conf = min(conf, 0.6)
    return {
        "criterionId": c["id"], "answer": answer,
        "points": c["points"] if c.get("points") is not None else 0,
        "maxPoints": c.get("weight") or 0, "effectiveWeight": c.get("effective_weight") or 0,
        "explanation": c.get("explanation") or "", "evidence": _evidence(c),
        "checkedRange": {"from": exp["index"], "to": exp["index"]} if exp and answer != "yes" and isinstance(exp.get("index"), int) else None,
        "naReason": (c.get("na_reason") or "Условие N/A выполнено") if answer == "na" else None,
        "confidence": conf,
        "reviewReasons": c.get("review_reasons") or [],
        "source": c.get("source"),
    }


def evaluation_ui(res: dict, created_at: str | None, with_raw: bool = True) -> dict:
    orig = res.get("original") or res
    pipe = res.get("pipeline") or {}
    names = {s["id"]: s["name"] for s in res.get("sections") or []}
    overrides, audit = {}, [{"at": _iso(created_at), "actor": pipe.get("model") or "model", "action": "evaluated",
                            "details": f"v{res.get('checklist_version')} · {orig.get('overall') if orig.get('overall') is not None else '—'}"}]
    for a in res.get("appeals") or []:
        audit.append({"at": _iso(a.get("created_at")), "actor": "QA", "action": "appeal", "details": f"{a['criterion_id']}: {a.get('comment', '')}"})
    for r in res.get("reviews") or []:
        changed = r.get("decision") == "change"
        audit.append({"at": _iso(r.get("created_at")), "actor": REVIEWER, "action": "changed" if changed else "confirmed",
                      "details": f"{r['criterion_id']}: {r.get('reason', '')}"})
        if changed:
            first = overrides.get(r["criterion_id"], {}).get("previous", ans_ui(r.get("old_value")))
            overrides[r["criterion_id"]] = {"answer": ans_ui(r.get("new_value")), "reason": r.get("reason", ""), "by": REVIEWER,
                                            "at": _iso(r.get("created_at")), "appealId": str(r.get("appeal_id") or ""),
                                            "previous": first}
    audit.sort(key=lambda x: x["at"] or "")
    ev = {
        "evaluationId": str(res["result_id"]), "conversationId": res["conversation_id"],
        "checklistId": res["checklist_id"], "checklistVersion": res.get("checklist_version") or 1,
        "model": pipe.get("model") or RULES_MODEL, "judge": pipe.get("judge"),
        "createdAt": _iso(created_at), "durationMs": int((pipe.get("duration_sec") or 0) * 1000),
        "costUsd": pipe.get("cost_usd") or 0, "tokens": {"in": pipe.get("input_tokens") or 0, "out": pipe.get("output_tokens") or 0},
        "criteria": [criterion_ui(c) for c in orig["criteria"]],
        "sections": [{"section": names.get(s["id"], s.get("name")), "score": s.get("points") or 0, "max": s.get("max_points") or 0}
                     for s in res.get("sections") or []],
        "total": res.get("overall"), "originalTotal": orig.get("overall"), "totalComputable": res.get("overall") is not None,
        "grossViolation": bool(res.get("critical_error")), "overrides": overrides, "audit": audit,
        "reviewRequired": bool(res.get("review_required")), "reviewCriteria": res.get("review_criteria") or [],
    }
    if with_raw:
        # что реально вернул наш конвейер (правила + модель); сырой текст LLM не храним
        ev["rawModelOutput"] = {
            "pipeline": pipe,
            "results": [{k: c.get(k) for k in ("id", "answer", "source", "rule_answer", "agreement", "confidence", "needs_review",
                                               "review_reasons", "na_reason", "explanation")}
                        | {"evidence_message_ids": [e["messageIndex"] for e in _evidence(c)]} for c in orig["criteria"]],
            "gross_violation": bool(orig.get("critical_error")),
        }
    return ev


def _all_results() -> list[tuple[dict, str, str]]:
    return db.result_rows()


def _latest_by_conversation(rows, active: str) -> dict[str, tuple[dict, str]]:
    """Последняя оценка диалога: по активному чек-листу, иначе самая свежая."""
    best: dict[str, tuple[dict, str, str]] = {}
    for body, created, updated in rows:
        cid = body["conversation_id"]
        cur = best.get(cid)
        rank = (body["checklist_id"] == active, updated)
        if not cur or rank > (cur[0]["checklist_id"] == active, cur[2]):
            best[cid] = (body, created, updated)
    return {k: (v[0], v[1]) for k, v in best.items()}


def _result_or_404(evaluation_id: str) -> tuple[dict, str]:
    try:
        rid = int(evaluation_id)
    except ValueError:
        _err(404, "Оценка не найдена")
    rows = db.result_rows("result_id=?", (rid,))
    if not rows:
        _err(404, "Оценка не найдена")
    return rows[0][0], rows[0][1]


# ---------------- апелляции ----------------

def _appeal_meta(aid: int) -> dict:
    return db.setting_get(f"appeal:{aid}", {}) or {}


def appeal_ui(a: dict, res: dict | None = None) -> dict:
    res = res or db.get_result_by_id(a["result_id"]) or {}
    meta = _appeal_meta(a["appeal_id"])
    rev = next((r for r in res.get("reviews") or [] if r.get("appeal_id") == a["appeal_id"]), None)
    orig = next((c for c in (res.get("original") or {}).get("criteria", []) if c["id"] == a["criterion_id"]), None)
    created = _iso(a["created_at"])
    history = [{"at": created, "status": "submitted", "actor": "QA"}]
    if meta.get("taken_at"):
        history.append({"at": meta["taken_at"], "status": "in_review", "actor": REVIEWER})
    decision = None
    if a["status"] == "open":
        status = "in_review" if meta.get("taken_at") else "submitted"
    elif rev:
        status = "changed" if rev["decision"] == "change" else "confirmed"
        decision = {"action": rev["decision"], "newValue": ans_ui(rev.get("new_value")) if rev["decision"] == "change" else None,
                    "reason": rev.get("reason", ""), "by": REVIEWER, "at": _iso(rev.get("created_at")),
                    "totalBefore": rev.get("overall_before"), "totalAfter": rev.get("overall_after")}
    else:  # superseded: диалог переоценили заново, апелляция к старой оценке закрыта
        status = "confirmed"
        decision = {"action": "confirm", "newValue": None, "reason": "Диалог переоценён заново — апелляция к прежней оценке закрыта автоматически.",
                    "by": "system", "at": _iso(a.get("resolved_at")), "totalBefore": None, "totalAfter": None}
    if decision:
        if not meta.get("taken_at"):
            history.append({"at": decision["at"], "status": "in_review", "actor": REVIEWER})
        history.append({"at": decision["at"], "status": status, "actor": decision["by"]})
    return {
        "id": str(a["appeal_id"]), "evaluationId": str(a["result_id"]), "conversationId": res.get("conversation_id"),
        "criterionId": a["criterion_id"],
        "originalAnswer": meta.get("original_answer", ans_ui((orig or {}).get("answer"))),
        "comment": a["comment"], "status": status, "createdAt": created, "history": history,
        "decision": decision, "aiReview": meta.get("ai_review"),
    }


def _appeal_or_404(appeal_id: str) -> dict:
    try:
        a = db.get_appeal(int(appeal_id))
    except ValueError:
        a = None
    if not a:
        _err(404, "Апелляция не найдена")
    return a


# ---------------- задачи оценки ----------------

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _run_job(job: dict, checklist: dict, mode: str | None) -> None:
    judge = make_judge(mode)
    for it in job["items"]:
        it["status"], it["stage"] = "running", 2
        try:
            conv = db.get_conversation(it["conversationId"])
            if not conv:
                raise LookupError("Диалог не найден — загрузите набор заново")
            if not conv.get("transcript"):
                raise ValueError("Пустой транскрипт — оценивать нечего")
            saved = service.evaluate_one(conv, checklist, judge=judge)
            it.update(status="done", stage=5, evaluationId=str(saved["result_id"]))
            job["done"] += 1
        except Exception as exc:  # noqa: BLE001 — один диалог не роняет задачу
            log.exception("frontend job item failed %s", it["conversationId"])
            it.update(status="error", error=str(exc)[:200] if isinstance(exc, (LookupError, ValueError)) else
                      f"Не удалось оценить диалог ({type(exc).__name__}). Повторите позже.")
            job["failed"] += 1
    job["status"], job["finishedAt"] = "done", _now()


# ---------------- эндпоинты ----------------

@router.get("/health")
def health():
    judge = make_judge()
    return {"ok": True, "judge": judge.name, "model": judge.model}


@router.get("/datasets/{group_id}")
def get_dataset(group_id: str, request: Request):
    g = group_id.strip()
    if not g:
        _err(400, "Укажите group_id")
    try:
        data = ingest_mod.fetch_group(g)
    except IngestError as exc:
        msg = str(exc)
        if "DATASET_URL" in msg:
            _err(503, "Бэкенд не настроен: нет DATASET_URL в backend/.env")
        if "organizers API error" in msg:
            _err(404, f"Набор {g} не найден")
        _err(502, f"API организаторов недоступен: {msg}")
    records = [validate_record(r) for r in data["records"]]
    if not records:
        _err(404, f"Набор {g} не найден или пуст")
    for rec in records:
        db.upsert_conversation(rec, g)
    return {"error": "", "isSuccess": True, "data": {
        "dataset_group_id": data.get("dataset_group_id") or g, "total_records": data.get("total_records", len(records)),
        "records": [conversation_ui({**r, "group_id": g}, request) for r in records]}}


@router.get("/conversations")
def list_conversations(request: Request):
    active = active_checklist_id()
    latest = _latest_by_conversation(_all_results(), active)
    appeals: dict[str, list[dict]] = {}
    res_conv = {body["result_id"]: body["conversation_id"] for body, *_ in _all_results()}
    for a in db.list_appeals():
        appeals.setdefault(res_conv.get(a["result_id"]), []).append(a)
    out = []
    for conv in db.list_conversations():
        full = db.get_conversation(conv["conversation_id"])
        ev = latest.get(conv["conversation_id"])
        status = None
        own = appeals.get(conv["conversation_id"]) or []
        if own:
            open_ = [a for a in own if a["status"] == "open"]
            status = appeal_ui(open_[-1] if open_ else own[-1])["status"]
        out.append({"conversation_id": conv["conversation_id"], "channel": conv.get("channel"), "language": conv.get("language"),
                    "audio_url": _audio_src(request, conv), "dataset": conv.get("group_id"),
                    "messages": len(full.get("transcript") or []), "duration": _duration(full),
                    "evaluation": evaluation_ui(ev[0], ev[1], with_raw=False) if ev else None, "appealStatus": status})
    return out


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, request: Request):
    conv = db.get_conversation(conversation_id)
    if not conv:
        _err(404, f"Диалог {conversation_id} не найден")
    latest = _latest_by_conversation(db.result_rows("conversation_id=?", (conversation_id,)), active_checklist_id())
    ev = latest.get(conversation_id)
    return {"conversation": conversation_ui(conv, request), "evaluation": evaluation_ui(*ev) if ev else None}


@router.get("/conversations/{conversation_id}/evaluations")
def list_evaluations(conversation_id: str):
    return [evaluation_ui(body, created) for body, created, _ in db.result_rows("conversation_id=?", (conversation_id,))]


@router.post("/conversations/import")
def import_conversations(payload: dict):
    records = payload.get("records")
    if not isinstance(records, list) or not records:
        _err(400, "В файле нет записей")
    ids = []
    for i, r in enumerate(records):
        if not isinstance(r, dict) or not r.get("conversation_id") or not isinstance(r.get("transcript"), list):
            _err(400, f"Запись #{i + 1}: нужны conversation_id и transcript[]")
        rec = validate_record({"channel": "agent chat", "language": "RU", "audio_url": None, **r})
        db.upsert_conversation(rec, "IMPORT")
        ids.append(rec["conversation_id"])
    return {"imported": len(ids), "ids": ids}


@router.get("/models")
def list_models():
    stats: dict[str, list[tuple[float, float]]] = {}
    for body, *_ in _all_results():
        p = body.get("pipeline") or {}
        stats.setdefault(p.get("model"), []).append((p.get("cost_usd") or 0, (p.get("duration_sec") or 0) * 1000))

    def avg(model, i, default):
        xs = [x[i] for x in stats.get(model, [])]
        return round(sum(xs) / len(xs), 6 if i == 0 else 0) if xs else default

    out = []
    judge = make_judge()
    if is_llm(judge):
        out.append({"id": judge.model, "name": f"{judge.model} (гибрид: правила + LLM)", "kind": "cloud",
                    "costUsd": avg(judge.model, 0, 0), "avgMs": avg(judge.model, 1, 8000)})
    out.append({"id": RULES_MODEL, "name": "Правила без LLM (офлайн, $0)", "kind": "local",
                "costUsd": 0, "avgMs": avg(RULES_MODEL, 1, 30)})
    return out


@router.post("/evaluations")
def start_evaluation(payload: dict):
    ids = [str(x) for x in payload.get("conversationIds") or []]
    if not ids:
        _err(400, "Выберите хотя бы один диалог")
    cl_id = payload.get("checklistId") or active_checklist_id()
    if not db.get_checklist(cl_id):
        _err(404, "Чек-лист не найден")
    checklist = service.get_checklist_or_404(cl_id)
    mode = "rules" if payload.get("model") == RULES_MODEL else None
    job = {"jobId": f"job_{uuid.uuid4().hex[:10]}", "checklistId": checklist["id"],
           "model": RULES_MODEL if mode else make_judge().model, "status": "running", "startedAt": _now(),
           "total": len(ids), "done": 0, "failed": 0, "_t0": time.time(),
           "items": [{"conversationId": i, "status": "queued", "stage": 0, "evaluationId": None, "error": None} for i in ids]}
    with _jobs_lock:
        _jobs[job["jobId"]] = job
    threading.Thread(target=_run_job, args=(job, checklist, mode), name=f"ui-{job['jobId']}", daemon=True).start()
    return {"jobId": job["jobId"]}


@router.get("/evaluations/jobs/{job_id}")
def get_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        _err(404, "Задача не найдена (сервер перезапускался?) — запустите оценку ещё раз")
    fin = job["done"] + job["failed"]
    eta = round((time.time() - job["_t0"]) * 1000 / fin * (job["total"] - fin)) if fin and job["status"] != "done" else (0 if fin else None)
    return {k: v for k, v in job.items() if not k.startswith("_")} | {"etaMs": eta}


@router.get("/evaluations/{evaluation_id}")
def get_evaluation(evaluation_id: str):
    return evaluation_ui(*_result_or_404(evaluation_id))


@router.post("/appeals")
def create_appeal(payload: dict):
    res, _ = _result_or_404(str(payload.get("evaluationId") or ""))
    cid, comment = payload.get("criterionId"), str(payload.get("comment") or "").strip()
    if not comment:
        _err(400, "Напишите комментарий к апелляции")
    if not any(c["id"] == cid for c in res["criteria"]):
        _err(400, f"Критерия {cid} нет в этой оценке")
    if any(a["criterion_id"] == cid and a["status"] == "open" for a in db.list_appeals(result_id=res["result_id"])):
        _err(409, "По этому критерию уже есть открытая апелляция")
    current = next(c for c in res["criteria"] if c["id"] == cid)
    out = service.add_appeal(res["result_id"], cid, comment)
    aid = out["appeal"]["appeal_id"]
    db.setting_put(f"appeal:{aid}", {"original_answer": ans_ui(current["answer"])})
    return appeal_ui(db.get_appeal(aid), out["result"])


@router.get("/appeals")
def list_appeals(status: str | None = None):
    items = [appeal_ui(a) for a in db.list_appeals()]
    if status:
        items = [a for a in items if a["status"] == status]
    return sorted(items, key=lambda a: (a["createdAt"] or "", int(a["id"])), reverse=True)  # новые первыми


@router.post("/appeals/{appeal_id}/take")
def take_appeal(appeal_id: str):
    a = _appeal_or_404(appeal_id)
    meta = _appeal_meta(a["appeal_id"])
    if a["status"] == "open" and not meta.get("taken_at"):
        db.setting_put(f"appeal:{a['appeal_id']}", {**meta, "taken_at": _now()})
    return appeal_ui(a)


@router.post("/appeals/{appeal_id}/decision")
def decide_appeal(appeal_id: str, payload: dict):
    a = _appeal_or_404(appeal_id)
    if a["status"] != "open":
        _err(409, "Решение по апелляции уже принято")
    reason = str(payload.get("reason") or "").strip()
    if not reason:
        _err(400, "Укажите причину решения")
    action = payload.get("action")
    if action not in ("confirm", "change"):
        _err(400, "action: confirm или change")
    if action == "change" and payload.get("newValue") is None:
        _err(400, "Выберите новую оценку")
    try:
        out = service.review(a["result_id"], ReviewIn(criterion_id=a["criterion_id"], decision=action, reason=reason,
                                                       new_value=ans_backend(payload.get("newValue")) if action == "change" else None,
                                                       appeal_id=a["appeal_id"]))
    except service.BadRequest as exc:
        _err(400, f"Недопустимая оценка: {exc}")
    res = out["result"]
    created = db.result_rows("result_id=?", (res["result_id"],))[0][1]
    return {"appeal": appeal_ui(db.get_appeal(a["appeal_id"]), res), "evaluation": evaluation_ui(res, created)}


@router.post("/appeals/{appeal_id}/ai-review")
def ai_review(appeal_id: str):
    """Второе мнение: повторная оценка одного критерия; довод апелляции добавляется к формулировке как аргумент, не как факт."""
    a = _appeal_or_404(appeal_id)
    res = db.get_result_by_id(a["result_id"]) or {}
    conv = db.get_conversation(res.get("conversation_id") or "")
    checklist = db.get_checklist(res.get("checklist_id") or "")
    crit = next((c for c in (checklist or {}).get("criteria", []) if c["id"] == a["criterion_id"]), None)
    if not (conv and crit):
        _err(404, "Нет диалога или критерия для повторной оценки")
    probe = {**crit, "description": crit["description"] + "\n\nДовод апелляции QA (проверь по транскрипту, это не доказательство): "
             + a["comment"][:1500]}
    judge = make_judge()
    out = evaluate_conversation(conv, {**checklist, "criteria": [probe], "sections": []}, judge)
    c = out["criteria"][0]
    current = next((x for x in res.get("criteria", []) if x["id"] == a["criterion_id"]), {})
    llm = is_llm(judge) and c.get("source") != "rules"
    review_out = {
        "answer": ans_ui(c["answer"]),
        "explanation": (c.get("explanation") or "") if llm else
        "LLM недоступна — повторно применены правила, они не учитывают текст апелляции. " + (c.get("explanation") or ""),
        "confidence": CONFIDENCE.get(c.get("confidence"), 0.6) if llm else 0.5,
        "model": out["pipeline"].get("model") or RULES_MODEL, "at": _now(),
        "agrees": ans_ui(c["answer"]) == ans_ui(current.get("answer")),
    }
    meta = _appeal_meta(a["appeal_id"])
    db.setting_put(f"appeal:{a['appeal_id']}", {**meta, "ai_review": review_out})
    return review_out
