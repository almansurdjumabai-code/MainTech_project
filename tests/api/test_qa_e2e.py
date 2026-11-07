"""QA блок 5: сквозные сценарии продукта через API (то, что UI вызывает при демо)."""
import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import db, service
from backend.app import ingest as ingest_mod
from backend.app.ingest import IngestError
from backend.app.main import app

FIXTURE = json.loads((Path(__file__).parents[1] / "fixtures/synthetic.json").read_text(encoding="utf-8"))
CALL = {"conversation_id": "qa-call", "channel": "voice call", "language": "RU", "audio_url": "https://organizers.example/player?x=1",
        "transcript": [
            {"timestamp": "2026-11-03T13:10:00.0000000+00:00", "speaker": "system", "text": "Агент присоединился."},
            {"timestamp": "2026-11-03T13:10:05.5000000+00:00", "speaker": "operator", "text": "Здравствуйте, меня зовут Нурлан, чем могу помочь?"},
            {"timestamp": "2026-11-03T13:10:20.0000000+00:00", "speaker": "client", "text": "Как пополнить брокерский счёт картой?"},
            {"timestamp": "2026-11-03T13:11:00.0000000+00:00", "speaker": "operator", "text": "Откройте «Пополнить», выберите «Картой». Всего доброго!"}]}


@pytest.fixture(scope="module")
def client():
    orig = ingest_mod.fetch_group

    def fake_fetch(group_id, base_url=None, timeout=90.0):
        if group_id != "QA":
            raise IngestError("organizers API error: unknown group_id")
        return FIXTURE["data"]
    ingest_mod.fetch_group = fake_fetch
    orig_dir = service.config.CHECKLIST_DIR
    with TestClient(app) as c:
        service.config.CHECKLIST_DIR = Path(service.config.DB_PATH).parent
        assert c.post("/ingest", params={"group_id": "QA"}).status_code == 200
        db.upsert_conversation(CALL, "QA")
        yield c
    service.config.CHECKLIST_DIR = orig_dir
    ingest_mod.fetch_group = orig


def evidence_points_to_transcript(client, res):
    conv = client.get(f"/conversations/{res['conversation_id']}").json()["transcript"]
    for c in res["criteria"]:
        for e in [c.get("evidence"), c.get("expected_span"), *(c.get("evidence_all") or [])]:
            if e:
                t = conv[e["index"]]
                assert (t["text"], t["speaker"], t["timestamp"]) == (e["text"], e["speaker"], e["timestamp"]), (c["id"], e)


def test_evaluate_shows_answer_points_weight_explanation_evidence(client):
    for rec in FIXTURE["data"]["records"] + [CALL]:
        res = client.post("/evaluate", json={"conversation_id": rec["conversation_id"]}).json()
        for c in res["criteria"]:
            assert {"answer", "points", "weight", "effective_weight", "explanation"} <= set(c)
            assert c["explanation"].startswith(c["name"])
            if c["na"]:
                assert c["na_reason"], c["id"]  # N/A всегда с причиной
            elif c["type"] != "flag":
                assert c["evidence"] is not None, c["id"]  # реплика-доказательство или место, где ожидалось
        evidence_points_to_transcript(client, res)
        assert res["sections"] and (res["overall"] is None or 0 <= res["overall"] <= 100)


def test_call_evidence_has_audio_offset(client):
    res = client.post("/evaluate", json={"conversation_id": "qa-call"}).json()
    c1 = next(c for c in res["criteria"] if c["id"] == "C1")
    assert c1["evidence"]["offset_sec"] == 5.5
    assert client.get("/conversations/qa-call").json()["audio_stream_url"] == "/conversations/qa-call/audio/stream"


def test_appeal_decision_three_values_and_persistence(client):
    res = client.post("/evaluate", json={"conversation_id": "t-ru-missed"}).json()
    rid, before = res["result_id"], res["overall"]
    crit = next(c for c in res["criteria"] if c["answer"] == "NO" and c["type"] == "binary")
    card = client.post(f"/results/{rid}/appeals", json={"criterion_id": crit["id"], "comment": "Не согласен"}).json()["card"]
    assert card["criterion"]["id"] == crit["id"] and card["comment"] == "Не согласен" and card["fragment"]
    out = client.post(f"/results/{rid}/review", json={"criterion_id": crit["id"], "decision": "change", "new_value": "YES",
                                                     "reason": "Действие выполнено"}).json()
    r = out["result"]
    # исходная оценка, решение, финальный результат
    assert next(c for c in r["original"]["criteria"] if c["id"] == crit["id"])["answer"] == "NO"
    assert r["reviews"][-1]["old_value"] == "NO" and r["reviews"][-1]["new_value"] == "YES" and r["reviews"][-1]["reason"]
    assert next(c for c in r["final"]["criteria"] if c["id"] == crit["id"])["answer"] == "YES"
    assert r["original"]["overall"] == before and r["overall"] > before
    # «перезагрузка страницы»: всё читается из БД заново
    with TestClient(app) as fresh:
        again = fresh.get(f"/results/by-id/{rid}").json()
        assert again["overall"] == r["overall"] and again["reviews"] and again["appeals"][0]["status"] == "resolved"


def test_checklist_change_applies_and_keeps_old_results(client):
    v1 = client.get("/checklists/cqa-default-v1").json()
    client.post("/evaluate/batch", json={"group_id": "QA", "checklist_id": "cqa-default-v1", "background": False})
    old = {r["conversation_id"]: r["overall"] for r in client.get("/results", params={"checklist_id": "cqa-default-v1"}).json()["items"]}
    v2 = copy.deepcopy(v1)
    for k in ("id", "version", "created_at"):
        v2.pop(k, None)
    c5 = next(c for c in v2["criteria"] if c["id"] == "C5")
    c5["description"] = "Да — оператор вежлив и отреагировал на проблему клиента."  # формулировка
    c5["weight"] = 10                                                                 # вес
    c4 = next(c for c in v2["criteria"] if c["id"] == "C4")
    c4["scale"], c4["scale_descriptions"] = [0, 10, 20], {"20": "всё", "10": "часть", "0": "ничего"}  # шкала
    v2["criteria"].append({"id": "C9", "name": "Предупреждение об ожидании", "section": "S3", "type": "binary", "weight": 5,
                           "na_allowed": True, "na_condition": "Пауз не было.", "description": "Предупредил о паузе.",
                           "keywords": ["минут", "подождите"]})
    v2["sections"][2]["criteria"].append("C9")
    saved = client.post("/checklists", json=v2)
    assert saved.status_code == 201
    new_id = saved.json()["id"]
    assert new_id != "cqa-default-v1" and saved.json()["version"] > 1
    job = client.post("/evaluate/batch", json={"group_id": "QA", "checklist_id": new_id, "background": False}).json()
    assert job["failed"] == 0 and job["done"] == len(old)
    new = client.get("/results", params={"checklist_id": new_id}).json()["items"]
    assert len(new) == len(old)
    r = client.get(f"/results/{new[0]['conversation_id']}", params={"checklist_id": new_id}).json()
    assert r["checklist_version"] == saved.json()["version"] and any(c["id"] == "C9" for c in r["criteria"])
    # старые оценки не потеряны
    still = {r["conversation_id"]: r["overall"] for r in client.get("/results", params={"checklist_id": "cqa-default-v1"}).json()["items"]}
    assert still == old
    assert any(c["id"] == new_id for c in client.get("/checklists").json()["items"])


def test_errors_are_clear_messages(client):
    r = client.post("/ingest", params={"group_id": "WRONG"})
    assert r.status_code == 502 and "group_id" in r.json()["detail"]
    r = client.post("/evaluate", json={"transcript": []})
    assert r.status_code == 422 and "conversation_id or transcript" in r.text
    r = client.post("/evaluate", json={"conversation_id": "nope"})
    assert r.status_code == 404 and "ingest" in r.json()["detail"]
    r = client.get("/conversations/t-ru-happy/audio")
    assert r.status_code == 404 and "chat" in r.json()["detail"]
