/**
 * Motion & micro-interactions: split-text headlines, cursor spotlight on surfaces,
 * magnetic primary buttons, nav glider, route transitions (View Transitions API).
 * Everything degrades to instant state under prefers-reduced-motion.
 */
import { esc, prefersReducedMotion } from './utils.js';

const SPOT = '.cqa-card, .cqa-crit, .cqa-kpi, .cqa-queue__item, .cqa-sec';
const MAGNET = '.cqa-btn--primary';

/** Split `.cqa-display` headlines into masked words / rising chars. @param {ParentNode} scope */
export function splitText(scope) {
  scope.querySelectorAll('.cqa-display:not([data-split])').forEach((el) => {
    const text = (el.textContent || '').trim();
    el.setAttribute('data-split', '1');
    el.setAttribute('aria-label', text);
    let i = 0;
    el.innerHTML = text.split(/\s+/).map((w) => `<span class="cqa-w" aria-hidden="true">${[...w].map((ch) => `<span class="cqa-ch" style="--i:${i++}">${esc(ch)}</span>`).join('')}</span>`).join(' ');
    el.classList.add('cqa-split');
  });
}

/** Spotlight + magnetic buttons, delegated on the app root. @param {HTMLElement} root */
export function initPointerFx(root) {
  if (prefersReducedMotion() || !window.matchMedia('(pointer: fine)').matches) return () => {};
  let magnet = null;
  const move = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const s = t.closest(SPOT);
    if (s) {
      const r = s.getBoundingClientRect();
      s.style.setProperty('--mx', `${e.clientX - r.left}px`);
      s.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    const b = /** @type {HTMLElement|null} */ (t.closest(MAGNET));
    if (magnet && magnet !== b) { magnet.style.transform = ''; magnet = null; }
    if (b && !b.disabled) {
      const r = b.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      b.style.transform = `translate(${dx * 6}px, ${dy * 5}px)`;
      magnet = b;
    }
  };
  const leave = () => { if (magnet) { magnet.style.transform = ''; magnet = null; } };
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('pointerleave', leave);
  return () => { root.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', leave); };
}

/** Slide the nav pill under the active link. @param {ParentNode} scope */
export function placeGlider(scope, instant = false) {
  const nav = scope.querySelector('.cqa-nav');
  if (!nav) return;
  let g = /** @type {HTMLElement|null} */ (nav.querySelector('.cqa-nav__glider'));
  if (!g) { g = document.createElement('span'); g.className = 'cqa-nav__glider'; g.setAttribute('aria-hidden', 'true'); nav.prepend(g); instant = true; }
  const a = /** @type {HTMLElement|null} */ (nav.querySelector('.cqa-nav__link.is-active'));
  if (!a) { g.style.opacity = '0'; return; }
  if (instant) g.style.transition = 'none';
  g.style.opacity = '1';
  g.style.width = `${a.offsetWidth}px`;
  g.style.transform = `translateX(${a.offsetLeft}px)`;
  if (instant) { void g.offsetWidth; g.style.transition = ''; }
}

/**
 * Run a DOM swap inside a view transition when supported.
 * @param {() => void} swap
 */
export function transition(swap) {
  const d = /** @type {any} */ (document);
  let ran = false;
  const once = () => { if (ran) return; ran = true; swap(); };
  if (prefersReducedMotion() || typeof d.startViewTransition !== 'function' || document.visibilityState !== 'visible') { once(); return; }
  // Only animate when the page is actually painting: a transition started in a window that
  // doesn't render times out (and Chrome logs it). No frame within 120ms → swap instantly.
  let framed = false;
  requestAnimationFrame(() => {
    framed = true;
    if (ran) return;
    try {
      const vt = d.startViewTransition(once);
      [vt?.ready, vt?.finished, vt?.updateCallbackDone].forEach((p) => p?.catch?.(() => {}));
      setTimeout(once, 250);
    } catch { once(); }
  });
  setTimeout(() => { if (!framed) once(); }, 120);
}

/** Observe a container and enhance newly rendered content (split headlines). @param {HTMLElement} el */
export function observeEnhance(el) {
  splitText(el);
  let raf = 0;
  const mo = new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => splitText(el)); });
  mo.observe(el, { childList: true, subtree: true });
  return () => mo.disconnect();
}
