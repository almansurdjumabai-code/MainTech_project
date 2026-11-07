# Встраивание в Dynamics 365 (web resource)

`d365/cqa-webresource.html` — минимальная обёртка, которая монтирует **только карточку диалога**: транскрипт, результат, апелляции и трассировку. Шапки и роутера в ней нет. Все стили изолированы под `.cqa-root` с префиксом классов `cqa-`, поэтому со стилями формы D365 они не конфликтуют.

## 1. Загрузите файлы как web resources

Сохраните относительную структуру через «виртуальные папки» в имени ресурса (префикс издателя — например, `new_`):

| Имя web resource | Тип | Файл |
|---|---|---|
| `new_/cqa/d365/cqa-webresource.html` | Webpage (HTML) | `d365/cqa-webresource.html` |
| `new_/cqa/css/tokens.css`, `base.css`, `components.css`, `animations.css`, `print.css` | Style Sheet (CSS) | `css/*.css` |
| `new_/cqa/js/config.js`, `js/d365-entry.js`, `js/core/*.js`, `js/api/*.js`, `js/components/*.js` | Script (JScript) | `js/**` |
| `new_/cqa/js/i18n/ru.json`, `kz.json`, `en.json` | Data (XML)* | `js/i18n/*.json` |

\* Для JSON используйте тип Data или переименуйте файлы в `*.json.js` и поправьте путь в `js/core/i18n.js`.

Так как ресурсы ссылаются друг на друга относительными путями (`../css/…`, `./core/…`), их имена обязаны повторять структуру папок проекта.

## 2. Настройте адрес бэкенда

Перед загрузкой задайте в `js/config.js` значения `USE_MOCK: false` и `API_BASE: 'https://<ваш-бэкенд>'`. Второй вариант — объявить `window.CQA = { config: { USE_MOCK: false, API_BASE: '…' } }` в отдельном скрипте до `d365-entry.js`. На бэкенде разрешите CORS для домена организации (`https://<org>.crm.dynamics.com`).

## 3. Добавьте на форму

1. Откройте редактор формы (например, сущности «Обращение» или собственной `new_conversation`) → **Insert → Web Resource** → `new_/cqa/d365/cqa-webresource.html`.
2. Включите **Pass record object-type code and unique identifier as parameters**.
3. В поле **Custom Parameter (data)** укажите:
   ```
   conversationId=p1-ru-001&lang=ru&role=qa
   ```
   D365 передаст это как `?data=conversationId%3Dp1-ru-001…` — обёртка разберёт строку. Если `conversationId` не задан, используется `id` записи (GUID), поэтому бэкенд должен уметь находить диалог по нему.
4. Высота — от 700 px. Уже 860 px карточка сама переходит в одну колонку с табами «Транскрипт / Результат».

Поддерживаемые параметры: `conversationId`, `msg` (номер реплики для deep link), `lang` (`ru|kz|en`), `role` (`qa|reviewer`), `theme` (`light|dark`).

## 4. Связь с формой

Динамически передать ID диалога из поля формы (form script):

```js
function onLoad(ctx) {
  const form = ctx.getFormContext();
  const ctrl = form.getControl('WebResource_cqa');
  ctrl.getContentWindow().then((w) => {
    w.postMessage({ type: 'cqa:open', conversationId: form.getAttribute('new_conversationid').getValue() }, '*');
  });
}
```

Карточка сама сообщает форме о событиях через `window.parent.postMessage` (если родителя нет, вызов безопасно пропускается):

| Событие | Payload |
|---|---|
| `cqa:ready` | `{ conversationId, mock }` |
| `cqa:evaluation-updated` | `{ conversationId, evaluationId, total?, grossViolation? }` — после оценки или решения по апелляции |

```js
window.addEventListener('message', (e) => {
  if (e.data?.type === 'cqa:evaluation-updated') {
    form.getAttribute('new_qascore').setValue(e.data.payload.total);
  }
});
```

Целевой origin задаётся в `config.HOST_ORIGIN` (по умолчанию `'*'`). В проде укажите домен организации.

## Проверка без D365

```
http://localhost:5173/d365/cqa-webresource.html?data=conversationId%3Dp1-ru-004%26lang%3Dkz
```
