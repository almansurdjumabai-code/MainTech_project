// Проверка results.json перед push (приложение к гайду, формат JSON 1.0).
//
//   node qa/validate_results.mjs results/dev/results.json  data/dev.json
//   node qa/validate_results.mjs results/prod/results.json data/prod.json --prod
//
// Второй аргумент (ответ API организаторов) необязателен, но с ним проверяются
// полнота ID и диапазон номеров реплик. --prod требует ровно 10 записей.
// Код выхода 1, если есть ошибки, — можно повесить на pre-push хук.
import fs from 'node:fs';
import { computeScore, DEFAULT_CHECKLIST, round2 } from './scoring.reference.mjs';

const [resultsPath, datasetPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const isProd = process.argv.includes('--prod');
if (!resultsPath) { console.error('Укажите путь к results.json'); process.exit(2); }

const errors = [], warnings = [];
const err = m => errors.push(m), warn = m => warnings.push(m);

const text = fs.readFileSync(resultsPath, 'utf8');
if (text.charCodeAt(0) === 0xfeff) warn('Файл начинается с BOM — лучше сохранить как UTF-8 без BOM');
let doc;
try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { console.error(`✗ Невалидный JSON: ${e.message}`); process.exit(1); }

const SPEC = {
  contact:        { c: 'c01', allowed: v => typeof v === 'boolean' },
  discovery:      { c: 'c02', allowed: v => typeof v === 'boolean' || v === null },
  identification: { c: 'c03', allowed: v => typeof v === 'boolean' || v === null },
  consultation:   { c: 'c04', allowed: v => [0, 5, 10, 15, 20, null].includes(v) },
  empathy:        { c: 'c05', allowed: v => typeof v === 'boolean' },
  dialogue:       { c: 'c06', allowed: v => [0, 4, 7, 10].includes(v) },
  closure:        { c: 'c07', allowed: v => typeof v === 'boolean' || v === null },
  critical:       { c: 'c08', allowed: v => typeof v === 'boolean' },
};
const toAnswer = v => (v === true ? 'yes' : v === false ? 'no' : v === null ? 'na' : v);

// Верхний уровень
if (doc.schema_version !== '1.0') err(`schema_version должен быть "1.0", сейчас ${JSON.stringify(doc.schema_version)}`);
if (!doc.team_name || doc.team_name === 'Название команды') err('team_name не заполнен');
if (!doc.model || !['local', 'external_api', 'hybrid'].includes(doc.model.mode)) err('model.mode: local | external_api | hybrid');
if (!doc.model?.name || doc.model.name === 'Название модели') err('model.name не заполнен');
if (!Array.isArray(doc.results)) { err('results должен быть массивом'); report(); }

// Датасет (необязательно)
let dataset = null;
if (datasetPath) {
  const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf8').replace(/^﻿/, ''));
  const recs = raw.data?.records ?? raw.records ?? raw;
  dataset = new Map(recs.map(r => [r.conversation_id, r.transcript.length]));
}

const seen = new Set();
let ok = 0, failed = 0;
for (const [n, r] of doc.results.entries()) {
  const id = r.conversation_id, at = `${id ?? `#${n}`}`;
  if (!id) { err(`${at}: нет conversation_id`); continue; }
  if (seen.has(id)) err(`${at}: повторяющийся ID`);
  seen.add(id);
  if (dataset && !dataset.has(id)) err(`${at}: такого ID нет в наборе API (опечатка?)`);

  if (r.status === 'error') {
    failed++;
    if (!Array.isArray(r.criteria) || r.criteria.length) err(`${at}: при status=error criteria должен быть []`);
    if (r.score !== null) err(`${at}: при status=error score должен быть null`);
    if (!r.error) err(`${at}: при status=error нужна причина в поле error`);
    continue;
  }
  if (r.status !== 'ok') { err(`${at}: status должен быть "ok" или "error"`); continue; }
  ok++;

  const crit = Array.isArray(r.criteria) ? r.criteria : [];
  const byId = {};
  for (const c of crit) {
    if (!SPEC[c.criterion_id]) { err(`${at}: неизвестный criterion_id "${c.criterion_id}"`); continue; }
    if (byId[c.criterion_id]) err(`${at}: критерий ${c.criterion_id} указан дважды`);
    byId[c.criterion_id] = c;
    if (!SPEC[c.criterion_id].allowed(c.value)) err(`${at}: ${c.criterion_id} = ${JSON.stringify(c.value)} — недопустимое значение`);
    if (typeof c.value === 'string') err(`${at}: ${c.criterion_id} — значение строкой ("${c.value}"), нужен true/false/null/число`);
    if (!c.rationale || !String(c.rationale).trim()) warn(`${at}: ${c.criterion_id} без rationale`);
    if (!Array.isArray(c.evidence_turns)) err(`${at}: ${c.criterion_id} — evidence_turns должен быть массивом`);
    else {
      if (c.evidence_turns.length === 0 && c.criterion_id !== 'critical') warn(`${at}: ${c.criterion_id} без evidence_turns`);
      for (const t of c.evidence_turns) {
        if (!Number.isInteger(t) || t < 1) err(`${at}: ${c.criterion_id} — номер реплики ${t}: нумерация с 1`);
        else if (dataset && t > dataset.get(id)) err(`${at}: ${c.criterion_id} — реплики ${t} нет (в диалоге ${dataset.get(id)})`);
      }
    }
  }
  const missing = Object.keys(SPEC).filter(k => !byId[k]);
  if (missing.length) { err(`${at}: нет критериев ${missing.join(', ')}`); continue; }

  // Итог и флаг
  const answers = Object.fromEntries(Object.entries(byId).map(([k, c]) => [SPEC[k].c, toAnswer(c.value)]));
  let expected;
  try { expected = computeScore(DEFAULT_CHECKLIST, answers).total; } catch (e) { err(`${at}: ${e.message}`); continue; }
  const fs_ = r.score?.final_score;
  if (!r.score) err(`${at}: нет объекта score`);
  else {
    if (expected === null && fs_ !== null) err(`${at}: применимых критериев нет — final_score должен быть null`);
    else if (expected !== null && (typeof fs_ !== 'number' || Math.abs(fs_ - expected) > 0.005))
      err(`${at}: final_score ${fs_}, по чек-листу должно быть ${expected}`);
    if (typeof fs_ === 'number' && round2(fs_) !== fs_) err(`${at}: final_score больше двух знаков после запятой`);
    if (r.score.critical_flag !== byId.critical.value) err(`${at}: critical_flag (${r.score.critical_flag}) ≠ critical (${byId.critical.value})`);
  }
}

if (dataset) {
  const lost = [...dataset.keys()].filter(id => !seen.has(id));
  if (lost.length) err(`Нет записей для ${lost.length} диалогов: ${lost.slice(0, 10).join(', ')}${lost.length > 10 ? '…' : ''}`);
}
if (isProd && doc.results.length !== 10) err(`prod: должно быть ровно 10 записей, сейчас ${doc.results.length}`);
if (!isProd && !datasetPath && doc.results.length !== 65) warn(`dev: ожидается 65 записей, сейчас ${doc.results.length}`);

report();

function report() {
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const e of errors) console.log(`✗ ${e}`);
  console.log(`\nЗаписей: ${doc?.results?.length ?? 0} (ok: ${ok}, error: ${failed}). Ошибок: ${errors.length}, предупреждений: ${warnings.length}.`);
  console.log(errors.length ? 'НЕ ГОТОВО К PUSH' : 'Формат в порядке ✓');
  process.exit(errors.length ? 1 : 0);
}
