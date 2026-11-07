"""LLM-судья без сети: подменяем Anthropic-клиент фейком и проверяем контракт, кэш-префикс, стоимость и fallback."""
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from ml import judges
from ml.judges import ClaudeJudge, Usage
from ml.pipeline import evaluate_conversation
from ml.retriever import build_ctx, retrieve

ROOT = Path(__file__).resolve().parents[1]
CHECKLIST = json.loads((ROOT / "configs/checklists/cqa-default-v1.json").read_text(encoding="utf-8"))
CONV = json.loads((ROOT / "tests/fixtures/synthetic.json").read_text(encoding="utf-8"))["data"]["records"][3]  # t-ru-missed


class FakeMessages:
    def __init__(self, answers, fail_on=(), refuse_on=()):
        self.answers, self.fail_on, self.refuse_on = answers, set(fail_on), set(refuse_on)
        self.calls = []
        self.lock = threading.Lock()

    def create(self, **kw):
        with self.lock:
            self.calls.append(kw)
        task = kw["messages"][0]["content"][1]["text"]
        cid = task.split(":", 1)[0].replace("Criterion ", "").strip()
        if cid in self.fail_on:
            raise RuntimeError("boom")
        usage = SimpleNamespace(input_tokens=100, output_tokens=50, cache_creation_input_tokens=0, cache_read_input_tokens=900)
        if cid in self.refuse_on:
            return SimpleNamespace(stop_reason="refusal", content=[], usage=usage)
        text = json.dumps(self.answers[cid], ensure_ascii=False)
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=text)], usage=usage)


def make_judge(monkeypatch, answers, model="claude-haiku-5-5", **kw):
    fake = FakeMessages(answers, **kw)
    j = ClaudeJudge.__new__(ClaudeJudge)
    import anthropic

    j.anthropic = anthropic
    j.client = SimpleNamespace(messages=fake, beta=SimpleNamespace(messages=fake))
    j.model = model
    j.system = (ROOT / "prompts/judge_system.md").read_text(encoding="utf-8")
    j.fallback = judges.RuleJudge()
    return j, fake


ANSWERS = {
    "C1": {"answer": "NO", "evidence_indices": [1], "expected_index": 1, "na_reason": "", "explanation": "Установление контакта — Нет."},
    "C2": {"answer": "NA", "evidence_indices": [0], "expected_index": -1, "na_reason": "", "explanation": "Выявление потребности — N/A."},
    "C3": {"answer": "NO", "evidence_indices": [1, 99], "expected_index": 1, "na_reason": "", "explanation": "Идентификация — Нет."},
    "C4": {"answer": "20", "evidence_indices": [3], "expected_index": -1, "na_reason": "", "explanation": "Консультация — 20."},
    "C5": {"answer": "NO", "evidence_indices": [0, 1], "expected_index": 1, "na_reason": "", "explanation": "Эмпатия — Нет."},
    "C6": {"answer": "10", "evidence_indices": [3], "expected_index": -1, "na_reason": "", "explanation": "Управление — 10."},
    "C7": {"answer": "NO", "evidence_indices": [3], "expected_index": 3, "na_reason": "", "explanation": "Завершение — Нет."},
    "C8": {"answer": "NO", "evidence_indices": [], "expected_index": -1, "na_reason": "", "explanation": "Грубые ошибки — Нет."},
}


def test_llm_path_contract_and_cost(monkeypatch):
    monkeypatch.setattr(judges.config, "LLM_PRICE_IN", 1.0)
    monkeypatch.setattr(judges.config, "LLM_PRICE_OUT", 2.0)
    monkeypatch.setattr(judges.config, "LLM_PRICE_CACHE_READ", 0.1)
    j, fake = make_judge(monkeypatch, ANSWERS)
    res = evaluate_conversation(CONV, CHECKLIST, j)
    assert len(fake.calls) == 8  # один вызов на критерий
    crit = {c["id"]: c for c in res["criteria"]}
    assert crit["C1"]["source"] == "llm" and crit["C1"]["evidence"]["index"] == 1
    assert [e["index"] for e in crit["C3"]["evidence_all"]] == [1]  # несуществующий индекс 99 отброшен
    assert crit["C2"]["na"] is True and crit["C2"]["na_reason"]  # consistency подставила условие N/A
    assert crit["C4"]["raw_score"] == 20
    # итог посчитал aggregator, не модель
    applicable = 100 - 15
    assert res["overall"] == round((20 + 15) * 100 / applicable, 2)
    p = res["pipeline"]
    assert p["llm_calls"] == 8 and p["cache_read_tokens"] == 8 * 900
    assert p["cost_usd"] == round((8 * 100 * 1.0 + 8 * 900 * 0.1 + 8 * 50 * 2.0) / 1e6, 6)


def test_prompt_prefix_is_shared_for_caching(monkeypatch):
    j, fake = make_judge(monkeypatch, ANSWERS)
    evaluate_conversation(CONV, CHECKLIST, j)
    prefixes = {c["messages"][0]["content"][0]["text"] for c in fake.calls}
    assert len(prefixes) == 1  # одинаковый префикс (транскрипт) у всех 8 вызовов
    first = fake.calls[0]["messages"][0]["content"][0]
    assert first["cache_control"] == {"type": "ephemeral"}
    assert "Criterion" not in first["text"]
    schema = fake.calls[0]["output_config"]["format"]["schema"]
    assert schema["additionalProperties"] is False


def test_llm_error_and_refusal_fall_back_to_rules(monkeypatch):
    j, fake = make_judge(monkeypatch, ANSWERS, fail_on={"C5"}, refuse_on={"C7"})
    res = evaluate_conversation(CONV, CHECKLIST, j)
    crit = {c["id"]: c for c in res["criteria"]}
    assert crit["C5"]["source"] == "rules-fallback"
    assert crit["C7"]["source"] == "rules-fallback"
    assert res["pipeline"]["llm_fallbacks"] == 2
    assert res["overall"] is not None


def test_invalid_llm_answer_replaced_by_consistency(monkeypatch):
    bad = dict(ANSWERS)
    bad["C1"] = {**ANSWERS["C1"], "answer": "NA"}  # N/A для C1 запрещён
    j, _ = make_judge(monkeypatch, bad)
    res = evaluate_conversation(CONV, CHECKLIST, j)
    c1 = next(c for c in res["criteria"] if c["id"] == "C1")
    assert c1["answer"] in ("YES", "NO") and "consistency" in c1["source"]
    assert any("C1" in n for n in res["pipeline"]["consistency_notes"])


def test_consult_max_with_empty_consultation_is_downgraded(monkeypatch):
    conv = {"conversation_id": "x", "language": "RU", "channel": "agent chat", "transcript": [
        {"timestamp": "00:00", "speaker": "client", "text": "Почему не проходит вывод средств со счёта?"},
        {"timestamp": "00:10", "speaker": "operator", "text": "Здравствуйте!"},
    ]}
    answers = {k: dict(v, evidence_indices=[0], expected_index=-1) for k, v in ANSWERS.items()}
    answers["C4"]["answer"] = "20"
    j, _ = make_judge(monkeypatch, answers)
    res = evaluate_conversation(conv, CHECKLIST, j)
    c4 = next(c for c in res["criteria"] if c["id"] == "C4")
    assert c4["raw_score"] == 0


def test_new_criterion_prompt_built_from_checklist_fields():
    crit = {"id": "C9", "name": "Предупреждение об ожидании", "type": "scale", "scale": [0, 5, 10], "weight": 10,
            "na_allowed": True, "na_condition": "Ожидания не было.", "description": "Оператор предупредил о паузе.",
            "scale_descriptions": {"10": "Предупредил и назвал срок"}}
    block = ClaudeJudge._criterion_block(crit)
    assert "Предупреждение об ожидании" in block and "10: Предупредил и назвал срок" in block
    assert "N/A allowed only when: Ожидания не было." in block
    assert ClaudeJudge._schema(crit)["properties"]["answer"]["enum"] == ["0", "5", "10", "NA"]


def test_kz_transcript_not_translated(monkeypatch):
    kz = json.loads((ROOT / "tests/fixtures/synthetic.json").read_text(encoding="utf-8"))["data"]["records"][1]
    j, fake = make_judge(monkeypatch, {k: dict(v, evidence_indices=[2], expected_index=-1) for k, v in ANSWERS.items()})
    evaluate_conversation(kz, CHECKLIST, j)
    assert "Сәлеметсіз бе, мен Дана" in fake.calls[0]["messages"][0]["content"][0]["text"]


def test_usage_is_thread_safe():
    u = Usage()
    threads = [threading.Thread(target=lambda: [u.add(1, 1) for _ in range(1000)]) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert u.calls == 8000 and u.input_tokens == 8000


@pytest.mark.parametrize("model,beta", [("claude-opus-5-5", True), ("claude-haiku-5-5", False)])
def test_opus_uses_server_side_fallback(monkeypatch, model, beta):
    j, fake = make_judge(monkeypatch, ANSWERS, model=model)
    ctx = build_ctx(CONV)
    hints = retrieve(ctx, CHECKLIST)
    j.judge(ctx, CHECKLIST["criteria"][0], hints["C1"], Usage())
    assert ("fallbacks" in fake.calls[0]) is beta
