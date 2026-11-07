import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app import audio, db, service
from backend.app import ingest as ingest_mod
from backend.app.main import app
from ml import batch as batch_cli

FIXTURE = json.loads((Path(__file__).parent / "fixtures/synthetic.json").read_text(encoding="utf-8"))

CALL = {
    "conversation_id": "t-call", "channel": "voice call", "language": "RU",
    "audio_url": "https://organizers.example/player?sig=SECRET",
    "transcript": [
        {"timestamp": "2026-11-03T13:10:00.6388245+00:00", "speaker": "system", "text": "Агент присоединился к разговору."},
        {"timestamp": "2026-11-03T13:10:05.1000000+00:00", "speaker": "operator", "text": "Здравствуйте, меня зовут Нурлан, чем могу помочь?"},
        {"timestamp": "2026-11-03T13:10:20.6388245+00:00", "speaker": "client", "text": "Как пополнить брокерский счёт картой?"},
        {"timestamp": "2026-11-03T13:11:00.6388245+00:00", "speaker": "operator", "text": "Откройте приложение, раздел «Пополнить», выберите «Картой». До свидания!"},
    ],
}

PLAYER_HTML = '<html><audio><source src="https://files.example/rec.mp3?sp=r&amp;se=2026-11-07T13:36:12Z&amp;sig=X" type="audio/mpeg"></audio></html>'


@pytest.fixture(scope="module")
def client():
    orig_fetch = ingest_mod.fetch_group
    ingest_mod.fetch_group = lambda group_id, base_url=None, timeout=90.0: FIXTURE["data"]
    orig_dir = service.config.CHECKLIST_DIR
    with TestClient(app) as c:
        service.config.CHECKLIST_DIR = Path(service.config.DB_PATH).parent
        c.post("/ingest", params={"group_id": "TEST"})
        db.upsert_conversation(CALL, "TEST")
        yield c
    service.config.CHECKLIST_DIR = orig_dir
    ingest_mod.fetch_group = orig_fetch


def test_call_offsets_and_evidence_offsets(client):
    conv = client.get("/conversations/t-call").json()
    assert conv["transcript"][0]["timestamp"] == CALL["transcript"][0]["timestamp"]  # исходная метка не тронута
    assert conv["transcript"][2]["offset_sec"] == 20.0
    assert conv["audio_stream_url"] == "/conversations/t-call/audio/stream"
    res = client.post("/evaluate", json={"conversation_id": "t-call"}).json()
    c1 = next(c for c in res["criteria"] if c["id"] == "C1")
    assert c1["answer"] == "YES" and c1["evidence"]["offset_sec"] == 4.46


def test_audio_resolves_fresh_mp3(client, monkeypatch):
    audio._CACHE.clear()
    calls = []

    def fake_get(url, timeout=30, follow_redirects=True):
        calls.append(url)
        return SimpleNamespace(status_code=200, headers={"content-type": "text/html; charset=utf-8"}, text=PLAYER_HTML)

    monkeypatch.setattr(audio.httpx, "get", fake_get)
    info = client.get("/conversations/t-call/audio").json()
    assert info["audio_src"].startswith("https://files.example/rec.mp3?sp=r&se=")  # &amp; раскодирован
    assert info["expires_at"] == "2026-11-07T13:36:12Z"
    r = client.get("/conversations/t-call/audio/stream", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == info["audio_src"]
    assert len(calls) == 1  # кэш
    assert client.get("/conversations/t-ru-happy/audio").status_code == 404  # у чата нет записи


def test_appeal_card_has_fragment_and_disputed_score(client):
    res = client.post("/evaluate", json={"conversation_id": "t-ru-missed"}).json()
    out = client.post(f"/results/{res['result_id']}/appeals", json={"criterion_id": "C3", "comment": "Оператор ничего не раскрывал"}).json()
    card = out["card"]
    assert card["criterion"]["answer"] == "NO" and card["criterion"]["name"] == "Идентификация"
    assert card["comment"] == "Оператор ничего не раскрывал"
    assert any(t["focus"] for t in card["fragment"]) and len(card["fragment"]) <= 5
    same = client.get(f"/appeals/{card['appeal_id']}").json()
    assert same["fragment"] == card["fragment"]
    queue = client.get("/appeals", params={"status": "open"}).json()["items"]
    assert any(a["appeal_id"] == card["appeal_id"] for a in queue)
    # переоценка заменяет результат -> старая апелляция superseded
    client.post("/evaluate", json={"conversation_id": "t-ru-missed", "force": True})
    assert client.get(f"/appeals/{card['appeal_id']}").json()["status"] == "superseded"


def test_stats_and_csv(client):
    client.post("/evaluate/batch", json={"group_id": "TEST", "checklist_id": "cqa-default-v1", "background": False, "force": True})
    s = client.get("/stats", params={"group_id": "TEST", "checklist_id": "cqa-default-v1"}).json()
    assert s["conversations"] == 5 and s["evaluated"] == 5
    assert s["critical_errors"] == 1
    assert {c["id"] for c in s["criteria"]} >= {"C1", "C8"}
    r = client.get("/results/export.csv", params={"group_id": "TEST", "checklist_id": "cqa-default-v1"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    lines = r.content.decode("utf-8-sig").strip().splitlines()
    assert lines[0].startswith("result_id,conversation_id") and len(lines) == 6


def test_batch_job_is_persisted(client):
    job = client.post("/evaluate/batch", json={"group_id": "TEST", "checklist_id": "cqa-default-v1", "background": False}).json()
    assert job["skipped"] == 5
    stored = client.get(f"/evaluate/batch/{job['job_id']}").json()
    assert stored["status"] == "finished" and stored["skipped"] == 5
    assert any(j["job_id"] == job["job_id"] for j in client.get("/evaluate/batch").json()["items"])
    assert client.get("/evaluate/batch/nope").status_code == 404


def test_checklist_validate(client):
    cl = client.get("/checklists/cqa-default-v1").json()
    ok = client.post("/checklists/validate", json=cl).json()
    assert ok["valid"] and ok["weight_total"] == 100
    cl["criteria"][0]["na_allowed"] = True  # без na_condition — ошибка
    cl["criteria"][0]["na_condition"] = None
    bad = client.post("/checklists/validate", json=cl).json()
    assert bad["valid"] is False and "na_condition" in bad["errors"]


def test_cli_batch(client, capsys):
    rc = batch_cli.main(["--group-id", "TEST", "--ids", "t-ru-happy", "t-kz-na-id", "--force", "--mode", "rules"])
    out = capsys.readouterr().out
    assert rc == 0 and "done=2" in out and "[2/2]" in out


def test_duplicate_background_batch_is_deduplicated(client, monkeypatch):
    import threading as th

    gate = th.Event()
    orig = service.evaluate_one

    def slow(*a, **kw):
        gate.wait(5)  # держим первый batch «в работе»
        return orig(*a, **kw)

    monkeypatch.setattr(service, "evaluate_one", slow)
    body = {"group_id": "TEST", "checklist_id": "cqa-default-v1", "force": True}
    first = client.post("/evaluate/batch", json=body).json()
    second = client.post("/evaluate/batch", json=body).json()
    assert second["job_id"] == first["job_id"] and second["deduplicated"] is True
    gate.set()
    for t in th.enumerate():
        if t.name == f"batch-{first['job_id']}":
            t.join(10)
    done = client.get(f"/evaluate/batch/{first['job_id']}").json()
    assert done["status"] == "finished" and done["done"] == 5


def test_batch_partial_failure_keeps_other_results(client, monkeypatch):
    orig = service.evaluate_one

    def flaky(conv, *a, **kw):
        if conv["conversation_id"] == "t-kz-na-id":
            raise RuntimeError("LLM down")
        return orig(conv, *a, **kw)

    monkeypatch.setattr(service, "evaluate_one", flaky)
    job = client.post("/evaluate/batch", json={"group_id": "TEST", "checklist_id": "cqa-default-v1", "force": True,
                                               "background": False}).json()
    assert job["failed"] == 1 and job["done"] == 4 and "t-kz-na-id" in job["errors"][0]
    # сбой переоценки не стирает прежний результат этого диалога
    assert db.result_exists("t-kz-na-id", "cqa-default-v1")
    assert client.get("/results/t-kz-na-id").json()["overall"] is not None


def test_invalid_payloads_rejected(client):
    assert client.post("/evaluate", json={}).status_code == 422
    assert client.post("/evaluate", json={"conversation_id": "nope"}).status_code == 404
    assert client.post("/evaluate", json={"transcript": [{"speaker": "hacker", "text": "x"}]}).status_code == 422
    assert client.post("/results/999999/appeals", json={"criterion_id": "C1", "comment": "x"}).status_code == 404
