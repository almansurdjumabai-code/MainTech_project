/** Dashboard metrics computed client-side from the conversation list. */
import { criterionPoints, evaluationAnswers, round2 } from './scoring.js';

const LANGS = ['RU', 'KZ', 'EN'];

/**
 * @param {any[]} conversations list items with `evaluation`
 * @param {any[]} appeals
 * @param {import('./scoring.js').Checklist|null} checklist active checklist (criteria to report on)
 */
export function computeStats(conversations, appeals, checklist) {
  const evaluated = conversations.filter((c) => c.evaluation && c.evaluation.total != null);
  const totals = evaluated.map((c) => c.evaluation.total);
  const avg = totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null;
  const avgAI = evaluated.length ? round2(evaluated.reduce((s, c) => s + (c.evaluation.originalTotal ?? c.evaluation.total), 0) / evaluated.length) : null;

  const histogram = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, count: 0 }));
  totals.forEach((v) => { histogram[Math.min(9, Math.floor(v / 10))].count++; });

  const byLang = LANGS.map((lang) => {
    const xs = evaluated.filter((c) => String(c.language).toUpperCase() === lang).map((c) => c.evaluation.total);
    return { lang, count: xs.length, avg: xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null };
  });
  const byChannel = ['chat', 'voice'].map((ch) => {
    const xs = evaluated.filter((c) => (/voice|call/i.test(c.channel) ? 'voice' : 'chat') === ch).map((c) => c.evaluation.total);
    return { channel: ch, count: xs.length, avg: xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null };
  });

  const criteria = (checklist?.criteria || []).filter((c) => c.type !== 'flag').map((crit) => {
    const cells = Object.fromEntries(LANGS.map((l) => [l, { sum: 0, n: 0, na: 0 }]));
    let na = 0; let seen = 0;
    evaluated.forEach((conv) => {
      const { final } = evaluationAnswers(conv.evaluation);
      if (!(crit.id in final)) return;
      seen++;
      const r = criterionPoints(crit, final[crit.id]);
      const cell = cells[String(conv.language).toUpperCase()];
      if (r.na) { na++; if (cell) cell.na++; return; }
      if (!r.applicable || !r.maxPoints) return;
      if (cell) { cell.sum += r.points / r.maxPoints; cell.n++; }
    });
    const all = Object.values(cells).reduce((a, c) => ({ sum: a.sum + c.sum, n: a.n + c.n }), { sum: 0, n: 0 });
    return {
      id: crit.id, title: crit.title,
      pass: all.n ? all.sum / all.n : null,
      naRate: seen ? na / seen : 0,
      byLang: Object.fromEntries(LANGS.map((l) => [l, cells[l].n ? cells[l].sum / cells[l].n : null])),
    };
  });

  const gross = evaluated.filter((c) => c.evaluation.grossViolation).length;
  const decided = appeals.filter((a) => a.status === 'confirmed' || a.status === 'changed');
  const changed = appeals.filter((a) => a.status === 'changed').length;
  const open = appeals.filter((a) => a.status === 'submitted' || a.status === 'in_review').length;

  return {
    total: conversations.length,
    evaluatedCount: evaluated.length,
    avg, avgAI, histogram, byLang, byChannel, criteria, gross,
    appeals: {
      total: appeals.length, open, decided: decided.length, changed,
      changeRate: decided.length ? changed / decided.length : null,
      aiAccuracy: decided.length ? 1 - changed / decided.length : null,
    },
    problems: [...criteria].filter((c) => c.pass != null).sort((a, b) => a.pass - b.pass).slice(0, 3),
    langs: LANGS,
  };
}
