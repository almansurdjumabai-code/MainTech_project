/**
 * In-browser mock backend implementing docs/API_CONTRACT.md.
 * State persists in localStorage so appeals / checklist versions survive reloads.
 */
import { DEV_RECORDS, CONTROL_RECORDS, UNEVALUATED, FAIL_ONCE, MODELS } from './mock-data.js';
import { defaultChecklist } from '../core/default-checklist.js';
import { scoreEvaluation, maxStep, evaluationAnswers, round2 } from '../core/scoring.js';
import { storage, clone, seeded, conversationDuration } from '../core/utils.js';
import { ApiError } from './errors.js';

const DB_KEY = 'mockdb.v4';
const TRUTH = new Map([...DEV_RECORDS, ...CONTROL_RECORDS].map((r) => [r.conversation_id, r.truth]));
const DEFAULT_CL = defaultChecklist();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const latency = () => wait(120 + Math.random() * 160);
const now = () => new Date().toISOString();
let seq = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/** @type {any} */
let db = null;
/** @type {Map<string, any>} */
const jobs = new Map();

const strip = ({ truth, ...rec }) => rec;

function persist() { storage.set(DB_KEY, db); }

function load() {
  if (db) return db;
  db = storage.get(DB_KEY, null);
  if (!db) seed();
  return db;
}

function upsertRecords(records, dataset) {
  records.forEach((r) => {
    const rec = { ...strip(r), dataset };
    if (!db.conversations[rec.conversation_id]) db.order.push(rec.conversation_id);
    db.conversations[rec.conversation_id] = rec;
  });
}

function seed() {
  db = { conversations: {}, order: [], checklists: [DEFAULT_CL], evaluations: {}, latest: {}, appeals: [], failed: {} };
  upsertRecords(DEV_RECORDS, 'DEV');
  const base = Date.now() - 1000 * 60 * 60 * 5;
  db.order.forEach((id, i) => {
    if (UNEVALUATED.includes(id)) return;
    const ev = buildEvaluation(db.conversations[id], DEFAULT_CL, MODELS[0].id, new Date(base + i * 1000 * 60 * 7).toISOString());
    storeEvaluation(ev);
  });
  // Seed appeals: one pending, one changed, one confirmed.
  const evOf = (id) => db.evaluations[db.latest[id]];
  const a1 = makeAppeal(evOf('p1-en-001'), 'c2', 'Клиент сразу описал задачу — перенос акций. Уточнять было нечего, ставить «Нет» несправедливо.', base + 3600e3);
  const a2 = makeAppeal(evOf('p1-kz-002'), 'c1', 'В профиле клиента выбран русский язык обслуживания — приветствие на русском корректно.', base + 3000e3);
  applyDecision(a2, { action: 'change', newValue: 'yes', reason: 'Подтверждено по CRM: язык обслуживания клиента — русский.' }, base + 3300e3);
  const a3 = makeAppeal(evOf('p1-en-002'), 'c8', 'Фраза резкая, но это не оскорбление.', base + 2000e3);
  applyDecision(a3, { action: 'confirm', newValue: null, reason: 'Пренебрежительный тон в ответ на жалобу — квалифицируется как оскорбление клиента.' }, base + 2400e3);
  db.appeals.push(a1, a2, a3);
  persist();
}

/* ───────────────────────── evaluation engine (mock) ───────────────────────── */

function quoteOf(text) {
  const s = String(text || '');
  const cut = s.search(/[.!?](\s|$)/);
  const q = cut > 12 && cut < 110 ? s.slice(0, cut + 1) : s.length > 90 ? s.slice(0, 90).replace(/\s+\S*$/, '') : s;
  return q.trim();
}

function mapAnswer(c, tr) {
  let a = tr.a;
  const def = DEFAULT_CL.criteria.find((d) => d.id === c.id);
  const ratio = typeof a === 'number' ? (def && def.type === 'scale' ? a / maxStep(def) : 1) : null;
  if (c.type === 'scale') {
    const steps = (c.scale || []).map((s) => Number(s.value)).sort((x, y) => x - y);
    const top = steps[steps.length - 1] ?? 0;
    if (a === 'yes') a = top;
    else if (a === 'no') a = steps[0] ?? 0;
    else if (typeof a === 'number') {
      const target = ratio * top;
      a = steps.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), steps[0] ?? 0);
    }
  } else if (c.type === 'binary' && typeof a === 'number') {
    a = ratio >= 0.5 ? 'yes' : 'no';
  }
  let note = '';
  if (a === 'na' && !c.allowNA) { a = 'yes'; note = ' N/A не разрешён в этой версии чек-листа: нарушения не было, критерий засчитан.'; }
  return { a, note };
}

function buildEvaluation(conv, checklist, modelId, createdAt = now()) {
  const truth = TRUTH.get(conv.conversation_id) || {};
  const model = MODELS.find((m) => m.id === modelId) || MODELS[0];
  const rnd = seeded(conv.conversation_id + checklist.id + model.id);
  const tr = conv.transcript;
  const firstOp = Math.max(0, tr.findIndex((m) => m.speaker === 'operator'));
  const confShift = model.kind === 'local' ? -0.07 : model.id.includes('haiku') ? -0.03 : 0;

  const answers = {};
  const details = checklist.criteria.map((c) => {
    const t = truth[c.id];
    let answer; let ev; let range = null; let why; let conf; let naReason = null;
    if (t) {
      const m = mapAnswer(c, t);
      answer = m.a;
      ev = t.ev;
      why = t.why + m.note;
      if (answer === 'no' && ev.length) why += ` Основание — #${ev.join(', #')}.`;
      conf = Math.max(0.3, Math.min(0.99, t.conf + confShift));
      if (answer === 'na') naReason = t.na || t.why;
      if (t.range) range = { from: t.range[0], to: t.range[1] };
      else if (answer === 'no' && ev.length) range = { from: Math.max(0, Math.min(...ev) - 1), to: Math.max(...ev) };
    } else {
      answer = c.type === 'flag' ? 'no' : c.type === 'scale' ? Math.max(...(c.scale || [{ value: 0 }]).map((s) => Number(s.value))) : 'yes';
      ev = [firstOp];
      range = { from: 0, to: tr.length - 1 };
      why = `Критерий «${c.title}» нет в эталонной разметке mock-данных — ответ получен эвристикой. Подключите бэкенд, чтобы его оценила модель.`;
      conf = 0.55;
    }
    answers[c.id] = answer;
    return {
      criterionId: c.id,
      answer,
      explanation: why,
      evidence: ev.filter((i) => tr[i]).map((i) => ({ messageIndex: i, quote: quoteOf(tr[i].text) })),
      checkedRange: range,
      naReason,
      confidence: round2(conf),
    };
  });

  const sc = scoreEvaluation(checklist, answers);
  const criteria = details.map((d) => {
    const r = sc.rows.find((x) => x.criterionId === d.criterionId);
    return { ...d, points: round2(r.points), maxPoints: r.maxPoints, effectiveWeight: round2(r.effectiveWeight) };
  });
  const chars = tr.reduce((s, m) => s + m.text.length, 0);
  const tokensIn = Math.round(1500 + chars / 3.1 + checklist.criteria.length * 120);
  const tokensOut = Math.round(checklist.criteria.length * (95 + rnd() * 40));
  const durationMs = Math.round(model.avgMs * (0.78 + rnd() * 0.45));
  const costUsd = round2(model.costUsd * (tokensIn + tokensOut * 4) / 6800 * 1000) / 1000;

  return {
    evaluationId: nextId('ev'),
    conversationId: conv.conversation_id,
    checklistId: checklist.id,
    checklistVersion: checklist.version,
    model: model.id,
    createdAt,
    durationMs,
    costUsd,
    tokens: { in: tokensIn, out: tokensOut },
    criteria,
    sections: sc.sections.map((s) => ({ section: s.section, score: s.points, max: s.max })),
    total: sc.total,
    originalTotal: sc.total,
    totalComputable: sc.computable,
    grossViolation: sc.gross,
    overrides: {},
    audit: [{ at: createdAt, actor: model.name, action: 'evaluated', details: `v${checklist.version} · ${sc.total == null ? '—' : sc.total.toFixed(2)}` }],
    rawModelOutput: {
      model: model.id,
      checklist_version: checklist.version,
      results: details.map((d) => ({
        id: d.criterionId, answer: d.answer, confidence: d.confidence,
        evidence_message_ids: d.evidence.map((e) => e.messageIndex),
        checked_range: d.checkedRange ? [d.checkedRange.from, d.checkedRange.to] : null,
        na_reason: d.naReason, rationale: d.explanation,
      })),
      gross_violation: sc.gross,
      usage: { input_tokens: tokensIn, output_tokens: tokensOut },
      stop_reason: 'end_turn',
    },
  };
}

function storeEvaluation(ev) {
  db.evaluations[ev.evaluationId] = ev;
  db.latest[ev.conversationId] = ev.evaluationId;
}

function recomputeFinal(ev) {
  const cl = db.checklists.find((c) => c.id === ev.checklistId) || DEFAULT_CL;
  const { final } = evaluationAnswers(ev);
  const sc = scoreEvaluation(cl, final);
  ev.total = sc.total;
  ev.totalComputable = sc.computable;
  ev.grossViolation = sc.gross;
  ev.sections = sc.sections.map((s) => ({ section: s.section, score: s.points, max: s.max }));
}

/* ───────────────────────── appeals ───────────────────────── */

function makeAppeal(ev, criterionId, comment, at = Date.now()) {
  const c = ev.criteria.find((x) => x.criterionId === criterionId);
  const iso = new Date(at).toISOString();
  ev.audit.push({ at: iso, actor: 'QA', action: 'appeal', details: `${criterionId}: ${comment}` });
  return {
    id: nextId('ap'),
    evaluationId: ev.evaluationId,
    conversationId: ev.conversationId,
    criterionId,
    originalAnswer: ev.overrides?.[criterionId]?.answer ?? c?.answer ?? null,
    comment,
    status: 'submitted',
    createdAt: iso,
    history: [{ at: iso, status: 'submitted', actor: 'QA' }],
    decision: null,
    aiReview: null,
  };
}

function applyDecision(ap, { action, newValue, reason }, at = Date.now()) {
  const ev = db.evaluations[ap.evaluationId];
  const iso = new Date(at).toISOString();
  const before = ev.total;
  if (action === 'change') {
    ev.overrides = ev.overrides || {};
    ev.overrides[ap.criterionId] = { answer: newValue, reason, by: 'Проверяющий', at: iso, appealId: ap.id, previous: ap.originalAnswer };
    recomputeFinal(ev);
  }
  ap.status = action === 'change' ? 'changed' : 'confirmed';
  ap.decision = { action, newValue: action === 'change' ? newValue : null, reason, by: 'Проверяющий', at: iso, totalBefore: before, totalAfter: ev.total };
  if (!ap.history.some((h) => h.status === 'in_review')) ap.history.push({ at: iso, status: 'in_review', actor: 'Проверяющий' });
  ap.history.push({ at: iso, status: ap.status, actor: 'Проверяющий' });
  ev.audit.push({ at: iso, actor: 'Проверяющий', action: action === 'change' ? 'changed' : 'confirmed', details: `${ap.criterionId}: ${reason}` });
  return ev;
}

/* ───────────────────────── list helpers ───────────────────────── */

function listItem(conv) {
  const ev = db.evaluations[db.latest[conv.conversation_id]] || null;
  const appeals = db.appeals.filter((a) => a.conversationId === conv.conversation_id);
  const open = appeals.find((a) => a.status === 'submitted' || a.status === 'in_review');
  return {
    conversation_id: conv.conversation_id,
    channel: conv.channel,
    language: conv.language,
    audio_url: conv.audio_url,
    dataset: conv.dataset,
    messages: conv.transcript.length,
    duration: conversationDuration(conv),
    evaluation: ev ? (({ rawModelOutput, ...rest }) => rest)(ev) : null,
    appealStatus: open ? open.status : appeals.length ? appeals[appeals.length - 1].status : null,
  };
}

const findAppeal = (id) => {
  const a = db.appeals.find((x) => x.id === id);
  if (!a) throw new ApiError('Апелляция не найдена', 404);
  return a;
};

/* ───────────────────────── adapter ───────────────────────── */

export const mockApi = {
  mode: 'mock',

  async health() { await wait(60); return { ok: true, mode: 'mock' }; },

  async getDataset(groupId) {
    load(); await latency(); await wait(350);
    const g = String(groupId || '').trim().toUpperCase();
    const recs = g === 'DEV' ? DEV_RECORDS : g === 'CONTROL' ? CONTROL_RECORDS : null;
    if (!recs) throw new ApiError(`Набор ${g || '(пусто)'} не найден`, 404);
    upsertRecords(recs, g);
    persist();
    return { error: '', isSuccess: true, data: { dataset_group_id: g, total_records: recs.length, records: recs.map(strip) } };
  },

  async listConversations() {
    load(); await latency();
    return clone(db.order.map((id) => listItem(db.conversations[id])));
  },

  async getConversation(id) {
    load(); await latency();
    const conv = db.conversations[id];
    if (!conv) throw new ApiError(`Диалог ${id} не найден`, 404);
    const ev = db.evaluations[db.latest[id]] || null;
    return clone({ conversation: conv, evaluation: ev });
  },

  async importConversations(records) {
    load(); await latency();
    if (!Array.isArray(records) || !records.length) throw new ApiError('В файле нет записей', 400);
    records.forEach((r, i) => {
      if (!r.conversation_id || !Array.isArray(r.transcript)) throw new ApiError(`Запись #${i + 1}: нужны conversation_id и transcript[]`, 400);
    });
    upsertRecords(records.map((r) => ({ channel: 'agent chat', language: 'RU', audio_url: null, ...r })), 'IMPORT');
    persist();
    return { imported: records.length, ids: records.map((r) => r.conversation_id) };
  },

  async listChecklists() { load(); await latency(); return clone(db.checklists); },

  async saveChecklist(cl) {
    load(); await latency();
    const version = Math.max(0, ...db.checklists.map((c) => c.version)) + 1;
    const saved = { ...clone(cl), id: `cl_v${version}`, version, createdAt: now(), active: false };
    db.checklists.push(saved);
    persist();
    return clone(saved);
  },

  async activateChecklist(id) {
    load(); await latency();
    if (!db.checklists.some((c) => c.id === id)) throw new ApiError('Версия не найдена', 404);
    db.checklists.forEach((c) => { c.active = c.id === id; });
    persist();
    return clone(db.checklists.find((c) => c.id === id));
  },

  async listModels() { await latency(); return clone(MODELS); },

  async startEvaluation({ conversationIds, checklistId, model }) {
    load(); await latency();
    const cl = db.checklists.find((c) => c.id === checklistId) || db.checklists.find((c) => c.active);
    if (!cl) throw new ApiError('Чек-лист не найден', 404);
    const jobId = nextId('job');
    const job = {
      jobId, checklistId: cl.id, model, status: 'running', startedAt: now(),
      total: conversationIds.length, done: 0, failed: 0,
      items: conversationIds.map((id) => ({ conversationId: id, status: 'queued', stage: 0, evaluationId: null, error: null })),
    };
    jobs.set(jobId, job);
    const batch = conversationIds.length > 1;
    const queue = [...job.items];
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        it.status = 'running';
        const stepMs = 260 + Math.random() * 240;
        for (let s = 1; s <= 4; s++) { await wait(stepMs); it.stage = s; }
        const conv = db.conversations[it.conversationId];
        const failNow = batch && FAIL_ONCE.includes(it.conversationId) && !db.failed[it.conversationId];
        if (!conv || failNow) {
          if (failNow) { db.failed[it.conversationId] = true; persist(); }
          it.status = 'error';
          it.error = conv ? 'Модель вернула невалидный JSON (timeout 30s)' : 'Диалог не найден';
          job.failed++;
        } else {
          const ev = buildEvaluation(conv, cl, model);
          storeEvaluation(ev);
          persist();
          it.status = 'done'; it.stage = 5; it.evaluationId = ev.evaluationId;
          job.done++;
        }
        if (job.done + job.failed === job.total) { job.status = 'done'; job.finishedAt = now(); }
      }
    };
    for (let i = 0; i < Math.min(3, conversationIds.length); i++) worker();
    return { jobId };
  },

  async getJob(jobId) {
    await wait(40);
    const job = jobs.get(jobId);
    if (!job) throw new ApiError('Задача не найдена', 404);
    const elapsed = Date.now() - Date.parse(job.startedAt);
    const fin = job.done + job.failed;
    const etaMs = fin ? Math.round((elapsed / fin) * (job.total - fin)) : null;
    return clone({ ...job, etaMs });
  },

  async getEvaluation(id) {
    load(); await latency();
    const ev = db.evaluations[id];
    if (!ev) throw new ApiError('Оценка не найдена', 404);
    return clone(ev);
  },

  async listEvaluations(conversationId) {
    load(); await latency();
    return clone(Object.values(db.evaluations).filter((e) => e.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  },

  async createAppeal({ evaluationId, criterionId, comment }) {
    load(); await latency();
    const ev = db.evaluations[evaluationId];
    if (!ev) throw new ApiError('Оценка не найдена', 404);
    if (db.appeals.some((a) => a.evaluationId === evaluationId && a.criterionId === criterionId && ['submitted', 'in_review'].includes(a.status))) {
      throw new ApiError('По этому критерию уже есть открытая апелляция', 409);
    }
    const ap = makeAppeal(ev, criterionId, comment);
    db.appeals.push(ap);
    persist();
    return clone(ap);
  },

  async listAppeals(status) {
    load(); await latency();
    const list = status ? db.appeals.filter((a) => a.status === status) : db.appeals;
    return clone([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  },

  async takeAppeal(id) {
    load(); await latency();
    const ap = findAppeal(id);
    if (ap.status === 'submitted') {
      ap.status = 'in_review';
      ap.history.push({ at: now(), status: 'in_review', actor: 'Проверяющий' });
      persist();
    }
    return clone(ap);
  },

  async decideAppeal(id, body) {
    load(); await latency();
    const ap = findAppeal(id);
    if (!['submitted', 'in_review'].includes(ap.status)) throw new ApiError('Решение уже принято', 409);
    if (!String(body.reason || '').trim()) throw new ApiError('Укажите причину решения', 400);
    const ev = applyDecision(ap, body);
    persist();
    return clone({ appeal: ap, evaluation: ev });
  },

  async aiReview(id) {
    load(); await wait(1400 + Math.random() * 600);
    const ap = findAppeal(id);
    const ev = db.evaluations[ap.evaluationId];
    const c = ev.criteria.find((x) => x.criterionId === ap.criterionId);
    const cl = db.checklists.find((x) => x.id === ev.checklistId) || DEFAULT_CL;
    const crit = cl.criteria.find((x) => x.id === ap.criterionId);
    let answer = c.answer; let explanation; let confidence;
    if (c.confidence < 0.78) {
      if (answer === 'no') answer = crit?.allowNA ? 'na' : 'yes';
      else if (answer === 'yes') answer = 'no';
      else if (answer === 'na') answer = 'yes';
      else if (typeof answer === 'number' && crit) {
        const steps = crit.scale.map((s) => Number(s.value)).sort((a, b) => a - b);
        answer = steps[Math.min(steps.length - 1, steps.indexOf(answer) + 1)];
      }
      explanation = `С учётом комментария апелляции («${ap.comment.slice(0, 80)}${ap.comment.length > 80 ? '…' : ''}») исходная оценка выглядит спорной: доказательство допускает другую трактовку. Рекомендую изменить оценку.`;
      confidence = 0.71;
    } else {
      explanation = 'Повторный анализ с учётом комментария апелляции подтверждает исходную оценку: доказательство однозначно соответствует условию критерия.';
      confidence = round2(Math.min(0.97, c.confidence + 0.02));
    }
    ap.aiReview = { answer, explanation, confidence, model: 'claude-opus-5-5', at: now(), agrees: answer === c.answer };
    persist();
    return clone(ap.aiReview);
  },

  /** Mock-only: wipe local state. */
  async reset() { storage.remove(DB_KEY); db = null; jobs.clear(); load(); },
};
