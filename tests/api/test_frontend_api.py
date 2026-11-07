"""Совместимость с фронтендом: /api/* по frontend/docs/API_CONTRACT.md (весь сценарий UI без браузера)."""
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import ingest as ingest_mod
from backend.app import service
from backend.app.ingest import IngestError
from backend.app.main import app

FIXTURE = json.loads((Path(__file__).parents[1] / "fixtures/synthetic.json").read_text(encoding="utf-8"))
IDS = [r["conversation_id"] for r in FIXTURE["data"]["records"]]
ANSWERS = {"yes", "no", "na"}


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
        yield c
    service.config.CHECKLIST_DIR = orig_dir
    ingest_mod.fetch_group = orig


def wait_job(client, job_id):
    for _ in range(200):
        job = client.get(f"/api/evaluations/jobs/{job_id}").json()
        if job["status"] == "done":
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def scoring_like_frontend(checklist, answers):
    """Копия правил js/core/scoring.js: N/A исключается, шкала value/max*weight, flag без баллов."""
    pts = w = 0.0
    for c in checklist["criteria"]:
        a = answers[c["id"]]
        if c["type"] == "flag" or (a == "na" and c["allowNA"]):
            continue
        w += c["weight"]
        if c["type"] == "scale":
            pts += (a if isinstance(a, (int, float)) else 0) / max(s["value"] for s in c["scale"]) * c["weight"]
        else:
            pts += c["weight"] if a == "yes" else 0
    return None if w == 0 else round(pts / w * 100 + 1e-9, 2)


def test_health_and_root_serves_ui(client):
    assert client.get("/api/health").json()["ok"] is True
    r = client.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"].startswith("/app/?mock=0&api=")
    page = client.get("/app/")
    assert page.status_code == 200 and "js/app.js" in page.text
    js = client.get("/app/js/app.js")
    assert js.headers["content-type"].startswith("text/javascript")
    assert js.headers["cache-control"] == "no-cache"  # после обновления браузер не держит старые модули


def test_dataset_loads_and_unknown_group_is_404(client):
    r = client.get("/api/datasets/QA").json()
    assert r["isSuccess"] is True and len(r["data"]["records"]) == len(IDS)
    bad = client.get("/api/datasets/NOPE")
    assert bad.status_code == 404 and "NOPE" in bad.json()["detail"]


def test_checklist_shape_and_scoring_matches_frontend_rules(client):
    cls = client.get("/api/checklists").json()
    active = [c for c in cls if c["active"]]
    assert len(active) == 1
    cl = active[0]
    assert {"id", "version", "name", "createdAt", "sections", "criteria"} <= set(cl)
    for c in cl["criteria"]:
        assert {"id", "title", "description", "section", "weight", "type", "allowNA", "naCondition", "scale", "aiGuidance"} <= set(c)
        assert c["section"] in cl["sections"]

    job = client.post("/api/evaluations", json={"conversationIds": IDS + ["missing-id"], "checklistId": cl["id"],
                                                "model": "rule-based-v1"}).json()
    job = wait_job(client, job["jobId"])
    assert job["done"] == len(IDS) and job["failed"] == 1
    err = next(i for i in job["items"] if i["conversationId"] == "missing-id")
    assert err["status"] == "error" and err["error"]  # понятный текст для человека

    for it in job["items"]:
        if it["status"] != "done":
            continue
        ev = client.get(f"/api/evaluations/{it['evaluationId']}").json()
        answers = {c["criterionId"]: c["answer"] for c in ev["criteria"]}
        for a in answers.values():
            assert a in ANSWERS or isinstance(a, int)
        # фронт пересчитывает итог сам — расхождения быть не должно
        assert ev["total"] == scoring_like_frontend(cl, answers), ev["conversationId"]
        conv = client.get(f"/api/conversations/{ev['conversationId']}").json()["conversation"]
        for c in ev["criteria"]:
            for e in c["evidence"]:
                assert e["quote"] in conv["transcript"][e["messageIndex"]]["text"]  # quote — точная подстрока реплики
            if c["answer"] == "na":
                assert c["naReason"]


def test_list_and_history(client):
    items = client.get("/api/conversations").json()
    row = next(i for i in items if i["conversation_id"] == IDS[0])
    assert row["messages"] > 0 and row["evaluation"] and "rawModelOutput" not in row["evaluation"]
    assert client.get(f"/api/conversations/{IDS[0]}").json()["evaluation"]["rawModelOutput"]
    assert len(client.get(f"/api/conversations/{IDS[0]}/evaluations").json()) >= 1
    assert client.get("/api/conversations/nope").status_code == 404


def test_appeal_take_change_recalculates_and_survives_reload(client):
    ev = client.get(f"/api/conversations/{IDS[0]}").json()["evaluation"]
    target = next(c for c in ev["criteria"] if c["answer"] in ("yes", "no") and c["criterionId"] != "C8")
    body = {"evaluationId": ev["evaluationId"], "criterionId": target["criterionId"], "comment": "Не согласен"}
    ap = client.post("/api/appeals", json=body).json()
    assert ap["status"] == "submitted" and ap["originalAnswer"] == target["answer"]
    assert client.post("/api/appeals", json=body).status_code == 409
    assert client.post(f"/api/appeals/{ap['id']}/take").json()["status"] == "in_review"
    assert client.post(f"/api/appeals/{ap['id']}/decision", json={"action": "change", "newValue": "no", "reason": ""}).status_code == 400

    new = "no" if target["answer"] == "yes" else "yes"
    out = client.post(f"/api/appeals/{ap['id']}/decision", json={"action": "change", "newValue": new, "reason": "По записи"}).json()
    ev2 = out["evaluation"]
    assert out["appeal"]["status"] == "changed" and out["appeal"]["decision"]["totalBefore"] == ev["total"]
    assert ev2["originalTotal"] == ev["originalTotal"] and ev2["total"] == out["appeal"]["decision"]["totalAfter"]
    assert ev2["overrides"][target["criterionId"]]["answer"] == new
    assert ev2["total"] != ev["total"]
    assert {a["action"] for a in ev2["audit"]} >= {"evaluated", "appeal", "changed"}
    assert client.post(f"/api/appeals/{ap['id']}/decision", json={"action": "confirm", "reason": "x"}).status_code == 409
    # «перезагрузка»: всё читается из БД
    again = client.get(f"/api/evaluations/{ev['evaluationId']}").json()
    assert again["total"] == ev2["total"] and again["overrides"]
    assert any(a["id"] == ap["id"] and a["status"] == "changed" for a in client.get("/api/appeals?status=changed").json())


def test_ai_review_without_llm_is_honest(client):
    ev = client.get(f"/api/conversations/{IDS[1]}").json()["evaluation"]
    ap = client.post("/api/appeals", json={"evaluationId": ev["evaluationId"], "criterionId": "C1", "comment": "Поздоровался"}).json()
    r = client.post(f"/api/appeals/{ap['id']}/ai-review").json()
    assert r["model"] == "rule-based-v1" and "LLM недоступна" in r["explanation"]
    listed = client.get("/api/appeals").json()
    assert listed[0]["id"] == ap["id"] and listed[0]["aiReview"]  # новые первыми, второе мнение сохранено


def test_new_checklist_version_activate_and_rescore(client):
    base = next(c for c in client.get("/api/checklists").json() if c["active"])
    draft = json.loads(json.dumps(base))
    for k in ("id", "version", "createdAt", "active"):
        draft.pop(k)
    c1 = next(c for c in draft["criteria"] if c["id"] == "C1")
    c1["weight"] = 20
    c1["aiGuidance"] = "Приветствие и имя в первом ответе"
    draft["criteria"].append({"id": "C9", "title": "Предложил приложение", "description": "Оператор рекомендовал мобильное приложение",
                              "section": draft["sections"][0], "weight": 5, "type": "binary", "allowNA": False,
                              "naCondition": "", "scale": [], "aiGuidance": ""})
    saved = client.post("/api/checklists", json=draft).json()
    assert saved["version"] == base["version"] + 1 and saved["active"] is False
    assert client.put(f"/api/checklists/{saved['id']}/activate").json()["active"] is True
    assert [c["id"] for c in client.get("/api/checklists").json() if c["active"]] == [saved["id"]]
    job = wait_job(client, client.post("/api/evaluations", json={"conversationIds": IDS[:2], "model": "rule-based-v1"}).json()["jobId"])
    ev = client.get(f"/api/evaluations/{job['items'][0]['evaluationId']}").json()
    assert ev["checklistId"] == saved["id"] and any(c["criterionId"] == "C9" for c in ev["criteria"])
    # старая версия цела: обе оценки в истории
    hist = client.get(f"/api/conversations/{IDS[0]}/evaluations").json()
    assert {h["checklistId"] for h in hist} >= {base["id"], saved["id"]}
    bad = client.post("/api/checklists", json={**draft, "criteria": []})
    assert bad.status_code == 400 and isinstance(bad.json()["detail"], str)


def test_models_and_import(client):
    models = client.get("/api/models").json()
    assert any(m["id"] == "rule-based-v1" and m["costUsd"] == 0 for m in models)
    rec = {"conversation_id": "imp-1", "transcript": [{"timestamp": "00:00", "speaker": "client", "text": "Привет, как открыть счёт?"}]}
    assert client.post("/api/conversations/import", json={"records": [rec]}).json() == {"imported": 1, "ids": ["imp-1"]}
    assert client.post("/api/conversations/import", json={"records": []}).status_code == 400


def test_stats_are_real_numbers_from_saved_evaluations(client):
    s = client.get("/api/stats").json()
    assert s["evaluations"] >= len(IDS) and s["aiCostUsd"] == 0 and s["llmUsed"] is False  # без ключа — правила, $0
    assert s["machineSeconds"] >= 0 and s["models"] == ["rule-based-v1"]
