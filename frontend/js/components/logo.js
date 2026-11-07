/**
 * Freedom Broker lockup, redrawn as SVG (reference: assets/freedom-broker-logo.jpg).
 * Shield = separate fill + outline paths; the "F" is negative space (mask);
 * its top arm curls into the right edge, giving the shield its wavy side.
 * All sizes are in em, so the same markup scales from the splash (≈88px) to the header (12.5px).
 */

/** Shield silhouette, viewBox 0 0 250 285. */
export const SHIELD = 'M6 6H244V92C244 178 196 242 125 279C54 242 6 178 6 92Z';
/** "F" cut: stem to the tip, top arm curling into the right edge, middle arm. */
export const F_CUT = 'M84 70H196C220 70 236 58 244 40V96C234 102 222 106 206 106H124V134H190V166H124V290H84Z';
/** Broker "growth chart" leading into the shield's top-left corner (used only by the splash). */
export const GROWTH_POINTS = [[-196, 268], [-156, 222], [-126, 240], [-86, 156], [-56, 176], [-22, 82], [6, 6]];
const GROWTH = GROWTH_POINTS.map((p) => p.join(',')).join(' ');
const AREA = `${GROWTH} 6,268`;

let seq = 0;

/** @param {{cls?: string, growth?: boolean}} [o] @returns {string} trusted HTML */
export function logoMarkup(o = {}) {
  const id = `cqa-lg${seq++}`;
  return `<span class="cqa-logo ${o.cls || ''}">
  <span class="cqa-logo__mark">
    <svg class="cqa-logo__fill" viewBox="0 0 250 285" aria-hidden="true" focusable="false">
      <defs>
        <mask id="${id}m" maskUnits="userSpaceOnUse" x="-10" y="-10" width="270" height="310">
          <rect x="-10" y="-10" width="270" height="310" fill="#fff"/><path d="${F_CUT}" fill="#000"/>
        </mask>
        <clipPath id="${id}c"><path d="${SHIELD}"/></clipPath>
        <linearGradient id="${id}g" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".42"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${SHIELD}" fill="currentColor" mask="url(#${id}m)"/>
      <g clip-path="url(#${id}c)"><rect class="cqa-logo__glare" x="-110" y="-40" width="80" height="380" fill="url(#${id}g)"/></g>
    </svg>
    <svg class="cqa-logo__outline" viewBox="0 0 250 285" aria-hidden="true" focusable="false">
      ${o.growth ? `<defs>
        <linearGradient id="${id}a" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#B8F28A" stop-opacity=".28"/><stop offset="1" stop-color="#B8F28A" stop-opacity="0"/></linearGradient>
        <linearGradient id="${id}l" x1="0" x2="1" y1="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".15"/><stop offset="1" stop-color="#B8F28A"/></linearGradient>
      </defs>
      <g class="cqa-logo__chart">
        <polygon class="cqa-logo__area" points="${AREA}" fill="url(#${id}a)"/>
        <polyline class="cqa-logo__growth" points="${GROWTH}" pathLength="1" fill="none" stroke="url(#${id}l)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        <g class="cqa-logo__head"><circle r="11" fill="#B8F28A" opacity=".22"/><circle r="3.6" fill="#fff"/></g>
      </g>
      <circle class="cqa-logo__ring" cx="6" cy="6" r="16" fill="none" stroke="#B8F28A" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : ''}
      <path class="cqa-logo__stroke" d="${SHIELD}" pathLength="1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>
  </span>
  <span class="cqa-logo__word" aria-hidden="true">
    <span class="cqa-logo__line cqa-logo__line--1">${[...'FREEDOM'].map((c, i) => `<span class="cqa-logo__ch" style="--k:${i}">${c}</span>`).join('')}</span>
    <span class="cqa-logo__line cqa-logo__line--2">${[...'BROKER'].map((c, i) => `<span class="cqa-logo__ch" style="--k:${i}">${c}</span>`).join('')}</span>
  </span>
</span>`;
}
