/** Appeal submission (role "QA") + instant AI second opinion inside the same dialog. */
import { html, render, $, $$, fmtScore, round2 } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { icon } from '../core/icons.js';
import { evaluationAnswers, scoreEvaluation } from '../core/scoring.js';
import { api } from '../api/client.js';
import { openModal } from './modal.js';
import { answerPill, deltaChip, createOdometer } from './ui.js';
import { createAppeal, refreshAppeals } from '../core/actions.js';
import { toast, errorToast } from './toast.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Phase 2 of the dialog: "Analysing the operator's argument…" → projected score change.
 * @param {HTMLElement} el modal element
 */
async function runAiReview(el, { appeal, evaluation, checklist }) {
  const body = /** @type {HTMLElement} */ ($(el, '.cqa-modal__body'));
  const foot = /** @type {HTMLElement} */ ($(el, '.cqa-modal__foot'));
  const title = $(el, 'h2');
  if (title) title.textContent = t('appeal.aiTitle');
  const crit = checklist.criteria.find((c) => c.id === appeal.criterionId);
  render(body, html`<div class="cqa-ai-review" aria-live="polite">
    <div class="cqa-ai-review__status"><span class="cqa-ai-orb" aria-hidden="true"></span>
      <div><b>${t('appeal.aiAnalysing')}</b><p class="cqa-small cqa-muted">${crit?.title || appeal.criterionId}</p></div></div>
    <ol class="cqa-ai-steps">${['appeal.aiStep1', 'appeal.aiStep2', 'appeal.aiStep3'].map((k, i) => html`<li class="cqa-ai-steps__item" data-step="${i}"><span class="cqa-ai-steps__dot"></span>${t(k)}</li>`)}</ol>
  </div>`);
  render(foot, html`<button type="button" class="cqa-btn cqa-btn--secondary" data-close="bg">${t('appeal.aiHide')}</button>`);

  const steps = $$(body, '[data-step]');
  const tick = (i) => { steps.forEach((s, k) => { s.classList.toggle('is-done', k < i); s.classList.toggle('is-active', k === i); }); };
  tick(0);
  const timers = [setTimeout(() => tick(1), 650), setTimeout(() => tick(2), 1300)];

  let review;
  try {
    [review] = await Promise.all([api.aiReview(appeal.id), wait(1900)]);
  } catch (e) {
    timers.forEach(clearTimeout);
    render(body, html`<div class="cqa-error-box">${icon('info')}<span>${t('appeal.aiError')}: ${e.message}</span></div>`);
    render(foot, html`<button type="button" class="cqa-btn cqa-btn--primary" data-close="done">${t('common.close')}</button>`);
    return;
  }
  timers.forEach(clearTimeout);
  tick(3);
  refreshAppeals().catch(() => {});

  const { final } = evaluationAnswers(evaluation);
  const before = scoreEvaluation(checklist, final).total;
  const after = scoreEvaluation(checklist, { ...final, [appeal.criterionId]: review.answer }).total;
  const delta = before != null && after != null ? round2(after - before) : null;
  const revised = delta != null && Math.abs(delta) >= 0.005;

  await wait(250);
  render(body, html`<div class="cqa-ai-result ${revised ? 'cqa-ai-result--revised' : ''}">
    <span class="cqa-eyebrow">${t('appeal.aiSecond')} · ${review.model}</span>
    <div class="cqa-ai-result__verdict">${icon(revised ? 'spark' : 'check', { size: 18 })}<b>${revised ? t('appeal.aiSupports') : t('appeal.aiUpholds')}</b></div>
    <div class="cqa-ai-result__answers">${answerPill(crit, final[appeal.criterionId])}<span class="cqa-ai-result__arrow">→</span>${answerPill(crit, review.answer)}</div>
    <div class="cqa-ai-result__score">
      <span class="cqa-ai-result__label">${revised ? t('appeal.aiRevised') : t('appeal.aiUnchanged')}</span>
      <span class="cqa-ai-result__nums">
        ${revised ? html`<s class="cqa-num">${fmtScore(before)}</s><span class="cqa-ai-result__arrow">→</span>` : ''}
        <b class="cqa-num" data-odo-after></b>
        ${revised ? deltaChip(delta, true) : ''}
      </span>
    </div>
    <p class="cqa-ai-result__why">${review.explanation}</p>
    <p class="cqa-notice cqa-notice--info">${icon('gavel', { size: 16 })}<span>${t('appeal.aiNote')}</span></p>
  </div>`);
  const odo = createOdometer(/** @type {HTMLElement} */ ($(body, '[data-odo-after]')));
  odo.set(before);
  if (revised) setTimeout(() => odo.set(after), 300);
  render(foot, html`<button type="button" class="cqa-btn cqa-btn--primary" data-close="done">${icon('check', { size: 16 })}${t('appeal.aiDone')}</button>`);
}

/**
 * Open the appeal dialog.
 * @param {{evaluation:any, checklist:any, criterionId?:string|null, appeals:any[]}} o
 * @returns {Promise<any|null>} created appeal
 */
export function openAppealForm({ evaluation, checklist, criterionId, appeals }) {
  const { final } = evaluationAnswers(evaluation);
  const open = new Set(appeals.filter((a) => a.evaluationId === evaluation.evaluationId && ['submitted', 'in_review'].includes(a.status)).map((a) => a.criterionId));
  const options = checklist.criteria.filter((c) => c.id in final);
  const first = criterionId && !open.has(criterionId) ? criterionId : options.find((c) => !open.has(c.id))?.id;
  const detail = (id) => evaluation.criteria.find((d) => d.criterionId === id);

  let created = null;
  const m = openModal({
    eyebrow: `${t('appeal.title')} · ${evaluation.conversationId}`,
    title: t('appeal.formTitle'),
    body: html`
      <label class="cqa-field"><span class="cqa-field__label">${t('appeal.criterion')}</span>
        <select class="cqa-select" name="criterion">${options.map((c, i) => html`<option value="${c.id}" ${c.id === first ? 'selected' : ''} ${open.has(c.id) ? 'disabled' : ''}>${String(i + 1).padStart(2, '0')} · ${c.title}${open.has(c.id) ? ` — ${t('appeal.alreadyOpen')}` : ''}</option>`)}</select>
      </label>
      <div class="cqa-card" data-current style="padding:16px 18px"></div>
      <label class="cqa-field"><span class="cqa-field__label">${t('appeal.comment')}</span>
        <textarea class="cqa-textarea" name="comment" rows="4" minlength="10" autofocus aria-describedby="cqa-appeal-hint" placeholder="${t('appeal.commentPh')}" required></textarea>
        <span class="cqa-field__hint" id="cqa-appeal-hint" data-hint>${t('appeal.commentHint')} · Ctrl/⌘+Enter</span>
      </label>`,
    footer: html`
      <button type="button" class="cqa-btn cqa-btn--secondary" data-close="">${t('common.cancel')}</button>
      <button type="button" class="cqa-btn cqa-btn--primary" data-submit>${t('appeal.submit')}</button>`,
    onMount(el) {
      const sel = /** @type {HTMLSelectElement} */ ($(el, 'select'));
      const box = $(el, '[data-current]');
      const paint = () => {
        const c = checklist.criteria.find((x) => x.id === sel.value);
        const d = detail(sel.value);
        box.innerHTML = html`<div class="cqa-row cqa-row--between" style="margin-bottom:8px"><span class="cqa-eyebrow">${t('appeal.currentAnswer')}</span>${answerPill(c, final[sel.value])}</div>
          <p class="cqa-small cqa-muted">${d?.explanation || ''}</p>`.s;
      };
      sel.addEventListener('change', paint);
      paint();
    },
    async onSubmit(el) {
      const sel = /** @type {HTMLSelectElement} */ ($(el, 'select'));
      const ta = /** @type {HTMLTextAreaElement} */ ($(el, 'textarea'));
      const comment = ta.value.trim();
      if (comment.length < 10) {
        ta.setAttribute('aria-invalid', 'true');
        $(el, '[data-hint]').textContent = t('appeal.commentTooShort');
        ta.focus();
        return undefined;
      }
      try {
        created = await createAppeal({ evaluationId: evaluation.evaluationId, criterionId: sel.value, comment });
        toast({ kind: 'approved', title: t('appeal.submittedToast'), message: `${evaluation.conversationId} · ${checklist.criteria.find((c) => c.id === sel.value)?.title}` });
        runAiReview(el, { appeal: created, evaluation, checklist });
        return undefined; // keep the dialog open for the AI phase
      } catch (e) {
        errorToast(e, t('appeal.submitError'));
        return undefined;
      }
    },
  });
  return m.result.then(() => created);
}
