/** Shared presentational helpers: pills, badges, odometer, gauge, empty states. */
import { html, raw, esc, langCode, isVoice, prefersReducedMotion, fmtNum, fmtUsd } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { normalizeAnswer, maxStep } from '../core/scoring.js';

/** Text for an answer. @param {any} criterion @param {any} answer */
export function answerText(criterion, answer) {
  const a = normalizeAnswer(answer);
  if (a == null) return '—';
  if (criterion?.type === 'flag') return a === 'yes' ? t('answer.flagYes') : t('answer.flagNo');
  if (a === 'yes') return t('answer.yes');
  if (a === 'no') return t('answer.no');
  if (a === 'na') return 'N/A';
  return `${a} / ${maxStep(criterion || { scale: [] }) || '?'}`;
}

/** @param {any} criterion @param {any} answer */
export function answerPill(criterion, answer) {
  const a = normalizeAnswer(answer);
  if (a == null) return html`<span class="cqa-answer cqa-answer--none">—</span>`;
  if (criterion?.type === 'flag') {
    return a === 'yes'
      ? html`<span class="cqa-answer cqa-answer--flag">${icon('shield', { size: 14 })}${t('answer.flagYes')}</span>`
      : html`<span class="cqa-answer cqa-answer--yes">${t('answer.flagNo')}</span>`;
  }
  if (a === 'yes') return html`<span class="cqa-answer cqa-answer--yes">${icon('check', { size: 14 })}${t('answer.yes')}</span>`;
  if (a === 'no') return html`<span class="cqa-answer cqa-answer--no">${icon('x', { size: 14 })}${t('answer.no')}</span>`;
  if (a === 'na') return html`<span class="cqa-answer cqa-answer--na">N/A</span>`;
  const steps = (criterion?.scale || []).map((s) => Number(s.value)).sort((x, y) => x - y);
  const m = maxStep(criterion || { scale: [] });
  return html`<span class="cqa-answer cqa-answer--scale" title="${(criterion?.scale || []).find((s) => Number(s.value) === a)?.label || ''}">
    <span class="cqa-steps" aria-hidden="true">${steps.filter((v) => v > 0).map((v) => html`<span class="cqa-steps__seg ${v === a ? 'is-sel' : v < a ? 'is-on' : ''}"></span>`)}</span>
    <span class="cqa-num">${a}/${m}</span></span>`;
}

export const langBadge = (lang) => html`<span class="cqa-badge cqa-badge--mono cqa-badge--line cqa-badge--sm cqa-lang" data-lang="${langCode(lang)}">${langCode(lang)}</span>`;

export const channelBadge = (conv) => isVoice(conv)
  ? html`<span class="cqa-chan">${icon('phone', { size: 15 })}<span>${t('channel.voice')}</span></span>`
  : html`<span class="cqa-chan">${icon('chat', { size: 15 })}<span>${t('channel.chat')}</span></span>`;

/** @param {number|null|undefined} total */
export const scoreTone = (total) => (total == null ? '' : total >= 80 ? 'hi' : total >= 60 ? 'mid' : 'lo');
export const gaugeColor = (total) => (total == null ? '#5A615D' : total >= 80 ? '#51AF3D' : total >= 60 ? '#D9A21B' : '#E5675E');

/** @param {string|null} status */
export function appealBadge(status) {
  if (!status) return '';
  const map = { submitted: 'amber', in_review: 'amber', confirmed: 'green', changed: 'solid' };
  return html`<span class="cqa-badge cqa-badge--sm cqa-badge--${map[status] || 'line'}">${t('appeal.status.' + status)}</span>`;
}

/** Transfer-tracking style timeline. @param {any} appeal */
export function appealTimeline(appeal) {
  const st = appeal?.status || 'submitted';
  const idx = { submitted: 0, in_review: 1, confirmed: 2, changed: 2 }[st] ?? 0;
  const steps = [t('appeal.status.submitted'), t('appeal.status.in_review'), st === 'changed' ? t('appeal.status.changed') : st === 'confirmed' ? t('appeal.status.confirmed') : t('appeal.decision')];
  return html`<div class="cqa-timeline" aria-label="${t('appeal.timeline')}">
    ${steps.map((label, i) => html`
      ${i > 0 ? html`<span class="cqa-timeline__line ${i <= idx ? 'is-done' : ''}"></span>` : ''}
      <span class="cqa-timeline__step ${i < idx || (i === idx && idx === 2) ? 'is-done' : i === idx ? 'is-current' : ''}"><span class="cqa-timeline__dot"></span>${label}</span>`)}
  </div>`;
}

/** Line illustration + CTA. */
export function emptyState({ title, text = '', action = '' }) {
  return html`<div class="cqa-empty">
    <svg class="cqa-illu" width="120" height="84" viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="14" y="10" width="72" height="54" rx="10"/><path d="M26 26h36M26 36h48M26 46h24"/>
      <rect x="52" y="30" width="54" height="44" rx="10" fill="var(--cqa-paper)"/><path d="M64 46h30M64 56h18"/>
      <circle cx="98" cy="22" r="8"/><path d="M95 22l2.2 2.2L101.5 20" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="cqa-h3">${title}</div>
    ${text ? html`<p class="cqa-lead" style="max-width:46ch">${text}</p>` : ''}
    ${action}
  </div>`;
}

/** @param {number} rows @param {number} [h] */
export const skeleton = (rows, h = 44) => html`<div class="cqa-stack-y" aria-busy="true" aria-label="${t('common.loading')}">
  ${Array.from({ length: rows }, (_, i) => html`<div class="cqa-skel" style="height:${h}px;opacity:${1 - i * 0.08}"></div>`)}</div>`;

/** Table-shaped skeleton (header + rows with varied cells). @param {number} rows */
export function tableSkeleton(rows = 7) {
  const cell = (w) => html`<span class="cqa-skel" style="height:12px;width:${w}"></span>`;
  return html`<div class="cqa-table-wrap cqa-skel-table" aria-busy="true" aria-label="${t('common.loading')}">
    <div class="cqa-skel-table__head">${['16px', '90px', '70px', '50px', '40px', '40px', '90px', '60px', '50px', '80px'].map(cell)}</div>
    ${Array.from({ length: rows }, (_, i) => html`<div class="cqa-skel-table__row" style="opacity:${1 - i * 0.1}">
      ${cell('16px')}${cell('84px')}<span class="cqa-skel cqa-skel--circle"></span>${cell('34px')}${cell('22px')}${cell('42px')}
      <span class="cqa-skel cqa-skel--pill"></span><span class="cqa-skel-table__score">${cell('46px')}${cell('76px')}</span>${cell('24px')}<span class="cqa-skel cqa-skel--pill"></span>
    </div>`)}
  </div>`;
}

/** Chart-card skeletons for the dashboard. @param {number} n */
export const chartSkeleton = (n = 4) => html`<div class="cqa-dash__grid" aria-busy="true">${Array.from({ length: n }, (_, i) => html`
  <div class="cqa-card cqa-dash__cell ${i === 2 ? 'cqa-dash__cell--wide' : ''} cqa-skel-chart">
    <span class="cqa-skel" style="height:16px;width:40%"></span>
    <div class="cqa-skel-chart__bars">${Array.from({ length: 10 }, (__, k) => html`<span class="cqa-skel" style="height:${20 + ((k * 37 + i * 13) % 70)}%"></span>`)}</div>
  </div>`)}</div>`;

/** "Local mode: $0.00 / call" vs "Cloud mode: $0.012 / call". @param {any} model */
export function modelMode(model) {
  if (!model) return '';
  const local = model.kind === 'local';
  return html`<span class="cqa-mode cqa-mode--${local ? 'local' : 'cloud'}" title="${model.name}">
    ${icon(local ? 'cpu' : 'cloud', { size: 14 })}
    <b>${local ? t('mode.local') : t('mode.cloud')}</b>
    <span class="cqa-num">${fmtUsd(Number(model.costUsd || 0), local ? 2 : 3)} / ${t('mode.call')}</span>
    <span class="cqa-mode__time cqa-num">≈ ${fmtNum(model.avgMs / 1000, 1)} s</span>
  </span>`;
}

/* ───────── Odometer (exchange-board digits) ───────── */
const STRIP = '<span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span>';

/**
 * @param {HTMLElement} el
 * @param {{decimals?:number}} [o]
 */
export function createOdometer(el, { decimals = 2 } = {}) {
  el.classList.add('cqa-odo');
  let shape = '';
  /** @param {number|null} v */
  function set(v) {
    const str = v == null || !Number.isFinite(v) ? '—' : fmtNum(v, decimals);
    el.setAttribute('aria-label', str);
    el.setAttribute('role', 'img');
    const sh = str.replace(/\d/g, '0');
    if (sh !== shape) {
      shape = sh;
      el.innerHTML = [...str].map((ch) => (/\d/.test(ch)
        ? `<span class="cqa-odo__col" aria-hidden="true"><span class="cqa-odo__strip" style="transform:translateY(0em)">${STRIP}</span></span>`
        : `<span class="cqa-odo__sep" aria-hidden="true">${esc(ch)}</span>`)).join('');
      // force layout so the next transform animates from 0
      void el.offsetWidth;
    }
    const strips = Array.from(el.querySelectorAll('.cqa-odo__strip'));
    const digits = [...str].filter((ch) => /\d/.test(ch));
    const apply = () => strips.forEach((s, i) => { /** @type {HTMLElement} */ (s).style.transform = `translateY(-${digits[i]}em)`; });
    if (prefersReducedMotion()) apply(); else requestAnimationFrame(apply);
  }
  return { set };
}

/* ───────── Ring gauge ───────── */
/** @param {number} size @param {number} stroke */
export function gaugeSvg(size = 168, stroke = 10) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return raw(`<svg class="cqa-gauge" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="cqa-gauge__track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle class="cqa-gauge__bar" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"
      stroke="${gaugeColor(null)}" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-c="${c}"/></svg>`);
}

/** @param {Element} root containing a gauge svg @param {number|null} value 0–100 */
export function setGauge(root, value) {
  const bar = /** @type {SVGCircleElement|null} */ (root.querySelector('.cqa-gauge__bar'));
  if (!bar) return;
  const c = Number(bar.dataset.c);
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  requestAnimationFrame(() => {
    bar.style.strokeDashoffset = String(c * (1 - v / 100));
    bar.style.stroke = gaugeColor(value);
  });
}

/** Delta chip ▲ +5.25 / ▼ −3.00. @param {number|null} d @param {boolean} [paper] */
export function deltaChip(d, paper = false) {
  if (d == null || !Number.isFinite(d)) return '';
  const k = Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down';
  const txt = k === 'flat' ? `±${fmtNum(0, 2)}` : `${d > 0 ? '▲ +' : '▼ −'}${fmtNum(Math.abs(d), 2)}`;
  return html`<span class="cqa-delta cqa-delta--${k} ${paper ? 'cqa-delta--paper' : ''}">${txt}</span>`;
}

/** Confidence meter. @param {number|null|undefined} c @param {number} low */
export function confidenceMeter(c, low) {
  if (c == null) return '';
  const isLow = c < low;
  return html`<span class="cqa-conf ${isLow ? 'cqa-conf--low' : ''}" title="${t('result.confidence')}">
    <span class="cqa-conf__bar"><span class="cqa-conf__fill" style="width:${Math.round(c * 100)}%"></span></span>
    <span class="cqa-num">${Math.round(c * 100)}%</span></span>
    ${isLow ? html`<span class="cqa-badge cqa-badge--amber cqa-badge--sm">${icon('info', { size: 13 })}${t('result.manualCheck')}</span>` : ''}`;
}
