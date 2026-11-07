"""QA блок 4: граничные случаи по правилам чек-листа (PDF), режим без LLM (то, что работает без ключа).
Ожидания взяты из PDF, а не из поведения кода. Известные ограничения правил помечены xfail(strict=True) с причиной:
тест сам сообщит, когда ограничение исправят."""
import json
from pathlib import Path

import pytest

from ml.judges import RuleJudge
from ml.pipeline import evaluate_conversation

ROOT = Path(__file__).resolve().parents[1]
CL = json.loads((ROOT / "configs/checklists/cqa-default-v1.json").read_text(encoding="utf-8"))


def run(turns, lang="RU"):
    conv = {"conversation_id": "qa", "language": lang, "channel": "agent chat",
            "transcript": [{"timestamp": f"{i // 6:02d}:{(i * 10) % 60:02d}", "speaker": s, "text": t} for i, (s, t) in enumerate(turns)]}
    return {c["id"]: c for c in evaluate_conversation(conv, CL, RuleJudge())["criteria"]}


GREET = ("operator", "Здравствуйте! Меня зовут Алия.")
BYE = ("operator", "Могу ли я ещё чем-то помочь? Хорошего дня!")


# ---------- идентификация: N/A vs «Нет» ----------

def test_general_tariff_question_identification_na():
    c = run([("client", "Какие у вас тарифы на брокерское обслуживание?"), GREET,
             ("operator", "Тарифы описаны в разделе «Тарифы» на сайте: откройте раздел и выберите свой план."), BYE])
    assert c["C3"]["answer"] == "NA" and c["C3"]["na_reason"]


def test_account_data_without_verification_is_no():
    c = run([("client", "Почему не пришёл мой вывод средств?"), GREET,
             ("operator", "Я посмотрела: на вашем счёте вывод ещё в обработке, поступит завтра."), BYE])
    assert c["C3"]["answer"] == "NO"


def test_account_data_after_verification_is_yes():
    c = run([("client", "Почему не пришёл мой вывод средств?"), GREET,
             ("system", "Клиент успешно идентифицирован."),
             ("operator", "Я посмотрела: на вашем счёте вывод ещё в обработке, поступит завтра."), BYE])
    assert c["C3"]["answer"] == "YES"


@pytest.mark.xfail(strict=True, reason="Правила видят раскрытие данных счёта, но не защищённые действия без раскрытия "
                                       "(«отменила заявку»). Решает LLM-судья.")
def test_protected_action_without_verification_is_no():
    c = run([("client", "Отмените, пожалуйста, мою заявку на вывод."), GREET,
             ("operator", "Готово, отменила вашу заявку на вывод."), BYE])
    assert c["C3"]["answer"] == "NO"


# ---------- оборванный чат ----------

def test_chat_dropped_before_request_consult_na():
    c = run([("client", "Здравствуйте"), ("system", "Клиент покинул чат.")])
    assert c["C4"]["answer"] == "NA"


def test_chat_dropped_before_farewell_close_na():
    c = run([("client", "Как пополнить счёт картой?"), GREET,
             ("operator", "Откройте приложение, раздел «Пополнить», выберите «Картой»."),
             ("system", "Клиент покинул чат.")])
    assert c["C7"]["answer"] == "NA"


# ---------- консультация и ведение диалога раздельно ----------

@pytest.mark.xfail(strict=True, reason="Правила не разбирают два вопроса в одной реплике: неотвеченный второй вопрос "
                                       "без переспроса клиента не виден. Решает LLM-судья.")
def test_clear_but_partial_answer_high_control_partial_consult():
    c = run([("client", "Как пополнить счёт картой и какая комиссия за вывод в долларах?"), GREET,
             ("operator", "Пополнить картой: откройте приложение, раздел «Пополнить», выберите «Картой»."), BYE])
    assert c["C6"]["answer"] == 10 and c["C4"]["answer"] in (5, 10, 15)


# ---------- грубые ошибки: достаточно самого предложения ----------

@pytest.mark.parametrize("lang,turns", [
    ("RU", [("client", "Подскажите по облигациям"), GREET,
            ("operator", "Переведите деньги мне на карту, я сам вложу их выгоднее."), ("client", "Нет, спасибо.")]),
    ("RU", [("client", "Подскажите по облигациям"), GREET,
            ("operator", "Дайте ваш личный номер, вечером проконсультирую за плату в частном порядке."), ("client", "Не надо.")]),
    ("EN", [("client", "Which bonds should I buy?"), ("operator", "Hi, I'm Chris."),
            ("operator", "Send me your personal number and I'll call you for a private paid consultation."), ("client", "No thanks.")]),
    ("RU", [("client", "Почему не работает приложение?"), GREET, ("operator", "Вы что, тупой? Перезагрузите телефон.")]),
    ("EN", [("client", "What is my balance?"), ("operator", "Hello, I'm Anna."),
            ("operator", "I can't see yours, but another client's balance is 5000 USD.")]),
])
def test_critical_errors_offer_alone_is_enough(lang, turns):
    c = run(turns, lang)
    assert c["C8"]["answer"] == "YES" and c["C8"]["evidence"] is not None


def test_critical_error_kz_personal_transfer():
    c = run([("client", "Облигациялар туралы айтыңызшы"), ("operator", "Сәлеметсіз бе, мен Дана."),
             ("operator", "Ақшаны маған аударыңыз, мен өзім инвестициялаймын.")], "KZ")
    assert c["C8"]["answer"] == "YES"


# ---------- бот и система не оцениваются как оператор ----------

def test_bot_greets_first_operator_greets_later_is_yes():
    c = run([("client", "Как скачать отчёт брокера?"), ("bot", "Здравствуйте! Я AIM, AI-ассистент. Перевожу на оператора."),
             ("operator", "Здравствуйте! Меня зовут Алия. Откройте раздел «Отчёты» и выберите период."), BYE])
    assert c["C1"]["answer"] == "YES"


def test_system_and_bot_politeness_not_credited():
    c = run([("client", "Как скачать отчёт брокера?"), ("bot", "Здравствуйте! Меня зовут AIM. Хорошего дня!"),
             ("operator", "Откройте раздел «Отчёты» и выберите период."), ("system", "Спасибо за обращение! До свидания.")])
    assert c["C1"]["answer"] == "NO" and c["C7"]["answer"] == "NO"


# ---------- не штрафуем за первую реакцию, теги и вложения ----------

def test_slow_first_response_tags_attachments_not_penalized():
    conv = {"conversation_id": "qa-slow", "language": "RU", "channel": "agent chat", "transcript": [
        {"timestamp": "00:00", "speaker": "client", "text": "Как скачать отчёт брокера за прошлый месяц?"},
        {"timestamp": "00:05", "speaker": "system", "text": "Клиент прикрепил файл screenshot.png. Тег: отчёты."},
        {"timestamp": "12:30", "speaker": "operator", "text": "Здравствуйте! Меня зовут Алия. Откройте раздел «Отчёты», выберите период и нажмите «Скачать»."},
        {"timestamp": "13:00", "speaker": "operator", "text": "Могу ли я ещё чем-то помочь? Хорошего дня!"},
    ]}
    c = {x["id"]: x for x in evaluate_conversation(conv, CL, RuleJudge())["criteria"]}
    assert c["C1"]["answer"] == "YES" and c["C6"]["answer"] == 10 and c["C4"]["answer"] == 20
