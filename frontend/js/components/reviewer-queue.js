/**
 * Appeals: QA sees statuses of submitted appeals; Reviewer works the queue —
 * disputed score, comment, dialog fragment, AI evidence, AI second opinion, decision with reason.
 */
import { html, render, $, $$, fmtDate, fmtScore, round2 } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t, getLang } from '../core/i18n.js';
import { api } from '../api/client.js';
import { store, checklistById, activeChecklist } from '../core/store.js';
import { takeAppeal, decideAppeal } from '../core/actions.js';
import { convLink } from '../core/router.js';
import { evaluationAnswers, scoreEvaluation, maxStep } from '../core/scoring.js';
import * as Transcript from './transcript-view.js';
import { answerPill, appealBadge, appealTimeline, emptyState, skeleton, createOdometer, deltaChip, confidenceMeter } from './ui.js';
import { toast, errorToast } from './toast.js';
import { renderHero, meter } from './hero.js';
import { config } from '../config.js';

/** @param {HTMLElement} root @param {{id?:string|null}} props */
export function mount(root, props) {
  let filter = 'open';
  let selected = props.id || null;
  let detailToken = 0;
  let fragment = null;
  let justDecided = null; // {before, after}

  render(root, html`<div class="cqa-page">
    <div class="cqa-page__head"><div class="cqa-page__title">
      <span class="cqa-eyebrow">${t('appeals.eyebrow')}</span>
      <h1 class="cqa-display">${t('appeals.title')}</h1>
      <p class="cqa-lead" data-lead></p>
    </div>
    <div class="cqa-seg" role="group" aria-label="${t('appeals.filter')}" data-filter></div>
    <span class="cqa-page__index" aria-hidden="true">03</span></div>
    <div data-hero></div>
    <div class="cqa-queue"><div class="cqa-queue__list" data-list></div><div class="cqa-queue__detail" data-detail aria-live="polite"></div></div>
  </div>`);
  const $list = $(root, '[data-list]');
  const $detail = $(root, '[data-detail]');

  const isOpen = (a) => a.status === 'submitted' || a.status === 'in_review';
  const visible = () => store.get().appeals.filter((a) => (filter === 'open' ? isOpen(a) : filter === 'done' ? !isOpen(a) : true));
  const clFor = (ev) => (ev && checklistById(ev.checklistId)) || activeChecklist();
  const critTitle = (a) => {
    for (const cl of store.get().checklists) { const c = cl.criteria.find((x) => x.id === a.criterionId); if (c) return c.title; }
    return a.criterionId;
  };

  function drawHead() {
    const s = store.get();
    const open = s.appeals.filter(isOpen).length;
    $(root, '[data-lead]').textContent = s.role === 'reviewer' ? t('appeals.leadReviewer', { n: open }) : t('appeals.leadQa');
    const decided = s.appeals.filter((a) => !isOpen(a));
    const changed = decided.filter((a) => a.status === 'changed').length;
    renderHero(/** @type {HTMLElement} */ ($(root, '[data-hero]')), [
      { label: t('appeals.f.open'), value: open, tone: open ? 'amber' : undefined, sub: t('hero.queue') },
      { label: t('appeals.f.done'), value: decided.length, sub: meter(s.appeals.length ? decided.length / s.appeals.length : 0) },
      { label: t('hero.changed'), value: changed, sub: decided.length ? `${Math.round((changed / decided.length) * 100)}% ${t('hero.ofDecided')}` : '—' },
      { label: t('dash.accuracy'), value: decided.length ? Math.round((1 - changed / decided.length) * 100) : null, suffix: '%', tone: 'green', sub: t('hero.accuracySub') },
    ]);
    render($(root, '[data-filter]'), html`${['open', 'done', 'all'].map((f) => html`<button type="button" class="cqa-seg__btn ${filter === f ? 'is-active' : ''}" data-f="${f}">${t('appeals.f.' + f)}${f === 'open' && open ? html` <span class="cqa-nav__count">${open}</span>` : ''}</button>`)}`);
  }

  function drawList() {
    const list = visible();
    if (store.get().loading) { render($list, skeleton(4, 90)); return; }
    if (!list.length) { render($list, html`<div class="cqa-card">${emptyState({ title: t('appeals.empty'), text: t('appeals.emptyHint') })}</div>`); return; }
    render($list, html`${list.map((a) => html`<button type="button" class="cqa-queue__item ${a.id === selected ? 'is-selected' : ''}" data-id="${a.id}" aria-pressed="${a.id === selected}">
      <span class="cqa-row cqa-row--between"><span class="cqa-mono">${a.conversationId}</span>${appealBadge(a.status)}</span>
      <b style="font-size:14px">${critTitle(a)}</b>
      <span class="cqa-queue__comment">«${a.comment}»</span>
      <span class="cqa-small cqa-mute">${fmtDate(a.createdAt, getLang())}</span>
    </button>`)}`);
  }

  async function drawDetail() {
    const token = ++detailToken;
    fragment?.destroy(); fragment = null;
    const s = store.get();
    let ap = s.appeals.find((a) => a.id === selected);
    if (!ap) {
      render($detail, html`<div class="cqa-card">${emptyState({ title: t('appeals.pick'), text: s.role === 'reviewer' ? t('appeals.pickHintReviewer') : t('appeals.pickHintQa') })}</div>`);
      return;
    }
    render($detail, skeleton(5, 80));
    if (s.role === 'reviewer' && ap.status === 'submitted') {
      try { ap = await takeAppeal(ap.id); } catch (e) { errorToast(e); }
    }
    let data;
    try { data = await api.getConversation(ap.conversationId); } catch (e) {
      if (token === detailToken) render($detail, html`<div class="cqa-error-box">${icon('info')}<span>${e.message}</span></div>`);
      return;
    }
    if (token !== detailToken) return;
    const conv = data.conversation;
    const ev = data.evaluation && data.evaluation.evaluationId === ap.evaluationId ? data.evaluation : await api.getEvaluation(ap.evaluationId).catch(() => data.evaluation);
    if (token !== detailToken || !ev) return;
    const cl = clFor(ev);
    const c = cl.criteria.find((x) => x.id === ap.criterionId) || { id: ap.criterionId, title: ap.criterionId, type: 'binary', scale: [], allowNA: true };
    const d = ev.criteria.find((x) => x.criterionId === ap.criterionId) || {};
    const role = store.get().role;
    const open = isOpen(ap);
    const { ai, final } = evaluationAnswers(ev);
    const totalAI = scoreEvaluation(cl, ai).total;
    const totalFinal = scoreEvaluation(cl, final).total;
    const idxs = new Set();
    (d.evidence || []).forEach((e) => { for (let i = e.messageIndex - 2; i <= e.messageIndex + 2; i++) idxs.add(i); });
    if (d.checkedRange) for (let i = d.checkedRange.from; i <= d.checkedRange.to; i++) idxs.add(i);
    if (!idxs.size) for (let i = 0; i < Math.min(5, conv.transcript.length); i++) idxs.add(i);
    const only = [...idxs].filter((i) => i >= 0 && i < conv.transcript.length).sort((x, y) => x - y);
    const firstEv = d.evidence?.[0]?.messageIndex ?? only[0];

    const options = c.type === 'scale'
      ? [...c.scale].sort((x, y) => y.value - x.value).map((s2) => ({ v: Number(s2.value), label: `${s2.value} / ${maxStep(c)}`, title: s2.label }))
      : c.type === 'flag' ? [{ v: 'yes', label: t('answer.flagYes') }, { v: 'no', label: t('answer.flagNo') }]
        : [{ v: 'yes', label: t('answer.yes') }, { v: 'no', label: t('answer.no') }];
    if (c.allowNA && c.type !== 'flag') options.push({ v: 'na', label: 'N/A' });

    render($detail, html`
      <div class="cqa-card cqa-stack-y" style="gap:14px">
        <div class="cqa-row cqa-row--between cqa-row--wrap">
          <div class="cqa-stack-y" style="gap:4px"><span class="cqa-eyebrow">${t('appeals.disputed')} · ${cl.name} v${cl.version}</span><h2 class="cqa-h2" style="font-size:26px">${c.title}</h2></div>
          <a class="cqa-btn cqa-btn--secondary cqa-btn--sm" href="${convLink(conv.conversation_id, firstEv)}">${icon('external', { size: 16 })}${conv.conversation_id}</a>
        </div>
        ${appealTimeline(ap)}
      </div>

      <div class="cqa-panel-grid" style="margin:0">
        <div class="cqa-card cqa-card--line cqa-stack-y">
          <div class="cqa-row cqa-row--between"><span class="cqa-eyebrow">${t('appeals.aiScore')}</span>${answerPill(c, d.answer)}</div>
          <p>${d.explanation || ''}</p>
          ${d.naReason ? html`<p class="cqa-crit__na">${icon('info', { size: 16 })}${d.naReason}</p>` : ''}
          ${(d.evidence || []).map((e) => html`<div class="cqa-quote"><span class="cqa-mono cqa-mute">#${e.messageIndex}</span> ${e.quote}</div>`)}
          <div class="cqa-crit__meta">${confidenceMeter(d.confidence, config.LOW_CONFIDENCE)}</div>
        </div>
        <div class="cqa-card cqa-stack-y">
          <span class="cqa-eyebrow">${t('appeals.comment')} · QA · ${fmtDate(ap.createdAt, getLang())}</span>
          <p style="font-size:15px">«${ap.comment}»</p>
          <div data-second></div>
        </div>
      </div>

      <div class="cqa-stack-y" style="gap:8px"><span class="cqa-eyebrow">${t('appeals.fragment')} · ${t('card.messages', { n: only.length })}</span><div class="cqa-fragment" data-fragment></div></div>

      ${ap.decision || justDecided?.id === ap.id ? decisionResult(ap, c, d, totalAI, totalFinal) : ''}
      ${open && role === 'reviewer' ? html`<form class="cqa-card cqa-card--line cqa-stack-y" data-decision>
        <span class="cqa-eyebrow">${t('appeals.decision')}</span>
        <div class="cqa-decision-opts" role="radiogroup" aria-label="${t('appeals.decision')}">
          <label class="cqa-opt"><input type="radio" name="action" value="confirm" checked>${icon('check', { size: 16 })}${t('appeals.confirm')}</label>
          <label class="cqa-opt"><input type="radio" name="action" value="change">${icon('edit', { size: 16 })}${t('appeals.change')}</label>
        </div>
        <div data-newval hidden class="cqa-stack-y" style="gap:8px"><span class="cqa-field__label">${t('appeals.newValue')}</span>
          <div class="cqa-decision-opts" role="radiogroup">${options.filter((o) => JSON.stringify(o.v) !== JSON.stringify(final[c.id])).map((o, i) => html`<label class="cqa-opt" title="${o.title || ''}"><input type="radio" name="value" value="${o.v}" ${i === 0 ? 'checked' : ''}>${o.label}</label>`)}</div></div>
        <label class="cqa-field"><span class="cqa-field__label">${t('appeals.reason')} *</span><textarea class="cqa-textarea" name="reason" rows="3" required placeholder="${t('appeals.reasonPh')}"></textarea><span class="cqa-field__hint" data-reason-hint>${t('appeals.reasonHint')}</span></label>
        <div class="cqa-row cqa-row--between cqa-row--wrap"><span class="cqa-small cqa-muted">${t('appeals.currentTotal')}: <b class="cqa-num">${fmtScore(totalFinal)}</b></span>
          <button type="submit" class="cqa-btn cqa-btn--primary">${icon('gavel', { size: 16 })}${t('appeals.saveDecision')}</button></div>
      </form>` : ''}
      ${open && role !== 'reviewer' ? html`<div class="cqa-notice cqa-notice--info">${icon('info')}<span>${t('appeals.qaWaiting')}</span></div>` : ''}
    `);

    fragment = Transcript.mount(/** @type {HTMLElement} */ ($($detail, '[data-fragment]')), { conversation: conv, only });
    (d.evidence || []).forEach((e) => $($detail, `.cqa-msg[data-index="${e.messageIndex}"]`)?.classList.add('is-evidence'));
    if (d.checkedRange) for (let i = d.checkedRange.from; i <= d.checkedRange.to; i++) $($detail, `.cqa-msg[data-index="${i}"]`)?.classList.add('is-range');
    drawSecond(ap, c, d);

    const odoEl = $($detail, '[data-odo]');
    if (odoEl) {
      const odo = createOdometer(/** @type {HTMLElement} */ (odoEl));
      if (justDecided?.id === ap.id) { odo.set(justDecided.before); setTimeout(() => odo.set(justDecided.after), 350); }
      else odo.set(ap.decision?.totalAfter ?? totalFinal);
    }
  }

  function decisionResult(ap, c, d, totalAI, totalFinal) {
    const dec = ap.decision;
    const before = justDecided?.id === ap.id ? justDecided.before : dec?.totalBefore ?? totalAI;
    const after = justDecided?.id === ap.id ? justDecided.after : dec?.totalAfter ?? totalFinal;
    return html`<div class="cqa-vault cqa-stack-y" style="gap:16px">
      <div class="cqa-row cqa-row--between cqa-row--wrap"><span class="cqa-eyebrow">${t('appeals.finalResult')}</span>${appealBadge(ap.status)}</div>
      <div class="cqa-result-swap">
        ${dec?.action === 'change' ? html`<span class="cqa-row" style="gap:10px"><span class="cqa-result-swap__old">${answerPill(c, ap.originalAnswer ?? d.answer)}</span>→<span style="animation:cqa-slide-in-right 500ms both">${answerPill(c, dec.newValue)}</span></span>` : html`<span>${answerPill(c, d.answer)} <span class="cqa-small" style="color:var(--cqa-vault-mute)">${t('appeals.confirmedNote')}</span></span>`}
        <span class="cqa-grow"></span>
        ${dec?.action === 'change' && before !== after ? html`<span class="cqa-result-swap__old cqa-num">${fmtScore(before)}</span>` : ''}
        <span class="cqa-result-swap__new cqa-num" data-odo></span>
        ${deltaChip(before != null && after != null ? round2(after - before) : null)}
      </div>
      ${dec ? html`<div class="cqa-small" style="color:var(--cqa-vault-ink)"><b>${dec.by}</b> · ${fmtDate(dec.at, getLang())} — ${dec.reason}</div>` : ''}
    </div>`;
  }

  function drawSecond(ap, c, d) {
    const box = $($detail, '[data-second]');
    if (!box) return;
    if (ap.aiReview) {
      render(box, html`<div class="cqa-second" style="animation:cqa-flip-in 420ms var(--cqa-ease) both">
        <span class="cqa-eyebrow">${t('appeal.aiSecond')} · ${ap.aiReview.model}</span>
        <div class="cqa-second__cols"><div class="cqa-stack-y" style="gap:6px"><span class="cqa-eyebrow">${t('result.ai')}</span>${answerPill(c, d.answer)}</div>
          <div class="cqa-stack-y" style="gap:6px"><span class="cqa-eyebrow">${t('appeal.secondOpinion')}</span>${answerPill(c, ap.aiReview.answer)}</div></div>
        <p style="font-size:13.5px">${ap.aiReview.explanation}</p>
        <span class="cqa-small" style="color:var(--cqa-vault-mute)">${ap.aiReview.agrees ? t('appeals.aiAgrees') : t('appeals.aiDisagrees')} · ${t('result.confidence')} ${Math.round(ap.aiReview.confidence * 100)}%</span>
      </div>`);
    } else if (store.get().role === 'reviewer' && isOpen(ap)) {
      render(box, html`<button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--sm" data-act="ai">${icon('spark', { size: 16 })}${t('appeal.aiSecond')}</button>`);
    } else box.innerHTML = '';
  }

  async function requestAi() {
    const ap = store.get().appeals.find((a) => a.id === selected);
    const box = $($detail, '[data-second]');
    if (!ap || !box) return;
    render(box, html`<div class="cqa-row cqa-muted"><span class="cqa-proc__dot" style="width:16px;height:16px;border-color:var(--cqa-green);border-top-color:transparent;animation:cqa-spin .8s linear infinite"></span>${t('appeal.aiThinking')}</div>`);
    try {
      ap.aiReview = await api.aiReview(ap.id);
      const data = await api.getEvaluation(ap.evaluationId);
      const cl = clFor(data);
      drawSecond(ap, cl.criteria.find((x) => x.id === ap.criterionId) || { type: 'binary', scale: [] }, data.criteria.find((x) => x.criterionId === ap.criterionId) || {});
    } catch (e) { errorToast(e); drawSecond(ap, { type: 'binary', scale: [] }, {}); }
  }

  async function submitDecision(form) {
    const fd = new FormData(form);
    const action = String(fd.get('action'));
    const reason = String(fd.get('reason') || '').trim();
    const ta = /** @type {HTMLTextAreaElement} */ ($(form, '[name=reason]'));
    if (reason.length < 5) {
      ta.setAttribute('aria-invalid', 'true');
      $(form, '[data-reason-hint]').textContent = t('appeals.reasonRequired');
      ta.focus();
      return;
    }
    let newValue = null;
    if (action === 'change') {
      const raw = fd.get('value');
      if (raw == null) return;
      newValue = /^-?\d+(\.\d+)?$/.test(String(raw)) ? Number(raw) : String(raw);
    }
    const btn = /** @type {HTMLButtonElement} */ ($(form, 'button[type=submit]'));
    btn.disabled = true;
    try {
      const res = await decideAppeal(selected, { action, newValue, reason });
      justDecided = { id: selected, before: res.appeal.decision?.totalBefore ?? null, after: res.evaluation.total };
      toast({ kind: 'approved', title: action === 'change' ? t('appeals.changedToast') : t('appeals.confirmedToast'), message: `${res.evaluation.conversationId} · ${fmtScore(justDecided.before)} → ${fmtScore(justDecided.after)}` });
      drawList();
      drawDetail();
    } catch (e) { errorToast(e, t('appeals.decisionError')); btn.disabled = false; }
  }

  const onClick = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const f = el?.closest('[data-f]');
    if (f) { filter = f.getAttribute('data-f'); drawHead(); drawList(); return; }
    const it = el?.closest('.cqa-queue__item');
    if (it) {
      selected = it.getAttribute('data-id');
      justDecided = null;
      history.replaceState(null, '', `#/appeals?id=${selected}`);
      $$(root, '.cqa-queue__item').forEach((b) => { b.classList.toggle('is-selected', b === it); b.setAttribute('aria-pressed', String(b === it)); });
      drawDetail();
      return;
    }
    if (el?.closest('[data-act="ai"]')) requestAi();
  };
  const onChange = (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.name === 'action') {
      const nv = $(root, '[data-newval]');
      if (nv) nv.hidden = el.value !== 'change';
    }
  };
  const onSubmit = (e) => {
    if (e.target instanceof HTMLFormElement && e.target.hasAttribute('data-decision')) { e.preventDefault(); submitDecision(e.target); }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);

  if (!selected) selected = visible()[0]?.id || null;
  drawHead(); drawList(); drawDetail();

  const unsub = store.subscribe((s, p) => {
    if (s.appeals !== p.appeals || s.loading !== p.loading) {
      if (!selected) selected = visible()[0]?.id || null;
      drawHead(); drawList();
      if (p.loading && !s.loading) drawDetail();
    }
    if (s.role !== p.role) { drawHead(); drawDetail(); }
  });

  return {
    update(next) { if (next.id && next.id !== selected) { selected = next.id; justDecided = null; drawList(); drawDetail(); } },
    destroy() {
      unsub(); fragment?.destroy();
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('submit', onSubmit);
      root.innerHTML = '';
    },
  };
}
