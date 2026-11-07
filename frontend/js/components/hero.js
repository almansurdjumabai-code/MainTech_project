/**
 * Editorial page masthead: a strip of key figures under the headline
 * (thin display numerals, odometer roll, sparkline / meter / split as the sub-line).
 */
import { html, raw, render } from '../core/utils.js';
import { createOdometer } from './ui.js';

let seq = 0;

/**
 * Area sparkline.
 * @param {number[]} values
 * @param {{w?:number, h?:number}} [o]
 */
export function sparkline(values, { w = 132, h = 34 } = {}) {
  if (values.length < 2) return '';
  const id = `cqa-sp${seq++}`;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
  const [lx, ly] = pts[pts.length - 1];
  return raw(`<svg class="cqa-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${w} ${h}L0 ${h}Z" fill="url(#${id})"/>
    <path class="cqa-spark__line" d="${d}" pathLength="1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="currentColor"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7" fill="currentColor" opacity=".18"/>
  </svg>`);
}

/** Thin progress meter. @param {number} k 0..1 */
export const meter = (k) => html`<span class="cqa-meter"><span style="transform:scaleX(${Math.max(0, Math.min(1, k)).toFixed(3)})"></span></span>`;

/** Colored split bar, e.g. languages. @param {{label:string, n:number, tone:string}[]} parts */
export function split(parts) {
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  return html`<span class="cqa-split-bar">${parts.map((p) => html`<span class="cqa-split-bar__seg cqa-split-bar__seg--${p.tone}" style="flex-grow:${p.n || 0.0001}"></span>`)}</span>
    <span class="cqa-split-legend">${parts.map((p) => html`<span><i class="cqa-split-bar__dot cqa-split-bar__seg--${p.tone}"></i>${p.label} ${p.n}</span>`)}</span>`;
}

/**
 * @typedef {{label:string, value:number|null, decimals?:number, prefix?:string, suffix?:string, sub?:any, tone?:'green'|'red'|'amber'}} HeroItem
 * Render (or keep) the masthead. Re-renders only when the figures change, so polling doesn't replay the roll.
 * @param {HTMLElement} el @param {HeroItem[]} items
 */
export function renderHero(el, items) {
  const sig = JSON.stringify(items.map((i) => [i.label, i.value, i.suffix, i.prefix, String(i.sub || '').replace(/cqa-sp\d+/g, '')]));
  if (el.dataset.sig === sig) return;
  const first = !el.dataset.sig;
  el.dataset.sig = sig;
  render(el, html`<section class="cqa-hero ${first ? 'cqa-hero--enter' : ''}">
    ${items.map((it, i) => html`<div class="cqa-hero__cell ${it.tone ? `cqa-hero__cell--${it.tone}` : ''}" style="--i:${i}">
      <span class="cqa-hero__label">${it.label}</span>
      <span class="cqa-hero__val">${it.prefix ? html`<em>${it.prefix}</em>` : ''}<span data-hero-val="${it.value == null ? '' : it.value}" data-dec="${it.decimals || 0}"></span>${it.suffix ? html`<small>${it.suffix}</small>` : ''}</span>
      <span class="cqa-hero__sub">${it.sub || ''}</span>
    </div>`)}
  </section>`);
  el.querySelectorAll('[data-hero-val]').forEach((n) => {
    const node = /** @type {HTMLElement} */ (n);
    if (node.dataset.heroVal === '') { node.textContent = '—'; return; }
    createOdometer(node, { decimals: Number(node.dataset.dec) }).set(Number(node.dataset.heroVal));
  });
}
