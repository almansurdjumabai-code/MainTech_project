# CQA — материалы для защиты (backend + ML)

| Документ | О чём |
|---|---|
| [architecture.md](architecture.md) | Компоненты, путь диалога от ingest до итога (Mermaid), принятые решения |
| [evaluation.md](evaluation.md) | Что измерено, сравнение Rules / LLM / Hybrid / Hybrid + review, тесты |
| [cost-report.md](cost-report.md) | Цены, размер промптов, оценка $/диалог, рычаги экономии |
| [demo-scenarios.md](demo-scenarios.md) | Сценарии A–E на реальных DEV-диалогах с командами |
| [limitations.md](limitations.md) | Ограничения, остаточные риски, security review |
| [eval_results/](eval_results/) | Сырые отчёты `eval.run_eval` (JSON + Markdown) |

## Требования организаторов → статус

Источник — `CQA_Hackathon_Student_Guide_v3.pdf` и `CQA_Chat_Quality_Checklist.pdf`. **Отдельной таблицы баллов жюри в документах нет.** Ниже — функции, тайминг и FAQ из ТЗ.

| Требование | Реализовано (backend/ML) | Не реализовано / риск | Как доказываем |
|---|---|---|---|
| 01 Чек-лист: критерии, формулировки, вес, тип, N/A, шкала; сохранить | `GET/POST /checklists`, версии `family-vN`, `POST /checklists/validate` (dry-run) | Экран редактора — в UI | `test_checklist_validate`, сценарий C |
| 02 Оценить диалог, выбрать чек-лист, RU/KZ/EN, бот и система — контекст | `POST /evaluate` (из БД или переданный транскрипт); промпт без перевода KZ; бот и система не засчитываются оператору | LLM вживую не проверен (нет ключа) | `test_kz_transcript_not_translated`, `test_bot_and_system_turns_are_not_credited_to_operator` |
| 03 Результат: ответ, баллы, вес, объяснение, реплика; пропуск — участок; N/A — причина; итог и секции | `criteria[]` с `answer, points, weight, effective_weight, explanation, evidence, expected_span, na_reason`; `sections[]`, `overall` | — | Сценарий A, контракт в `backend/README.md` |
| Вес и итог: шкала × вес, перераспределение N/A, грубые отдельно, округление | `scoring/aggregator.py`, LLM в арифметику не допускается | — | `tests/test_aggregator.py` |
| 04 Карточка: переход к сообщению или фрагменту звонка, плеер | `evidence.index`, `offset_sec`, `/conversations/{id}/audio/stream#t=` | Плеер и скролл — в UI | Сценарий D, `test_call_offsets_and_evidence_offsets` |
| 05 Апелляция: критерий, комментарий; проверяющий видит оценку, комментарий, фрагмент | `POST /results/{id}/appeals`, `GET /appeals` с `fragment[]` | — | `test_appeal_card_has_fragment_and_disputed_score` |
| 06 Решение проверяющего с причиной, пересчёт, исходная / решение / финал | `POST /results/{id}/review`; `original`, `final`, `reviews[]` | — | Сценарий E, тесты review |
| t+23h: новые транскрипты, обработать заранее | `POST /ingest?group_id=<новый>` без правки кода; идемпотентный batch; защита от дубликата; сбой одного диалога не останавливает batch | Держать сервер поднятым к t+23h | `test_batch_partial_failure_keeps_other_results`, `test_duplicate_background_batch_is_deduplicated` |
| Замена критерия и применение нового чек-листа | Промпт собирается из JSON; кэш ответов — платим только за новый критерий | Без ключа новому критерию нужны `keywords` | Сценарий C, `test_result_cache_skips_paid_calls_…` |
| Интерфейс HTML/CSS/JS, адаптация под Dynamics 365 | Не моя часть (фронтенд команды) | **Главный незакрытый блок для защиты** | — |
| README с шагами запуска | `backend/README.md` | — | — |
| FAQ: модель и примерная стоимость одной оценки | Claude Sonnet 5.5 (`claude-sonnet-5-5`); `pipeline.cost_usd` по usage; оценка $0.03–0.07 за диалог | Факт после live smoke | [cost-report.md](cost-report.md) |
| CORS: данные организаторов — через сервер | `POST /ingest` (сервер), CORS для localhost и file:// | — | — |

## Что даст максимальный прирост к защите

1. **Рабочий UI от начала до конца** (команда фронта): без него Контур 1 и 2 нельзя показать за 5 минут.
2. **Ключ API → `ml.live_smoke` → `eval.run_eval --modes rules,hybrid,llm_only`.** Даст реальные цифры качества, стоимости и колонку hybrid.
3. **Человек проверяет `eval/gold_dev.json`:** 10 диалогов — минут 30. После этого accuracy можно называть согласием с экспертом.

## Защита за 5 минут (backend-часть)

1. **Диалог** — список `GET /conversations`, карточка `p1-ru-013`.
2. **Оценка** — объяснения со ссылкой на реплику; два N/A и перераспределение веса; итог 100. Звонок `p4-ru-001`: перемотка к 76.6 с.
3. **Апелляция** — `p1-ru-005`, C2 «Нет» → проверяющий меняет на N/A → `overall_before` → `overall_after`.
4. **Замена критерия** — сохранить v2 (C7 → C9), запустить batch с `cqa-default-v2`. Код и промпты не менялись; с LLM платный только новый критерий.
5. **Уникальность (одна фраза):** «Итог считает код по правилам PDF, а не модель. Два независимых метода — правила и Claude — проверяют друг друга; где они расходятся, решение идёт человеку».
