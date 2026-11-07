import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import ingest as ingest_mod
from backend.app import service
from backend.app.main import app

FIXTURE = json.loads((Path(__file__).parent / "fixtures/synthetic.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def client():
    # подменяем GET организаторов синтетикой; файлы чек-листов, созданные тестом, не пишем в репо
    orig_fetch = ingest_mod.fetch_group
    ingest_mod.fetch_group = lambda group_id, base_url=None, timeout=90.0: FIXTURE["data"]
    orig_dir = service.config.CHECKLIST_DIR
    with TestClient(app) as c:
        service.config.CHECKLIST_DIR = Path(service.config.DB_PATH).parent  # seed уже загружен
        yield c
    service.config.CHECKLIST_DIR = orig_dir
    ingest_mod.fetch_group = orig_fetch


def crit(result, cid):
    return next(c for c in result["criteria"] if c["id"] == cid)


def test_health_and_ingest(client):
    assert client.get("/health").json()["judge"] == "rules"
    r = client.post("/ingest", params={"group_id": "TEST"}).json()
    assert r["ingested"] == 4
    assert r["languages"] == {"RU": 2, "KZ": 1, "EN": 1}
    items = client.get("/conversations", params={"language": "KZ"}).json()["items"]
    assert [i["conversation_id"] for i in items] == ["t-kz-na-id"]
    conv = client.get("/conversations/t-ru-happy").json()
    assert conv["transcript"][3]["index"] == 3 and conv["transcript"][3]["timestamp"] == "00:40"
    assert conv["transcript"][3]["offset_sec"] == 40


def test_ru_happy_path(client):
    res = client.post("/evaluate", json={"conversation_id": "t-ru-happy", "checklist_id": "cqa-default-v1"}).json()
    assert crit(res, "C1")["answer"] == "YES"
    assert crit(res, "C1")["evidence"]["index"] == 3
    assert crit(res, "C3")["na"] is True
    assert res["critical_error"] is False
    assert res["overall"] == 100.0
    for c in res["criteria"]:
        assert c["explanation"].startswith(c["name"])


def test_kz_identification_na(client):
    res = client.post("/evaluate", json={"conversation_id": "t-kz-na-id"}).json()
    c3 = crit(res, "C3")
    assert c3["na"] is True and c3["points"] is None
    assert "идентификац" in c3["explanation"].lower()
    assert crit(res, "C1")["answer"] == "YES"  # казахское приветствие + «мен Дана»
    assert crit(res, "C7")["answer"] == "YES"
    assert res["overall"] == 100.0


def test_critical_flag(client):
    res = client.post("/evaluate", json={"conversation_id": "t-en-critical"}).json()
    assert res["critical_error"] is True
    c8 = crit(res, "C8")
    assert c8["answer"] == "YES" and c8["points"] is None
    assert "personal number" in c8["evidence"]["text"]


def test_missed_actions_point_to_expected_place(client):
    res = client.post("/evaluate", json={"conversation_id": "t-ru-missed"}).json()
    assert crit(res, "C1")["answer"] == "NO"
    assert crit(res, "C1")["evidence"]["index"] == 1  # где ожидалось приветствие
    assert crit(res, "C3")["answer"] == "NO"  # данные счёта без идентификации
    assert crit(res, "C5")["answer"] == "NO"  # недовольство без реакции
    assert crit(res, "C7")["answer"] == "NO"
    assert "ожидалось" in crit(res, "C7")["explanation"]
    assert res["overall"] < 60


def test_appeal_and_review_recalculates_with_same_math(client):
    res = client.get("/results/t-ru-missed").json()
    rid, before = res["result_id"], res["overall"]
    a = client.post(f"/results/{rid}/appeals", json={"criterion_id": "C7", "comment": "Клиент ушёл, завершать было нечего"}).json()
    assert a["appeal"]["status"] == "open" and a["appeal"]["disputed"]["answer"] == "NO"
    assert client.get("/appeals", params={"status": "open"}).json()["items"]

    bad = client.post(f"/results/{rid}/review", json={"criterion_id": "C1", "decision": "change", "new_value": "NA", "reason": "x"})
    assert bad.status_code == 400  # N/A для C1 запрещён чек-листом

    r = client.post(f"/results/{rid}/review", json={"criterion_id": "C7", "decision": "change", "new_value": "NA",
                                                   "reason": "Чат оборвался"}).json()
    after = r["result"]
    assert after["status"] == "reviewed"
    assert after["original"]["overall"] == before
    assert crit(after, "C7")["na"] is True and crit(after, "C7")["reviewed"] is True
    # проверка: пересчёт тем же aggregator — C7 (w=5) исключён, вес перераспределён
    def applicable(r):
        return sum(c["weight"] for c in r["criteria"] if not c["na"] and c["type"] != "flag")
    assert applicable(after) == applicable(res) - 5
    earned = sum(c["weight"] * (c["raw_score"] / c["max_score"]) for c in after["criteria"] if not c["na"] and c["type"] != "flag")
    assert after["overall"] == round(earned * 100 / applicable(after), 2)
    assert r["review"]["overall_before"] == before
    assert after["overall"] == r["review"]["overall_after"]
    assert client.get("/appeals", params={"status": "open"}).json()["items"] == []

    conf = client.post(f"/results/{rid}/review", json={"criterion_id": "C4", "decision": "confirm", "reason": "Ок"}).json()
    assert conf["result"]["overall"] == after["overall"]


def test_new_checklist_version_and_batch(client):
    cl = client.get("/checklists/cqa-default-v1").json()
    # организаторы заменяют один критерий: вместо «Завершения» — «Предупреждение об ожидании»
    cl["criteria"] = [c for c in cl["criteria"] if c["id"] != "C7"] + [{
        "id": "C9", "name": "Благодарность за обращение", "section": "S3", "type": "binary", "weight": 5,
        "na_allowed": False, "description": "Да — оператор поблагодарил клиента за обращение.",
        "keywords": ["спасибо за обращение", "рада помочь", "рақмет", "thanks for contacting"],
    }]
    for s in cl["sections"]:
        s["criteria"] = ["C9" if x == "C7" else x for x in s["criteria"]]
    new = client.post("/checklists", json=cl)
    assert new.status_code == 201, new.text
    body = new.json()
    assert body["id"] == "cqa-default-v2" and body["version"] == 2
    job = client.post("/evaluate/batch", json={"group_id": "TEST", "checklist_id": "cqa-default-v2", "background": False}).json()
    assert job["status"] == "finished" and job["done"] == 4 and job["failed"] == 0
    again = client.post("/evaluate/batch", json={"group_id": "TEST", "checklist_id": "cqa-default-v2", "background": False}).json()
    assert again["skipped"] == 4  # идемпотентно
    res = client.get("/results/t-ru-happy", params={"checklist_id": "cqa-default-v2"}).json()
    assert crit(res, "C9")["answer"] == "YES"
    assert len(client.get("/results", params={"checklist_id": "cqa-default-v2"}).json()["items"]) == 4


def test_adhoc_transcript_and_invalid_checklist(client):
    res = client.post("/evaluate", json={"transcript": [
        {"timestamp": "00:00", "speaker": "client", "text": "Привет"},
    ], "language": "RU"}).json()
    assert res["conversation_id"].startswith("adhoc-")
    assert crit(res, "C4")["na"] is True  # запрос не сформулирован
    bad = client.post("/checklists", json={"name": "x", "criteria": [{"id": "A", "name": "a", "type": "scale", "scale": [5, 10], "description": "d"}]})
    assert bad.status_code == 422
