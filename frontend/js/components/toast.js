/** Toast notifications (aria-live). Payment-confirmation style for "approved". */
import { html, render } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';

/** @type {HTMLElement|null} */
let host = null;

/** @param {HTMLElement} rootEl */
export function mount(rootEl) {
  host = document.createElement('div');
  host.className = 'cqa-toasts';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  rootEl.appendChild(host);
  return { update() {}, destroy() { host?.remove(); host = null; } };
}

/**
 * @param {{kind?:'success'|'approved'|'error'|'info', title:string, message?:string, timeout?:number, action?:{label:string, onClick:()=>void}}} o
 */
export function toast({ kind = 'success', title, message = '', timeout = 4600, action }) {
  if (!host) return;
  const el = document.createElement('div');
  el.className = `cqa-toast cqa-toast--${kind}`;
  const ic = kind === 'error' ? icon('x') : kind === 'info' ? icon('info') : kind === 'approved'
    ? html`<svg class="cqa-check-draw" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>`
    : icon('check');
  render(el, html`
    <span class="cqa-toast__icon">${ic}</span>
    <span class="cqa-grow"><span class="cqa-toast__title">${title}</span>${message ? html`<br><span class="cqa-toast__msg">${message}</span>` : ''}</span>
    ${action ? html`<button type="button" class="cqa-btn cqa-btn--vault cqa-btn--xs cqa-toast__action">${action.label}</button>` : ''}
  `);
  if (action) el.querySelector('button').addEventListener('click', () => { action.onClick(); close(); });
  host.appendChild(el);
  let timer = setTimeout(close, timeout);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(close, 1800); });
  function close() {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 230);
  }
  return close;
}

/** Human error text for API failures. @param {unknown} e @param {string} [ctx] */
export function errorToast(e, ctx) {
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  toast({ kind: 'error', title: ctx || t('common.error'), message: msg.slice(0, 220), timeout: 7000 });
}
