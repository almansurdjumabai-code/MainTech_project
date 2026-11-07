// Тесты движка скоринга. Запуск: node --test "qa/*.test.mjs"
// По умолчанию проверяется эталон. Чтобы проверить движок команды:
//   CQA_ENGINE=./path/to/engine.mjs node --test "qa/*.test.mjs"
// Движок должен экспортировать computeScore(checklist, answers) → { total, gross, items[] }
// (или напишите тонкий адаптер под этот интерфейс).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import * as reference from './scoring.reference.mjs';

const engine = process.env.CQA_ENGINE
  ? await import(pathToFileURL(path.resolve(process.env.CQA_ENGINE)).href)
  : reference;
const { computeScore } = engine;
const { DEFAULT_CHECKLIST: CL } = reference;

const ALL_YES = { c01: 'yes', c02: 'yes', c03: 'yes', c04: 20, c05: 'yes', c06: 10, c07: 'yes', c08: 'no' };
const withA = patch => ({ ...ALL_YES, ...patch });
const pts = (res, id) => res.items.find(i => i.id === id);

// 1. Все критерии «да»
test('все «да» и верхние ступени → 100', () => {
  assert.equal(computeScore(CL, ALL_YES).total, 100);
});

test('все «нет» и нижние ступени → 0, а не null', () => {
  const r = computeScore(CL, { c01: 'no', c02: 'no', c03: 'no', c04: 0, c05: 'no', c06: 0, c07: 'no', c08: 'no' });
  assert.equal(r.total, 0);
});

// 2. Один N/A и перераспределение весов
test('N/A у идентификации (вес 20), остальное максимум → 100', () => {
  assert.equal(computeScore(CL, withA({ c03: 'na' })).total, 100);
});

test('N/A у идентификации: веса перераспределены пропорционально, сумма 100', () => {
  const r = computeScore(CL, withA({ c03: 'na' }));
  assert.equal(pts(r, 'c01').effectiveWeight, 12.5);
  assert.equal(pts(r, 'c04').effectiveWeight, 25);
  assert.equal(pts(r, 'c07').effectiveWeight, 6.25);
  assert.equal(pts(r, 'c03').points, null);
  const sum = r.items.reduce((s, i) => s + i.effectiveWeight, 0);
  assert.ok(Math.abs(sum - 100) < 0.02, `сумма весов ${sum}`);
});

test('N/A у идентификации + «нет» за контакт → 70/80 = 87.5', () => {
  assert.equal(computeScore(CL, withA({ c03: 'na', c01: 'no' })).total, 87.5);
});

test('N/A не уменьшает итог по сравнению с «да» (частая ошибка: N/A = 0)', () => {
  const r = computeScore(CL, withA({ c07: 'na' }));
  assert.equal(r.total, 100);
});

// 3. Все N/A
test('все применимые критерии N/A → итог не считается (null, не 0 и не NaN)', () => {
  const allNa = { criteria: CL.criteria.map(c => ({ ...c, naAllowed: c.type !== 'flag' })) };
  const ans = Object.fromEntries(allNa.criteria.map(c => [c.id, c.type === 'flag' ? 'no' : 'na']));
  const r = computeScore(allNa, ans);
  assert.equal(r.total, null);
});

test('в базовом чек-листе N/A у контакта (c01) запрещён', () => {
  assert.throws(() => computeScore(CL, withA({ c01: 'na' })));
});

test('в базовом чек-листе N/A у ведения диалога (c06) запрещён', () => {
  assert.throws(() => computeScore(CL, withA({ c06: 'na' })));
});

// 4. Округление
test('N/A у потребности + «нет» за контакт → 75/85 = 88.235… → 88.24', () => {
  assert.equal(computeScore(CL, withA({ c02: 'na', c01: 'no' })).total, 88.24);
});

test('N/A у завершения + ведение 7 → 90.5/95 = 95.263… → 95.26', () => {
  assert.equal(computeScore(CL, withA({ c07: 'na', c06: 7 })).total, 95.26);
});

test('итог имеет не больше двух знаков после запятой', () => {
  const t = computeScore(CL, withA({ c02: 'na', c03: 'na', c06: 4, c01: 'no' })).total;
  assert.equal(t, Math.round(t * 100) / 100);
});

test('round2 не теряет половинки из-за float', () => {
  assert.equal(reference.round2(1.005), 1.01);
});

// 5. Шкальные критерии на каждой ступени
for (const [step, expected] of [[0, 80], [5, 85], [10, 90], [15, 95], [20, 100]]) {
  test(`консультация (0–20, вес 20) = ${step} → ${expected}`, () => {
    const r = computeScore(CL, withA({ c04: step }));
    assert.equal(r.total, expected);
    assert.equal(pts(r, 'c04').points, step);
  });
}

for (const [step, points, expected] of [[0, 0, 85], [4, 6, 91], [7, 10.5, 95.5], [10, 15, 100]]) {
  test(`ведение диалога (0–10, вес 15) = ${step} → ${points} баллов, итог ${expected}`, () => {
    const r = computeScore(CL, withA({ c06: step }));
    assert.equal(r.total, expected);
    assert.equal(pts(r, 'c06').points, points);
  });
}

test('шкала + N/A вместе: консультация 15, идентификация N/A → 75/80 = 93.75', () => {
  assert.equal(computeScore(CL, withA({ c04: 15, c03: 'na' })).total, 93.75);
});

test('значение вне ступеней шкалы отклоняется (12 для 0–20, 5 для 0–10)', () => {
  assert.throws(() => computeScore(CL, withA({ c04: 12 })));
  assert.throws(() => computeScore(CL, withA({ c06: 5 })));
});

// 6. Грубая ошибка не меняет баллы
test('грубая ошибка помечается флагом, итог тот же', () => {
  const clean = computeScore(CL, ALL_YES);
  const dirty = computeScore(CL, withA({ c08: 'yes' }));
  assert.equal(dirty.gross, true);
  assert.equal(clean.gross, false);
  assert.equal(dirty.total, clean.total);
});

test('грубая ошибка не участвует в весах (сумма весов без неё = 100)', () => {
  const r = computeScore(CL, withA({ c08: 'yes' }));
  assert.ok(!r.items.some(i => i.id === 'c08'));
});

// 7. Замена критерия (контрольная проверка организаторов)
test('замена критерия: новый вес применяется, итог пересчитывается', () => {
  const replaced = {
    criteria: CL.criteria.map(c => c.id === 'c07'
      ? { id: 'c09', title: 'Новый критерий', type: 'scale', weight: 5, naAllowed: true, scale: [0, 1, 2], section: 'flow' }
      : c),
  };
  const { c07, ...rest } = ALL_YES;
  assert.equal(computeScore(replaced, { ...rest, c09: 1 }).total, 97.5);
  assert.equal(computeScore(replaced, { ...rest, c09: 'na' }).total, 100);
});
