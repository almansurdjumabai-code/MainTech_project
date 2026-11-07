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

То же из терминала, без запущенного сервера (та же БД):

```powershell
backend\.venv\Scripts\python -m ml.batch --group-id DEV --ingest              # загрузить и оценить
backend\.venv\Scripts\python -m ml.batch --group-id DEV --limit 3 --force     # проба на 3 диалогах (оценить стоимость)
backend\.venv\Scripts\python -m ml.batch --group-id <NEW> --ingest --checklist cqa-default-v2
```

Тесты: `backend\.venv\Scripts\python -m pytest -q` (без сети и ключа; LLM-судья проверяется на фейковом клиенте).

Качество против ручной разметки (`eval/gold_dev.json`, 10 DEV-диалогов, черновик — проверить человеком):

```powershell
backend\.venv\Scripts\python -m eval.run_eval --show-misses                   # rule-based
backend\.venv\Scripts\python -m eval.run_eval --mode anthropic                # Claude (нужен ключ)
```

Rule-based сейчас совпадает с этой разметкой на 97% (67 из 69 ответов). Это завышенная оценка: разметку делала модель (не человек),
а правила дорабатывались на этих же диалогах. На контрольном наборе основной путь — LLM-судья.

Материалы для защиты (архитектура, evaluation, стоимость, сценарии, ограничения, матрица требований): [docs/demo/](docs/demo/README.md).

Независимая разметка: http://127.0.0.1:8000/labeler/ (слепая, 18 диалогов из `eval/split_test.json` → `eval/gold_human.json`).

Живая проверка Claude API (центы): `backend\.venv\Scripts\python -m ml.live_smoke`. Сравнение режимов: `python -m eval.run_eval --modes rules,hybrid,llm_only --out backend/docs/demo/eval_results`.

План на остаток хакатона и промпт для ассистента любого участника команды: [HACKATHON_PROMPT.md](HACKATHON_PROMPT.md).

## Как фронту стучаться

База `http://127.0.0.1:8000`, CORS открыт для `localhost` / `127.0.0.1` на любом порту и для `file://`. Авторизации нет.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/health` | статус, какой судья активен (`anthropic` / `rules`) |
| POST | `/ingest?group_id=DEV` | забрать набор у организаторов (сервером, без CORS) |
| GET | `/conversations?language=KZ&channel=voice%20call&group_id=DEV` | список + последний итог по диалогу |
| GET | `/conversations/{id}` | транскрипт: `index`, исходный `timestamp`, `offset_sec` (секунды от начала — для плеера), `audio_url`, `audio_stream_url` |
| GET | `/conversations/{id}/audio` | свежая mp3-ссылка записи звонка (`audio_src`, `expires_at`) — ссылка организаторов живёт ~1 ч |
| GET | `/conversations/{id}/audio/stream` | 307 на mp3: `<audio src=".../audio/stream#t=76.6">` перематывает к реплике |
| GET | `/checklists` | все версии (`is_latest`) |
| GET | `/checklists/{id}` | чек-лист целиком |
| POST | `/checklists` | сохранить новую версию: прислать чек-лист с тем же `family` → `cqa-default-v2` |
| POST | `/checklists/validate` | dry-run для формы редактирования: `valid`, `errors`, `weight_total` |
| POST | `/evaluate` | `{conversation_id, checklist_id}` или `{transcript:[{timestamp,speaker,text}], language}` |
| POST | `/evaluate/batch` | `{group_id, checklist_id, force?}` → `job_id`; статус `GET /evaluate/batch/{job_id}` (хранится в БД) |
| GET | `/evaluate/batch` | последние batch-задачи |
| GET | `/results?group_id=&checklist_id=&needs_review=true` | таблица результатов (`review_required`, `review_criteria`); `needs_review=true` — очередь на ручную проверку |
| GET | `/results/export.csv?group_id=&checklist_id=` | выгрузка для Excel (ответы и баллы по критериям) |
| GET | `/stats?group_id=&checklist_id=` | сводка: средний итог по языкам/каналам, ответы и доля N/A по критериям, грубые ошибки |
| GET | `/results/{conversation_id}?checklist_id=` | карточка результата |
| GET | `/results/by-id/{result_id}` | то же по `result_id` |
| POST | `/results/{result_id}/appeals` | `{criterion_id, comment}` → `appeal` + `card` |
| GET | `/appeals?status=open` | очередь проверяющего: спорная оценка, комментарий, `fragment[]` (реплики вокруг доказательства, `focus`) |
| GET | `/appeals/{appeal_id}` | одна карточка апелляции |
| POST | `/results/{result_id}/review` | `{criterion_id, decision: "confirm"\|"change", new_value, reason}` → пересчёт |

Переоценка диалога тем же чек-листом (`force`) заменяет результат; открытые апелляции к старой версии получают статус `superseded`.

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
  // ручная проверка (добавлено, старые поля не менялись):
  "review_required": true, "review_criteria": ["C8"], "agreement_rate": 0.875, "review_reasons": {"critical_flag": 1},
  // в каждом критерии: "rule_answer", "agreement": "agree|near|disagree|null", "confidence": "high|medium|low",
  //                     "needs_review": bool, "review_reasons": ["rules_llm_disagree", "llm_low_confidence", "llm_fallback",
  //                     "consistency_override", "no_evidence", "no_rule", "critical_flag"]
  "pipeline": {"judge": "anthropic", "model": "claude-sonnet-5-5", "llm_calls": 8, "input_tokens": …, "output_tokens": …, "cost_usd": …, "consistency_notes": []}
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

5. **Review signals** (`ml/review.py`): правила и LLM — два независимых мнения. Расхождение, низкая самооценка модели, fallback, правка консистентностью, нет evidence, грубая ошибка → `needs_review` с причиной. `confidence` — уровень по этим сигналам, не вероятность.

Нет ключа или модель ответила ошибкой / отказом / таймаутом / битым JSON → rule-based судья по этому критерию, JSON того же формата, критерий уходит на проверку, демо не падает.

Транскрипт передаётся модели как недоверенные данные в `<transcript>`: инструкции внутри реплик не выполняются.

Кэширование промпта: system + транскрипт идут общим префиксом с `cache_control`, критерий — после него. Первый вызов прогревает кэш,
остальные 7 читают префикс по цене кэша (у Opus 5.5 это $0.20 / 1M вместо $4). Для Opus 5.5 включён серверный fallback модели при отказе.

## Модель и стоимость

**Бесплатно:** `OPENAI_COMPAT_API_KEY` (ключ Gemini из https://aistudio.google.com → Get API key) в `backend/.env`, `LLM_STRATEGY=single_call`.
Тот же адаптер работает с Groq, OpenRouter и локальной Ollama — меняются `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL`.
Доступные модели: `backend\.venv\Scripts\python -m ml.live_smoke --list-models`. Если задан `ANTHROPIC_API_KEY`, в режиме `auto` приоритет у Claude.

Подробно и с методикой: [docs/demo/cost-report.md](docs/demo/cost-report.md). Экономия без потери качества: кэш префикса, кэш ответов `LLM_RESULT_CACHE=1` (повтор — $0, замена одного критерия — 1 вызов вместо 8), `LLM_STRATEGY=single_call` (все критерии одним вызовом; включать после сравнения в eval).

| Модель (`LLM_MODEL`) | Цена, $ / 1M токенов (вход / выход) | Одна полная оценка (8 вызовов) |
|---|---|---|
| `claude-sonnet-5-5` (по умолчанию) | 2 / 10, чтение кэша 0.20 | ≈ $0.03–0.07 (оценка, см. docs/demo/cost-report.md) |
| `claude-opus-5-5` | 4 / 20, чтение кэша 0.20 | ≈ $0.06–0.14 |
| `claude-haiku-5-5` | 0.10 / 0.50 | ≈ $0.003 |
| rule-based (`LLM_PROVIDER=rules`) | 0 | 0 |

Оценка по замеру промптов на DEV: в среднем ≈ 30 тыс. символов входа на 8 вызовов (≈ 10 тыс. токенов),
выход ≈ 3 тыс. токенов вместе с размышлением при `LLM_EFFORT=low`. Весь DEV (65 диалогов) на Opus 5.5 обойдётся примерно в $6–7.
Фактическая стоимость каждой оценки считается по `usage` из ответа API и пишется в `pipeline.cost_usd` (цены задаются в `LLM_PRICE_IN` / `LLM_PRICE_OUT` / `LLM_PRICE_CACHE_READ`; токены кэша — `cache_write_tokens` / `cache_read_tokens`).
Цифры в таблице — оценка до кэширования. Фактические заменить после первого прогона с ключом.

## Чек-лист

`configs/checklists/cqa-default-v1.json` — начальная конфигурация из PDF организаторов, схема — `checklist.schema.json`.
Типы критериев: `binary` (Да/Нет), `scale` (ступени, верхняя = полный вес), `flag` (грубая ошибка без баллов).
Для нового критерия достаточно `description` (+ `na_condition`, если разрешён N/A). Поле `keywords` даёт rule-based режиму подсказку,
как оценивать новый критерий без LLM.

## Что осталось (TODO(hackathon))

- Лексиконы rule-based режима собраны по DEV; на контрольном наборе основной путь — LLM.
- Batch идёт в потоке процесса сервера: при рестарте задача получает статус `interrupted`; повторный batch досчитывает только оставшееся.
- Gold-разметка `eval/gold_dev.json` — черновик, нужна проверка человеком.
- LLM-путь проверен тестами на фейковом клиенте; живой прогон с ключом ещё не делался.
- UI (HTML/CSS/JS, Dynamics 365) делает другая часть команды.
