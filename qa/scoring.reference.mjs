// Эталонный расчёт итога по чек-листу CQA (стр. 2, «Порядок расчёта»).
// Нужен QA как «оракул»: тесты сравнивают ваш движок с этим кодом.
// Без зависимостей, Node 18+.

export const DEFAULT_CHECKLIST = {
  id: 'cqa-default-v1',
  criteria: [
    { id: 'c01', title: 'Установление контакта', type: 'binary', weight: 10, naAllowed: false, section: 'start' },
    { id: 'c02', title: 'Выявление потребности', type: 'binary', weight: 15, naAllowed: true, section: 'start' },
    { id: 'c03', title: 'Идентификация', type: 'binary', weight: 20, naAllowed: true, section: 'security' },
    { id: 'c04', title: 'Корректная и полная консультация', type: 'scale', weight: 20, naAllowed: true, scale: [0, 5, 10, 15, 20], section: 'security' },
    { id: 'c05', title: 'Эмпатия и клиентоориентированность', type: 'binary', weight: 15, naAllowed: false, section: 'flow' },
    { id: 'c06', title: 'Управление диалогом, скорость и грамотность', type: 'scale', weight: 15, naAllowed: false, scale: [0, 4, 7, 10], section: 'flow' },
    { id: 'c07', title: 'Завершение', type: 'binary', weight: 5, naAllowed: true, section: 'flow' },
    { id: 'c08', title: 'Грубые ошибки', type: 'flag', weight: 0, naAllowed: false, section: 'gross' },
  ],
};

// Округление до 2 знаков без ошибки float (1.005 → 1.01, а не 1.00).
export function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * @param checklist  { criteria: [...] }
 * @param answers    { [criterionId]: 'yes' | 'no' | 'na' | number }
 * @returns { total: number|null, maxPoints: 100, gross: boolean, items: [...], sections: {...} }
 */
export function computeScore(checklist, answers) {
  const scored = checklist.criteria.filter(c => c.type !== 'flag');
  const flag = checklist.criteria.find(c => c.type === 'flag');

  const items = scored.map(c => {
    const a = answers[c.id];
    if (a === undefined) throw new Error(`${c.id}: нет ответа`);
    if (a === 'na') {
      if (!c.naAllowed) throw new Error(`${c.id}: N/A не разрешён`);
      return { id: c.id, weight: c.weight, applicable: false, raw: 0 };
    }
    let fraction;
    if (c.type === 'binary') {
      if (a !== 'yes' && a !== 'no') throw new Error(`${c.id}: ожидается yes/no`);
      fraction = a === 'yes' ? 1 : 0;
    } else if (c.type === 'scale') {
      if (typeof a !== 'number' || !c.scale.includes(a)) throw new Error(`${c.id}: ${a} не ступень шкалы ${c.scale.join('/')}`);
      fraction = a / Math.max(...c.scale); // верхняя ступень = полный вес
    } else {
      throw new Error(`${c.id}: неизвестный тип ${c.type}`);
    }
    return { id: c.id, weight: c.weight, applicable: true, raw: c.weight * fraction };
  });

  const applicable = items.filter(i => i.applicable && i.weight > 0);
  const applicableWeight = applicable.reduce((s, i) => s + i.weight, 0);
  const k = applicableWeight > 0 ? 100 / applicableWeight : 0; // перераспределение весов N/A

  for (const i of items) {
    i.effectiveWeight = i.applicable ? round2(i.weight * k) : 0;
    i.points = i.applicable ? round2(i.raw * k) : null;
  }

  // Итог считаем из несокращённых значений и округляем один раз в конце.
  const total = applicableWeight > 0 ? round2(applicable.reduce((s, i) => s + i.raw, 0) * k) : null;

  // Секции: доля набранного от применимого веса секции, в процентах.
  const sections = {};
  for (const c of scored) {
    const i = items.find(x => x.id === c.id);
    const s = (sections[c.section] ??= { raw: 0, weight: 0 });
    if (i.applicable) { s.raw += i.raw; s.weight += i.weight; }
  }
  for (const s of Object.values(sections)) s.percent = s.weight > 0 ? round2((s.raw / s.weight) * 100) : null;

  const gross = flag ? answers[flag.id] === 'yes' : false;
  return { total, maxPoints: 100, gross, items, sections };
}
