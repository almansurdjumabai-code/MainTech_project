# CQA — Conversation Quality Analytics · фронтенд

Интерфейс AI-оценки диалогов операторов Freedom Broker (чаты и звонки, RU / KZ / EN) по настраиваемому чек-листу. Внутри: апелляции, решения проверяющего, дашборд и трассировка оценок.

Чистые **HTML + CSS + vanilla JS (ES-модули)**: без фреймворков, без сборщика, без `npm install`. Структура готова к встраиванию в Dynamics 365 как web resource ([d365/README_D365.md](d365/README_D365.md)).

## Запуск за 3 команды

```bash
git clone https://github.com/almansurdjumabai-code/MainTech_project.git
cd MainTech_project/frontend
python serve.py            # → http://localhost:5173
```

Подойдёт любой статический сервер (`python -m http.server 5173`, `npx serve .`), но `serve.py` отключает кеш — иначе браузер держит старые ES-модули после правок.

По умолчанию включён **mock-режим**: всё работает без бэкенда, данные хранятся в `localStorage`.

| URL | Что делает |
|---|---|
| `/` | Приложение (mock) |
| `/?mock=0` | Реальный API на `API_BASE` |
| `/?mock=0&api=http://localhost:8000` | Реальный API на другом адресе |
| `/?demo=1` | Кнопка «Сценарий защиты» — тур по 5-минутной презентации |
| `/tests/scoring.test.html` | Юнит-тесты расчёта баллов |
| `/d365/cqa-webresource.html?data=conversationId%3Dp1-ru-004` | Карточка в режиме D365 |
| `/#/conversations?lang=KZ&score=low` | Таблица с фильтрами (так открывает её клик по графику дашборда). Параметры: `lang=RU\|KZ\|EN`, `score=low\|mid\|high`, `status=pass\|fail\|manual\|dispute`, `channel=chat\|voice`, `gross=1` |
| `/?intro=1` / `/?intro=0` | Показать / отключить интро |

## Mock ↔ реальный бэкенд

Проще всего открыть UI через бэкенд: `uvicorn backend.app.main:app --port 8000` из корня репозитория, затем **http://127.0.0.1:8000/**. Это реальный API, отдельный статический сервер не нужен (см. корневой README).

`js/config.js`:

```js
API_BASE: 'http://localhost:8000',   // наш бэкенд (проксирует API организаторов)
USE_MOCK: true,                      // false → HTTP-запросы по docs/API_CONTRACT.md
```

Весь сетевой код находится в `js/api/client.js`. Контракт для бэкендера описан в [docs/API_CONTRACT.md](docs/API_CONTRACT.md).

В mock-наборе `DEV` 14 диалогов (RU/KZ/EN, 2 звонка). Среди них есть случаи с N/A, с грубой ошибкой при высоком балле, с низкой уверенностью модели и с апелляциями во всех статусах. Набор `CONTROL` добавляет 2 новых диалога. Один диалог намеренно падает при первой пакетной оценке, чтобы показать кнопку «Повторить упавшие». Сбросить данные можно кнопкой на дашборде.

## Сценарий ТЗ

1. **Чек-листы** → изменить критерий → «Сохранить как новую версию» (diff и сумма весов видны сразу) → «Переоценить диалоги» → выбрать диалоги → пакетная оценка.
2. **Диалоги** → `group_id` → «Загрузить» → отметить диалоги → «Оценить выбранные». Прогресс показывается сегментами с ETA.
3. **Карточка**: клик по доказательству прокручивает транскрипт к реплике и подсвечивает цитату. Для пропущенного действия виден проверенный участок, для N/A — причина. Блок «Как посчитан итог» раскрывает расчёт по шагам.
4. Роль **QA** → «Оспорить» → комментарий → «Подать апелляцию».
5. Роль **Проверяющий** → **Апелляции** → доказательства, фрагмент диалога, «AI второе мнение» → «Изменить оценку» с причиной → итог пересчитывается.

Горячие клавиши в карточке: `J/K` — следующий/предыдущий диалог, `1–8` — критерий, `E` — доказательство, `A` — апелляция, `?` — шпаргалка.

## Структура

```
index.html                 оболочка (шапка, ticker, hash-роутер)
serve.py                   dev-сервер без кеша
css/                       tokens · base · components · animations · print  (всё под .cqa-root, префикс cqa-)
js/config.js               API_BASE, USE_MOCK, пороги
js/app.js                  standalone-приложение
js/d365-entry.js           точка входа для D365 (только карточка)
js/core/                   router · store (pub/sub) · scoring · i18n · utils · events · actions · jobs · stats · icons
js/api/                    client (HTTP) · mock · mock-data · errors
js/components/             conversation-list · conversation-card · transcript-view · audio-player · result-panel
                           appeal-form · reviewer-queue · checklist-editor · dashboard · trace-view · toast · modal · ui · demo-tour
js/i18n/                   ru.json · kz.json · en.json
d365/                      cqa-webresource.html · README_D365.md
docs/API_CONTRACT.md       контракт для бэкенда
tests/scoring.test.html    юнит-тесты scoring.js (без фреймворков)
```

Каждый компонент экспортирует `mount(rootEl, props) → { update(props), destroy() }` и ищет элементы только внутри своего `rootEl`. Глобальное имя одно — `window.CQA`.

## Расчёт баллов

`js/core/scoring.js` — чистая функция по правилам чек-листа:

- «Да» даёт полный вес, «Нет» — 0.
- Шкала: `value / maxStep × weight`.
- Вес критериев с N/A пропорционально перераспределяется.
- Итог округляется до 2 знаков; если применимых критериев нет, он не рассчитывается.
- Грубая ошибка отмечается отдельным флагом.

Тесты: откройте `/tests/scoring.test.html` — все строки должны быть ✓.

## Скриншоты

> _Заглушки — заменить перед сдачей._
> `docs/screenshots/conversations.png` · `card.png` · `appeals.png` · `checklists.png` · `dashboard.png`

## Доступность и дизайн

- Контраст AA. Метаданные и ссылки сделаны темнее фирменных `#9AA19C` / `#51AF3D`, потому что исходные цвета не проходят 4.5:1 на белом.
- Видимый focus-ring, полная клавиатурная навигация, `aria-live` для результатов и уведомлений.
- `prefers-reduced-motion` отключает все анимации.
- Тёмная тема и печатная версия карточки (`@media print`).
- Шрифты Inter и IBM Plex Mono подключаются неблокирующе, офлайн работает системный fallback-стек.
