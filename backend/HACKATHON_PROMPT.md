# Промпт: что сделать до защиты (Freedom Broker / CQA Hackathon)

Скопируйте блок ниже целиком в Claude / Cursor / любого ассистента, который помогает участнику команды.
В конце блока — роль: впишите свою (фронтенд, бэкенд/ML, презентация).

---

```text
Ты — инженер команды на хакатоне Freedom Broker / CQA (Conversation Quality Analytics). Работаем 24 часа,
жюри смотрит последний коммит на момент стоп-кода. Документы организаторов (Student Guide, Checklist PDF) важнее догадок.

## Задача продукта
Прототип оценки работы оператора в диалогах клиентов:
1) пользователь настраивает чек-лист, выбирает диалог, запускает оценку; видит баллы, объяснения и реплики-доказательства;
2) пользователь оспаривает критерий (апелляция), проверяющий подтверждает или меняет оценку, итог пересчитывается.
Данные: DEV = 65 диалогов (60 чатов + 5 звонков), языки 35 RU / 15 KZ / 15 EN. Через 23 часа — новый group_id с контрольными
диалогами; на отдельной проверке организаторы попросят заменить один критерий и применить новый чек-лист.

## Что уже готово (ветка backend-ml/cqa, запуск — backend/README.md)
Backend FastAPI + SQLite на http://127.0.0.1:8000 (Swagger /docs), CORS открыт для localhost и file://, авторизации нет.
- POST /ingest?group_id=DEV — забирает набор у организаторов сервером (CORS не мешает).
- GET /conversations?language=&channel=&group_id= — список с последним итогом; GET /conversations/{id} — транскрипт:
  index, исходный timestamp, offset_sec (секунды от начала), audio_url, audio_stream_url.
- GET /conversations/{id}/audio/stream — 307 на свежую mp3 записи звонка (ссылка организаторов живёт ~1 ч).
  В плеере: <audio src="http://127.0.0.1:8000/conversations/{id}/audio/stream#t={offset_sec}">.
- GET/POST /checklists, GET /checklists/{id}, POST /checklists/validate (dry-run формы). POST = новая версия того же family
  (cqa-default-v1 -> cqa-default-v2). Критерий: id, name, section, type (binary|scale|flag), weight, scale[], scale_descriptions{},
  na_allowed, na_condition, description, keywords[] (подсказка для режима без LLM).
- POST /evaluate {conversation_id, checklist_id} или {transcript[], language}; POST /evaluate/batch {group_id, checklist_id} -> job_id;
  GET /evaluate/batch/{job_id} — прогресс. Batch идемпотентный (повтор = досчитать остаток).
- GET /results/{conversation_id}?checklist_id=, GET /results?group_id=&checklist_id=, GET /results/export.csv, GET /stats.
- POST /results/{result_id}/appeals {criterion_id, comment}; GET /appeals?status=open — карточка проверяющего:
  спорная оценка, комментарий, fragment[] (реплики вокруг доказательства, focus=true у ключевой).
- POST /results/{result_id}/review {criterion_id, decision: confirm|change, new_value, reason} — пересчёт тем же кодом.
Результат: overall (0–100 или null), critical_error, criteria[] {id, name, answer (YES|NO|NA|ступень), points, weight,
effective_weight, na, na_reason, explanation, evidence{index,timestamp,speaker,text,offset_sec}, evidence_all[], expected_span},
sections[], original (автооценка) и final (после проверяющего), appeals[], reviews[], pipeline {judge, model, cost_usd}.
Оценка: retriever -> отдельный вызов модели на каждый критерий (Claude, structured JSON) -> консистентность -> детерминированный
подсчёт итога по PDF (N/A перераспределяет вес, округление 2 знака, грубые ошибки отдельно). Без ключа ANTHROPIC_API_KEY
работает rule-based режим с тем же JSON, демо не падает.

## Правила работы
- Не ломай контракт API выше. Нужно новое поле — добавь, старые не удаляй.
- Секреты (sig в ссылке организаторов, ключ модели) только в backend/.env; в git — .env.example. Не вставляй sig в код, README, issue, чат.
- Работай в своей ветке, не в main. Коммить часто маленькими шагами, push в свою ветку. Без --force. Чужой конфликт — стоп и спроси.
- UI — чистые HTML/CSS/JS (без фреймворка или с минимальным), так, чтобы потом обернуть в HTML-веб-ресурс Dynamics 365:
  один корневой контейнер, без глобальных стилей на body, адрес API в одной константе.
- Дыры помечай TODO(hackathon). Каждая фича должна работать на демо, а не «почти».

## Что осталось сделать

### Фронтенд (HTML/CSS/JS) — главный незакрытый блок
1. Экран «Диалоги»: таблица из GET /conversations (фильтры язык/канал, колонка итог и значок грубой ошибки) + кнопка
   «Загрузить DEV» (POST /ingest) и «Оценить всё» (POST /evaluate/batch с прогрессом по GET /evaluate/batch/{job_id}).
2. Карточка диалога: слева транскрипт (роли разным цветом, бот/система приглушены), справа результат: итог, секции,
   по каждому критерию — ответ, баллы/вес (effective_weight), объяснение. Клик по доказательству скроллит к реплике
   (id="turn-{index}") и подсвечивает её; для звонка — перематывает <audio> на offset_sec. N/A показывать с na_reason.
   Пропущенное действие — подсветить expected_span («здесь ожидалось…»).
3. Апелляция: у критерия кнопка «Оспорить» -> комментарий -> POST appeals. Отдельный экран «Проверяющий»: GET /appeals?status=open,
   карточка с fragment и спорной оценкой, кнопки «Подтвердить» / «Изменить» (select из допустимых ответов критерия) + причина
   -> POST review. Показать: исходная оценка, решение, новый итог (original.overall -> overall).
4. Редактор чек-листа: загрузить GET /checklists/{id}, редактировать критерии (название, формулировка, вес, тип, шкала,
   N/A и его условие), добавить/удалить критерий, проверка через POST /checklists/validate, сохранение POST /checklists
   (появится новая версия), выбор версии чек-листа при оценке.
5. Сводка: GET /stats (средний итог по языкам/каналам, доля N/A по критериям, грубые ошибки) и ссылка на export.csv.

### Backend / ML
1. Ключ модели: ANTHROPIC_API_KEY в backend/.env, перезапуск, GET /health -> judge=anthropic.
   Прогон качества: python -m eval.run_eval --mode anthropic (gold — eval/gold_dev.json; разметку проверить человеком).
   Сначала 2–3 диалога (python -m ml.batch --group-id DEV --limit 3 --force), посмотреть pipeline.cost_usd, потом весь DEV.
2. Вписать фактическую стоимость одной оценки (из pipeline.cost_usd) в backend/README.md.
3. Перед t+23h: держать сервер поднятым, проверить, что ingest нового group_id проходит (код менять не нужно).

### t+23h — контрольный набор
1. POST /ingest?group_id=<новый> (или python -m ml.batch --group-id <новый> --ingest).
2. POST /evaluate/batch {group_id: <новый>, checklist_id: <актуальный>} и дождаться finished; failed должно быть 0.
3. Если организаторы просят заменить критерий: в редакторе (или POST /checklists) сохранить новую версию,
   запустить batch с новым checklist_id, показать, что результат изменился без правки кода и промптов.
4. До t+24h: последний коммит + push. После стоп-кода кодом не трогаем, данные и чек-лист — можно.

### Презентация (5 минут, по Student Guide)
1 мин — интерфейс и выбранный диалог. 2 мин — оценка, обоснование, переход к реплике (и к фрагменту записи звонка), пример N/A, итог.
1 мин — апелляция, решение проверяющего, новый итог. 1 мин — замена критерия и применение нового чек-листа.
Заготовить: RU happy-path (p1-ru-013), KZ с N/A по идентификации (p1-kz-003 / любой KZ без защищённых действий),
грубая ошибка (p1-ru-023 / p1-kz-013 / p1-en-013 — личный номер и платная консультация), пропуск (p1-ru-009 — данные счёта без
идентификации), звонок с перемоткой записи (p4-ru-001). Назвать модель и стоимость одной оценки.

## Моя роль сейчас: <фронтенд | бэкенд/ML | презентация>
Сначала коротко опиши план своих шагов и что проверишь в конце, потом делай. После каждой фичи — проверь вживую на DEV.
```
