/** Accessible modal dialogs (no alert/confirm). */
import { html, render, $$ } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';

/** @type {HTMLElement|null} */
let hostEl = null;
/** Where modals are appended (inside .cqa-root so tokens apply). @param {HTMLElement} el */
export function setModalHost(el) { hostEl = el; }

/**
 * @param {Object} o
 * @param {string} o.title
 * @param {string} [o.eyebrow]
 * @param {import('../core/utils.js').Raw} o.body
 * @param {import('../core/utils.js').Raw} [o.footer]  buttons: [data-close="value"] closes, [data-submit] calls onSubmit
 * @param {'md'|'lg'} [o.size]
 * @param {(el:HTMLElement, close:(v:any)=>void) => void} [o.onMount]
 * @param {(el:HTMLElement) => any | Promise<any>} [o.onSubmit] return undefined to keep open
 * @returns {{el:HTMLElement, close:(v?:any)=>void, result:Promise<any>}}
 */
export function openModal({ title, eyebrow, body, footer, size = 'md', onMount, onSubmit }) {
  const prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
  const backdrop = document.createElement('div');
  backdrop.className = 'cqa-modal-backdrop';
  const titleId = 'cqa-modal-' + Math.random().toString(36).slice(2, 8);
  render(backdrop, html`
    <div class="cqa-modal ${size === 'lg' ? 'cqa-modal--lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
      <div class="cqa-modal__head">
        <div class="cqa-stack-y" style="gap:6px">
          <h2 class="cqa-h3" id="${titleId}" style="font-size:22px;font-weight:500">${title}</h2>
          ${eyebrow ? html`<span class="cqa-modal__meta">${eyebrow}</span>` : ''}
        </div>
        <button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--icon cqa-btn--sm" data-close="" aria-label="${t('common.close')}">${icon('x')}</button>
      </div>
      <div class="cqa-modal__body">${body}</div>
      ${footer ? html`<div class="cqa-modal__foot">${footer}</div>` : ''}
    </div>`);
  (hostEl || document.body).appendChild(backdrop);
  const el = /** @type {HTMLElement} */ (backdrop.querySelector('.cqa-modal'));

  let resolve;
  const result = new Promise((r) => { resolve = r; });
  let closed = false;
  const close = (v = null) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    try { prevFocus?.focus(); } catch { /* element gone */ }
    resolve(v);
  };

  const focusables = () => $$(el, 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    // Ctrl/⌘+Enter in a textarea submits the dialog
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target instanceof HTMLTextAreaElement && el.contains(e.target)) {
      const sub = /** @type {HTMLElement|null} */ (el.querySelector('[data-submit]:not([disabled])'));
      if (sub) { e.preventDefault(); sub.click(); }
    }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
  el.addEventListener('click', async (e) => {
    const target = e.target instanceof Element ? e.target : null;
    const c = target?.closest('[data-close]');
    if (c) { close(c.getAttribute('data-close') || null); return; }
    const s = target?.closest('[data-submit]');
    if (s && onSubmit) {
      s.setAttribute('disabled', '');
      s.classList.add('is-loading');
      s.setAttribute('aria-busy', 'true');
      try {
        const v = await onSubmit(el);
        if (v !== undefined) close(v);
      } finally { s.removeAttribute('disabled'); s.classList.remove('is-loading'); s.removeAttribute('aria-busy'); }
    }
  });
  onMount?.(el, close);
  requestAnimationFrame(() => {
    // Autofocus a field only with a fine pointer; on touch it would pop the keyboard — focus the dialog instead.
    if (!window.matchMedia('(pointer: fine)').matches) { el.focus(); return; }
    const auto = el.querySelector('[autofocus]') || el.querySelector('input, textarea, select') || el.querySelector('[data-submit]') || focusables()[0];
    /** @type {HTMLElement} */ (auto)?.focus();
  });
  return { el, close, result };
}

/**
 * @param {{title:string, message:string, confirmLabel?:string, danger?:boolean}} o
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel, danger = false }) {
  const m = openModal({
    title,
    body: html`<p class="cqa-muted">${message}</p>`,
    footer: html`
      <button type="button" class="cqa-btn cqa-btn--secondary" data-close="">${t('common.cancel')}</button>
      <button type="button" class="cqa-btn ${danger ? 'cqa-btn--danger' : 'cqa-btn--primary'}" data-close="ok">${confirmLabel || t('common.confirm')}</button>`,
  });
  return m.result.then((v) => v === 'ok');
}
