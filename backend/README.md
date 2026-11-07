# CQA backend + ML

Сервис оценки качества диалогов (Freedom Broker / CQA Hackathon): ingest набора организаторов, версионированные чек-листы,
автооценка оператора (RU / KZ / EN), объяснения с репликами-доказательствами, апелляция, решение проверяющего и пересчёт итога.

Стек: Python 3.11+ (проверено на 3.13), FastAPI, Pydantic v2, SQLite. Модель: Claude через официальный SDK `anthropic`; без ключа работает rule-based режим.

## Запуск (Windows / PowerShell, из корня репозитория)

```powershell
python -m venv backend\.venv
backend\.venv\Scripts\python -m pip install -r backend\requirements.txt
copy .env.example backend\.env      # вписать DATASET_URL (ссылка организаторов БЕЗ group_id) и, если есть, ANTHROPIC_API_KEY
backend\.venv\Scripts\python -m uvicorn backend.app.main:app --reload --port 8000
```

Swagger: http://127.0.0.1:8000/docs

Первичная загрузка и оценка:

```powershell
curl.exe -X POST "http://127.0.0.1:8000/ingest?group_id=DEV"
curl.exe -X POST http://127.0.0.1:8000/evaluate/batch -H "Content-Type: application/json" -d "{\"group_id\":\"DEV\",\"checklist_id\":\"cqa-default-v1\"}"
```

Контрольный набор (t+23h): то же самое с новым `group_id`, код не меняется. Batch идемпотентный: повторный запуск пропускает
уже оценённые диалоги (resume после падения), `"force": true` переоценивает.

Тесты: `backend\.venv\Scripts\python -m pytest -q`

## Как фронту стучаться

База `http://127.0.0.1:8000`, CORS открыт для `localhost` / `127.0.0.1` на любом порту и для `file://`. Авторизации нет.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/health` | статус, какой судья активен (`anthropic` / `rules`) |
| POST | `/ingest?group_id=DEV` | забрать набор у организаторов (сервером, без CORS) |
| GET | `/conversations?language=KZ&channel=voice%20call&group_id=DEV` | список + последний итог по диалогу |
| GET | `/conversations/{id}` | транскрипт: `index`, исходный `timestamp`, `offset_sec` (секунды от начала — для плеера), `audio_url` |
| GET | `/checklists` | все версии (`is_latest`) |
| GET | `/checklists/{id}` | чек-лист целиком |
| POST | `/checklists` | сохранить новую версию: прислать чек-лист с тем же `family` → `cqa-default-v2` |
| POST | `/evaluate` | `{conversation_id, checklist_id}` или `{transcript:[{timestamp,speaker,text}], language}` |
| POST | `/evaluate/batch` | `{group_id, checklist_id, force?}` → `job_id`; статус `GET /evaluate/batch/{job_id}` |
| GET | `/results?group_id=&checklist_id=` | таблица результатов |
| GET | `/results/{conversation_id}?checklist_id=` | карточка результата |
| GET | `/results/by-id/{result_id}` | то же по `result_id` |
| POST | `/results/{result_id}/appeals` | `{criterion_id, comment}` |
| GET | `/appeals?status=open` | очередь проверяющего (спорная оценка + фрагмент в ответе POST) |
| POST | `/results/{result_id}/review` | `{criterion_id, decision: "confirm"\|"change", new_value, reason}` → пересчёт |

### Контракт результата (стабильный)

```jsonc
// пример формы ответа, числа иллюстративные
{
  "result_id": 12, "conversation_id": "p1-ru-005", "checklist_id": "cqa-default-v1", "checklist_version": 1,
  "language": "RU", "channel": "agent chat", "audio_url": null,
  "status": "auto | appealed | reviewed",
  "overall": 69.38, "max_overall": 100, "critical_error": false, "critical_criteria": [],
  "criteria": [{
    "id": "C7", "name": "Завершение", "section": "S3", "type": "binary",
    "answer": "NO",            // YES | NO | NA | число-ступень шкалы
    "raw_score": 0, "max_score": 1,
    "weight": 5,               // вес из чек-листа
    "effective_weight": 6.25,  // вес после перераспределения N/A
    "points": 0.0,             // null для N/A и для грубых ошибок
    "na": false, "na_reason": "",
    "explanation": "Завершение — Нет. … Основание — ожидалось: [07:16] оператор: «…»",
    "evidence": {"index": 15, "timestamp": "07:16", "speaker": "operator", "text": "…"},   // главная реплика (для пропуска — где ожидалось)
    "evidence_all": [ … ], "expected_span": { … } | null,
    "source": "llm | rules | rules-fallback | review", "reviewed": true, "original_answer": "NO"
  }],
  "sections": [{"id": "S1", "name": "…", "points": 25.0, "max_points": 31.25, "percent": 80.0}],
  "original": { "criteria": […], "sections": […], "overall": …, "critical_error": … },  // автооценка, не меняется
  "final":    { … },                                                                      // после решений проверяющего
  "appeals": [ … ], "reviews": [{"criterion_id": "C7", "decision": "change", "old_value": "NO", "new_value": "NA", "reason": "…", "overall_before": 69.38, "overall_after": 72.67}],
  "pipeline": {"judge": "anthropic", "model": "claude-opus-5-5", "llm_calls": 8, "input_tokens": …, "output_tokens": …, "cost_usd": …, "consistency_notes": []}
}
```

Ссылка из обоснования на реплику: `evidence.index` = индекс в `GET /conversations/{id}` → `transcript[index]`;
для звонка позиция в записи — `transcript[index].offset_sec`.

## Как устроена оценка

Не один промпт на 8 критериев, а 4 прохода:

1. **Retriever** (`ml/retriever.py`): правила на RU/KZ/EN находят 1–3 реплики-кандидата на критерий и место, где ожидалось пропущенное действие.
2. **Judge** (`ml/judges.py`): отдельный вызов модели на каждый критерий, structured JSON (`answer`, `evidence_indices`, `expected_index`, `na_reason`, `explanation`). Без итога. Промпт собирается из полей критерия в JSON чек-листа, поэтому новый критерий не требует правки кода. KZ не переводится, модель судит по оригиналу; объяснение для жюри пишется на русском.
3. **Consistency** (`ml/consistency.py`): ответ вне шкалы или запрещённый N/A заменяется ответом правил; при пустой консультации C4 не может получить максимум; evidence обязателен.
4. **Aggregator** (`scoring/aggregator.py`): только математика из PDF. Шкала → `weight * step / max_step`, N/A исключаются и их вес перераспределяется (максимум 100), округление 2 знака half-up, нет применимых → `overall = null`, грубые ошибки отдельно. Решение проверяющего пересчитывается этой же функцией.

Нет ключа или модель ответила ошибкой → rule-based судья по этому критерию, JSON того же формата, демо не падает.

## Модель и стоимость

| Модель (`LLM_MODEL`) | Цена, $ / 1M токенов (вход / выход) | Одна полная оценка (8 вызовов) |
|---|---|---|
| `claude-opus-5-5` (по умолчанию) | 4 / 20 | ≈ $0.10 (средний DEV-диалог), до ≈ $0.25 для длинного звонка |
| `claude-haiku-5-5` | 0.10 / 0.50 | ≈ $0.003 |
| rule-based (`LLM_PROVIDER=rules`) | 0 | 0 |

Оценка по замеру промптов на DEV: в среднем ≈ 30 тыс. символов входа на 8 вызовов (≈ 10 тыс. токенов),
выход ≈ 3 тыс. токенов вместе с размышлением при `LLM_EFFORT=low`. Весь DEV (65 диалогов) на Opus 5.5 обойдётся примерно в $6–7.
Фактическая стоимость каждой оценки считается по `usage` из ответа API и пишется в `pipeline.cost_usd` (цены задаются в `LLM_PRICE_IN` / `LLM_PRICE_OUT`).

## Чек-лист

`configs/checklists/cqa-default-v1.json` — начальная конфигурация из PDF организаторов, схема — `checklist.schema.json`.
Типы критериев: `binary` (Да/Нет), `scale` (ступени, верхняя = полный вес), `flag` (грубая ошибка без баллов).
Для нового критерия достаточно `description` (+ `na_condition`, если разрешён N/A). Поле `keywords` даёт rule-based режиму подсказку,
как оценивать новый критерий без LLM.

## Что осталось (TODO(hackathon))

- Лексиконы rule-based режима собраны по DEV; на контрольном наборе основной путь — LLM.
- Batch-задачи хранятся в памяти: после рестарта статус `job_id` теряется, но результаты лежат в БД, и повторный batch досчитывает только оставшееся.
- UI (HTML/CSS/JS, Dynamics 365) делает другая часть команды.
