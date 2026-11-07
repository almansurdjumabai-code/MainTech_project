/** Standalone shell: header, ticker, hash router. Exposes only window.CQA. */
import { config } from './config.js';
import { html, raw, render, $, $$, fmtScore } from './core/utils.js';
import { logoMarkup } from './components/logo.js';
import * as Splash from './components/splash.js';
import { icon } from './core/icons.js';
import { initI18n, setLang, t } from './core/i18n.js';
import { store, activeChecklist } from './core/store.js';
import { startRouter, navigate, parseHash } from './core/router.js';
import { bootstrap, checkHealth } from './core/actions.js';
import { computeStats } from './core/stats.js';
import { api } from './api/client.js';
import * as Toast from './components/toast.js';
import { setModalHost } from './components/modal.js';
import * as ConversationList from './components/conversation-list.js';
import * as ConversationCard from './components/conversation-card.js';
import * as ChecklistEditor from './components/checklist-editor.js';
import * as ReviewerQueue from './components/reviewer-queue.js';
import * as Dashboard from './components/dashboard.js';
import * as DemoTour from './components/demo-tour.js';
import { initPointerFx, placeGlider, transition, observeEnhance } from './core/fx.js';

const PAGES = {
  conversations: { mod: ConversationList, nav: 'conversations', props: (r) => ({ query: Object.fromEntries(r.query) }) },
  conversation: { mod: ConversationCard, nav: 'conversations', props: (r) => ({ id: r.params.id, msg: r.query.has('msg') ? Number(r.query.get('msg')) : null }) },
  checklists: { mod: ChecklistEditor, nav: 'checklists', props: () => ({}) },
  appeals: { mod: ReviewerQueue, nav: 'appeals', props: (r) => ({ id: r.query.get('id') }) },
  dashboard: { mod: Dashboard, nav: 'dashboard', props: () => ({}) },
};
const NAV = [
  ['conversations', 'list'], ['checklists', 'doc'], ['appeals', 'gavel'], ['dashboard', 'chart'],
];

const host = /** @type {HTMLElement} */ (document.getElementById('cqa-app'));
/** Shell container; toasts / modals / tour live beside it so a re-render keeps them. */
const shellEl = document.createElement('div');

let page = null;
let pageName = null;
let tour = null;

function shell() {
  render(shellEl, html`<div class="cqa-app">
    <header class="cqa-header" data-header></header>
    <div class="cqa-ticker" aria-label="${t('ticker.label')}" data-ticker></div>
    <main class="cqa-main" id="cqa-main" data-main tabindex="-1"></main>
  </div>`);
}

function drawHeader() {
  const s = store.get();
  const route = parseHash();
  const active = PAGES[route.name]?.nav;
  const openAppeals = s.appeals.filter((a) => a.status === 'submitted' || a.status === 'in_review').length;
  const src = config.USE_MOCK ? `MOCK · ${s.dataset}` : s.dataset;
  render($(host, '[data-header]'), html`<div class="cqa-header__inner">
    <a class="cqa-brand" href="#/conversations" aria-label="Freedom Broker · CQA">${raw(logoMarkup())}<span class="cqa-brand__tag" aria-hidden="true">CQA</span></a>
    <nav class="cqa-nav" aria-label="${t('nav.label')}">${NAV.map(([k, ic]) => html`<a class="cqa-nav__link ${active === k ? 'is-active' : ''}" href="#/${k}" ${active === k ? 'aria-current="page"' : ''}>${icon(ic, { size: 16 })}<span class="cqa-nav__text">${t('nav.' + k)}</span>${k === 'appeals' && openAppeals ? html`<span class="cqa-nav__count" aria-label="${t('appeals.f.open')}">${openAppeals}</span>` : ''}</a>`)}</nav>
    <div class="cqa-header__tools">
      <span class="cqa-source" title="${config.USE_MOCK ? t('header.mockHint') : config.API_BASE}">
        <span class="cqa-dot ${s.backendOnline ? 'cqa-dot--on' : s.backendOnline === false ? 'cqa-dot--off' : ''}" aria-hidden="true"></span>
        <span class="cqa-source__label">${s.backendOnline === false ? t('header.offline') : t('header.online')} ·</span> ${src}
      </span>
      <div class="cqa-seg" role="group" aria-label="${t('header.role')}">
        <button type="button" class="cqa-seg__btn ${s.role === 'qa' ? 'is-active' : ''}" data-role="qa" aria-pressed="${s.role === 'qa'}">${icon('user', { size: 14 })}QA</button>
        <button type="button" class="cqa-seg__btn ${s.role === 'reviewer' ? 'is-active' : ''}" data-role="reviewer" aria-pressed="${s.role === 'reviewer'}">${icon('gavel', { size: 14 })}${t('header.reviewer')}</button>
      </div>
      <div class="cqa-seg" role="group" aria-label="${t('header.lang')}">
        ${['ru', 'kz', 'en'].map((l) => html`<button type="button" class="cqa-seg__btn ${s.lang === l ? 'is-active' : ''}" data-lang="${l}" aria-pressed="${s.lang === l}">${l.toUpperCase()}</button>`)}
      </div>
      <button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--icon cqa-btn--sm" data-theme-toggle aria-label="${t('header.theme')}" title="${t('header.theme')}">${icon(s.theme === 'dark' ? 'sun' : 'moon', { size: 16 })}</button>
    </div>
  </div>`);
  requestAnimationFrame(() => placeGlider(shellEl, true));
}

function drawTicker() {
  const s = store.get();
  const el = $(host, '[data-ticker]');
  if (s.loading || !s.conversations.length) { el.innerHTML = ''; return; }
  const st = computeStats(s.conversations, s.appeals, activeChecklist(s));
  const d = st.avg != null && st.avgAI != null ? st.avg - st.avgAI : 0;
  const arrow = d > 0.005 ? html`<span class="cqa-ticker__up">▲${d.toFixed(2)}</span>` : d < -0.005 ? html`<span class="cqa-ticker__down">▼${Math.abs(d).toFixed(2)}</span>` : '';
  const items = [
    html`${t('ticker.avg')} <b>${fmtScore(st.avg)}</b> ${arrow}`,
    html`${t('ticker.evaluated')} <b>${st.evaluatedCount}</b>/${st.total}`,
    ...st.byLang.filter((l) => l.count).map((l) => html`${l.lang} <b>${fmtScore(l.avg)}</b>`),
    html`${t('ticker.appeals')} <b>${st.appeals.open}</b>`,
    html`${t('ticker.gross')} <b>${st.gross}</b>`,
    html`${t('ticker.accuracy')} <b>${st.appeals.aiAccuracy == null ? '—' : Math.round(st.appeals.aiAccuracy * 100) + '%'}</b>`,
    html`${t('ticker.checklist')} <b>v${activeChecklist(s)?.version ?? '—'}</b>`,
  ];
  // Two identical groups → seamless loop (track scrolls by -50%).
  const group = (hidden) => html`<span class="cqa-ticker__group" ${hidden ? 'aria-hidden="true"' : ''}>${items.map((it) => html`<span class="cqa-ticker__item">${it}</span><span class="cqa-ticker__sep">·</span>`)}</span>`;
  render(el, html`<div class="cqa-ticker__track">${group(false)}${group(true)}</div>`);
}

function onRoute(route) {
  const def = PAGES[route.name];
  const main = /** @type {HTMLElement} */ ($(host, '[data-main]'));
  if (page && pageName === route.name) {
    page.update(def.props(route));
  } else {
    const swap = () => {
      page?.destroy();
      main.innerHTML = '';
      const el = document.createElement('div');
      el.className = 'cqa-page-enter';
      main.appendChild(el);
      pageName = route.name;
      page = def.mod.mount(el, def.props(route));
      window.scrollTo({ top: 0 });
      setTimeout(() => el.classList.remove('cqa-page-enter'), 1400);
    };
    if (page) transition(swap); else swap();
  }
  $$(host, '.cqa-nav__link').forEach((a) => {
    const on = a.getAttribute('href') === `#/${def.nav}`;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  placeGlider(shellEl);
}

function remountPage() {
  page?.destroy();
  page = null;
  pageName = null;
  onRoute(parseHash());
}

async function start() {
  const s = store.get();
  host.dataset.theme = s.theme;
  host.replaceChildren(shellEl);
  // Intro overlays the app while it boots and fetches data underneath (never blocks).
  if (Splash.shouldShow()) Splash.mount(host, { lang: s.lang });
  else document.documentElement.classList.remove('cqa-preintro');
  await initI18n(s.lang);
  document.documentElement.lang = s.lang === 'kz' ? 'kk' : s.lang;
  shell();
  setModalHost(host);
  Toast.mount(host);
  drawHeader();
  bootstrap();
  startRouter(onRoute);
  if (config.DEMO) tour = DemoTour.mount(host);
  setInterval(checkHealth, 30000);
  observeEnhance(shellEl);
  initPointerFx(host);
  window.addEventListener('resize', () => placeGlider(shellEl, true));
  document.fonts?.ready.then(() => placeGlider(shellEl, true));

  host.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const r = el?.closest('[data-role]');
    if (r) store.set({ role: /** @type {'qa'|'reviewer'} */ (r.getAttribute('data-role')) });
    const l = el?.closest('[data-lang]');
    if (l) store.set({ lang: /** @type {any} */ (l.getAttribute('data-lang')) });
    if (el?.closest('[data-theme-toggle]')) store.set({ theme: store.get().theme === 'dark' ? 'light' : 'dark' });
  });

  store.subscribe((n, p) => {
    if (n.lang !== p.lang) {
      setLang(n.lang);
      document.documentElement.lang = n.lang === 'kz' ? 'kk' : n.lang;
      shell(); drawHeader(); drawTicker(); remountPage();
      tour?.update();
      return;
    }
    if (n.theme !== p.theme) host.dataset.theme = n.theme;
    if (n.role !== p.role || n.theme !== p.theme || n.backendOnline !== p.backendOnline || n.dataset !== p.dataset || n.appeals !== p.appeals) drawHeader();
    if (n.conversations !== p.conversations || n.appeals !== p.appeals || n.loading !== p.loading || n.checklists !== p.checklists) drawTicker();
  });
}

window.CQA = Object.assign(window.CQA || {}, { version: '1.0.0', config, store, api, navigate });
start();
