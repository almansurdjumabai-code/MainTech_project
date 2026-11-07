"""Слепая разметка: валидация, атомарная запись, ответы системы скрыты до разметки, совместимость с eval."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import db, labeling
from backend.app.main import app

SPLIT = json.loads(labeling.SPLIT_PATH.read_text(encoding="utf-8"))
CID = SPLIT["conversation_ids"][0]
CONV = {"conversation_id": CID, "channel": "agent chat", "language": "RU", "audio_url": None, "transcript": [
    {"timestamp": "00:00", "speaker": "client", "text": "Как пополнить счёт картой?"},
    {"timestamp": "00:10", "speaker": "operator", "text": "Здравствуйте, меня зовут Алия. Откройте «Пополнить» → «Картой». До свидания!"},
]}
GOOD = {"C1": "YES", "C2": "NA", "C3": "NA", "C4": "20", "C5": "YES", "C6": 10, "C7": None, "C8": "NO"}


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    import os
    os.environ["CQA_GOLD_HUMAN_PATH"] = str(tmp_path_factory.mktemp("gold") / "gold_human.json")
    with TestClient(app) as c:
        db.upsert_conversation(CONV, "DEV")
        c.post("/evaluate", json={"conversation_id": CID, "checklist_id": SPLIT["checklist_id"]})
        yield c
    os.environ.pop("CQA_GOLD_HUMAN_PATH")


def test_split_is_fixed_and_excludes_gold():
    gold = json.loads((labeling.config.ROOT / "eval/gold_dev.json").read_text(encoding="utf-8"))
    assert not set(SPLIT["conversation_ids"]) & set(gold["labels"])
    assert len(SPLIT["conversation_ids"]) == len(set(SPLIT["conversation_ids"])) == 18


def test_system_answers_hidden_until_labeled(client):
    assert client.get(f"/labeling/compare/{CID}").status_code == 409


def test_label_validation(client):
    assert client.put(f"/labeling/labels/{CID}", json={"labels": {"C1": "YES"}, "labeler": "qa"}).status_code == 422
    assert client.put(f"/labeling/labels/{CID}", json={"labels": {**GOOD, "C1": "NA"}, "labeler": "qa"}).status_code == 422
    assert client.put("/labeling/labels/p1-ru-001", json={"labels": GOOD, "labeler": "qa"}).status_code == 400  # не из сплита


def test_save_then_compare_and_eval_format(client):
    r = client.put(f"/labeling/labels/{CID}", json={"labels": GOOD, "labeler": "qa", "notes": "ok"})
    assert r.status_code == 200 and r.json()["labels"]["C4"] == 20 and r.json()["labels"]["C7"] is None
    split = client.get("/labeling/split").json()
    assert split["labeled"] == 1
    cmp = client.get(f"/labeling/compare/{CID}").json()
    assert cmp["has_result"] and len(cmp["rows"]) == 8
    c1 = next(x for x in cmp["rows"] if x["id"] == "C1")
    assert c1["human"] == "YES" and c1["match"] is (c1["system"] == "YES")
    gold = json.loads(Path(labeling.gold_path()).read_text(encoding="utf-8"))
    assert gold["labels"][CID]["C1"] == "YES" and gold["meta"][CID]["labeler"] == "qa"
    assert set(gold) >= {"checklist_id", "group_id", "labeled_by", "labels"}  # формат eval/run_eval.py --gold


def test_labeler_page_served(client):
    r = client.get("/labeler/")
    assert r.status_code == 200 and "CQA" in r.text and 'const API = ""' in r.text


def test_second_labeler_is_blind_and_separate(client):
    # второй разметчик не видит систему, пока сам не разметит
    assert client.get(f"/labeling/compare/{CID}", params={"labeler": "qa2"}).status_code == 409
    r = client.put(f"/labeling/labels/{CID}", json={"labels": {**GOOD, "C6": 7}, "labeler": "qa2"})
    assert r.json()["role"] == "second"
    gold = json.loads(Path(labeling.gold_path()).read_text(encoding="utf-8"))
    assert gold["labels"][CID]["C6"] == 10 and gold["second"][CID]["labels"]["C6"] == 7  # основная не перезаписана
    assert client.get(f"/labeling/compare/{CID}", params={"labeler": "qa2"}).json()["second"]["labeler"] == "qa2"
    from eval.run_eval import human_agreement, kappa
    agr = human_agreement(gold)
    assert agr["criteria"]["C6"]["agreement"] == 0 and agr["criteria"]["C1"]["agreement"] == 1
    assert kappa([("YES", "YES"), ("NO", "NO")]) == 1.0 and kappa([("YES", "NO"), ("NO", "YES")]) == -1.0


def test_reasons_saved_per_criterion(client):
    cid = SPLIT["conversation_ids"][1]
    db.upsert_conversation({**CONV, "conversation_id": cid}, "DEV")
    client.put(f"/labeling/labels/{cid}", json={"labels": GOOD, "labeler": "qa", "reasons": {"C1": "#1 поздоровалась", "ZZ": "x"}})
    meta = json.loads(Path(labeling.gold_path()).read_text(encoding="utf-8"))["meta"][cid]
    assert meta["reasons"] == {"C1": "#1 поздоровалась"}
