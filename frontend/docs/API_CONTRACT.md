# CQA API — контракт фронтенда

Фронтенд обращается к бэкенду только через `js/api/client.js`. Базовый адрес — `API_BASE` в `js/config.js` (можно переопределить через `?api=http://host:port`). Mock-адаптер `js/api/mock.js` реализует этот же контракт в браузере, поэтому по нему удобно сверять поведение.

Общие правила:

- JSON in / JSON out, `Content-Type: application/json`, кодировка UTF-8.
- CORS: разрешить origin фронтенда (`http://localhost:5173` и домен D365) для `GET, POST, PUT` и заголовка `Content-Type`.
- Ошибки: HTTP-статус ≠ 2xx и тело `{ "error": "Человеческое описание" }`. Фронт показывает поле `error` (или `message` / `detail`) пользователю как есть, поэтому пишите текст по-человечески.
- Время — ISO 8601 (UTC), например `2026-11-07T08:00:00.000Z`.
- **Исходные таймстемпы реплик не меняем**: у чатов `MM:SS`, у звонков ISO 8601 с часовым поясом.

---

## Типы

```ts
type Speaker = 'client' | 'operator' | 'bot' | 'system';

interface Message { timestamp: string; speaker: Speaker; text: string }

// Запись в формате организаторов (храним 1-в-1, плюс dataset)
interface Conversation {
  conversation_id: string;
  channel: 'agent chat' | 'voice call';
  language: 'RU' | 'KZ' | 'EN';
  transcript: Message[];
  audio_url: string | null;
  dataset?: string;            // group_id, из которого загружено ('DEV', 'CONTROL', 'IMPORT')
}

type CriterionType = 'binary' | 'scale' | 'flag';

interface Criterion {
  id: string;                  // стабильный: 'c1', 'c2', … (по нему сопоставляются ответы)
  title: string;
  description: string;         // условие «Да»
  section: string;
  weight: number;              // для flag = 0
  type: CriterionType;
  allowNA: boolean;
  naCondition: string;
  scale: { value: number; label: string }[];   // для scale; верхняя ступень = полный вес
  aiGuidance: string;          // подсказка модели — вставляется в промпт
}

interface Checklist {
  id: string;                  // 'cl_v2'
  version: number;             // 1, 2, 3 … (монотонно)
  name: string;
  createdAt: string;
  active: boolean;             // ровно одна активная
  note?: string;               // комментарий к версии
  sections: string[];          // порядок секций
  criteria: Criterion[];       // порядок критериев
}

type Answer = 'yes' | 'no' | 'na' | number;   // number — ступень шкалы

interface CriterionResult {
  criterionId: string;
  answer: Answer;
  points: number;              // в единицах веса (до перераспределения)
  maxPoints: number;
  effectiveWeight: number;     // вес после перераспределения N/A (сумма = 100)
  explanation: string;
  evidence: { messageIndex: number; quote: string }[];   // quote — ТОЧНАЯ подстрока текста реплики
  checkedRange: { from: number; to: number } | null;     // для пропущенного действия
  naReason: string | null;     // для N/A — какое условие выполнено
  confidence: number | null;   // 0..1
}

interface Evaluation {
  evaluationId: string;
  conversationId: string;
  checklistId: string;
  checklistVersion: number;
  model: string;
  createdAt: string;
  durationMs: number;
  costUsd: number;
  tokens: { in: number; out: number };
  criteria: CriterionResult[];
  sections: { section: string; score: number; max: number }[];
  total: number | null;              // ФИНАЛЬНЫЙ итог (с учётом решений проверяющего), 2 знака
  originalTotal: number | null;      // итог AI до пересмотра
  totalComputable: boolean;
  grossViolation: boolean;
  overrides: Record<string, {        // решения проверяющего по критериям
    answer: Answer; reason: string; by: string; at: string; appealId: string; previous: Answer | null;
  }>;
  audit: { at: string; actor: string; action: 'evaluated' | 'appeal' | 'changed' | 'confirmed'; details: string }[];
  rawModelOutput: unknown;           // сырой ответ модели — показывается во вкладке «Трассировка»
}

type AppealStatus = 'submitted' | 'in_review' | 'confirmed' | 'changed';

interface Appeal {
  id: string;
  evaluationId: string;
  conversationId: string;
  criterionId: string;
  originalAnswer: Answer | null;
  comment: string;
  status: AppealStatus;
  createdAt: string;
  history: { at: string; status: AppealStatus; actor: string }[];
  decision: null | {
    action: 'confirm' | 'change'; newValue: Answer | null; reason: string; by: string; at: string;
    totalBefore: number | null; totalAfter: number | null;
  };
  aiReview: null | { answer: Answer; explanation: string; confidence: number; model: string; at: string; agrees: boolean };
}

interface Job {
  jobId: string;
  checklistId: string;
  model: string;
  status: 'running' | 'done';
  startedAt: string;
  finishedAt?: string;
  total: number; done: number; failed: number;
  etaMs: number | null;
  items: {
    conversationId: string;
    status: 'queued' | 'running' | 'done' | 'error';
    stage: 0 | 1 | 2 | 3 | 4 | 5;   // 0 получение · 1 чек-лист · 2 анализ · 3 расчёт · 4 подпись · 5 готово (если не отдаёте — фронт покажет 0)
    evaluationId: string | null;
    error: string | null;
  }[];
}
```

## Правила расчёта (должны совпадать с `js/core/scoring.js`)

1. N/A допустим только при `allowNA = true`. N/A там, где он запрещён, считается как 0 баллов.
2. `binary`: «Да» даёт полный вес, «Нет» даёт 0. `scale`: `points = value / max(scale.value) × weight`.
3. Критерии с N/A исключаются: `total = Σpoints / Σweight_applicable × 100`, а `effectiveWeight = weight / Σweight_applicable × 100`.
4. Итог округляется до 2 знаков. Если `Σweight_applicable = 0`, то `total = null` и `totalComputable = false`.
5. `flag` баллов не даёт. `grossViolation = (ответ по flag-критерию === 'yes')`, балл при этом не обнуляется.

Фронт пересчитывает итог сам (live-превью, решения проверяющего), поэтому расхождение с бэкендом будет заметно сразу. Юнит-тесты лежат в `tests/scoring.test.html`.

---

## Эндпоинты

### `GET /api/health`
`200 { "ok": true }` — по нему горит индикатор online в шапке.

### `GET /api/datasets/:groupId`
Прокси к API организаторов (из браузера запрос не пройдёт из-за CORS). Бэкенд **сохраняет** записи в своё хранилище (upsert по `conversation_id`, `dataset = groupId`) и возвращает ответ организаторов без изменений:
```json
{ "error": "", "isSuccess": true, "data": { "dataset_group_id": "DEV", "total_records": 65, "records": [ /* Conversation */ ] } }
```
Неизвестный group_id → `404 { "error": "Набор XYZ не найден" }`.

### `GET /api/conversations`
Список для таблицы. Каждая запись — облегчённый диалог плюс последняя оценка, **без** `rawModelOutput` и транскрипта:
```json
[{
  "conversation_id": "p1-ru-001", "channel": "agent chat", "language": "RU", "audio_url": null, "dataset": "DEV",
  "messages": 9, "duration": 130,
  "evaluation": { /* Evaluation без rawModelOutput */ } | null,
  "appealStatus": "submitted" | "in_review" | "confirmed" | "changed" | null
}]
```
`duration` — секунды от первой до последней реплики. `appealStatus` — открытая апелляция, а если открытых нет, то последняя.

### `GET /api/conversations/:id`
`{ "conversation": Conversation, "evaluation": Evaluation | null }` — последняя оценка с `rawModelOutput`.

### `GET /api/conversations/:id/evaluations`
Все оценки диалога (`Evaluation[]`) по возрастанию `createdAt` — для вкладки «Сравнение версий».

### `POST /api/conversations/import`
Body: `{ "records": Conversation[] }` → `{ "imported": 2, "ids": ["…"] }`. Записи сохраняются с `dataset = "IMPORT"`.

### `GET /api/checklists`
`Checklist[]` — все версии.

### `POST /api/checklists`
Body: `Checklist` без `id/version/createdAt/active` (поля `name, note, sections, criteria`).
Ответ: сохранённый `Checklist` с новыми `id = "cl_v{N}"`, `version = N`, `active = false`. Старые версии **не изменяются**.

### `PUT /api/checklists/:id/activate`
Делает версию активной (остальные получают `active = false`). Возвращает `Checklist`.

### `GET /api/models`
```json
[{ "id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5", "kind": "cloud", "costUsd": 0.012, "avgMs": 8400 }]
```
`costUsd` и `avgMs` — средние стоимость и время **одной оценки** со всеми вызовами модели. Если эндпоинта нет, фронт просто скроет переключатель модели.

### `POST /api/evaluations`
Body: `{ "conversationIds": ["…"], "checklistId": "cl_v2", "model": "claude-sonnet-5-5" }` → `{ "jobId": "job_…" }`.
Оценка выполняется асинхронно. Каждая оценка создаёт **новый** `Evaluation` (старые сохраняются для сравнения версий).

### `GET /api/evaluations/jobs/:jobId`
`Job` — фронт опрашивает этот эндпоинт каждые 600 мс до `status = "done"`. Ошибки по отдельным диалогам записываются в `items[].status = "error"` и `items[].error` с текстом для человека. Повтор упавших делается обычным `POST /api/evaluations` с их id.

### `GET /api/evaluations/:id`
`Evaluation`.

### `POST /api/appeals`
Body: `{ "evaluationId", "criterionId", "comment" }` → `Appeal` (`status = "submitted"`). Если по этому критерию уже есть открытая апелляция → `409`. В `evaluation.audit` добавляется запись `appeal`.

### `GET /api/appeals?status=submitted|in_review|confirmed|changed`
`Appeal[]`, новые первыми. Без параметра возвращаются все.

### `POST /api/appeals/:id/take`
Проверяющий открыл апелляцию: `submitted → in_review`. Возвращает `Appeal`.

### `POST /api/appeals/:id/decision`
Body: `{ "action": "confirm" | "change", "newValue": Answer | null, "reason": "обязательно" }`.
При `change` бэкенд записывает `evaluation.overrides[criterionId]`, **пересчитывает** `total / sections / grossViolation` по правилам выше (`originalTotal` не меняется) и пишет в `audit`.
Ответ: `{ "appeal": Appeal, "evaluation": Evaluation }`. Пустая причина → `400`, если решение уже принято → `409`.

### `POST /api/appeals/:id/ai-review`
«AI второе мнение»: повторная оценка спорного критерия с учётом `comment` апелляции. Сохраняется в `appeal.aiReview` и возвращается `Appeal["aiReview"]`.

### `GET /api/stats` (опционально)
Дашборд считает метрики на фронте из `GET /api/conversations` и `GET /api/appeals`, поэтому этот эндпоинт не обязателен.

---

## Подсказки по промпту модели

- Передавайте транскрипт с индексами: `#3 [operator 00:41] текст`. Модель должна ссылаться на `messageIndex`, а `quote` — быть **дословной подстрокой** текста реплики (фронт подсвечивает её через `<mark>`).
- Для каждого критерия передавайте `description`, `naCondition`, `scale` (подписи ступеней) и `aiGuidance`.
- Реплики `bot` и `system` — контекст: их нельзя засчитывать как действия оператора, но можно приводить как доказательство (например, «Чат закрыт по таймауту»).
- Структурированный вывод: `{ results: [{ id, answer, evidence_message_ids, quote, checked_range, na_reason, rationale, confidence }], gross_violation }`. Баллы считайте **кодом**, а не моделью.
