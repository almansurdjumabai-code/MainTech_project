/** Dashboard — all charts are hand-written inline SVG / CSS, no libraries. */
import { html, render, raw, $, fmtScore, fmtNum, fmtUsd } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { store, activeChecklist } from '../core/store.js';
import { computeStats } from '../core/stats.js';
import { api } from '../api/client.js';
import { bootstrap } from '../core/actions.js';
import { config } from '../config.js';
import { createOdometer, emptyState, chartSkeleton } from './ui.js';
import { confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { setLead } from '../core/fx.js';

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const DEFS = `<defs>
  <linearGradient id="cqa-grad-bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B7A45"/><stop offset="1" stop-color="#0A3A22"/></linearGradient>
  <linearGradient id="cqa-grad-bar-hi" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B8F28A"/><stop offset=".55" stop-color="#51AF3D"/><stop offset="1" stop-color="#1B7A45"/></linearGradient>
</defs>`;

function histogram(h) {
  const W = 640; const H = 220; const pad = { l: 28, r: 8, t: 18, b: 26 };
  const max = Math.max(1, ...h.map((b) => b.count));
  const bw = (W - pad.l - pad.r) / h.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.ceil(max / 2), max];
  return raw(`<svg class="cqa-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${t('dash.histogram')}">${DEFS}
    ${ticks.map((v) => `<line class="cqa-chart__grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${h.map((b, i) => {
      const x = pad.l + i * bw + 4; const yy = y(b.count); const hh = H - pad.b - yy;
      const band = b.from < 60 ? 'low' : b.from < 80 ? 'mid' : 'high';
      return `<a href="#/conversations?score=${band}&amp;from=dash" class="cqa-chart__link" aria-label="${t('score.' + band)} · ${b.from}–${b.to}: ${b.count}"><title>${t('dash.openFiltered')}: ${t('score.' + band)}</title><rect class="cqa-chart__hit" x="${x - 4}" y="${pad.t - 10}" width="${bw}" height="${H - pad.b - pad.t + 10}" rx="8"/></a>
        <rect class="cqa-chart__bar ${b.from >= 80 ? 'cqa-chart__bar--hi' : ''} ${b.from < 60 ? 'cqa-chart__bar--lo' : ''}" x="${x}" y="${yy}" width="${bw - 8}" height="${Math.max(0, hh)}" rx="4" style="animation-delay:${i * 40}ms" pointer-events="none"></rect>
        ${b.count ? `<text class="cqa-chart__val" x="${x + (bw - 8) / 2}" y="${yy - 6}" text-anchor="middle" pointer-events="none">${b.count}</text>` : ''}
        <text x="${x + (bw - 8) / 2}" y="${H - 8}" text-anchor="middle" pointer-events="none">${b.from}</text>`;
    }).join('')}
  </svg>`);
}

function bars(items, label) {
  // items: {label, avg, count, nav?}
  const W = 640; const row = 34; const H = items.length * row + 4; const x0 = 80; const bw = W - x0 - 110;
  return raw(`<svg class="cqa-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${label}">${DEFS}
    ${items.map((it, i) => {
      const w = ((it.avg ?? 0) / 100) * bw;
      const hit = it.nav ? `<a href="#${it.nav}&amp;from=dash" class="cqa-chart__link" aria-label="${it.label}: ${it.avg == null ? '—' : fmtNum(it.avg, 1)}"><title>${t('dash.openFiltered')}: ${it.label}</title><rect class="cqa-chart__hit" x="-6" y="${i * row + 2}" width="${W + 12}" height="${row - 4}" rx="8"/></a>` : '';
      return `${hit}<text x="0" y="${i * row + 21}" style="fill:var(--cqa-ink);font-size:12px" pointer-events="none">${it.label}</text>
        <rect x="${x0}" y="${i * row + 10}" width="${bw}" height="14" rx="5" style="fill:var(--cqa-line)" pointer-events="none"/>
        <rect class="cqa-chart__bar cqa-chart__bar--hi" x="${x0}" y="${i * row + 10}" width="${w}" height="14" rx="5" style="transform-origin:left;animation-name:cqa-grow-x;animation-delay:${i * 60}ms" pointer-events="none"/>
        <text class="cqa-chart__val" x="${W - 4}" y="${i * row + 21}" text-anchor="end" pointer-events="none">${it.avg == null ? '—' : fmtNum(it.avg, 1)} · ${it.count}</text>`;
    }).join('')}
  </svg>`);
}

function heatColor(p) {
  if (p == null) return 'background:var(--cqa-mist);color:var(--cqa-mute)';
  // One hue, lightness carries the value (safe for red/green colour blindness); weak cells add an outline + weight.
  const a = (0.06 + p * 0.74).toFixed(2);
  if (p >= 0.5) return `--heat:${a};background:rgba(81,175,61,var(--heat));color:${p > 0.82 ? 'var(--cqa-heat-ink-strong)' : 'var(--cqa-ink)'}`;
  return `--heat:${a};background:rgba(81,175,61,var(--heat));color:var(--cqa-red);box-shadow:inset 0 0 0 1.5px var(--cqa-red);font-weight:750`;
}

/** Assumptions for the savings estimate (shown to the user, not hidden). */
const QA_MIN_CHAT = 12;      // manual review of one chat against the checklist, minutes
const QA_VOICE_FACTOR = 1.5; // listening + notes ≈ 1.5× call length (+ 5 min checklist)
const QA_RATE_USD = 15;      // loaded hourly cost of a QA specialist

function savings(conversations) {
  const evaluated = conversations.filter((c) => c.evaluation);
  const minutes = evaluated.reduce((m, c) => m + (/voice|call/i.test(c.channel) ? ((c.duration || 300) / 60) * QA_VOICE_FACTOR + 5 : QA_MIN_CHAT), 0);
  const hours = minutes / 60;
  const ai = evaluated.reduce((sum, c) => sum + (Number(c.evaluation.costUsd) || 0), 0);
  return { hours, ai, human: hours * QA_RATE_USD, n: evaluated.length };
}

/** Seconds -> "22 мс" / "4.5 с" / "3.2 мин" / "1.5 ч". */
function fmtDur(sec) {
  if (sec < 1) return `${Math.max(1, Math.round(sec * 1000))} ${t('unit.ms')}`;
  if (sec < 60) return `${fmtNum(sec, sec < 10 ? 2 : 0)} ${t('unit.sec')}`;
  if (sec < 3600) return `${fmtNum(sec / 60, 1)} ${t('unit.min')}`;
  return `${fmtNum(sec / 3600, 1)} ${t('unit.hour')}`;
}

/** @param {HTMLElement} root */
export function mount(root) {
  let ready = false;
  /** Real numbers from the backend (GET /api/stats); null in mock mode or if the call fails. */
  let server = null;
  const loadServer = () => {
    if (!api.stats) return;
    api.stats().then((r) => { server = r; draw(); }).catch(() => { server = null; });
  };
  const readyTimer = window.setTimeout(() => { ready = true; draw(); }, 450);

  function savingsWidget(sv) {
    const ai = server ? server.aiCostUsd : sv.ai;
    const fact = server ? html`<div class="cqa-savings__fact">
        <span>${icon('cpu', { size: 13 })}${t('dash.machineTime', { time: fmtDur(server.machineSeconds), avg: fmtDur(server.avgMs / 1000), n: server.evaluations })}</span>
        <span>${icon('cloud', { size: 13 })}${server.llmUsed
          ? t('dash.llmFact', { model: server.models.filter((m) => m !== 'rule-based-v1').join(', '), calls: fmtNum(server.llmCalls), tin: fmtNum(server.tokens.in), tout: fmtNum(server.tokens.out), avg: fmtUsd(server.avgCostUsd, 4) })
          : t(server.llmConnected ? 'dash.llmReady' : 'dash.noLlm', { model: server.currentModel })}</span>
      </div>` : '';
    return html`<aside class="cqa-savings" aria-label="${t('dash.savings')}">
      <div class="cqa-savings__main">
        <span class="cqa-savings__label">${icon('clockfast', { size: 16 })}${t('dash.savedTime')}</span>
        <span class="cqa-savings__val"><span data-sv-hours></span><small>${t('dash.hoursQa')}</small></span>
      </div>
      <div class="cqa-savings__cost">
        <span><b class="cqa-num">${fmtUsd(ai, ai > 0 && ai < 1 ? 4 : 2)}</b> ${t('dash.aiCost')}${server ? html` <span class="cqa-savings__tag">${t('dash.fact')}</span>` : ''}</span>
        <span class="cqa-savings__vs">${t('dash.insteadOf')} <s class="cqa-num">≈ ${fmtUsd(Math.round(sv.human), 0)}</s> ${t('dash.humanQa')}</span>
      </div>
      ${fact}
      <span class="cqa-savings__note" title="${t('dash.savingsAssumptions', { chat: QA_MIN_CHAT, factor: QA_VOICE_FACTOR, rate: QA_RATE_USD })}">${icon('info', { size: 13 })}${server ? t('dash.estimateHours') : t('dash.estimate')}</span>
    </aside>`;
  }

  /**
   * Paint the page but keep the headline and subtitle nodes that are already on screen.
   * The dashboard draws twice on open (skeleton, then data) and again on every store change;
   * re-creating the <h1> restarted its letter-by-letter entrance — the headline blinked out and back in.
   */
  function paint(tpl) {
    const tmp = document.createElement('div');
    render(tmp, tpl);
    const next = /** @type {HTMLElement|null} */ (tmp.firstElementChild);
    const cur = /** @type {HTMLElement|null} */ (root.querySelector(':scope > .cqa-page'));
    if (!next) return;
    const curHead = cur?.querySelector(':scope > .cqa-page__head');
    const nextHead = next.querySelector(':scope > .cqa-page__head');
    const curTitle = curHead?.querySelector(':scope > .cqa-page__title');
    if (!cur || !curHead || !nextHead || !curTitle) { root.replaceChildren(next); return; }
    // The title block never leaves the document (moving a node restarts its CSS animations):
    // only the subtitle text and the head's other parts (savings widget) are updated around it.
    const lead = /** @type {HTMLElement|null} */ (curTitle.querySelector('.cqa-lead'));
    const text = (nextHead.querySelector('.cqa-page__title .cqa-lead')?.textContent || '').trim();
    if (lead && text) setLead(lead, text);
    [...curHead.children].forEach((c) => { if (c !== curTitle) c.remove(); });
    [...nextHead.children].forEach((c) => { if (!c.classList.contains('cqa-page__title')) curHead.appendChild(c); });
    [...cur.children].forEach((c) => { if (c !== curHead) c.remove(); });
    [...next.children].forEach((c) => { if (c !== nextHead) cur.appendChild(c); });
  }

  function draw() {
    const s = store.get();
    const st = s.loading ? null : computeStats(s.conversations, s.appeals, activeChecklist(s));
    if (!st || !ready) {
      paint(html`<div class="cqa-page"><div class="cqa-page__head"><div class="cqa-page__title"><h1 class="cqa-display">${t('dash.title')}</h1>
        <p class="cqa-lead" aria-busy="true">&nbsp;</p></div></div>
        <div class="cqa-kpis">${Array.from({ length: 5 }, () => html`<div class="cqa-kpi"><span class="cqa-skel" style="height:12px;width:50%"></span><span class="cqa-skel" style="height:44px;width:70%"></span><span class="cqa-skel" style="height:10px;width:60%"></span></div>`)}</div>
        ${chartSkeleton(4)}</div>`);
      return;
    }
    const head = html`<div class="cqa-page__head"><div class="cqa-page__title"><h1 class="cqa-display">${t('dash.title')}</h1>
      <p class="cqa-lead">${t('dash.lead', { n: st.evaluatedCount, total: st.total })}</p></div>
      ${st.evaluatedCount ? savingsWidget(savings(s.conversations)) : ''}</div>`;
    const resetBtn = config.USE_MOCK ? html`<div class="cqa-row" style="justify-content:flex-end;margin-top:28px"><button type="button" class="cqa-btn cqa-btn--line cqa-btn--sm" data-act="reset">${icon('refresh', { size: 16 })}${t('dash.resetMock')}</button></div>` : '';
    if (!st.evaluatedCount) {
      paint(html`<div class="cqa-page">${head}<div class="cqa-card">${emptyState({ title: t('dash.empty'), text: t('dash.emptyHint'), action: html`<a class="cqa-btn cqa-btn--primary" href="#/conversations">${t('nav.conversations')}</a>` })}</div>${resetBtn}</div>`);
      return;
    }
    paint(html`<div class="cqa-page">${head}
      <div class="cqa-kpis">
        <div class="cqa-kpi cqa-kpi--vault" style="--i:0"><span class="cqa-eyebrow">${t('dash.avg')}</span><span class="cqa-kpi__val cqa-num" data-odo></span>
          <span class="cqa-kpi__sub">${t('dash.avgAI')}: ${fmtScore(st.avgAI)}</span></div>
        <div class="cqa-kpi" style="--i:1"><span class="cqa-eyebrow">${t('dash.evaluated')}</span><span class="cqa-kpi__val cqa-num">${st.evaluatedCount}<span class="cqa-mute" style="font-size:20px"> / ${st.total}</span></span>
          <span class="cqa-kpi__sub">${st.byChannel.map((c) => `${t('channel.' + c.channel)}: ${c.count}`).join(' · ')}</span></div>
        <a class="cqa-kpi cqa-kpi--link" style="--i:2" href="#/conversations?gross=1&amp;from=dash" title="${t('dash.openFiltered')}"><span class="cqa-eyebrow">${t('dash.gross')}</span><span class="cqa-kpi__val cqa-num" style="${st.gross ? 'color:var(--cqa-red)' : ''}">${st.gross}</span>
          <span class="cqa-kpi__sub">${t('dash.grossSub')}</span></a>
        <div class="cqa-kpi" style="--i:3"><span class="cqa-eyebrow">${t('dash.appeals')}</span><span class="cqa-kpi__val cqa-num">${st.appeals.total}</span>
          <span class="cqa-kpi__sub">${t('dash.appealsSub', { open: st.appeals.open, changed: st.appeals.changed, decided: st.appeals.decided })}</span></div>
        <div class="cqa-kpi" style="--i:4"><span class="cqa-eyebrow">${t('dash.accuracy')}</span><span class="cqa-kpi__val cqa-num" style="color:var(--cqa-green-text)">${pct(st.appeals.aiAccuracy)}</span>
          <span class="cqa-kpi__sub">${t('dash.accuracySub', { rate: pct(st.appeals.changeRate) })}</span></div>
      </div>
      <div class="cqa-dash__grid">
        <section class="cqa-card cqa-dash__cell cqa-stack-y"><div class="cqa-row cqa-row--between"><h2 class="cqa-h3">${t('dash.histogram')}</h2><span class="cqa-click-hint">${icon('target', { size: 13 })}${t('dash.clickHint')}</span></div>${histogram(st.histogram)}</section>
        <section class="cqa-card cqa-dash__cell cqa-stack-y"><h2 class="cqa-h3">${t('dash.byLang')}</h2>
          ${bars(st.byLang.map((l) => ({ label: l.lang, avg: l.avg, count: l.count, nav: `/conversations?lang=${l.lang}` })), t('dash.byLang'))}
          <hr class="cqa-hr" style="margin:4px 0">
          ${bars(st.byChannel.map((c) => ({ label: t('channel.' + c.channel), avg: c.avg, count: c.count, nav: `/conversations?channel=${c.channel}` })), t('dash.byChannel'))}
        </section>
        <section class="cqa-card cqa-dash__cell--wide cqa-stack-y"><div class="cqa-row cqa-row--between cqa-row--wrap"><h2 class="cqa-h3">${t('dash.heatmap')}</h2><span class="cqa-small cqa-muted">${t('dash.heatmapHint')}</span></div>
          <div class="cqa-heat" style="grid-template-columns:minmax(200px,2fr) repeat(${st.langs.length + 1},minmax(64px,1fr))" role="group" aria-label="${t('dash.heatmap')}">
            <span aria-hidden="true"></span>${st.langs.map((l) => html`<a class="cqa-heat__head cqa-heat__head--link" href="#/conversations?lang=${l}&amp;from=dash" title="${t('dash.openFiltered')}: ${l}">${l}</a>`)}<span class="cqa-heat__head">${t('common.all')}</span>
            ${st.criteria.map((c, i) => html`<span class="cqa-heat__label"><span class="cqa-mono cqa-mute" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span><span title="${c.title}">${c.title}</span></span>
              ${st.langs.map((l) => html`<a class="cqa-heat__cell cqa-heat__cell--link" style="${heatColor(c.byLang[l])}" href="#/conversations?lang=${l}&amp;from=dash" aria-label="${c.title} · ${l}: ${pct(c.byLang[l])}" title="${t('dash.openFiltered')}: ${l}">${pct(c.byLang[l])}</a>`)}
              <span class="cqa-heat__cell" style="${heatColor(c.pass)};font-weight:600" aria-label="${c.title} · ${t('common.all')}: ${pct(c.pass)}">${pct(c.pass)}</span>`)}
          </div></section>
        <section class="cqa-card cqa-dash__cell cqa-stack-y"><h2 class="cqa-h3">${t('dash.naRate')}</h2>
          ${st.criteria.map((c) => html`<div class="cqa-hbar"><span>${c.title}</span><span class="cqa-hbar__track"><span class="cqa-hbar__fill" style="width:${Math.round(c.naRate * 100)}%"></span></span><span class="cqa-num cqa-mono" style="text-align:right">${pct(c.naRate)}</span></div>`)}
        </section>
        <section class="cqa-card cqa-dash__cell cqa-stack-y"><h2 class="cqa-h3">${t('dash.problems')}</h2>
          ${st.problems.map((c, i) => html`<div class="cqa-hbar" style="grid-template-columns:28px minmax(0,1fr) 140px 52px"><span class="cqa-mono" style="color:var(--cqa-red)">#${i + 1}</span><span>${c.title}</span><span class="cqa-hbar__track"><span class="cqa-hbar__fill cqa-hbar__fill--red" style="width:${Math.round((1 - c.pass) * 100)}%"></span></span><span class="cqa-num cqa-mono" style="text-align:right">${pct(c.pass)}</span></div>`)}
          <p class="cqa-small cqa-mute">${t('dash.problemsHint')}</p>
        </section>
      </div>
      ${resetBtn}
    </div>`);
    const odoEl = $(root, '[data-odo]');
    if (odoEl) createOdometer(/** @type {HTMLElement} */ (odoEl)).set(st.avg);
    const hEl = $(root, '[data-sv-hours]');
    if (hEl) createOdometer(/** @type {HTMLElement} */ (hEl), { decimals: 1 }).set(Math.round(savings(s.conversations).hours * 10) / 10);
  }

  const onClick = async (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('[data-act="reset"]')) return;
    if (!(await confirmDialog({ title: t('dash.resetMock'), message: t('dash.resetText'), confirmLabel: t('dash.resetMock'), danger: true }))) return;
    await api.reset?.();
    await bootstrap();
    toast({ kind: 'success', title: t('dash.resetDone') });
  };
  root.addEventListener('click', onClick);
  draw();
  loadServer();
  const unsub = store.subscribe((s, p) => {
    if (s.conversations !== p.conversations) loadServer(); // new evaluations -> fresh spend/time
    if (s.conversations !== p.conversations || s.appeals !== p.appeals || s.loading !== p.loading || s.checklists !== p.checklists) draw();
  });
  return { update() {}, destroy() { clearTimeout(readyTimer); unsub(); root.removeEventListener('click', onClick); root.innerHTML = ''; } };
}
