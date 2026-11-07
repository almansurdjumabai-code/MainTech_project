/**
 * Quiet editorial illustrations that sit next to page headlines.
 * Pure inline SVG in brand palette (classes styled in css/motion.css, theme-aware).
 */
import { raw } from '../core/utils.js';

const wave = (x0, cy, n, seed) => Array.from({ length: n }, (_, i) => {
  const h = 8 + Math.round(Math.abs(Math.sin(i * 1.7 + seed) * Math.cos(i * 0.6)) * 30);
  return `<rect class="a-wave" x="${x0 + i * 11}" y="${cy - h / 2}" width="5" height="${h}" rx="2.5" style="--k:${i}"/>`;
}).join('');

const ring = (cx, cy, r, pct, label) => `
  <circle cx="${cx}" cy="${cy}" r="${r + 10}" class="a-ink"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" class="a-ring-track"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" class="a-ring" pathLength="100" style="--len:${pct}" transform="rotate(-90 ${cx} ${cy})"/>
  <text x="${cx}" y="${cy + 7}" text-anchor="middle" class="a-num">${label}</text>`;

const ART = {
  conversations: `
    <rect class="a-surface" x="150" y="16" width="226" height="150" rx="26"/>
    <rect class="a-line" x="176" y="44" width="118" height="10" rx="5"/>
    <rect class="a-line" x="176" y="64" width="162" height="10" rx="5"/>
    <rect class="a-line" x="176" y="84" width="86" height="10" rx="5"/>
    ${wave(176, 128, 16, 1)}
    <path class="a-deep" d="M40 112H212A24 24 0 0 1 236 136V192A24 24 0 0 1 212 216H78L52 240V216H40A24 24 0 0 1 16 192V136A24 24 0 0 1 40 112Z"/>
    <rect class="a-white" x="40" y="138" width="132" height="9" rx="4.5"/>
    <rect class="a-white" x="40" y="158" width="168" height="9" rx="4.5"/>
    <rect class="a-lime" x="40" y="178" width="96" height="9" rx="4.5"/>
    ${ring(322, 210, 30, 87, '87')}`,
  checklists: `
    <rect class="a-surface" x="56" y="22" width="232" height="236" rx="26"/>
    <rect class="a-deep" x="132" y="8" width="80" height="28" rx="11"/>
    ${[64, 110, 156, 202].map((y, i) => `
      ${i < 2 ? `<rect class="a-check" x="84" y="${y}" width="26" height="26" rx="8" style="--k:${i}"/><path class="a-checkmark" d="M90 ${y + 13}l5 5 10-10"/>`
        : `<rect class="a-box" x="85" y="${y + 1}" width="24" height="24" rx="7"/>`}
      <rect class="a-line" x="124" y="${y + 8}" width="${[118, 92, 136, 74][i]}" height="10" rx="5"/>`).join('')}
    <rect class="a-line" x="250" y="88" width="126" height="8" rx="4"/>
    <rect class="a-lime" x="250" y="88" width="84" height="8" rx="4"/>
    <circle class="a-deep" cx="334" cy="92" r="12"/>
    ${ring(322, 198, 32, 100, '100')}`,
  appeals: `
    <rect class="a-surface" x="24" y="64" width="160" height="116" rx="24"/>
    <rect class="a-no" x="46" y="88" width="70" height="26" rx="13"/>
    <rect class="a-line" x="46" y="128" width="116" height="9" rx="4.5"/>
    <rect class="a-line" x="46" y="146" width="80" height="9" rx="4.5"/>
    <rect class="a-deep" x="216" y="36" width="160" height="116" rx="24"/>
    <rect class="a-lime" x="238" y="60" width="70" height="26" rx="13"/>
    <rect class="a-white" x="238" y="100" width="116" height="9" rx="4.5"/>
    <rect class="a-white" x="238" y="118" width="80" height="9" rx="4.5"/>
    <path class="a-arrow" d="M184 122C200 122 202 98 214 96"/>
    <path class="a-arrow-head" d="M206 89l9 7-9 7"/>
    <circle class="a-ink" cx="150" cy="226" r="40"/>
    <path class="a-scale" d="M150 202v46M132 248h36M128 212h44M128 212l-10 20h20zM172 212l-10 20h20z"/>
    <rect class="a-mint" x="208" y="208" width="112" height="38" rx="19"/>
    <text class="a-delta" x="264" y="233" text-anchor="middle">▲ +3.62</text>`,
};

/** @param {'conversations'|'checklists'|'appeals'} kind */
export function pageArt(kind) {
  const body = ART[kind];
  if (!body) return '';
  return raw(`<svg class="cqa-page__art cqa-art cqa-art--${kind}" viewBox="0 0 400 270" aria-hidden="true" focusable="false"><g class="cqa-art__float">${body}</g></svg>`);
}
