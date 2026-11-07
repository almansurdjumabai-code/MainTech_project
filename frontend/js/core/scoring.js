/**
 * Scoring rules — a pure mirror of the checklist PDF ("Порядок расчёта"):
 *  1. N/A only where allowed.
 *  2. Yes = full weight, No = 0. Scale: points = value / maxStep × weight (top step = full weight).
 *  3. N/A criteria are excluded; weights are redistributed: total = Σpoints / Σweights_applicable × 100.
 *  4. Round to 2 decimals. No applicable weighted criteria → total is not computed (null).
 *  5. Gross violations (type "flag") give no points and are reported separately.
 *
 * @typedef {'binary'|'scale'|'flag'} CriterionType
 * @typedef {{value:number, label:string}} ScaleStep
 * @typedef {Object} Criterion
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} section
 * @property {number} weight
 * @property {CriterionType} type
 * @property {boolean} allowNA
 * @property {string} naCondition
 * @property {ScaleStep[]} scale
 * @property {string} aiGuidance
 *
 * @typedef {Object} Checklist
 * @property {string} id
 * @property {number} version
 * @property {string} name
 * @property {string} createdAt
 * @property {boolean} active
 * @property {string[]} sections
 * @property {Criterion[]} criteria
 *
 * @typedef {'yes'|'no'|'na'|number} Answer
 *
 * @typedef {Object} ScoreRow
 * @property {string} criterionId
 * @property {CriterionType} type
 * @property {string} section
 * @property {number} weight            original weight
 * @property {Answer|null} answer       normalized answer
 * @property {boolean} applicable       counts toward the total
 * @property {boolean} na
 * @property {boolean} missing          no answer given
 * @property {number} points            points in original weight units
 * @property {number} maxPoints         = weight when applicable
 * @property {number} effectiveWeight   weight after N/A redistribution (sums to 100)
 * @property {number} effectivePoints   contribution to the 0–100 total
 * @property {string|null} warning      'na_not_allowed' | 'invalid_answer'
 */

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** @param {Criterion} c */
export function maxStep(c) {
  const vals = (c.scale || []).map((s) => Number(s.value)).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : 0;
}

/**
 * Normalize model / human answers ("Да", "N/A", "15", 15 …).
 * @param {unknown} a
 * @returns {Answer|null}
 */
export function normalizeAnswer(a) {
  if (a == null || a === '') return null;
  if (typeof a === 'number') return Number.isFinite(a) ? a : null;
  if (typeof a === 'boolean') return a ? 'yes' : 'no';
  const s = String(a).trim().toLowerCase();
  if (['yes', 'да', 'иә', 'true', 'y'].includes(s)) return 'yes';
  if (['no', 'нет', 'жоқ', 'false', 'n'].includes(s)) return 'no';
  if (['na', 'n/a', 'н/п', 'n.a.', 'not applicable'].includes(s)) return 'na';
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Points of one criterion in its own weight units.
 * @param {Criterion} c
 * @param {unknown} rawAnswer
 */
export function criterionPoints(c, rawAnswer) {
  const answer = normalizeAnswer(rawAnswer);
  const w = Math.max(0, Number(c.weight) || 0);
  const base = { answer, applicable: false, na: false, missing: false, points: 0, maxPoints: 0, warning: null };
  if (c.type === 'flag') return { ...base, missing: answer == null };
  if (answer == null) return { ...base, missing: true };
  if (answer === 'na') {
    if (c.allowNA) return { ...base, na: true };
    return { ...base, applicable: true, maxPoints: w, warning: 'na_not_allowed' };
  }
  if (c.type === 'scale') {
    const m = maxStep(c);
    if (answer === 'yes') return { ...base, applicable: true, points: w, maxPoints: w };
    if (answer === 'no') return { ...base, applicable: true, points: 0, maxPoints: w };
    const v = Math.min(Math.max(answer, 0), m);
    const onStep = (c.scale || []).some((s) => Number(s.value) === answer);
    return { ...base, applicable: true, points: m > 0 ? (v / m) * w : 0, maxPoints: w, warning: onStep ? null : 'invalid_answer' };
  }
  // binary
  if (answer === 'yes') return { ...base, applicable: true, points: w, maxPoints: w };
  if (answer === 'no') return { ...base, applicable: true, points: 0, maxPoints: w };
  return { ...base, applicable: true, points: 0, maxPoints: w, warning: 'invalid_answer' };
}

/**
 * Score a set of answers against a checklist.
 * @param {Checklist} checklist
 * @param {Record<string, unknown>} answers criterionId → answer
 */
export function scoreEvaluation(checklist, answers) {
  const criteria = checklist?.criteria || [];
  const partial = criteria.map((c) => ({ c, r: criterionPoints(c, answers?.[c.id]) }));
  const applicableWeight = partial.reduce((s, { r }) => s + (r.applicable ? r.maxPoints : 0), 0);
  const rawPoints = partial.reduce((s, { r }) => s + (r.applicable ? r.points : 0), 0);
  const computable = applicableWeight > 0;
  const total = computable ? round2((rawPoints / applicableWeight) * 100) : null;

  /** @type {ScoreRow[]} */
  const rows = partial.map(({ c, r }) => ({
    criterionId: c.id,
    type: c.type,
    section: c.section,
    weight: c.type === 'flag' ? 0 : Math.max(0, Number(c.weight) || 0),
    answer: r.answer,
    applicable: r.applicable,
    na: r.na,
    missing: r.missing,
    points: r.points,
    maxPoints: r.maxPoints,
    effectiveWeight: computable && r.applicable ? (r.maxPoints / applicableWeight) * 100 : 0,
    effectivePoints: computable && r.applicable ? (r.points / applicableWeight) * 100 : 0,
    warning: r.warning,
  }));

  const order = [...(checklist?.sections || [])];
  criteria.forEach((c) => { if (!order.includes(c.section)) order.push(c.section); });
  const sections = order
    .map((section) => {
      const rs = rows.filter((r) => r.section === section && r.type !== 'flag');
      if (!rs.length) return null;
      const points = rs.reduce((s, r) => s + r.effectivePoints, 0);
      const max = rs.reduce((s, r) => s + r.effectiveWeight, 0);
      return { section, points: round2(points), max: round2(max), score: max > 0 ? round2((points / max) * 100) : null };
    })
    .filter(Boolean);

  const gross = rows.some((r) => r.type === 'flag' && r.answer === 'yes');
  const naWeight = rows.reduce((s, r) => s + (r.na ? r.weight : 0), 0);
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);

  return { total, computable, gross, rows, sections, applicableWeight, rawPoints, naWeight, totalWeight };
}

/**
 * Validate a checklist draft for the editor.
 * @param {Checklist} cl
 * @returns {{weightSum:number, ok:boolean, issues:{level:'error'|'warn', key:string, vars?:object, criterionId?:string}[]}}
 */
export function validateChecklist(cl) {
  const issues = [];
  const criteria = cl?.criteria || [];
  const weightSum = round2(criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0));
  if (!criteria.length) issues.push({ level: 'error', key: 'val.empty' });
  if (weightSum !== 100) issues.push({ level: 'warn', key: 'val.weightSum', vars: { sum: weightSum } });
  const ids = new Set();
  criteria.forEach((c) => {
    if (ids.has(c.id)) issues.push({ level: 'error', key: 'val.dupId', vars: { id: c.id }, criterionId: c.id });
    ids.add(c.id);
    if (!String(c.title || '').trim()) issues.push({ level: 'error', key: 'val.noTitle', criterionId: c.id });
    if (c.type === 'scale') {
      const vals = (c.scale || []).map((s) => Number(s.value));
      if (vals.length < 2) issues.push({ level: 'error', key: 'val.scaleSteps', criterionId: c.id });
      if (new Set(vals).size !== vals.length) issues.push({ level: 'error', key: 'val.scaleDup', criterionId: c.id });
      if (vals.some((v) => !Number.isFinite(v) || v < 0)) issues.push({ level: 'error', key: 'val.scaleValue', criterionId: c.id });
    }
    if (c.type !== 'flag' && !(Number(c.weight) > 0)) issues.push({ level: 'warn', key: 'val.zeroWeight', criterionId: c.id, vars: { title: c.title } });
    if (c.allowNA && !String(c.naCondition || '').trim()) issues.push({ level: 'warn', key: 'val.naCondition', criterionId: c.id, vars: { title: c.title } });
  });
  return { weightSum, ok: !issues.some((i) => i.level === 'error'), issues };
}

/**
 * Field-level diff between two checklist versions.
 * @param {Checklist|null} prev @param {Checklist} next
 * @returns {{kind:'added'|'removed'|'changed', id:string, title:string, fields?:string[]}[]}
 */
export function diffChecklists(prev, next) {
  const out = [];
  const p = new Map((prev?.criteria || []).map((c) => [c.id, c]));
  const n = new Map((next?.criteria || []).map((c) => [c.id, c]));
  const FIELDS = ['title', 'description', 'section', 'weight', 'type', 'allowNA', 'naCondition', 'scale', 'aiGuidance'];
  n.forEach((c, id) => {
    const o = p.get(id);
    if (!o) { out.push({ kind: 'added', id, title: c.title }); return; }
    const fields = FIELDS.filter((f) => JSON.stringify(o[f] ?? null) !== JSON.stringify(c[f] ?? null));
    if (fields.length) out.push({ kind: 'changed', id, title: c.title, fields });
  });
  p.forEach((c, id) => { if (!n.has(id)) out.push({ kind: 'removed', id, title: c.title }); });
  const po = (prev?.criteria || []).map((c) => c.id).filter((id) => n.has(id));
  const no = (next?.criteria || []).map((c) => c.id).filter((id) => p.has(id));
  if (po.join() !== no.join()) out.push({ kind: 'changed', id: '*', title: '', fields: ['order'] });
  return out;
}

/**
 * Merge AI answers with reviewer overrides.
 * @param {{criteria:{criterionId:string, answer:any}[], overrides?:Record<string,{answer:any}>}} evaluation
 * @returns {{ai: Record<string, any>, final: Record<string, any>}}
 */
export function evaluationAnswers(evaluation) {
  const ai = {};
  (evaluation?.criteria || []).forEach((c) => { ai[c.criterionId] = c.answer; });
  const final = { ...ai };
  Object.entries(evaluation?.overrides || {}).forEach(([id, o]) => { final[id] = o.answer; });
  return { ai, final };
}
