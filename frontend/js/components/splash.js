/**
 * Intro splash (~2.8s), "private banking" cinematic:
 *   0.00  brand curtain: vignette, slow aura, drifting candlestick field, viewfinder corners, progress hairline
 *   0.10  growth chart climbs (line + gradient area + glowing head) while the shield outline draws
 *   0.78  the head touches the shield → one soft ignition ring
 *   0.80  shield fills like liquid (waving surface), "F" appears as negative space; chart dissolves
 *   1.10  FREEDOM / BROKER rise from masks, tracking tightens
 *   1.45  hairline rule + serif tagline wipe in
 *   1.80  single light sweep across the shield
 *   2.25  exit: lockup FLIPs into the header, curtain lifts with a lime leading edge, UI fades up (40ms stagger)
 * Only transform / opacity / clip-path / stroke-dashoffset are animated (WAAPI). The app boots underneath.
 * Shown once per session; ?intro=1 forces it, ?intro=0 disables it. Never mounted in D365.
 */
import { prefersReducedMotion, seeded } from '../core/utils.js';
import { logoMarkup, GROWTH_POINTS } from './logo.js';

const EASE = 'cubic-bezier(.2,.8,.2,1)';
const DRAW = 'cubic-bezier(.45,0,.2,1)';
const FLY = 'cubic-bezier(.65,0,.25,1)';
const KEY = 'cqa.intro.seen';
const EXIT_AT = 2250;
const HINT = { ru: 'Нажмите, чтобы пропустить', kz: 'Өткізу үшін басыңыз', en: 'Click to skip' };
const LOADING = { ru: 'Загрузка', kz: 'Жүктелуде', en: 'Loading' };
const TAGLINE = { ru: 'Аналитика качества диалогов', kz: 'Диалог сапасының аналитикасы', en: 'Conversation quality analytics' };

/** Decide whether to show the intro on this load. */
export function shouldShow() {
  const p = new URLSearchParams(location.search).get('intro');
  if (p === '1') return true;
  if (p === '0') return false;
  try { return sessionStorage.getItem(KEY) !== '1'; } catch { return true; }
}

/** Abstract candlestick field (decorative, no data). */
function candles() {
  const rnd = seeded('freedom-broker');
  let v = 150;
  let out = '';
  for (let i = 0; i < 84; i++) {
    const o = v;
    v = Math.max(40, Math.min(250, v + (rnd() - 0.42) * 34));
    const hi = Math.min(o, v) - rnd() * 18;
    const lo = Math.max(o, v) + rnd() * 18;
    const x = i * 22 + 6;
    const up = v < o;
    out += `<line x1="${x + 5}" x2="${x + 5}" y1="${hi.toFixed(1)}" y2="${lo.toFixed(1)}"/>`
      + `<rect x="${x}" y="${Math.min(o, v).toFixed(1)}" width="10" height="${Math.max(2, Math.abs(v - o)).toFixed(1)}" ${up ? 'class="up"' : ''}/>`;
  }
  return `<svg class="cqa-splash__candles" viewBox="0 0 1860 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g>${out}</g></svg>`;
}

/** Liquid surface: polygon with a sine top edge at `level`% (same point count for interpolation). */
function wave(level, amp, phase) {
  const pts = [];
  for (let x = 100; x >= 0; x -= 10) pts.push(`${x}% ${(level + amp * Math.sin((x / 100) * Math.PI * 2.4 + phase)).toFixed(2)}%`);
  return `polygon(0% 100%, 100% 100%, ${pts.join(', ')})`;
}

/**
 * @param {HTMLElement} host .cqa-root
 * @param {{lang?: string, onDone?: () => void}} [opts]
 */
export function mount(host, opts = {}) {
  try { sessionStorage.setItem(KEY, '1'); } catch { /* private mode */ }
  const reduced = prefersReducedMotion();
  const lang = opts.lang || 'ru';
  host.classList.add('cqa-intro-active');

  const el = document.createElement('div');
  el.className = `cqa-splash ${reduced ? 'cqa-splash--static' : ''}`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="cqa-splash__curtain">
      <div class="cqa-splash__aura"></div>
      ${reduced ? '' : candles()}
      <div class="cqa-splash__vignette"></div>
      <span class="cqa-splash__corner cqa-splash__corner--tl"></span><span class="cqa-splash__corner cqa-splash__corner--tr"></span>
      <span class="cqa-splash__corner cqa-splash__corner--bl"></span><span class="cqa-splash__corner cqa-splash__corner--br"></span>
      <div class="cqa-splash__meta"><span><b>Freedom Broker</b> · Conversation Quality Analytics</span><span>${LOADING[lang] || LOADING.ru} <span class="cqa-splash__count">0</span>%</span></div>
      <div class="cqa-splash__progress"><span></span></div>
      <div class="cqa-splash__edge"></div>
    </div>
    <div class="cqa-splash__stage">
      <div class="cqa-splash__lockup">
        ${logoMarkup({ cls: 'cqa-logo--splash', growth: !reduced })}
        <div class="cqa-splash__tag"><span class="cqa-splash__rule"></span><span class="cqa-splash__tagline">${TAGLINE[lang] || TAGLINE.ru}</span></div>
      </div>
    </div>
    <div class="cqa-splash__skip">${HINT[lang] || HINT.ru}</div>`;
  host.appendChild(el);
  // The curtain now covers the app: lift the pre-paint guard set in index.html.
  document.documentElement.classList.remove('cqa-preintro');

  const q = (s) => /** @type {HTMLElement} */ (el.querySelector(s));
  const qa = (s) => /** @type {HTMLElement[]} */ ([...el.querySelectorAll(s)]);
  const logo = q('.cqa-logo');
  const curtain = q('.cqa-splash__curtain');
  const skip = q('.cqa-splash__skip');
  const count = q('.cqa-splash__count');

  /** @type {Animation[]} */ const intro = [];
  /** @type {Animation[]} */ const settle = [];
  const play = (node, frames, delay, duration, easing = EASE) => {
    if (!node) return null;
    const an = node.animate(frames, { delay, duration, easing, fill: 'both' });
    intro.push(an);
    return an;
  };

  let exiting = false;
  let done = false;
  let timer = 0;
  const t0 = performance.now();
  const counter = window.setInterval(() => {
    const p = Math.min(1, (performance.now() - t0) / EXIT_AT);
    const e = 1 - Math.pow(1 - p, 2.2);
    count.textContent = String(Math.round(e * 100));
  }, 40);

  if (reduced) {
    count.textContent = '100';
    timer = window.setTimeout(exit, 800);
  } else {
    // Atmosphere
    play(q('.cqa-splash__lockup'), [{ transform: 'scale(.955)' }, { transform: 'scale(1)' }], 0, EXIT_AT, 'cubic-bezier(.25,.6,.3,1)');
    play(q('.cqa-splash__aura'), [{ opacity: 0, transform: 'translate(-50%,-50%) rotate(0deg) scale(.8)' }, { opacity: 1, transform: 'translate(-50%,-50%) rotate(50deg) scale(1)' }], 0, EXIT_AT + 300, 'cubic-bezier(.3,.6,.3,1)');
    play(q('.cqa-splash__candles'), [{ opacity: 0, transform: 'translateX(0)' }, { opacity: 1, transform: 'translateX(-60px)', offset: 0.3 }, { opacity: 1, transform: 'translateX(-200px)' }], 0, EXIT_AT + 400, 'linear');
    qa('.cqa-splash__corner').forEach((c, i) => play(c, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], 120 + i * 60, 520));
    play(q('.cqa-splash__meta'), [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], 250, 500);
    play(q('.cqa-splash__progress > span'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 0, EXIT_AT, 'cubic-bezier(.3,.1,.3,1)');

    // Growth chart: line, area, head travelling along the polyline (offsets by segment length)
    play(q('.cqa-logo__growth'), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], 100, 700, DRAW);
    play(q('.cqa-logo__area'), [{ opacity: 0 }, { opacity: 1 }], 300, 500);
    const lens = GROWTH_POINTS.slice(1).map((p, i) => Math.hypot(p[0] - GROWTH_POINTS[i][0], p[1] - GROWTH_POINTS[i][1]));
    const total = lens.reduce((a, b) => a + b, 0);
    let acc = 0;
    const headFrames = GROWTH_POINTS.map((p, i) => {
      if (i > 0) acc += lens[i - 1];
      return { transform: `translate(${p[0]}px, ${p[1]}px)`, offset: acc / total };
    });
    play(q('.cqa-logo__head'), headFrames, 100, 700, DRAW);
    play(q('.cqa-logo__head'), [{ opacity: 1 }, { opacity: 0 }], 820, 200);
    play(q('.cqa-logo__ring'), [{ transform: 'scale(.3)', opacity: 0.9 }, { transform: 'scale(2.6)', opacity: 0 }], 780, 650, 'cubic-bezier(.1,.6,.3,1)');
    play(q('.cqa-logo__chart'), [{ opacity: 1 }, { opacity: 0 }], 900, 450);

    // Shield: outline draws, then fills like liquid
    play(q('.cqa-logo__stroke'), [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], 150, 650, DRAW);
    play(q('.cqa-logo__fill'), [
      { clipPath: wave(108, 4, 0) },
      { clipPath: wave(72, 6, 1.6), offset: 0.3 },
      { clipPath: wave(40, 5, 3.2), offset: 0.6 },
      { clipPath: wave(12, 3, 4.8), offset: 0.85 },
      { clipPath: wave(-8, 0, 6.4) },
    ], 800, 560, 'cubic-bezier(.35,.1,.25,1)');

    // Wordmark: rise from masks, tracking tightens
    const rise = (chars, start) => chars.forEach((c, i) => {
      const spread = (i - (chars.length - 1) / 2) * 0.09;
      play(c, [{ transform: `translate(${spread}em, 118%)` }, { transform: 'translate(0, 0)' }], start + i * 28, 520);
    });
    rise(qa('.cqa-splash .cqa-logo__line--1 .cqa-logo__ch'), 1100);
    rise(qa('.cqa-splash .cqa-logo__line--2 .cqa-logo__ch'), 1220);

    // Editorial tagline
    play(q('.cqa-splash__rule'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 1450, 520);
    play(q('.cqa-splash__tagline'), [{ clipPath: 'inset(0 100% 0 0)', transform: 'translateX(-8px)' }, { clipPath: 'inset(0 0% 0 0)', transform: 'translateX(0)' }], 1560, 600);

    // One light sweep
    play(q('.cqa-logo__glare'), [{ transform: 'translateX(0) skewX(-18deg)' }, { transform: 'translateX(460px) skewX(-18deg)' }], 1800, 420, 'cubic-bezier(.4,0,.2,1)');
    timer = window.setTimeout(exit, EXIT_AT);
  }
  skip.animate([{ opacity: 0 }, { opacity: 0.5 }], { delay: 800, duration: 300, easing: EASE, fill: 'both' });

  function exit() {
    if (exiting) return;
    exiting = true;
    clearTimeout(timer);
    clearInterval(counter);
    count.textContent = '100';
    window.removeEventListener('keydown', onKey, true);
    el.style.cursor = 'default';
    intro.forEach((an) => { try { an.finish(); } catch { /* already finished */ } });

    const chrome = qa('.cqa-splash__skip, .cqa-splash__tag, .cqa-splash__meta, .cqa-splash__corner, .cqa-splash__candles, .cqa-splash__aura, .cqa-splash__progress');
    chrome.forEach((n) => n.animate([{ opacity: getComputedStyle(n).opacity }, { opacity: 0 }], { duration: 180, easing: 'linear', fill: 'forwards' }));

    if (reduced) {
      host.classList.remove('cqa-intro-active');
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: EASE, fill: 'forwards' });
      // Timer, not `.finished`: a background tab may not tick animations, the app must still unlock.
      window.setTimeout(finish, 320);
      return;
    }

    // FLIP the lockup into the header brand (same em proportions → exact landing)
    const target = /** @type {HTMLElement|null} */ (host.querySelector('.cqa-brand .cqa-logo'));
    host.classList.remove('cqa-intro-active');
    if (target) {
      const s = logo.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const k = t.height / s.height;
      logo.animate(
        [{ transform: 'translate(0, 0) scale(1)' }, { transform: `translate(${t.left - s.left}px, ${t.top - s.top}px) scale(${k})` }],
        { delay: 60, duration: 560, easing: FLY, fill: 'both' },
      );
      logo.animate([{ opacity: 1 }, { opacity: 0 }], { delay: 460, duration: 160, easing: 'linear', fill: 'forwards' });
      settle.push(target.animate([{ opacity: 0 }, { opacity: 1 }], { delay: 440, duration: 180, easing: 'linear', fill: 'backwards' }));
    } else {
      logo.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
    }

    // Curtain lifts with a rounded lower edge and a lime leading line
    curtain.style.borderRadius = '0 0 56px 56px';
    curtain.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], { delay: 120, duration: 560, easing: 'cubic-bezier(.76,0,.24,1)', fill: 'forwards' });
    q('.cqa-splash__edge').animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1 }], { delay: 120, duration: 560, fill: 'forwards' });

    // Interface fades up underneath, stagger 40ms
    const items = [...host.querySelectorAll('.cqa-header__inner > :not(.cqa-brand), .cqa-ticker, .cqa-main .cqa-page > *, .cqa-main .cqa-cardpage > *')].slice(0, 12);
    items.forEach((n, i) => settle.push(n.animate(
      [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { delay: 260 + i * 40, duration: 480, easing: EASE, fill: 'backwards' },
    )));
    window.setTimeout(finish, 700);
    // Safety net: whatever the animation clock did, the interface ends fully visible.
    window.setTimeout(() => settle.forEach((an) => an.cancel()), 1500);
  }

  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(counter);
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    host.classList.remove('cqa-intro-active');
    /** @type {HTMLElement|null} */ (host.querySelector('#cqa-main'))?.focus({ preventScroll: true });
    opts.onDone?.();
  }

  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') e.preventDefault();
    exit();
  }
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('pointerdown', exit);

  return { update() {}, destroy: finish, skip: exit };
}
