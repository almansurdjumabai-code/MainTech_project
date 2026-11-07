/** "Defense scenario" (?demo=1): 5-minute guided walk-through with coachmarks. */
import { html, render, $ } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { store } from '../core/store.js';
import { navigate } from '../core/router.js';

const STEPS = [
  { key: 'list', route: '/conversations', target: '[data-tour="loader"]' },
  { key: 'card', route: '/conversation/p1-ru-002', target: '[data-tour="evaluate"]', role: 'qa' },
  { key: 'evidence', route: '/conversation/p1-ru-002', target: '.cqa-evidence' },
  { key: 'na', route: '/conversation/p1-ru-004', target: '.cqa-answer--na' },
  { key: 'total', route: '/conversation/p1-ru-004', target: '[data-calc]' },
  { key: 'appeal', route: '/conversation/p1-ru-005', target: '[data-act="appeal"]', role: 'qa' },
  { key: 'decision', route: '/appeals', target: '[data-decision], .cqa-queue__detail', role: 'reviewer' },
  { key: 'criterion', route: '/checklists', target: '[data-tour="checklist-bar"]', role: 'qa' },
  { key: 'reeval', route: '/checklists', target: '[data-act="reeval"]' },
];

/** @param {HTMLElement} root app root (.cqa-root) */
export function mount(root) {
  const box = document.createElement('div');
  root.appendChild(box);
  let step = -1;
  let timer = 0;

  function clearCoach() { root.querySelectorAll('.cqa-coach-target').forEach((el) => el.classList.remove('cqa-coach-target')); }

  function draw() {
    clearCoach();
    if (step < 0) {
      render(box, html`<button type="button" class="cqa-btn cqa-btn--primary cqa-tour-fab" data-tour-act="start">${icon('play', { size: 16 })}${t('tour.start')}</button>`);
      return;
    }
    const s = STEPS[step];
    render(box, html`<div class="cqa-tour" role="dialog" aria-label="${t('tour.title')}">
      <div class="cqa-row cqa-row--between"><span class="cqa-eyebrow">${t('tour.title')} · ${step + 1} / ${STEPS.length}</span>
        <button type="button" class="cqa-btn cqa-btn--vault cqa-btn--xs cqa-btn--icon" data-tour-act="close" aria-label="${t('common.close')}">${icon('x', { size: 14 })}</button></div>
      <div class="cqa-tour__progress">${STEPS.map((_, i) => html`<span class="${i <= step ? 'is-on' : ''}"></span>`)}</div>
      <b style="font-size:16px">${t(`tour.${s.key}.title`)}</b>
      <p style="font-size:13.5px;color:var(--cqa-vault-mute)">${t(`tour.${s.key}.text`)}</p>
      <div class="cqa-row cqa-row--between">
        <button type="button" class="cqa-btn cqa-btn--vault cqa-btn--sm" data-tour-act="prev" ${step === 0 ? 'disabled' : ''}>${icon('left', { size: 14 })}${t('tour.prev')}</button>
        <button type="button" class="cqa-btn cqa-btn--primary cqa-btn--sm" data-tour-act="next">${step === STEPS.length - 1 ? t('tour.finish') : t('tour.next')}${icon('right', { size: 14 })}</button>
      </div>
    </div>`);
    if (s.role && store.get().role !== s.role) store.set({ role: s.role });
    navigate(s.route);
    clearTimeout(timer);
    let tries = 0;
    const find = () => {
      const el = s.target.split(',').map((sel) => root.querySelector(sel.trim())).find(Boolean);
      if (el) { el.classList.add('cqa-coach-target'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      else if (tries++ < 20) timer = setTimeout(find, 250);
    };
    timer = setTimeout(find, 400);
  }

  const onClick = (e) => {
    const a = e.target instanceof Element ? e.target.closest('[data-tour-act]')?.getAttribute('data-tour-act') : null;
    if (!a) return;
    if (a === 'start') step = 0;
    if (a === 'close') step = -1;
    if (a === 'prev') step = Math.max(0, step - 1);
    if (a === 'next') step = step >= STEPS.length - 1 ? -1 : step + 1;
    draw();
  };
  box.addEventListener('click', onClick);
  draw();
  return { update() { draw(); }, destroy() { clearTimeout(timer); clearCoach(); box.remove(); } };
}
