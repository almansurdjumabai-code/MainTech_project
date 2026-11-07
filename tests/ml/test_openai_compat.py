"""OpenAI-совместимый провайдер (Gemini и др.) на подменённом HTTP: без сети и без ключа."""
import json
from pathlib import Path

import httpx
import pytest

from backend.app import config
from ml import judges
from ml.openai_compat import OpenAICompatJudge, parse_json
from ml.pipeline import evaluate_conversation
from ml.retriever import build_ctx, retrieve

ROOT = Path(__file__).resolve().parents[2]
CHECKLIST = json.loads((ROOT / "configs/checklists/cqa-default-v1.json").read_text(encoding="utf-8"))
CONV = json.loads((ROOT / "tests/fixtures/synthetic.json").read_text(encoding="utf-8"))["data"]["records"][0]


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(config, "OPENAI_COMPAT_MIN_INTERVAL_SEC", 0)
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 2)
    monkeypatch.setattr("ml.openai_compat.time.sleep", lambda s: None)


def answers():
    hints = retrieve(build_ctx(CONV), CHECKLIST)
    return {cid: {"answer": str(h["answer"]), "evidence_indices": [s["index"] for s in h["spans"]] or [0],
                  "expected_index": -1, "na_reason": h.get("na_reason") or "", "explanation": "ok", "confidence": "high"}
            for cid, h in hints.items()}


def server(script):
    """script(request, body, n) -> httpx.Response; n — номер вызова."""
    calls = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        calls.append(body)
        return script(request, body, len(calls))
    return httpx.MockTransport(handler), calls


def crit_of(body):
    text = body["messages"][1]["content"]
    if "Assess EACH" in text:
        return None
    return text.split("Criterion ", 1)[1].split(":", 1)[0]


def ok_reply(body, wrap=False):
    ans = answers()
    cid = crit_of(body)
    payload = {k: ans[k] for k in ans} if cid is None else ans[cid]
    text = json.dumps(payload, ensure_ascii=False)
    if wrap:
        text = f"```json\n{text}\n```"
    return httpx.Response(200, json={"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1000, "completion_tokens": 100,
                                               "prompt_tokens_details": {"cached_tokens": 200}}})


def judge(transport):
    return OpenAICompatJudge(model="gemini-test", base_url="https://example.test/v1beta/openai", api_key="k", transport=transport)


def test_happy_path_free_cost_and_fenced_json():
    t, calls = server(lambda r, b, n: ok_reply(b, wrap=True))
    res = evaluate_conversation(CONV, CHECKLIST, judge(t))
    assert len(calls) == 8 and all(c["response_format"]["type"] == "json_schema" for c in calls)
    assert calls[0]["temperature"] == 0 and calls[0]["messages"][0]["role"] == "system"
    assert "<transcript>" in calls[0]["messages"][1]["content"]  # та же защита от инъекций
    assert all(c["source"] == "llm" for c in res["criteria"])
    p = res["pipeline"]
    assert p["judge"] == "openai_compat" and p["model"] == "gemini-test"
    assert p["input_tokens"] == 8 * 800 and p["cache_read_tokens"] == 8 * 200 and p["cost_usd"] == 0  # бесплатный тариф
    assert res["agreement_rate"] == 1.0  # review-сигналы работают и для этого провайдера


def test_schema_rejected_switches_to_json_object():
    def script(r, b, n):
        if b["response_format"]["type"] == "json_schema":
            return httpx.Response(400, json={"error": {"message": "additionalProperties not supported"}})
        return ok_reply(b)
    t, calls = server(script)
    j = judge(t)
    res = evaluate_conversation(CONV, CHECKLIST, j)
    assert j.json_mode == "json_object" and all(c["source"] == "llm" for c in res["criteria"])


def test_rate_limit_is_retried():
    def script(r, b, n):
        return httpx.Response(429, headers={"retry-after": "0"}) if n == 1 else ok_reply(b)
    t, calls = server(script)
    ctx = build_ctx(CONV)
    hints = retrieve(ctx, CHECKLIST)
    out = judge(t).judge(ctx, CHECKLIST["criteria"][0], hints["C1"], judges.Usage())
    assert out["source"] == "llm" and len(calls) == 2


def test_vote_majority_median_and_confidence():
    from ml.judges import vote
    a = lambda ans, conf="high": {"answer": ans, "confidence": conf, "explanation": str(ans)}  # noqa: E731
    assert vote([a("YES"), a("YES"), a("YES")])["confidence"] == "high"
    two = vote([a("NO"), a("YES"), a("YES")])
    assert two["answer"] == "YES" and two["confidence"] == "medium" and two["votes"] == ["NO", "YES", "YES"]
    split = vote([a(20), a(5), a(10)])
    assert split["answer"] == 10 and split["confidence"] == "low"  # шкала без большинства — медиана, на проверку
    assert vote([a("NA"), a("NO"), a("YES")])["confidence"] == "low"
    assert vote([None, a("NO")])["answer"] == "NO"  # неудачное прочтение не мешает


def test_single_call_voting_uses_majority(monkeypatch):
    monkeypatch.setattr(config, "LLM_STRATEGY", "single_call")
    monkeypatch.setattr(config, "LLM_VOTES", 3)
    ans = answers()
    flip = {"C1": {**ans["C1"], "answer": "NO" if ans["C1"]["answer"] == "YES" else "YES"}}

    def reply(r, body, n):
        payload = {**ans, **(flip if n == 2 else {})}  # второе прочтение не согласно по C1
        if n == 3:
            return httpx.Response(503)  # третье прочтение упало: голосуем по двум оставшимся
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload)}, "finish_reason": "stop"}], "usage": {}})
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 0)
    t, calls = server(reply)
    res = evaluate_conversation(CONV, CHECKLIST, judge(t))
    c1 = next(c for c in res["criteria"] if c["id"] == "C1")
    assert len(calls) == 3 and c1["source"] == "llm"
    assert c1["llm_votes"] is not None and len(c1["llm_votes"]) == 2
    assert c1["answer"] == ans["C1"]["answer"]  # при ничьей 1:1 — первое прочтение, уверенность low
    assert c1["llm_confidence"] == "low" and c1["needs_review"]


DAILY_429 = {"error": {"code": 429, "message": "You exceeded your current quota", "details": [
    {"violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}


@pytest.fixture
def fresh_quota(monkeypatch):
    import ml.openai_compat as oc
    monkeypatch.setattr(oc, "_quota_exhausted", {})
    return oc


def test_daily_quota_falls_back_to_rules_immediately(fresh_quota, monkeypatch):
    slept = []
    monkeypatch.setattr("ml.openai_compat.time.sleep", lambda s: slept.append(s))
    monkeypatch.setattr(config, "OPENAI_COMPAT_FALLBACK_MODEL", "")
    t, calls = server(lambda r, b, n: httpx.Response(429, json=DAILY_429))
    res = evaluate_conversation(CONV, CHECKLIST, OpenAICompatJudge(base_url="https://example.test/v1", api_key="k", transport=t))
    assert slept == [] and all(c["source"] == "rules-fallback" for c in res["criteria"])  # без минут ожидания на сцене
    assert any("daily quota" in e for e in res["pipeline"]["errors"])


def test_daily_quota_switches_to_fallback_model_and_remembers(fresh_quota, monkeypatch):
    monkeypatch.setattr(config, "LLM_STRATEGY", "single_call")
    monkeypatch.setattr(config, "OPENAI_COMPAT_MODEL", "gemini-lite")
    monkeypatch.setattr(config, "OPENAI_COMPAT_FALLBACK_MODEL", "gemini-backup")

    def reply(r, body, n):
        return httpx.Response(429, json=DAILY_429) if body["model"] == "gemini-lite" else ok_reply(body)
    t, calls = server(reply)
    j = OpenAICompatJudge(base_url="https://example.test/v1", api_key="k", transport=t)
    res = evaluate_conversation(CONV, CHECKLIST, j)
    assert [c["model"] for c in calls] == ["gemini-lite", "gemini-backup"]
    assert all(c["source"] == "llm" for c in res["criteria"]) and res["pipeline"]["model"] == "gemini-backup"
    # следующий судья в этом процессе сразу берёт запасную модель
    assert OpenAICompatJudge(base_url="https://example.test/v1", api_key="k", transport=t).model == "gemini-backup"


def test_provider_content_filter_falls_back_with_readable_reason():
    # Gemini: finish_reason="content_filter: PROHIBITED_CONTENT" без message (встречается на диалогах с грубыми нарушениями)
    t, calls = server(lambda r, b, n: httpx.Response(200, json={"choices": [
        {"index": 0, "finish_reason": "content_filter: PROHIBITED_CONTENT"}], "usage": {}}))
    res = evaluate_conversation(CONV, CHECKLIST, judge(t))
    assert all(c["source"] == "rules-fallback" for c in res["criteria"])
    assert res["review_required"] and any("PROHIBITED_CONTENT" in e for e in res["pipeline"]["errors"])


def test_persistent_server_error_falls_back_to_rules():
    t, calls = server(lambda r, b, n: httpx.Response(503))
    res = evaluate_conversation(CONV, CHECKLIST, judge(t))
    assert all(c["source"] == "rules-fallback" for c in res["criteria"])
    assert res["overall"] is not None and res["review_required"]


def test_single_call_one_request(monkeypatch):
    monkeypatch.setattr(config, "LLM_STRATEGY", "single_call")
    t, calls = server(lambda r, b, n: ok_reply(b))
    res = evaluate_conversation(CONV, CHECKLIST, judge(t))
    assert len(calls) == 1 and res["pipeline"]["llm_calls"] == 1


def test_provider_selection(monkeypatch):
    monkeypatch.setattr(config, "LLM_PROVIDER", "auto")
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(config, "OPENAI_COMPAT_API_KEY", "")
    monkeypatch.setattr(config, "OPENAI_COMPAT_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
    assert judges.make_judge().name == "rules"
    monkeypatch.setattr(config, "OPENAI_COMPAT_API_KEY", "free-key")
    assert judges.make_judge().name == "openai_compat"
    monkeypatch.setattr(config, "OPENAI_COMPAT_API_KEY", "")
    monkeypatch.setattr(config, "OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1")  # Ollama без ключа
    assert judges.make_judge("openai_compat").name == "openai_compat"


def test_parse_json_tolerates_wrapping():
    assert parse_json('Вот ответ:\n```json\n{"answer": "YES"}\n```') == {"answer": "YES"}
    with pytest.raises(ValueError):
        parse_json("[1, 2]")


def test_voting_stops_after_switch_to_slow_fallback(fresh_quota, monkeypatch):
    monkeypatch.setattr(config, "LLM_STRATEGY", "single_call")
    monkeypatch.setattr(config, "LLM_VOTES", 3)
    monkeypatch.setattr(config, "OPENAI_COMPAT_MODEL", "gemini-lite")
    monkeypatch.setattr(config, "OPENAI_COMPAT_FALLBACK_MODEL", "gemini-backup")
    t, calls = server(lambda r, b, n: httpx.Response(429, json=DAILY_429) if b["model"] == "gemini-lite" else ok_reply(b))
    res = evaluate_conversation(CONV, CHECKLIST, OpenAICompatJudge(base_url="https://example.test/v1", api_key="k", transport=t))
    assert [c["model"] for c in calls] == ["gemini-lite", "gemini-backup"]  # одно прочтение на запасной модели
    assert all(c["source"] == "llm" for c in res["criteria"])


def test_fallback_chain_skips_exhausted_models(fresh_quota, monkeypatch):
    monkeypatch.setattr(config, "LLM_STRATEGY", "single_call")
    monkeypatch.setattr(config, "OPENAI_COMPAT_MODEL", "gemini-lite")
    monkeypatch.setattr(config, "OPENAI_COMPAT_FALLBACK_MODEL", "gemma-big, gemini-flash")
    exhausted = {"gemini-lite", "gemma-big"}
    t, calls = server(lambda r, b, n: httpx.Response(429, json=DAILY_429) if b["model"] in exhausted else ok_reply(b))
    res = evaluate_conversation(CONV, CHECKLIST, OpenAICompatJudge(base_url="https://example.test/v1", api_key="k", transport=t))
    assert [c["model"] for c in calls] == ["gemini-lite", "gemma-big", "gemini-flash"]
    assert res["pipeline"]["model"] == "gemini-flash" and all(c["source"] == "llm" for c in res["criteria"])
