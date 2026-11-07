# Quality Assurance AI Automation

**CQA — Conversation Quality Analytics** для Freedom Broker: автоматическая оценка диалогов операторов (чаты и звонки, RU / KZ / EN) по настраиваемому чек-листу. У каждого балла есть объяснение и ссылка на реплику-доказательство. Спорную оценку можно оспорить, проверяющий принимает решение, итог пересчитывается.

## Быстрый старт (Windows)

Двойной клик по **`start.bat`**: при первом запуске он создаст окружение, затем поднимет сервер и откроет http://127.0.0.1:8000/. Сценарий защиты лежит в [docs/pitch.md](docs/pitch.md).

## Запуск: UI + backend + модель одним процессом

Нужен Python 3.11 или новее. Node.js нужен только для QA-скриптов.

```powershell
git clone https://github.com/almansurdjumabai-code/MainTech_project.git
cd MainTech_project
python -m venv backend\.venv
backend\.venv\Scripts\pip install -r backend\requirements.txt
copy .env.example backend\.env        # вписать DATASET_URL организаторов; ключ LLM — по желанию
backend\.venv\Scripts\python -m uvicorn backend.app.main:app --port 8000
```

Откройте **http://127.0.0.1:8000/**. Это интерфейс на реальном API. Порядок работы: «Диалоги» → `DEV` → «Загрузить» → «Оценить».

| Адрес | Что там |
|---|---|
| `/` | UI (frontend/) на реальном backend |
| `/app/?mock=1` | UI на демо-данных, без backend |
| `/docs` | Swagger: все эндпоинты |
| `/labeler/` | слепая ручная разметка для оценки качества |

Без ключа LLM система работает на детерминированных правилах (RU/KZ/EN, $0) и не падает. С ключом Gemini (бесплатный тариф) или Claude включается гибрид «правила + LLM» с флагами ручной проверки. Подробнее: [backend/README.md](backend/README.md).

## Сдача результатов (приложение к гайду, формат JSON 1.0)

```powershell
# DEV: 60 чатов + 5 звонков -> results/dev/results.json
backend\.venv\Scripts\python -m ml.export_results --group-id DEV --set dev --evaluate
# контрольный набор (t+23h): получить -> оценить -> проверить -> записать
backend\.venv\Scripts\python -m ml.export_results --group-id <ID> --set prod --ingest --evaluate
node qa\validate_results.mjs results\prod\results.json --prod
git add results/prod/results.json; git commit -m "Add prod results"; git push
```

## Структура

```
frontend/        UI: HTML + CSS + vanilla JS (без сборки); контракт API — frontend/docs/API_CONTRACT.md
backend/app/     FastAPI: ingest у организаторов, SQLite, чек-листы, оценка, апелляции, /api для UI
ml/              конвейер: retriever (правила) -> judge (LLM или правила) -> consistency -> review-флаги
scoring/         детерминированный расчёт итога (N/A перераспределяет вес, округление до 0.01)
configs/         чек-листы (версии JSON)
prompts/         системный промпт судьи
eval/            разметка, сплит, метрики качества (точность, Cohen's kappa)
qa/              QA-набор: тесты скоринга, ручная разметка, валидатор results.json
tests/           pytest: unit / ml / api / qa
results/         dev/ и prod/results.json для организаторов
docs/            qa-report.md, demo/ (архитектура, оценка качества, стоимость, сценарий защиты)
```

## Проверка

```powershell
backend\.venv\Scripts\python -m pytest -q          # backend + ML + совместимость с UI
node --test "qa/*.test.mjs"                         # эталонный скоринг QA
backend\.venv\Scripts\python -m ml.preflight --online
```

Секреты (`DATASET_URL` с `sig=`, ключи моделей) хранятся только в `backend/.env`, в git лежит `.env.example`. Данные организаторов в репозиторий не кладём.
