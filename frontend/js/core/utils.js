/** Small DOM / formatting helpers. No globals. */

/** Marker for trusted HTML strings. */
export class Raw {
  /** @param {string} s */
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

/** @param {string} s */
export const raw = (s) => new Raw(s);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** @param {unknown} s */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function fmtVal(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmtVal).join('');
  return esc(String(v));
}

/**
 * Tagged template: interpolations are escaped unless wrapped in raw()/html``.
 * @returns {Raw}
 */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += fmtVal(vals[i]);
  });
  return new Raw(out);
}

/** @param {Element} root @param {Raw|string} tpl */
export function render(root, tpl) {
  root.innerHTML = tpl instanceof Raw ? tpl.s : esc(tpl);
}

/** @param {ParentNode} root @param {string} sel */
export const $ = (root, sel) => root.querySelector(sel);
/** @param {ParentNode} root @param {string} sel */
export const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));

/**
 * Event delegation inside root.
 * @param {Element} root @param {string} type @param {string} sel
 * @param {(e: Event, el: HTMLElement) => void} fn
 * @returns {() => void} unsubscribe
 */
export function on(root, type, sel, fn) {
  const h = (e) => {
    const el = e.target instanceof Element ? e.target.closest(sel) : null;
    if (el && root.contains(el)) fn(e, /** @type {HTMLElement} */ (el));
  };
  root.addEventListener(type, h);
  return () => root.removeEventListener(type, h);
}

/** localStorage wrapper: every access guarded. */
export const storage = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('cqa.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('cqa.' + key, JSON.stringify(value)); } catch { /* quota / privacy mode */ }
  },
  remove(key) {
    try { localStorage.removeItem('cqa.' + key); } catch { /* ignore */ }
  },
};

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
/** @param {number|null|undefined} n */
export const fmtScore = (n) => (n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(2));

/** @param {number} sec */
export function fmtClock(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/**
 * Parse an organizer timestamp. Chats: "MM:SS", calls: ISO 8601 with zone.
 * @param {string} ts
 * @returns {{kind:'mmss'|'iso'|'unknown', seconds:number|null, epoch:number|null, display:string, full:string}}
 */
export function parseTimestamp(ts) {
  const s = String(ts ?? '').trim();
  const mm = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (mm) {
    const secs = mm[3] != null ? (+mm[1]) * 3600 + (+mm[2]) * 60 + (+mm[3]) : (+mm[1]) * 60 + (+mm[2]);
    return { kind: 'mmss', seconds: secs, epoch: null, display: s, full: s };
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}T/.test(s)) {
    const time = /T(\d{2}:\d{2}:\d{2})/.exec(s);
    return { kind: 'iso', seconds: null, epoch: t, display: time ? time[1] : s, full: s };
  }
  return { kind: 'unknown', seconds: null, epoch: null, display: s, full: s };
}

/**
 * Seconds from conversation start for each message (null if unknown).
 * @param {{timestamp:string}[]} transcript
 */
export function transcriptOffsets(transcript) {
  const parsed = transcript.map((m) => parseTimestamp(m.timestamp));
  const firstIso = parsed.find((p) => p.kind === 'iso');
  return parsed.map((p) => {
    if (p.kind === 'mmss') return p.seconds;
    if (p.kind === 'iso' && firstIso) return (p.epoch - firstIso.epoch) / 1000;
    return null;
  });
}

/** @param {{transcript:{timestamp:string}[]}} conv */
export function conversationDuration(conv) {
  const offs = transcriptOffsets(conv.transcript || []).filter((x) => x != null);
  return offs.length ? Math.max(...offs) : null;
}

export const isVoice = (conv) => /voice|call|звон/i.test(conv?.channel || '');

let uidN = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${(uidN++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Deterministic PRNG from a string seed (mulberry32). */
export function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {string} name @param {string} content @param {string} mime */
export function downloadFile(name, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

const LOCALES = { ru: 'ru-RU', kz: 'kk-KZ', en: 'en-GB' };
/** @param {string} iso @param {string} lang */
export function fmtDate(iso, lang = 'ru') {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(LOCALES[lang] || 'ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

/**
 * Animate a number with rAF. Respects reduced motion.
 * @param {number} from @param {number} to @param {number} ms @param {(v:number)=>void} cb
 * @returns {() => void} cancel
 */
export function tween(from, to, ms, cb) {
  if (prefersReducedMotion() || ms <= 0) { cb(to); return () => {}; }
  let raf; const t0 = performance.now();
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    cb(from + (to - from) * ease(k));
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/**
 * FLIP animation for keyed elements ([data-flip]) inside root across a DOM update.
 * @param {Element} root @param {() => void} mutate
 */
export function flip(root, mutate) {
  if (prefersReducedMotion()) { mutate(); return; }
  const first = new Map($$(root, '[data-flip]').map((el) => [el.dataset.flip, el.getBoundingClientRect()]));
  mutate();
  $$(root, '[data-flip]').forEach((el) => {
    const f = first.get(el.dataset.flip);
    if (!f) return;
    const l = el.getBoundingClientRect();
    const dx = f.left - l.left; const dy = f.top - l.top;
    if (!dx && !dy) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0,0)' }],
      { duration: 380, easing: 'cubic-bezier(.2,1.3,.4,1)' },
    );
  });
}

/** Deep clone JSON-safe data. */
export const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/** Language → short badge code used everywhere. */
export const langCode = (l) => String(l || '').toUpperCase().replace('KK', 'KZ');
