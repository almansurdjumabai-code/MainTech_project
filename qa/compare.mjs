// Сравнение ручной разметки (gold_labels.json) с оценками модели.
//
//   node qa/compare.mjs                      — только итоги ручной разметки
//   node qa/compare.mjs results/dev/results.json   — + расхождения с моделью
//
// Понимает официальный формат сдачи (schema 1.0) и два упрощённых:
//   { "p1-ru-006": { "c01": "yes", "c04": 20, ... }, ... }
//   [ { "conversation_id": "p1-ru-006", "answers": { "c01": "yes", ... } }, ... ]
// Значение может быть и объектом { "a": "yes" } / { "answer": "yes" } / { "value": 20 }.
// "N/A", "n/a", "да"/"нет" нормализуются.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScore, DEFAULT_CHECKLIST } from './scoring.reference.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(fs.readFileSync(path.join(here, 'gold_labels.json'), 'utf8'));

const norm = v => {
  if (v && typeof v === 'object') v = v.a ?? v.answer ?? v.value ?? v.score;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['yes', 'да', 'иә', 'true'].includes(s)) return 'yes';
    if (['no', 'нет', 'жоқ', 'false'].includes(s)) return 'no';
    if (['na', 'n/a', 'н/п', 'not applicable'].includes(s)) return 'na';
    if (!Number.isNaN(Number(s))) return Number(s);
  }
  return v;
};
const flat = ans => Object.fromEntries(Object.entries(ans).map(([k, v]) => [k, norm(v)]));

const ids = DEFAULT_CHECKLIST.criteria.map(c => c.id);
const goldRows = gold.dialogs.map(d => {
  const answers = flat(d.answers);
  return { ...d, answers, total: computeScore(DEFAULT_CHECKLIST, answers).total };
});

// Официальный формат сдачи (results.json, schema 1.0): коды критериев → c01..c08, true/false/null → yes/no/na.
const OFFICIAL = { contact: 'c01', discovery: 'c02', identification: 'c03', consultation: 'c04', empathy: 'c05', dialogue: 'c06', closure: 'c07', critical: 'c08' };
const fromOfficial = v => (v === true ? 'yes' : v === false ? 'no' : v === null ? 'na' : v);

let model = null;
if (process.argv[2]) {
  const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (raw && Array.isArray(raw.results)) {
    model = Object.fromEntries(raw.results.filter(r => r.status === 'ok').map(r => [
      r.conversation_id,
      Object.fromEntries(r.criteria.map(c => [OFFICIAL[c.criterion_id] ?? c.criterion_id, fromOfficial(c.value)])),
    ]));
  } else model = Array.isArray(raw)
    ? Object.fromEntries(raw.map(r => [r.conversation_id ?? r.id, flat(r.answers ?? r.criteria ?? r)]))
    : Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, flat(v.answers ?? v)]));
}

const show = v => (v === undefined ? '—' : String(v));
console.log('\nИТОГИ РУЧНОЙ РАЗМЕТКИ');
for (const g of goldRows) {
  const gross = g.answers.c08 === 'yes' ? ' ⚠ грубая ошибка' : '';
  console.log(`${g.id.padEnd(10)} ${g.lang} ${String(g.total).padStart(6)}${gross}  ${ids.map(i => show(g.answers[i])).join(' | ')}`);
}

if (model) {
  const perCrit = Object.fromEntries(ids.map(i => [i, { ok: 0, n: 0 }]));
  const diffs = [];
  let totalDiff = 0, totalN = 0;
  for (const g of goldRows) {
    const m = model[g.id];
    if (!m) { console.log(`\nнет оценки модели для ${g.id}`); continue; }
    for (const i of ids) {
      if (m[i] === undefined) continue;
      perCrit[i].n++;
      if (m[i] === g.answers[i]) perCrit[i].ok++;
      else diffs.push({ id: g.id, crit: i, gold: g.answers[i], model: m[i], ev: gold.dialogs.find(d => d.id === g.id).answers[i].ev, why: gold.dialogs.find(d => d.id === g.id).answers[i].why });
    }
    try {
      const mt = computeScore(DEFAULT_CHECKLIST, m).total;
      if (mt !== null && g.total !== null) { totalDiff += Math.abs(mt - g.total); totalN++; }
    } catch (e) { console.log(`${g.id}: оценка модели невалидна — ${e.message}`); }
  }
  console.log('\nСОВПАДЕНИЕ ПО КРИТЕРИЯМ');
  for (const i of ids) {
    const { ok, n } = perCrit[i];
    console.log(`${i}: ${ok}/${n}${n ? ` (${Math.round((ok / n) * 100)}%)` : ''}`);
  }
  if (totalN) console.log(`Средняя разница итога: ${(totalDiff / totalN).toFixed(2)} балла`);
  console.log('\nРАСХОЖДЕНИЯ ДЛЯ ML');
  for (const d of diffs) console.log(`${d.id} ${d.crit}: модель=${show(d.model)}, разметка=${show(d.gold)} — реплики ${d.ev.join(', ') || '—'}: ${d.why}`);
}
