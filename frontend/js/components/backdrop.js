/**
 * Page backdrop: a muted "conversation quality index" chart — engineering grid, candlesticks,
 * average-score line with area, 80/60 verdict thresholds, 0–100 score axis and volume strip.
 * Decorative only (aria-hidden). Parallax on scroll via transform; slow drift in CSS.
 */
import { seeded } from '../core/utils.js';

const W = 1600;
const H = 900;
/** Score (30..100) → y inside the chart band (lower part of the viewport, under the masthead). */
const Y = (v) => 300 + ((100 - v) / 70) * 560;

function build(t) {
  const rnd = seeded('cqa-quality-index');
  const n = 64;
  const step = W / n;
  let v = 74;
  const candles = [];
  const line = [];
  for (let i = 0; i < n; i++) {
    const o = v;
    v = Math.max(48, Math.min(96, v + (rnd() - 0.46) * 9));
    const hi = Math.max(o, v) + rnd() * 4;
    const lo = Math.min(o, v) - rnd() * 4;
    const x = i * step + step / 2;
    candles.push({ x, o, c: v, hi, lo, up: v >= o, vol: 0.25 + rnd() * 0.75 });
    line.push([x, Y((o + v) / 2)]);
  }
  // Catmull-Rom → cubic Bézier for a calm, smooth average line
  let d = `M${line[0][0].toFixed(1)} ${line[0][1].toFixed(1)}`;
  for (let i = 0; i < line.length - 1; i++) {
    const p0 = line[i - 1] || line[i]; const p1 = line[i]; const p2 = line[i + 1]; const p3 = line[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const area = `${d}L${line[line.length - 1][0].toFixed(1)} ${H}L${line[0][0].toFixed(1)} ${H}Z`;
  const bw = step * 0.42;

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" focusable="false">
    <defs>
      <pattern id="cqa-bg-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" class="b-grid"/></pattern>
      <pattern id="cqa-bg-grid-major" width="200" height="200" patternUnits="userSpaceOnUse"><path d="M200 0H0V200" fill="none" class="b-grid-major"/></pattern>
      <linearGradient id="cqa-bg-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="b-area-top"/><stop offset="1" class="b-area-bottom"/></linearGradient>
      <radialGradient id="cqa-bg-fade" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset=".75" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="cqa-bg-mask"><rect width="${W}" height="${H}" fill="url(#cqa-bg-fade)"/></mask>
    </defs>
    <g mask="url(#cqa-bg-mask)">
      <rect width="${W}" height="${H}" fill="url(#cqa-bg-grid)"/>
      <rect width="${W}" height="${H}" fill="url(#cqa-bg-grid-major)"/>
      <g class="cqa-bg__drift">
        <path class="b-area" d="${area}" fill="url(#cqa-bg-area)"/>
        ${candles.map((c) => `<line class="b-wick" x1="${c.x.toFixed(1)}" x2="${c.x.toFixed(1)}" y1="${Y(c.hi).toFixed(1)}" y2="${Y(c.lo).toFixed(1)}"/><rect class="${c.up ? 'b-up' : 'b-down'}" x="${(c.x - bw / 2).toFixed(1)}" y="${Y(Math.max(c.o, c.c)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, Math.abs(Y(c.o) - Y(c.c))).toFixed(1)}" rx="1.5"/>`).join('')}
        <path class="b-line" d="${d}" pathLength="1"/>
        ${candles.map((c) => `<rect class="b-vol" x="${(c.x - bw / 2).toFixed(1)}" y="${(H - 18 - c.vol * 70).toFixed(1)}" width="${bw.toFixed(1)}" height="${(c.vol * 70).toFixed(1)}"/>`).join('')}
      </g>
      ${[80, 60].map((s) => `<line class="b-threshold b-threshold--${s}" x1="0" x2="${W}" y1="${Y(s)}" y2="${Y(s)}"/><text class="b-label b-label--${s}" x="48" y="${Y(s) - 10}">${s} — ${s === 80 ? t.norm : t.risk}</text>`).join('')}
      ${[100, 90, 80, 70, 60, 50, 40].map((s) => `<text class="b-axis" x="${W - 40}" y="${Y(s) + 4}" text-anchor="end">${s}</text><line class="b-tick" x1="${W - 30}" x2="${W - 18}" y1="${Y(s)}" y2="${Y(s)}"/>`).join('')}
      <text class="b-axis b-axis--title" x="${W - 40}" y="${Y(100) - 26}" text-anchor="end">${t.index}</text>
    </g>
  </svg>`;
}

/**
 * @param {HTMLElement} host .cqa-root
 * @param {{norm:string, risk:string, index:string}} labels
 */
export function mount(host, labels) {
  const el = document.createElement('div');
  el.className = 'cqa-bg';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = build(labels);
  host.prepend(el);

  let raf = 0;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches || host.classList.contains('cqa-motion-paused');
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      el.style.transform = reduced() ? '' : `translate3d(0, ${(-window.scrollY * 0.06).toFixed(1)}px, 0)`;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return {
    update(next) { el.innerHTML = build(next); },
    destroy() { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); el.remove(); },
  };
}
