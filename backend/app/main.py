"""CQA backend — FastAPI. Запуск из корня репо:
    backend\\.venv\\Scripts\\python -m uvicorn backend.app.main:app --reload --port 8000
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response

from ml.judges import make_judge
from scoring.checklist import Checklist

from . import audio, config, db, service
from .ingest import IngestError, ingest_group
from .schemas import AppealIn, BatchIn, EvaluateIn, ReviewIn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# httpx на INFO печатает полный URL организаторов вместе с sig — не светим секрет в логах
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    service.seed_checklists()
    yield


app = FastAPI(title="CQA backend", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=config.CORS_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(service.NotFound)
async def _nf(_, exc):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(service.BadRequest)
async def _br(_, exc):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/health")
def health():
    judge = make_judge()
    return {"status": "ok", "judge": judge.name, "model": judge.model, "dataset_url_set": bool(config.DATASET_URL),
            "default_checklist_id": config.DEFAULT_CHECKLIST_ID}


# ---------- ingest / conversations ----------

@app.post("/ingest")
def ingest(group_id: str = Query(..., min_length=1)):
    try:
        return ingest_group(group_id)
    except IngestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/conversations")
def conversations(language: Optional[str] = None, channel: Optional[str] = None, group_id: Optional[str] = None):
    items = db.list_conversations(language, channel, group_id)
    return {"total": len(items), "items": items}


@app.get("/conversations/{conversation_id}")
def conversation(conversation_id: str):
    conv = db.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="conversation not found")
    view = service.conversation_view(conv)
    view["results"] = [{"result_id": r["result_id"], "checklist_id": r["checklist_id"], "overall": r["overall"],
                        "critical_error": r["critical_error"], "status": r["status"]}
                       for r in db.get_results_for_conversation(conversation_id)]
    return view


def _audio_info(conversation_id: str) -> dict:
    conv = db.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="conversation not found")
    if not conv.get("audio_url"):
        raise HTTPException(status_code=404, detail="no audio for this conversation (chat)")
    try:
        return {"player_url": conv["audio_url"], **audio.resolve(conv["audio_url"])}
    except audio.AudioError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/conversations/{conversation_id}/audio")
def conversation_audio(conversation_id: str):
    """Свежая mp3-ссылка (ссылка организаторов живёт ~1 ч) + страница плеера."""
    return _audio_info(conversation_id)


@app.get("/conversations/{conversation_id}/audio/stream")
def conversation_audio_stream(conversation_id: str):
    """Для <audio src=".../audio/stream#t=123">: редирект на свежую mp3-ссылку, перемотка через #t=offset_sec."""
    return RedirectResponse(_audio_info(conversation_id)["audio_src"], status_code=307)


# ---------- checklists ----------

@app.get("/checklists")
def checklists():
    return {"items": db.list_checklists()}


@app.post("/checklists", status_code=201)
def create_checklist(payload: dict):
    try:
        return service.create_checklist(payload)
    except ValueError as exc:  # pydantic ValidationError тоже ValueError
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/checklists/validate")
def validate_checklist(payload: dict):
    """Dry-run для формы редактирования: ошибки до сохранения, сумма весов."""
    try:
        model = Checklist.model_validate(payload)
    except ValueError as exc:
        return {"valid": False, "errors": str(exc)}
    weights = sum(c.weight for c in model.criteria if c.type != "flag")
    return {"valid": True, "errors": None, "weight_total": weights,
            "note": None if weights == 100 else "Сумма весов не 100 — итог всё равно нормируется к 100."}


@app.get("/checklists/{checklist_id}")
def checklist(checklist_id: str):
    return service.get_checklist_or_404(checklist_id)


# ---------- evaluate ----------

@app.post("/evaluate")
def evaluate(payload: EvaluateIn):
    return service.evaluate_request(payload)


@app.post("/evaluate/batch", status_code=202)
def evaluate_batch(payload: BatchIn):
    return service.start_batch(payload)


@app.get("/evaluate/batch")
def batch_jobs():
    return {"items": db.list_jobs()}


@app.get("/evaluate/batch/{job_id}")
def batch_status(job_id: str):
    return service.get_job_or_404(job_id)


# ---------- results / appeals / review ----------

@app.get("/stats")
def stats(group_id: Optional[str] = None, checklist_id: Optional[str] = None):
    return service.stats(group_id, checklist_id)


@app.get("/results")
def results(group_id: Optional[str] = None, checklist_id: Optional[str] = None, needs_review: Optional[bool] = None):
    """needs_review=true — очередь автоматически отмеченных для ручной проверки результатов."""
    items = db.list_results(group_id, checklist_id, needs_review)
    return {"total": len(items), "items": items}


@app.get("/results/export.csv")
def results_csv(group_id: Optional[str] = None, checklist_id: Optional[str] = None):
    name = f"cqa_{group_id or 'all'}_{checklist_id or 'all'}.csv"
    return Response(service.export_csv(group_id, checklist_id), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/results/by-id/{result_id}")
def result_by_id(result_id: int):
    return service.get_result_or_404(result_id)


@app.get("/results/{conversation_id}")
def result(conversation_id: str, checklist_id: Optional[str] = None):
    items = db.get_results_for_conversation(conversation_id, checklist_id)
    if not items:
        raise HTTPException(status_code=404, detail="no result yet (POST /evaluate)")
    return items[0]


@app.post("/results/{result_id}/appeals", status_code=201)
def appeal(result_id: int, payload: AppealIn):
    return service.add_appeal(result_id, payload.criterion_id, payload.comment)


@app.get("/appeals")
def appeals(status: Optional[str] = None, result_id: Optional[int] = None):
    """Очередь проверяющего: спорная оценка, комментарий и фрагмент диалога."""
    return {"items": service.list_appeal_cards(status, result_id)}


@app.get("/appeals/{appeal_id}")
def appeal_card(appeal_id: int):
    return service.get_appeal_card_or_404(appeal_id)


@app.post("/results/{result_id}/review")
def review(result_id: int, payload: ReviewIn):
    return service.review(result_id, payload)
