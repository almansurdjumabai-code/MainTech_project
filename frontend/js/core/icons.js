/** Inline line icons, 24×24 grid, stroke 1.5, currentColor. */
import { raw } from './utils.js';

const P = {
  chat: '<path d="M4 5.5h16v10H9l-5 4v-14z"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.2a11 11 0 0 0 6.3 6.3l1.2-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6L12 3z"/><path d="M12 8.5v4.5M12 16v.01"/>',
  play: '<path d="M8 5.5v13l10.5-6.5L8 5.5z"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13"/>',
  drag: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="2.4" stroke-linecap="round"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  edit: '<path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.5 18.5l-4 1z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4.5 15v4.5h15V15"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M4.5 15v4.5h15V15"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  spark: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8L12 3.5z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"/>',
  flag: '<path d="M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11"/>',
  scale: '<path d="M12 4v16M7 20h10M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0L5 8zM19 8l-2.5 6a3 3 0 0 0 5 0L19 8z"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-linecap="round"/>',
  chart: '<path d="M4.5 19.5h15M7.5 16v-5M12 16V7M16.5 16v-8"/>',
  inbox: '<path d="M4.5 13.5l2-8h11l2 8v5h-15v-5z"/><path d="M4.5 13.5h4.5l1 2h4l1-2h4.5"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8" stroke-linecap="round"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13M17 13.5v5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5"/>',
  print: '<path d="M7 9V4.5h10V9M7 16.5H4.5V9h15v7.5H17M7 13.5h10v6H7z"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  gavel: '<path d="M13.5 4.5l6 6M11 7l6 6M9.5 8.5l6 6-2 2-6-6 2-2zM9 14l-5 5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
  doc: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12.5h6M9 16h6"/>',
  cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z"/>',
  clockfast: '<circle cx="13" cy="12.5" r="7"/><path d="M13 9v3.5l2.5 1.5M2.5 9h3M1.5 12.5h3M2.5 16h3"/>',
};

/**
 * @param {keyof typeof P} name
 * @param {{size?:number, cls?:string, label?:string}} [o]
 */
export function icon(name, o = {}) {
  const size = o.size || 18;
  const a11y = o.label ? `role="img" aria-label="${o.label}"` : 'aria-hidden="true" focusable="false"';
  return raw(`<svg class="cqa-icon ${o.cls || ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${P[name] || ''}</svg>`);
}
