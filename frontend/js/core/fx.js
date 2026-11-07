/**
 * Motion & micro-interactions: split-text headlines, cursor spotlight on surfaces,
 * magnetic primary buttons, nav glider, route transitions (View Transitions API).
 * Everything degrades to instant state under prefers-reduced-motion.
 */
import { esc, prefersReducedMotion } from './utils.js';

const SPOT = '.cqa-card, .cqa-crit, .cqa-kpi, .cqa-queue__item, .cqa-sec, .cqa-hero__cell, .cqa-savings';
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
    el.style.setProperty('--n', String(i));
  });
}

/* ── Scroll reveal ────────────────────────────────────────────────────
   Content that starts below the fold rises in as it enters the viewport.
   Only nodes that are off-screen when tagged get hidden, so nothing visible ever blinks;
   without IntersectionObserver or with reduced motion nothing is tagged at all. */
const REVEAL = [
  '.cqa-page > section', '.cqa-page > .cqa-card', '.cqa-panel-grid > *', '.cqa-kpis > *', '.cqa-dash > *',
  '.cqa-table tbody tr', '.cqa-ledger > *', '.cqa-queue__item', '.cqa-crit', '.cqa-sec', '.cqa-item',
  '.cqa-heat__cell', '.cqa-card :is(h2, h3)', '.cqa-page h2',
].join(',');
let io = null;
const SCROLL_TIMELINES = typeof CSS !== 'undefined' && CSS.supports?.('animation-timeline: view()');
const revealOff = (root) => prefersReducedMotion() || root.closest('.cqa-motion-paused') || !('IntersectionObserver' in window);

function revealIn(entries) {
  const batch = entries.filter((e) => e.isIntersecting).map((e) => /** @type {HTMLElement} */ (e.target));
  batch.sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top || x.getBoundingClientRect().left - y.getBoundingClientRect().left);
  batch.forEach((el, k) => {
    io.unobserve(el);
    el.style.setProperty('--rd', `${Math.min(k, 8) * 55}ms`);
    el.classList.add('is-in');
    setTimeout(() => { el.removeAttribute('data-reveal'); el.classList.remove('is-in'); el.style.removeProperty('--rd'); }, 1300 + Math.min(k, 8) * 55);
  });
}

/** Tag below-the-fold content for reveal. @param {HTMLElement} root */
export function scanReveal(root) {
  if (revealOff(root) || SCROLL_TIMELINES) return; // view() timelines in canvas.css drive the motion instead
  io ||= new IntersectionObserver(revealIn, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  const vh = window.innerHeight;
  root.querySelectorAll(REVEAL).forEach((n) => {
    const el = /** @type {HTMLElement} */ (n);
    if (el.dataset.reveal != null || el.dataset.seen) return;
    el.dataset.seen = '1';
    if (el.closest('[data-reveal]') || el.closest('.cqa-modal, .cqa-toasts, .cqa-header')) return;
    if (el.getBoundingClientRect().top < vh * 0.94) return; // already on screen: leave it alone
    el.dataset.reveal = el.matches('h2, h3') ? 'head' : el.matches('tr, .cqa-heat__cell') ? 'soft' : '';
    io.observe(el);
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
      b.style.transform = `translate(${dx * 8}px, ${dy * 6 - 2}px)`;
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
 * @param {'fwd'|'back'} [dir] slide direction (tab order); styles in css/motion.css
 */
/**
 * @param {() => void} swap
 * @param {'fwd'|'back'} [dir]
 * @param {{to?: string, x?: number, y?: number}} [o] destination route (picks the per-tab choreography in
 *   css/transitions.css) and the point the reveal grows from (centre of the clicked tab)
 */
export function transition(swap, dir = 'fwd', o = {}) {
  const d = /** @type {any} */ (document);
  const html = document.documentElement;
  html.dataset.vtDir = dir;
  html.dataset.vtTo = o.to || '';
  html.style.setProperty('--vt-x', `${Math.round(o.x ?? window.innerWidth / 2)}px`);
  html.style.setProperty('--vt-y', `${Math.round(o.y ?? 0)}px`);
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

/* ── Page subtitle: types itself in, letter by letter ────────────────
   Once per text per page visit: re-renders of the same page (store updates, the dashboard's
   second draw) and later count updates show the text instantly, so it never blinks.
   The full text is laid out from the start (the untyped rest is invisible), so nothing below shifts. */
const typedTexts = new Set();
let typedRoute = '';
const TYPE_DELAY = 250;   // after the headline starts
const TYPE_TOTAL = 1400;  // max duration, long subtitles type faster
const TYPE_STEP = 32;     // ms per character for short ones

/**
 * Set a page subtitle without restarting/cutting its typing when the text is unchanged.
 * Pages re-render their header on every store update — writing the same text again would replace the typing spans.
 * @param {HTMLElement|null} el @param {string} text
 */
export function setLead(el, text) {
  if (!el || el.dataset.text === text) return;
  el.dataset.text = text;
  el.textContent = text;
}

/** @param {ParentNode} scope */
export function typeLead(scope) {
  const route = location.hash.split('?')[0];
  if (route !== typedRoute) { typedRoute = route; typedTexts.clear(); }
  scope.querySelectorAll('.cqa-page__title .cqa-lead:not([data-typed])').forEach((node) => {
    const el = /** @type {HTMLElement} */ (node);
    const text = (el.textContent || '').trim();
    if (!text) return; // filled in later by the page — handled on the next mutation
    el.setAttribute('data-typed', '');
    if (prefersReducedMotion() || el.closest('.cqa-motion-paused') || typedTexts.has(text)) return;
    typedTexts.add(text);
    const chars = [...text];
    el.innerHTML = `<span class="cqa-sr">${esc(text)}</span><span aria-hidden="true"><span class="cqa-type__on"></span><span class="cqa-type__caret"></span><span class="cqa-type__off">${esc(text)}</span></span>`;
    el.classList.add('is-typing');
    const on = /** @type {HTMLElement} */ (el.querySelector('.cqa-type__on'));
    const off = /** @type {HTMLElement} */ (el.querySelector('.cqa-type__off'));
    const step = Math.min(TYPE_STEP, TYPE_TOTAL / chars.length);
    const t0 = performance.now() + TYPE_DELAY;
    let shown = -1;
    const finish = () => {
      if (!on.isConnected) { el.classList.remove('is-typing'); return; } // the page replaced the text meanwhile — its own content wins
      el.classList.remove('is-typing');
      el.textContent = text;
    };
    // Timer, not rAF: rAF stops in background tabs and would leave the subtitle invisible.
    const tick = () => {
      if (!on.isConnected) { el.classList.remove('is-typing'); return; }
      const k = Math.max(0, Math.min(chars.length, Math.floor((performance.now() - t0) / step)));
      if (k !== shown) {
        shown = k;
        on.textContent = chars.slice(0, k).join('');
        off.textContent = chars.slice(k).join('');
      }
      if (k < chars.length) setTimeout(tick, Math.max(16, step));
      else setTimeout(finish, 450); // caret lingers a moment, then plain text
    };
    setTimeout(tick, TYPE_DELAY);
  });
}

/** Observe a container and enhance newly rendered content (split headlines, typed subtitles). @param {HTMLElement} el */
export function observeEnhance(el) {
  splitText(el);
  typeLead(el);
  let raf = 0;
  const run = () => { splitText(el); typeLead(el); scanReveal(el); };
  setTimeout(() => scanReveal(el), 60);
  // Subtitles are handled right in the callback (before paint), so a late-filled one never flashes in full first.
  const mo = new MutationObserver(() => { typeLead(el); cancelAnimationFrame(raf); raf = requestAnimationFrame(run); });
  mo.observe(el, { childList: true, subtree: true, characterData: true });
  return () => mo.disconnect();
}

/* ── Pointer parallax (page art + headline) and vault tilt ─────────────
   Fine pointers only. Sets CSS variables; the motion itself is CSS. */
const TILT = '.cqa-vault';

/** @param {HTMLElement} root */
export function initCursorFx(root) {
  if (prefersReducedMotion() || !window.matchMedia('(pointer: fine)').matches) return () => {};
  let tilt = null;
  const move = (e) => {
    const x = e.clientX, y = e.clientY;
    const t = e.target instanceof Element ? e.target : null;
    root.style.setProperty('--px', `${((x / window.innerWidth - 0.5) * 28).toFixed(1)}px`);
    root.style.setProperty('--py', `${((y / window.innerHeight - 0.5) * 20).toFixed(1)}px`);
    const v = /** @type {HTMLElement|null} */ (t?.closest(TILT) || null);
    if (tilt && tilt !== v) { tilt.style.removeProperty('--rx'); tilt.style.removeProperty('--ry'); }
    tilt = v;
    if (v) {
      const r = v.getBoundingClientRect();
      v.style.setProperty('--ry', `${(((x - r.left) / r.width - 0.5) * 8).toFixed(2)}deg`);
      v.style.setProperty('--rx', `${(-((y - r.top) / r.height - 0.5) * 6).toFixed(2)}deg`);
    }
  };
  window.addEventListener('pointermove', move, { passive: true });
  return () => window.removeEventListener('pointermove', move);
}
