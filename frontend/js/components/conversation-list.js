/**
 * Conversations: dataset loader (group_id), JSON / manual import, batch evaluation with live progress,
 * filterable / sortable table.
 */
import { html, render, $, $$, fmtClock, fmtScore, isVoice, langCode, fmtDate, debounce, storage } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t, getLang } from '../core/i18n.js';
import { store } from '../core/store.js';
import { loadDataset, importRecords, runChecklistId, refreshConversations } from '../core/actions.js';
import { runEvaluation, retryFailed, jobItemFor } from '../core/jobs.js';
import { navigate, convLink } from '../core/router.js';
import { config } from '../config.js';
import { langBadge, channelBadge, emptyState, skeleton, tableSkeleton, scoreTone, appealBadge, createOdometer, modelMode } from './ui.js';
import { toast, errorToast } from './toast.js';
import { renderHero, sparkline, meter, split } from './hero.js';
import { pageArt } from './page-art.js';
import { openModal } from './modal.js';
import { setLead } from '../core/fx.js';

const VERDICTS = ['pass', 'fail', 'manual', 'dispute', 'none', 'running'];
/** Rows rendered per step — keeps the DOM small for 65+ conversation datasets. */
const PAGE = 50;
const SCORES = ['low', 'mid', 'high'];

/** @param {HTMLElement} root @param {{query?: Record<string,string>}} [props] */
export function mount(root, props = {}) {
  const ui = { q: '', channel: '', lang: '', status: '', score: '', gross: false, fromDash: false, sort: 'id', dir: 1, limit: PAGE, selected: new Set(), groupId: store.get().dataset || config.DEFAULT_GROUP_ID };
  let skelTimer = 0;

  /** Filters can arrive from a link, e.g. dashboard: #/conversations?lang=KZ&score=low&gross=1 */
  function applyQuery(q = {}) {
    const has = ['lang', 'score', 'status', 'channel', 'gross', 'q', 'sort'].some((k) => q[k] != null);
    if (!has) return false;
    Object.assign(ui, { lang: '', score: '', status: '', channel: '', gross: false, q: '', sort: 'id', dir: 1 });
    if (typeof q.q === 'string') ui.q = q.q.slice(0, 80);
    if (['id', 'channel', 'lang', 'messages', 'duration', 'status', 'score', 'gross', 'appeal'].includes(q.sort)) ui.sort = q.sort;
    if (q.dir === 'desc') ui.dir = -1;
    if (['RU', 'KZ', 'EN'].includes(q.lang)) ui.lang = q.lang;
    if (SCORES.includes(q.score)) ui.score = q.score;
    if (VERDICTS.includes(q.status)) ui.status = q.status;
    if (q.channel === 'chat' || q.channel === 'voice') ui.channel = q.channel;
    if (q.gross === '1') ui.gross = true;
    ui.fromDash = q.from === 'dash';
    return true;
  }
  applyQuery(props.query);
  let batchOdo = null;
  let lastBatchId = null;
  let tableShown = false;

  render(root, html`<div class="cqa-page">
    <div class="cqa-page__head">
      <div class="cqa-page__title">
        <h1 class="cqa-display">${t('list.title')}</h1>
        <p class="cqa-lead" data-subtitle></p>
      </div>
      ${pageArt('conversations')}
    </div>
    <div data-hero></div>
    <div class="cqa-panel-grid">
      <section class="cqa-card cqa-stack-y" data-tour="loader" aria-labelledby="cqa-loader-h">
        <div class="cqa-row cqa-row--between"><h2 class="cqa-h3" id="cqa-loader-h">${t('list.loadTitle')}</h2><span class="cqa-eyebrow">GET /datasets/:group_id</span></div>
        <form class="cqa-toolbar" data-form="dataset">
          <label class="cqa-field" style="flex:1 1 160px"><span class="cqa-field__label">group_id</span>
            <input class="cqa-input cqa-input--mono" name="group" value="${ui.groupId}" autocomplete="off" spellcheck="false" list="cqa-groups"></label>
          <datalist id="cqa-groups"><option value="DEV"></option><option value="CONTROL"></option></datalist>
          <button type="submit" class="cqa-btn cqa-btn--primary" data-load>${icon('download', { size: 16 })}${t('list.load')}</button>
          <button type="button" class="cqa-btn cqa-btn--secondary" data-act="import">${icon('upload', { size: 16 })}${t('list.import')}</button>
        </form>
        <div data-load-msg></div>
      </section>
      <section class="cqa-card cqa-stack-y" data-tour="run" aria-labelledby="cqa-run-h">
        <div class="cqa-row cqa-row--between"><h2 class="cqa-h3" id="cqa-run-h">${t('run.title')}</h2><span class="cqa-eyebrow" data-model-meta></span></div>
        <div class="cqa-toolbar" data-run></div>
      </section>
    </div>
    <div data-batch></div>
    <div class="cqa-filters" data-filters></div>
    <div data-table></div>
  </div>`);

  const $sub = $(root, '[data-subtitle]');
  const $run = $(root, '[data-run]');
  const $table = $(root, '[data-table]');
  const $batch = $(root, '[data-batch]');
  const $filters = $(root, '[data-filters]');

  function drawFilters() {
    render($filters, html`
      <div class="cqa-search">${icon('search', { size: 16 })}<input class="cqa-input" type="search" name="q" autocomplete="off" spellcheck="false" inputmode="search" data-f="q" placeholder="${t('list.search')}" value="${ui.q}" aria-label="${t('list.search')}"></div>
      <select class="cqa-select cqa-select--sm" data-f="channel" style="width:auto" aria-label="${t('list.col.channel')}">
        <option value="">${t('list.allChannels')}</option><option value="chat" ${ui.channel === 'chat' ? 'selected' : ''}>${t('channel.chat')}</option><option value="voice" ${ui.channel === 'voice' ? 'selected' : ''}>${t('channel.voice')}</option></select>
      <div class="cqa-seg" role="group" aria-label="${t('list.col.lang')}">${['', 'RU', 'KZ', 'EN'].map((l) => html`<button type="button" class="cqa-seg__btn ${ui.lang === l ? 'is-active' : ''}" data-lang-f="${l}">${l || t('common.all')}</button>`)}</div>
      <select class="cqa-select cqa-select--sm" data-f="status" style="width:auto" aria-label="${t('list.col.status')}">
        ${['', ...VERDICTS].map((v) => html`<option value="${v}" ${ui.status === v ? 'selected' : ''}>${v ? t('verdict.' + v) : t('list.allStatuses')}</option>`)}</select>
      <select class="cqa-select cqa-select--sm" data-f="score" style="width:auto" aria-label="${t('list.col.score')}">
        ${['', ...SCORES].map((v) => html`<option value="${v}" ${ui.score === v ? 'selected' : ''}>${v ? t('score.' + v) : t('score.all')}</option>`)}</select>
      <label class="cqa-switch"><input type="checkbox" data-f="gross" ${ui.gross ? 'checked' : ''}><span class="cqa-switch__track"></span>${t('list.grossOnly')}</label>
      ${ui.fromDash ? html`<button type="button" class="cqa-chip-filter" data-act="reset-filters">${icon('chart', { size: 14 })}${t('list.fromDash')}${icon('x', { size: 13 })}</button>` : ''}
      <span class="cqa-grow"></span>
      <span class="cqa-small cqa-mute" data-count></span>`);
  }

  function drawRun() {
    const s = store.get();
    const model = s.models.find((m) => m.id === s.model);
    const runCl = runChecklistId();
    const visible = filtered().map((c) => c.conversation_id);
    const sel = [...ui.selected];
    render($run, html`
      <label class="cqa-field" style="flex:1 1 140px"><span class="cqa-field__label">${t('run.checklist')}</span>
        <select class="cqa-select" data-r="checklist">${s.checklists.map((c) => html`<option value="${c.id}" ${c.id === runCl ? 'selected' : ''}>v${c.version} · ${c.criteria.length} ${t('checklist.criteriaShort')}${c.active ? ` · ${t('checklist.active')}` : ''}</option>`)}</select></label>
      ${s.models.length ? html`<label class="cqa-field" style="flex:1 1 180px"><span class="cqa-field__label">${t('run.model')}</span>
        <select class="cqa-select" data-r="model">${s.models.map((m) => html`<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.name} · ${m.kind === 'local' ? t('run.local') : t('run.cloud')}</option>`)}</select></label>` : ''}
      <button type="button" class="cqa-btn cqa-btn--primary" data-act="run-selected" ${sel.length ? '' : 'disabled'}>${icon('spark', { size: 16 })}${t('run.selected', { n: sel.length })}</button>
      <button type="button" class="cqa-btn cqa-btn--secondary" data-act="run-all" ${visible.length ? '' : 'disabled'}>${t('run.all', { n: visible.length })}</button>`);
    render($(root, '[data-model-meta]'), modelMode(model));
  }

  function drawBatch() {
    const s = store.get();
    const job = [...s.jobs].reverse().find((j) => j.total > 1);
    if (!job || s.dismissedJob === job.jobId) { $batch.innerHTML = ''; batchOdo = null; lastBatchId = null; return; }
    const fin = job.done + job.failed;
    const errors = job.items.filter((i) => i.status === 'error');
    if (lastBatchId !== job.jobId) {
      lastBatchId = job.jobId;
      render($batch, html`<section class="cqa-vault cqa-batch" style="margin-bottom:20px" aria-live="polite" data-tour="batch">
        <div class="cqa-batch__head">
          <span class="cqa-eyebrow">${t('batch.title')}</span>
          <span class="cqa-batch__count"><span data-odo></span><small>/ ${job.total}</small></span>
          <span class="cqa-grow"></span>
          <span class="cqa-mono" data-eta style="color:var(--cqa-vault-mute)"></span>
          <button type="button" class="cqa-btn cqa-btn--vault cqa-btn--xs" data-act="dismiss" aria-label="${t('common.close')}">${icon('x', { size: 14 })}</button>
        </div>
        <div class="cqa-batch__segs" role="progressbar" aria-valuemin="0" aria-valuemax="${job.total}">${job.items.map((it) => html`<span class="cqa-batch__seg" title="${it.conversationId}" data-seg="${it.conversationId}"></span>`)}</div>
        <div class="cqa-batch__errors" data-errors></div>
      </section>`);
      batchOdo = createOdometer(/** @type {HTMLElement} */ ($($batch, '[data-odo]')), { decimals: 0 });
    }
    batchOdo?.set(fin);
    job.items.forEach((it) => {
      const seg = $($batch, `[data-seg="${CSS.escape(it.conversationId)}"]`);
      if (seg) seg.className = `cqa-batch__seg ${it.status === 'done' ? 'is-done' : it.status === 'error' ? 'is-error' : it.status === 'running' ? 'is-running' : ''}`;
    });
    $($batch, '[role="progressbar"]')?.setAttribute('aria-valuenow', String(fin));
    const eta = $($batch, '[data-eta]');
    if (eta) eta.textContent = job.status === 'done' ? `${t('batch.done')} · ${fmtDate(job.finishedAt || new Date().toISOString(), getLang())}` : job.etaMs != null ? `ETA ${fmtClock(job.etaMs / 1000)}` : t('batch.starting');
    const errBox = $($batch, '[data-errors]');
    if (errBox) render(errBox, errors.length ? html`
      ${errors.map((it) => html`<div class="cqa-batch__err">${icon('x', { size: 14 })}<span class="cqa-mono">${it.conversationId}</span><span>${it.error || ''}</span></div>`)}
      ${job.status === 'done' ? html`<div><button type="button" class="cqa-btn cqa-btn--vault cqa-btn--sm" data-act="retry-failed" data-job="${job.jobId}">${icon('refresh', { size: 16 })}${t('batch.retry', { n: errors.length })}</button></div>` : ''}` : '');
  }

  function statusOf(c) {
    const ji = jobItemFor(c.conversation_id);
    if (ji && (ji.item.status === 'queued' || ji.item.status === 'running')) return 'running';
    if (ji && ji.item.status === 'error' && !c.evaluation) return 'error';
    return c.evaluation ? 'done' : 'none';
  }

  /** Passed / Failed / Manual review / Dispute — what QA needs to act on. */
  function verdictOf(c) {
    const st = statusOf(c);
    if (st !== 'done') return st === 'error' ? 'none' : st;
    if (c.appealStatus === 'submitted' || c.appealStatus === 'in_review') return 'dispute';
    const ev = c.evaluation;
    if (ev.grossViolation || (ev.total != null && ev.total < 60)) return 'fail';
    if ((ev.criteria || []).some((d) => d.confidence != null && d.confidence < config.LOW_CONFIDENCE)) return 'manual';
    return 'pass';
  }

  const scoreBand = (c) => {
    const v = c.evaluation?.total;
    if (v == null) return '';
    return v < 60 ? 'low' : v < 80 ? 'mid' : 'high';
  };

  /** The URL mirrors filters, search and sort (shareable, survives reload / Back). */
  function syncUrl() {
    const p = new URLSearchParams();
    if (ui.lang) p.set('lang', ui.lang);
    if (ui.score) p.set('score', ui.score);
    if (ui.status) p.set('status', ui.status);
    if (ui.channel) p.set('channel', ui.channel);
    if (ui.gross) p.set('gross', '1');
    if (ui.q.trim()) p.set('q', ui.q.trim());
    if (ui.sort !== 'id' || ui.dir < 0) { p.set('sort', ui.sort); if (ui.dir < 0) p.set('dir', 'desc'); }
    if (ui.fromDash) p.set('from', 'dash');
    const qs = p.toString();
    history.replaceState(history.state, '', `#/conversations${qs ? '?' + qs : ''}`);
  }

  /** Short skeleton while filters re-apply, so the table feels networked. */
  function refilter() {
    clearTimeout(skelTimer);
    render($table, tableSkeleton(7));
    ui.limit = PAGE;
    syncUrl();
    skelTimer = window.setTimeout(() => { tableShown = false; drawTable(); drawRun(); }, 380);
  }

  function filtered() {
    const s = store.get();
    const q = ui.q.trim().toLowerCase();
    let list = s.conversations.filter((c) => {
      if (q && !c.conversation_id.toLowerCase().includes(q)) return false;
      if (ui.channel && (isVoice(c) ? 'voice' : 'chat') !== ui.channel) return false;
      if (ui.lang && langCode(c.language) !== ui.lang) return false;
      if (ui.gross && !c.evaluation?.grossViolation) return false;
      if (ui.status && verdictOf(c) !== ui.status) return false;
      if (ui.score && scoreBand(c) !== ui.score) return false;
      return true;
    });
    const key = {
      id: (c) => c.conversation_id, channel: (c) => (isVoice(c) ? 1 : 0), lang: (c) => langCode(c.language), messages: (c) => c.messages,
      duration: (c) => c.duration ?? -1, status: (c) => verdictOf(c), score: (c) => c.evaluation?.total ?? -1, gross: (c) => (c.evaluation?.grossViolation ? 1 : 0), appeal: (c) => c.appealStatus || '',
    }[ui.sort];
    list = [...list].sort((a, b) => { const x = key(a); const y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * ui.dir; });
    return list;
  }

  function th(k, label, num = false) {
    const active = ui.sort === k;
    return html`<th class="${num ? 'cqa-td-num' : ''}" ${active ? html`aria-sort="${ui.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" class="cqa-th-sort" data-sort="${k}" ${active ? 'data-active' : ''}>${label}${active ? (ui.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
  }

  function drawHero() {
    const s = store.get();
    if (s.loading || !s.conversations.length) return;
    const convs = s.conversations;
    const evaluated = convs.filter((c) => c.evaluation && c.evaluation.total != null);
    const totals = evaluated.map((c) => c.evaluation.total);
    const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
    const byLang = (l) => convs.filter((c) => langCode(c.language) === l).length;
    const open = s.appeals.filter((a) => a.status === 'submitted' || a.status === 'in_review').length;
    const decided = s.appeals.length - open;
    const gross = evaluated.filter((c) => c.evaluation.grossViolation).length;
    renderHero(/** @type {HTMLElement} */ ($(root, '[data-hero]')), [
      { label: t('hero.dialogs'), value: convs.length, sub: split([{ label: 'RU', n: byLang('RU'), tone: 'ru' }, { label: 'KZ', n: byLang('KZ'), tone: 'kz' }, { label: 'EN', n: byLang('EN'), tone: 'en' }]) },
      { label: t('hero.evaluated'), value: evaluated.length, suffix: `/ ${convs.length}`, sub: html`${meter(evaluated.length / convs.length)}<span>${Math.round((evaluated.length / convs.length) * 100)}%</span>` },
      { label: t('hero.avg'), value: avg == null ? null : Math.round(avg * 100) / 100, decimals: 2, tone: 'green', sub: sparkline(totals) },
      { label: t('hero.gross'), value: gross, tone: gross ? 'red' : undefined, sub: t('hero.grossSub') },
      { label: t('hero.appealsOpen'), value: open, tone: open ? 'amber' : undefined, sub: t('hero.decided', { n: decided }) },
    ]);
  }

  function drawTable() {
    const s = store.get();
    if (s.loading) { render($table, skeleton(8, 52)); return; }
    drawHero();
    if (s.loadError) {
      render($table, html`<div class="cqa-error-box" role="alert">${icon('info')}<div class="cqa-stack-y" style="gap:8px"><b>${t('list.loadFailed')}</b><p>${s.loadError}</p><div><button type="button" class="cqa-btn cqa-btn--primary cqa-btn--sm" data-act="reload">${t('common.retry')}</button></div></div></div>`);
      return;
    }
    const list = filtered();
    const allSel = list.length > 0 && list.every((c) => ui.selected.has(c.conversation_id));
    $(root, '[data-count]').textContent = t('list.shown', { n: list.length, total: s.conversations.length });
    const evaluated = s.conversations.filter((c) => c.evaluation).length;
    setLead($sub, t('list.subtitle', { total: s.conversations.length, done: evaluated, dataset: s.dataset }));
    if (!s.conversations.length) {
      render($table, html`<div class="cqa-card">${emptyState({ title: t('list.emptyTitle'), text: t('list.emptyText'), action: html`<button type="button" class="cqa-btn cqa-btn--primary" data-act="load-dev">${t('list.loadDev')}</button>` })}</div>`);
      return;
    }
    if (!list.length) { render($table, html`<div class="cqa-card">${emptyState({ title: t('list.noMatch'), action: html`<button type="button" class="cqa-btn cqa-btn--secondary" data-act="reset-filters">${t('list.resetFilters')}</button>` })}</div>`); return; }
    const enter = !tableShown;
    tableShown = true;
    render($table, html`<div class="cqa-table-wrap"><table class="cqa-table ${enter ? 'cqa-table--enter' : ''}">
      <thead><tr>
        <th style="width:52px"><label class="cqa-hit"><input type="checkbox" data-sel-all ${allSel ? 'checked' : ''} aria-label="${t('list.selectAll')}"></label></th>
        ${th('id', 'ID')}${th('channel', t('list.col.channel'))}${th('lang', t('list.col.lang'))}${th('messages', t('list.col.messages'), true)}${th('duration', t('list.col.duration'), true)}
        ${th('status', t('list.col.status'))}${th('score', t('list.col.score'), true)}${th('gross', t('list.col.gross'))}${th('appeal', t('list.col.appeal'))}
        <th style="width:48px"><span class="cqa-sr">${t('list.open')}</span></th>
      </tr></thead>
      <tbody>${list.slice(0, ui.limit).map((c, i) => {
        const total = c.evaluation?.total;
        return html`<tr data-id="${c.conversation_id}" class="${ui.selected.has(c.conversation_id) ? 'is-selected' : ''}" style="--r:${Math.min(i, 24)}">
          <td><label class="cqa-hit"><input type="checkbox" data-sel="${c.conversation_id}" ${ui.selected.has(c.conversation_id) ? 'checked' : ''} aria-label="${t('list.select')} ${c.conversation_id}"></label></td>
          <td><a class="cqa-mono" translate="no" href="${convLink(c.conversation_id)}" style="color:var(--cqa-ink);font-weight:500">${c.conversation_id}</a></td>
          <td>${channelBadge(c)}</td>
          <td>${langBadge(c.language)}</td>
          <td class="cqa-td-num cqa-num">${c.messages}</td>
          <td class="cqa-td-num cqa-num cqa-mono">${fmtClock(c.duration)}</td>
          <td>${verdictBadge(verdictOf(c))}</td>
          <td class="cqa-td-num"><span class="cqa-scorebar cqa-scorebar--${scoreTone(total) || 'none'}">
            <span class="cqa-score-cell cqa-num cqa-score-cell--${scoreTone(total)}">${c.evaluation ? fmtScore(total) : '—'}</span>
            <span class="cqa-scorebar__track"><span style="transform:scaleX(${c.evaluation && total != null ? (total / 100).toFixed(3) : 0})"></span></span>
          </span></td>
          <td>${c.evaluation?.grossViolation ? html`<span class="cqa-badge cqa-badge--red cqa-badge--sm">${icon('shield', { size: 13 })}${t('list.grossYes')}</span>` : html`<span class="cqa-mute">—</span>`}</td>
          <td>${appealBadge(c.appealStatus) || html`<span class="cqa-mute">—</span>`}</td>
          <td class="cqa-td-go"><span class="cqa-go" aria-hidden="true">${icon('right', { size: 16 })}</span></td>
        </tr>`;
      })}</tbody></table></div>
      ${list.length > ui.limit ? html`<div class="cqa-more"><button type="button" class="cqa-btn cqa-btn--secondary" data-act="more">${t('list.more', { n: Math.min(PAGE, list.length - ui.limit) })}</button><span class="cqa-small cqa-mute">${t('list.shown', { n: ui.limit, total: list.length })}</span></div>` : ''}`);
    const sa = /** @type {HTMLInputElement|null} */ ($(root, '[data-sel-all]'));
    if (sa) sa.indeterminate = !allSel && list.some((c) => ui.selected.has(c.conversation_id));
  }

  function verdictBadge(v) {
    const map = {
      pass: ['green', 'check'], fail: ['red', 'x'], manual: ['amber', 'info'], dispute: ['amber', 'flag'],
      running: ['green', null], none: ['line', 'clock'],
    };
    const [tone, ic] = map[v] || map.none;
    return html`<span class="cqa-badge cqa-badge--sm cqa-badge--${tone} cqa-verdict cqa-verdict--${v}">${ic ? icon(ic, { size: 13 }) : html`<span class="cqa-dot cqa-dot--on" style="width:6px;height:6px"></span>`}${t('verdict.' + v)}</span>`;
  }

  async function doLoad(groupId) {
    const btn = /** @type {HTMLButtonElement} */ ($(root, '[data-load]'));
    const msg = $(root, '[data-load-msg]');
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    render(msg, html`<div class="cqa-skel" style="height:6px"></div>`);
    try {
      const n = await loadDataset(groupId);
      render(msg, html`<div class="cqa-notice cqa-notice--info">${icon('check')}<span>${t('list.loaded', { n, group: groupId })}</span></div>`);
      toast({ kind: 'success', title: t('list.loadedToast', { group: groupId }), message: t('list.loaded', { n, group: groupId }) });
    } catch (e) {
      render(msg, html`<div class="cqa-error-box" role="alert">${icon('info')}<div class="cqa-stack-y" style="gap:8px"><p>${t('list.loadSetError', { group: groupId })}</p><span class="cqa-small cqa-mono">${e.message}</span>
        <div><button type="button" class="cqa-btn cqa-btn--primary cqa-btn--sm" data-act="retry-load">${t('common.retry')}</button></div></div></div>`);
    } finally { btn.disabled = false; btn.classList.remove('is-loading'); btn.removeAttribute('aria-busy'); }
  }

  function openImport() {
    let parsed = null;
    const m = openModal({
      title: t('import.title'), eyebrow: 'POST /conversations/import', size: 'lg',
      body: html`
        <div class="cqa-seg" role="group" aria-label="${t('import.title')}"><button type="button" class="cqa-seg__btn is-active" data-mode="file" aria-pressed="true">${t('import.file')}</button><button type="button" class="cqa-seg__btn" data-mode="paste">${t('import.paste')}</button></div>
        <div data-pane="file"><label class="cqa-dropzone" data-drop>${icon('upload', { size: 28 })}<p style="margin-top:8px"><b>${t('import.drop')}</b></p><p class="cqa-small">${t('import.dropHint')}</p><input type="file" accept=".json,application/json" hidden></label></div>
        <div data-pane="paste" hidden class="cqa-stack-y">
          <div class="cqa-row cqa-row--wrap" style="gap:12px">
            <label class="cqa-field" style="flex:1"><span class="cqa-field__label">conversation_id</span><input class="cqa-input cqa-input--mono" name="cid" value="manual-${Date.now().toString(36)}"></label>
            <label class="cqa-field"><span class="cqa-field__label">${t('list.col.lang')}</span><select class="cqa-select" name="lang"><option>RU</option><option>KZ</option><option>EN</option></select></label>
            <label class="cqa-field"><span class="cqa-field__label">${t('list.col.channel')}</span><select class="cqa-select" name="channel"><option value="agent chat">agent chat</option><option value="voice call">voice call</option></select></label>
          </div>
          <label class="cqa-field"><span class="cqa-field__label">${t('import.transcript')}</span><textarea class="cqa-textarea cqa-input--mono" name="text" rows="9" placeholder="00:02 operator: Здравствуйте!&#10;00:10 client: Добрый день…"></textarea><span class="cqa-field__hint">${t('import.format')}</span></label>
        </div>
        <div data-preview></div>`,
      footer: html`<button type="button" class="cqa-btn cqa-btn--secondary" data-close="">${t('common.cancel')}</button><button type="button" class="cqa-btn cqa-btn--primary" data-submit>${t('import.submit')}</button>`,
      onMount(el) {
        let mode = 'file';
        const preview = $(el, '[data-preview]');
        const input = /** @type {HTMLInputElement} */ ($(el, 'input[type=file]'));
        const drop = $(el, '[data-drop]');
        el.addEventListener('click', (e) => {
          const b = e.target instanceof Element ? e.target.closest('[data-mode]') : null;
          if (!b) return;
          mode = b.getAttribute('data-mode');
          $$(el, '[data-mode]').forEach((x) => { x.classList.toggle('is-active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
          $$(el, '[data-pane]').forEach((p) => { p.hidden = p.getAttribute('data-pane') !== mode; });
          el.dataset.mode = mode;
        });
        el.dataset.mode = mode;
        const readFile = async (f) => {
          try {
            const json = JSON.parse(await f.text());
            parsed = Array.isArray(json) ? json : json?.data?.records || json?.records || (json?.conversation_id ? [json] : null);
            if (!parsed?.length) throw new Error(t('import.noRecords'));
            render(preview, html`<div class="cqa-notice cqa-notice--info">${icon('check')}<span>${t('import.ready', { n: parsed.length, name: f.name })}</span></div>`);
          } catch (err) {
            parsed = null;
            render(preview, html`<div class="cqa-error-box">${icon('info')}<span>${t('import.badJson')}: ${err.message}</span></div>`);
          }
        };
        input.addEventListener('change', () => input.files?.[0] && readFile(input.files[0]));
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
        drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); const f = e.dataTransfer?.files?.[0]; if (f) readFile(f); });
      },
      async onSubmit(el) {
        let records = parsed;
        if (el.dataset.mode === 'paste') {
          const text = /** @type {HTMLTextAreaElement} */ ($(el, '[name=text]')).value;
          const transcript = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
            const m2 = /^(\S+)\s+(client|operator|bot|system)\s*:\s*(.*)$/i.exec(l);
            return m2 ? { timestamp: m2[1], speaker: m2[2].toLowerCase(), text: m2[3] } : null;
          });
          if (!transcript.length || transcript.some((x) => !x)) {
            render($(el, '[data-preview]'), html`<div class="cqa-error-box">${icon('info')}<span>${t('import.badLines')}</span></div>`);
            return undefined;
          }
          records = [{
            conversation_id: /** @type {HTMLInputElement} */ ($(el, '[name=cid]')).value.trim(),
            language: /** @type {HTMLSelectElement} */ ($(el, '[name=lang]')).value,
            channel: /** @type {HTMLSelectElement} */ ($(el, '[name=channel]')).value,
            transcript, audio_url: null,
          }];
        }
        if (!records?.length) { render($(el, '[data-preview]'), html`<div class="cqa-notice">${icon('info')}<span>${t('import.chooseFile')}</span></div>`); return undefined; }
        try {
          const r = await importRecords(records);
          toast({ kind: 'success', title: t('import.done', { n: r.imported }) });
          return r;
        } catch (e) { errorToast(e, t('import.error')); return undefined; }
      },
    });
    return m.result;
  }

  async function run(ids) {
    if (!ids.length) return;
    try {
      await runEvaluation(ids, { checklistId: runChecklistId(), model: store.get().model });
      ui.selected.clear();
      drawRun(); drawTable();
    } catch (e) { errorToast(e, t('run.error')); }
  }

  const onClick = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const act = el.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'import') openImport();
    if (act === 'retry-load') doLoad(ui.groupId);
    if (act === 'load-dev') doLoad('DEV');
    if (act === 'reload') refreshConversations().catch((er) => errorToast(er));
    if (act === 'run-selected') run([...ui.selected]);
    if (act === 'run-all') run(filtered().map((c) => c.conversation_id));
    if (act === 'dismiss') { const job = [...store.get().jobs].reverse().find((j) => j.total > 1); store.set({ dismissedJob: job?.jobId || null }); }
    if (act === 'retry-failed') retryFailed(el.closest('[data-job]').getAttribute('data-job'));
    if (act === 'reset-filters') {
      Object.assign(ui, { q: '', channel: '', lang: '', status: '', score: '', gross: false, fromDash: false });
      history.replaceState(null, '', '#/conversations');
      drawFilters(); refilter();
    }
    const sortBtn = el.closest('[data-sort]');
    if (sortBtn) { const k = sortBtn.getAttribute('data-sort'); ui.dir = ui.sort === k ? -ui.dir : 1; ui.sort = k; syncUrl(); drawTable(); return; }
    if (act === 'more') { ui.limit += PAGE; drawTable(); return; }
    const lf = el.closest('[data-lang-f]');
    if (lf) { ui.lang = lf.getAttribute('data-lang-f'); drawFilters(); refilter(); return; }
    if (el.closest('input[type=checkbox], a, button, label')) return;
    const tr = el.closest('tr[data-id]');
    if (tr) navigate(`/conversation/${encodeURIComponent(tr.getAttribute('data-id'))}`);
  };
  const onChange = (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
    if (el.dataset.sel) { el.checked ? ui.selected.add(el.dataset.sel) : ui.selected.delete(el.dataset.sel); el.closest('tr')?.classList.toggle('is-selected', el.checked); drawRun(); return; }
    if (el.hasAttribute('data-sel-all')) { filtered().forEach((c) => (el.checked ? ui.selected.add(c.conversation_id) : ui.selected.delete(c.conversation_id))); drawTable(); drawRun(); return; }
    if (el.dataset.r === 'checklist') store.set({ checklistId: el.value });
    if (el.dataset.r === 'model') { storage.set('modelPicked', true); store.set({ model: el.value }); }
    if (el.dataset.f === 'channel') { ui.channel = el.value; refilter(); }
    if (el.dataset.f === 'status') { ui.status = el.value; refilter(); }
    if (el.dataset.f === 'score') { ui.score = el.value; refilter(); }
    if (el.dataset.f === 'gross') { ui.gross = /** @type {HTMLInputElement} */ (el).checked; refilter(); }
  };
  const onInput = (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.dataset.f === 'q') { ui.q = el.value; searchSoon(); }
    if (el instanceof HTMLInputElement && el.name === 'group') ui.groupId = el.value.trim().toUpperCase();
  };
  const onSubmit = (e) => {
    if (!(e.target instanceof HTMLFormElement) || e.target.dataset.form !== 'dataset') return;
    e.preventDefault();
    if (ui.groupId) doLoad(ui.groupId);
  };
  const searchSoon = debounce(refilter, 220);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('submit', onSubmit);

  drawFilters(); drawRun(); drawBatch(); drawTable();
  const unsub = store.subscribe((s, p) => {
    if (s.conversations !== p.conversations || s.loading !== p.loading || s.loadError !== p.loadError || s.dataset !== p.dataset) { drawTable(); drawRun(); }
    if (s.jobs !== p.jobs || s.dismissedJob !== p.dismissedJob) { drawBatch(); if (s.jobs !== p.jobs) drawTable(); }
    if (s.checklists !== p.checklists || s.models !== p.models || s.checklistId !== p.checklistId || s.model !== p.model) drawRun();
  });

  return {
    update(next) {
      if (applyQuery(next?.query)) { drawFilters(); refilter(); }
    },
    destroy() {
      clearTimeout(skelTimer);
      unsub();
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onInput);
      root.removeEventListener('submit', onSubmit);
      root.innerHTML = '';
    },
  };
}
