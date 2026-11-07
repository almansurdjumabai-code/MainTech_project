/**
 * Conversation card (main screen): transcript (+ call player) on the left, result on the right.
 * Deep link: #/conversation/{id}?msg={index}
 */
import { html, render, $, $$, isVoice, downloadFile, fmtScore, fmtNum, fmtUsd, transcriptOffsets, storage } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { api } from '../api/client.js';
import { store, checklistById, activeChecklist } from '../core/store.js';
import { runChecklistId } from '../core/actions.js';
import { runEvaluation, jobItemFor } from '../core/jobs.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { scoreEvaluation, evaluationAnswers } from '../core/scoring.js';
import * as Transcript from './transcript-view.js';
import * as Player from './audio-player.js';
import * as Result from './result-panel.js';
import * as Trace from './trace-view.js';
import { openAppealForm } from './appeal-form.js';
import { toast, errorToast } from './toast.js';
import { openModal } from './modal.js';
import { langBadge, channelBadge, emptyState, skeleton, answerPill, deltaChip, modelMode } from './ui.js';

const STAGES = ['fetch', 'checklist', 'analyze', 'score', 'signed'];

/**
 * @param {HTMLElement} root
 * @param {{id:string, msg?:number|null, embedded?:boolean}} props
 */
export function mount(root, props) {
  let conv = null;
  let evaluation = null;
  const TABS = ['result', 'trace', 'compare'];
  let tab = TABS.includes(props.tab) ? props.tab : 'result';
  let pane = 'result';
  let processing = null; // {stage, startedAt}
  let justEvaluated = false;
  let animateFrom = null;
  let compareCache = null;
  let destroyed = false;
  /** @type {any} */ let transcript = null;
  /** @type {any} */ let player = null;
  /** @type {any} */ let panel = null;
  const unsubs = [];

  render(root, html`<div class="cqa-cardpage">${skeleton(1, 48)}<div class="cqa-cardpage__grid" style="margin-top:20px">${skeleton(8, 56)}${skeleton(5, 90)}</div></div>`);
  load();

  /** Deep links can land here before bootstrap has fetched checklist versions — wait for them. */
  function ensureChecklists() {
    const s = store.get();
    if (s.checklists.length || s.loadError || !s.loading) return Promise.resolve();
    return new Promise((resolve) => {
      const off = store.subscribe((n) => { if (n.checklists.length || n.loadError || !n.loading) { off(); resolve(); } });
    });
  }

  async function load() {
    try {
      const [res] = await Promise.all([api.getConversation(props.id), ensureChecklists()]);
      if (destroyed) return;
      conv = res.conversation;
      evaluation = res.evaluation;
      const ji = jobItemFor(props.id);
      if (ji && (ji.item.status === 'queued' || ji.item.status === 'running')) processing = { stage: ji.item.stage, startedAt: Date.now() };
      drawShell();
      if (props.msg != null && Number.isFinite(props.msg)) setTimeout(() => focusEvidence(props.msg), 120);
    } catch (e) {
      if (destroyed) return;
      render(root, html`<div class="cqa-page"><div class="cqa-error-box" role="alert">${icon('info')}<div class="cqa-stack-y" style="gap:8px">
        <b>${t('card.loadError', { id: props.id })}</b><p>${e.message}</p>
        <div class="cqa-row"><button type="button" class="cqa-btn cqa-btn--primary cqa-btn--sm" data-act="retry">${t('common.retry')}</button><a class="cqa-btn cqa-btn--secondary cqa-btn--sm" href="#/conversations">${t('nav.conversations')}</a></div>
      </div></div></div>`);
    }
  }

  const checklistFor = (ev) => (ev && checklistById(ev.checklistId)) || activeChecklist();

  function drawShell() {
    const s = store.get();
    const voice = isVoice(conv);
    const ids = s.conversations.map((c) => c.conversation_id);
    const idx = ids.indexOf(conv.conversation_id);
    const runCl = runChecklistId();
    render(root, html`<div class="cqa-cardpage">
      <div class="cqa-cardpage__bar">
        ${props.embedded ? '' : html`<a class="cqa-btn cqa-btn--secondary cqa-btn--sm" href="#/conversations">${icon('left', { size: 16 })}${t('nav.conversations')}</a>`}
        <span class="cqa-cardpage__id" translate="no">${conv.conversation_id}</span>
        ${langBadge(conv.language)} ${channelBadge(conv)}
        ${conv.dataset ? html`<span class="cqa-badge cqa-badge--mono cqa-badge--sm">${conv.dataset}</span>` : ''}
        <span class="cqa-grow"></span>
        ${props.embedded ? '' : html`<div class="cqa-row cqa-no-print">
          <button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--icon cqa-btn--sm" data-act="prev" ${idx <= 0 ? 'disabled' : ''} title="${t('card.prev')} (K)" aria-label="${t('card.prev')}">${icon('up', { size: 16 })}</button>
          <button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--icon cqa-btn--sm" data-act="next" ${idx < 0 || idx >= ids.length - 1 ? 'disabled' : ''} title="${t('card.next')} (J)" aria-label="${t('card.next')}">${icon('down', { size: 16 })}</button>
        </div>`}
        <div class="cqa-row cqa-no-print" data-tour="evaluate">
          <select class="cqa-select cqa-select--sm" data-field="checklist" aria-label="${t('run.checklist')}" style="width:auto">
            ${s.checklists.map((c) => html`<option value="${c.id}" ${c.id === runCl ? 'selected' : ''}>v${c.version}${c.active ? ` · ${t('checklist.active')}` : ''}</option>`)}
          </select>
          ${s.models.length ? html`<select class="cqa-select cqa-select--sm" data-field="model" aria-label="${t('run.model')}" style="width:auto">
            ${s.models.map((m) => html`<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.name}</option>`)}</select>` : ''}
          <span data-mode>${modelMode(s.models.find((m) => m.id === s.model))}</span>
          <button type="button" class="cqa-btn cqa-btn--primary cqa-btn--sm" data-act="evaluate" ${processing ? 'disabled' : ''}>${icon('spark', { size: 16 })}${evaluation ? t('card.reevaluate') : t('card.evaluate')}</button>
        </div>
        <div class="cqa-row cqa-no-print">
          <button type="button" class="cqa-btn cqa-btn--line cqa-btn--icon cqa-btn--sm" data-act="csv" title="CSV" aria-label="${t('export.csv')}" ${evaluation ? '' : 'disabled'}>${icon('download', { size: 16 })}</button>
          <button type="button" class="cqa-btn cqa-btn--line cqa-btn--icon cqa-btn--sm" data-act="json" title="JSON" aria-label="${t('export.json')}" ${evaluation ? '' : 'disabled'}>${icon('doc', { size: 16 })}</button>
          <button type="button" class="cqa-btn cqa-btn--line cqa-btn--icon cqa-btn--sm" data-act="print" title="${t('export.print')}" aria-label="${t('export.print')}">${icon('print', { size: 16 })}</button>
          <button type="button" class="cqa-btn cqa-btn--line cqa-btn--icon cqa-btn--sm" data-act="keys" title="${t('keys.title')} (?)" aria-label="${t('keys.title')}">${icon('keyboard', { size: 16 })}</button>
        </div>
      </div>
      <div class="cqa-seg cqa-mobile-tabs" role="group" aria-label="${t('card.result')} / ${t('card.transcript')}" style="margin-bottom:16px">
        <button type="button" class="cqa-seg__btn ${pane === 'transcript' ? 'is-active' : ''}" data-pane-btn="transcript" aria-pressed="${pane === 'transcript'}">${t('card.transcript')}</button>
        <button type="button" class="cqa-seg__btn ${pane === 'result' ? 'is-active' : ''}" data-pane-btn="result" aria-pressed="${pane === 'result'}">${t('card.result')}</button>
      </div>
      <div class="cqa-cardpage__grid">
        <div class="cqa-cardpage__col ${pane === 'transcript' ? 'is-shown' : ''}" data-pane="transcript">
          <div class="cqa-cardpage__sticky cqa-stack-y">
            ${voice ? html`<div data-player></div>` : ''}
            <div class="cqa-row cqa-row--between"><span class="cqa-eyebrow">${t('card.transcript')} · ${t('card.messages', { n: conv.transcript.length })}</span>
              <span class="cqa-mute cqa-small">${voice ? t('card.clickToSeek') : t('card.contextHint')}</span></div>
            <div class="cqa-cardpage__scroll ${voice ? 'cqa-cardpage__scroll--short' : ''}" data-transcript tabindex="-1"></div>
          </div>
        </div>
        <div class="cqa-cardpage__col ${pane === 'result' ? 'is-shown' : ''}" data-pane="result">
          <div class="cqa-tabs cqa-no-print" role="tablist" aria-label="${t('card.result')}">
            ${TABS.map((k) => html`<button type="button" role="tab" id="cqa-tab-${k}" class="cqa-tab ${tab === k ? 'is-active' : ''}" aria-selected="${tab === k}" aria-controls="cqa-tabpanel" tabindex="${tab === k ? 0 : -1}" data-tab="${k}">${t('card.tab.' + k)}</button>`)}
          </div>
          <div data-tabpanel id="cqa-tabpanel" role="tabpanel" aria-labelledby="cqa-tab-${tab}" aria-live="polite"></div>
        </div>
      </div>
    </div>`);

    transcript?.destroy();
    transcript = Transcript.mount(/** @type {HTMLElement} */ ($(root, '[data-transcript]')), {
      conversation: conv,
      onMessageClick: (i, off) => { if (player && off != null) player.seek(off, true); },
    });
    player?.destroy();
    player = null;
    if (voice) {
      player = Player.mount(/** @type {HTMLElement} */ ($(root, '[data-player]')), {
        conversation: conv,
        offsets: transcriptOffsets(conv.transcript),
        onActive: (i) => transcript?.setActive(i),
      });
    }
    drawTab();
    if (processing) transcript.startScan(2200);
  }

  function drawTab() {
    const host = /** @type {HTMLElement} */ ($(root, '[data-tabpanel]'));
    if (!host) return;
    panel?.destroy();
    panel = null;
    if (processing) { drawProcessing(host); return; }
    if (!evaluation) {
      render(host, html`<div class="cqa-card" style="margin-top:16px">${emptyState({
        title: t('card.noEvaluation'), text: t('card.noEvaluationHint'),
        action: html`<button type="button" class="cqa-btn cqa-btn--primary" data-act="evaluate">${icon('spark', { size: 16 })}${t('card.evaluate')}</button>`,
      })}</div>`);
      return;
    }
    const cl = checklistFor(evaluation);
    if (!cl) {
      render(host, html`<div class="cqa-error-box" role="alert" style="margin-top:16px">${icon('info')}<span>${store.get().loadError || t('list.loadFailed')}</span></div>`);
      return;
    }
    const wrap = document.createElement('div');
    wrap.style.marginTop = '16px';
    host.replaceChildren(wrap);
    if (tab === 'result') {
      panel = Result.mount(wrap, {
        evaluation, checklist: cl, conversation: conv, role: store.get().role,
        appeals: store.get().appeals.filter((a) => a.evaluationId === evaluation.evaluationId),
        animateFrom, justEvaluated,
        onEvidence: focusEvidence,
        onRange: (r) => { showPane('transcript'); transcript.setRange(r); },
        onAppeal: (cid) => appeal(cid),
        onAiReview: (apId) => api.aiReview(apId),
      });
      animateFrom = null;
      justEvaluated = false;
    } else if (tab === 'trace') {
      panel = Trace.mount(wrap, { evaluation, checklist: cl });
    } else {
      drawCompare(wrap);
    }
  }

  function drawProcessing(host) {
    const stage = processing.stage ?? 0;
    render(host, html`<div class="cqa-vault cqa-proc" style="margin-top:16px" aria-busy="true">
      <div class="cqa-row cqa-row--between"><span class="cqa-eyebrow">${t('proc.title')}</span><span class="cqa-mono" style="color:var(--cqa-vault-mute)">${conv.conversation_id}</span></div>
      <div class="cqa-score__title">${t('proc.subtitle')}</div>
      <ol class="cqa-proc__steps">${STAGES.map((k, i) => html`
        <li class="cqa-proc__step ${i < stage ? 'is-done' : i === stage ? 'is-active' : ''}">
          <span class="cqa-proc__dot">${i < stage ? html`<svg class="cqa-check-draw" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>` : ''}</span>
          <span>${t('proc.' + k)}</span><span class="cqa-proc__time">${i < stage ? 'OK' : i === stage ? '…' : ''}</span>
        </li>`)}</ol>
    </div>`);
  }

  async function drawCompare(wrap) {
    render(wrap, skeleton(5, 44));
    try {
      if (!compareCache) compareCache = await api.listEvaluations(conv.conversation_id);
    } catch (e) { render(wrap, html`<div class="cqa-error-box">${e.message}</div>`); return; }
    if (destroyed || tab !== 'compare') return;
    const list = compareCache;
    if (list.length < 2) {
      render(wrap, html`<div class="cqa-card">${emptyState({ title: t('compare.emptyTitle'), text: t('compare.emptyText'),
        action: html`<button type="button" class="cqa-btn cqa-btn--primary" data-act="evaluate">${icon('spark', { size: 16 })}${t('card.reevaluate')}</button>` })}</div>`);
      return;
    }
    const b = list[list.length - 1];
    const a = [...list].reverse().find((x) => x.checklistId !== b.checklistId) || list[list.length - 2];
    const paint = (ea, eb) => {
      const ca = checklistFor(ea); const cb = checklistFor(eb);
      const sa = scoreEvaluation(ca, evaluationAnswers(ea).final);
      const sb = scoreEvaluation(cb, evaluationAnswers(eb).final);
      const ids = [...new Set([...cb.criteria.map((c) => c.id), ...ca.criteria.map((c) => c.id)])];
      const label = (e) => `v${checklistFor(e).version} · ${e.model} · ${new Date(e.createdAt).toLocaleTimeString()}`;
      render(wrap, html`<div class="cqa-compare">
        <div class="cqa-row cqa-row--wrap" style="gap:12px">
          <label class="cqa-field" style="flex:1"><span class="cqa-field__label">A</span><select class="cqa-select cqa-select--sm" data-cmp="a">${list.map((e) => html`<option value="${e.evaluationId}" ${e === ea ? 'selected' : ''}>${label(e)}</option>`)}</select></label>
          <label class="cqa-field" style="flex:1"><span class="cqa-field__label">B</span><select class="cqa-select cqa-select--sm" data-cmp="b">${list.map((e) => html`<option value="${e.evaluationId}" ${e === eb ? 'selected' : ''}>${label(e)}</option>`)}</select></label>
        </div>
        <div class="cqa-vault cqa-row cqa-row--between cqa-row--wrap" style="padding:20px 24px">
          <div><span class="cqa-eyebrow">A · v${ca.version}</span><div class="cqa-score__num cqa-num">${fmtScore(sa.total)}</div></div>
          ${deltaChip(sa.total != null && sb.total != null ? sb.total - sa.total : null)}
          <div style="text-align:right"><span class="cqa-eyebrow">B · v${cb.version}</span><div class="cqa-score__num cqa-num">${fmtScore(sb.total)}</div></div>
        </div>
        <div class="cqa-compare__row cqa-compare__row--head"><span>${t('compare.criterion')}</span><span>A</span><span>B</span><span style="text-align:right">Δ</span></div>
        ${ids.map((id) => {
          const c1 = ca.criteria.find((c) => c.id === id); const c2 = cb.criteria.find((c) => c.id === id);
          const r1 = sa.rows.find((r) => r.criterionId === id); const r2 = sb.rows.find((r) => r.criterionId === id);
          const d = (r2?.effectivePoints ?? 0) - (r1?.effectivePoints ?? 0);
          const diff = !c1 || !c2 || JSON.stringify(r1?.answer) !== JSON.stringify(r2?.answer) || Math.abs(d) > 0.005;
          return html`<div class="cqa-compare__row ${diff ? 'cqa-compare__row--diff' : ''}">
            <span>${(c2 || c1).title}${!c1 ? html` <span class="cqa-badge cqa-badge--green cqa-badge--sm">${t('diff.added')}</span>` : !c2 ? html` <span class="cqa-badge cqa-badge--red cqa-badge--sm">${t('diff.removed')}</span>` : ''}</span>
            <span>${c1 ? answerPill(c1, r1?.answer) : '—'}</span><span>${c2 ? answerPill(c2, r2?.answer) : '—'}</span>
            <span class="cqa-num cqa-mono" style="text-align:right">${Math.abs(d) < 0.005 ? fmtNum(0, 2) : (d > 0 ? '+' : '−') + fmtNum(Math.abs(d), 2)}</span></div>`;
        })}
      </div>`);
      $$(wrap, '[data-cmp]').forEach((sel) => sel.addEventListener('change', () => {
        const va = /** @type {HTMLSelectElement} */ ($(wrap, '[data-cmp="a"]')).value;
        const vb = /** @type {HTMLSelectElement} */ ($(wrap, '[data-cmp="b"]')).value;
        paint(list.find((e) => e.evaluationId === va), list.find((e) => e.evaluationId === vb));
      }));
    };
    paint(a, b);
  }

  function showPane(p) {
    pane = p;
    $$(root, '[data-pane]').forEach((el) => el.classList.toggle('is-shown', el.getAttribute('data-pane') === p));
    $$(root, '[data-pane-btn]').forEach((el) => {
      const on = el.getAttribute('data-pane-btn') === p;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-pressed', String(on));
    });
  }

  function focusEvidence(i, quote) {
    showPane('transcript');
    transcript?.focusMessage(i, { quote });
    const off = transcript?.offsets()[i];
    if (player && off != null) player.seek(off);
    if (!props.embedded) history.replaceState(null, '', `#/conversation/${encodeURIComponent(conv.conversation_id)}?msg=${i}`);
  }

  async function evaluate() {
    if (processing) return;
    const s = store.get();
    processing = { stage: 0, startedAt: Date.now() };
    drawShell();
    try {
      await runEvaluation([conv.conversation_id], { checklistId: runChecklistId(), model: s.model });
    } catch (e) {
      processing = null;
      transcript?.stopScan();
      drawShell();
      errorToast(e, t('run.error'));
    }
  }

  async function appeal(cid) {
    if (!evaluation) return;
    const ap = await openAppealForm({ evaluation, checklist: checklistFor(evaluation), criterionId: cid, appeals: store.get().appeals });
    if (ap) drawTab();
  }

  function exportCsv() {
    const cl = checklistFor(evaluation);
    const { ai, final } = evaluationAnswers(evaluation);
    const sc = scoreEvaluation(cl, final);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['conversation_id', 'checklist_version', 'criterion_id', 'criterion', 'answer_ai', 'answer_final', 'points', 'weight', 'effective_weight', 'confidence', 'evidence', 'explanation'];
    const rows = cl.criteria.map((c) => {
      const d = evaluation.criteria.find((x) => x.criterionId === c.id) || {};
      const r = sc.rows.find((x) => x.criterionId === c.id);
      return [conv.conversation_id, cl.version, c.id, c.title, ai[c.id], final[c.id], r?.points?.toFixed(2), c.weight, r?.effectiveWeight?.toFixed(2), d.confidence, (d.evidence || []).map((e) => '#' + e.messageIndex).join(' '), d.explanation];
    });
    rows.push([conv.conversation_id, cl.version, 'TOTAL', '', '', '', sc.total ?? '', 100, '', '', '', sc.gross ? 'GROSS VIOLATION' : '']);
    downloadFile(`${conv.conversation_id}_v${cl.version}.csv`, '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
  }

  function showKeys() {
    const k = [['J / K', t('keys.nextPrev')], ['1–8', t('keys.criterion')], ['E', t('keys.evidence')], ['A', t('keys.appeal')], ['?', t('keys.help')], ['Esc', t('keys.close')]];
    openModal({ title: t('keys.title'), body: html`<div class="cqa-keys">${k.map(([a, b]) => html`<span><span class="cqa-kbd">${a}</span></span><span>${b}</span>`)}</div>` });
  }

  function go(delta) {
    const ids = store.get().conversations.map((c) => c.conversation_id);
    const i = ids.indexOf(conv?.conversation_id);
    const next = ids[i + delta];
    if (next) navigate(`/conversation/${encodeURIComponent(next)}`);
  }

  const onClick = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const act = el?.closest('[data-act]')?.getAttribute('data-act');
    if (act === 'retry') { load(); return; }
    if (act === 'evaluate') evaluate();
    if (act === 'prev') go(-1);
    if (act === 'next') go(1);
    if (act === 'csv') exportCsv();
    if (act === 'json') downloadFile(`${conv.conversation_id}_${evaluation.evaluationId}.json`, JSON.stringify({ conversation: conv, evaluation }, null, 2));
    if (act === 'print') window.print();
    if (act === 'keys') showKeys();
    const tb = el?.closest('[data-tab]');
    if (tb) selectTab(tb.getAttribute('data-tab'));
    const pb = el?.closest('[data-pane-btn]');
    if (pb) showPane(pb.getAttribute('data-pane-btn'));
  };
  const onChange = (e) => {
    const el = e.target instanceof HTMLSelectElement ? e.target : null;
    if (el?.dataset.field === 'checklist') store.set({ checklistId: el.value });
    if (el?.dataset.field === 'model') { storage.set('modelPicked', true); store.set({ model: el.value }); }
  };
  /** WAI-ARIA tabs: roving tabindex, the active tab is in the URL (?tab=trace). */
  function selectTab(k, focus = false) {
    if (!TABS.includes(k)) return;
    tab = k;
    $$(root, '[data-tab]').forEach((b) => {
      const on = b.getAttribute('data-tab') === k;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      b.setAttribute('tabindex', on ? '0' : '-1');
      if (on && focus) b.focus();
    });
    $(root, '[data-tabpanel]')?.setAttribute('aria-labelledby', `cqa-tab-${k}`);
    if (!props.embedded) {
      const q = new URLSearchParams(location.hash.split('?')[1] || '');
      if (k === 'result') q.delete('tab'); else q.set('tab', k);
      q.delete('msg');
      const qs = q.toString();
      history.replaceState(history.state, '', `#/conversation/${encodeURIComponent(conv.conversation_id)}${qs ? '?' + qs : ''}`);
    }
    drawTab();
  }

  const onTabKey = (e) => {
    const tb = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
    if (!tb) return;
    const i = TABS.indexOf(tb.getAttribute('data-tab'));
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectTab(TABS[next], true);
  };

  const onKey = (e) => {
    if (!conv || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const tgt = e.target instanceof Element ? e.target : null;
    if (tgt?.closest('input, textarea, select, [contenteditable]')) return;
    if (root.closest('.cqa-root')?.querySelector('.cqa-modal')) return;
    const k = e.key;
    if (k === 'j' || k === 'J' || k === 'о' || k === 'О') go(1);
    else if (k === 'k' || k === 'K' || k === 'л' || k === 'Л') go(-1);
    else if (/^[1-9]$/.test(k)) { showPane('result'); panel?.focusCriterion?.(Number(k) - 1); }
    else if (k === 'e' || k === 'E' || k === 'у' || k === 'У') panel?.gotoEvidence?.();
    else if ((k === 'a' || k === 'A' || k === 'ф' || k === 'Ф') && store.get().role === 'qa') appeal(panel?.focusedCriterionId?.() || null);
    else if (k === '?') showKeys();
    else return;
    e.preventDefault();
  };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onTabKey);
  document.addEventListener('keydown', onKey);

  unsubs.push(store.subscribe((s, p) => {
    if (!conv) return;
    if (s.model !== p.model) {
      const m = $(root, '[data-mode]');
      if (m) render(m, modelMode(s.models.find((x) => x.id === s.model)));
    }
    if (s.jobs !== p.jobs) {
      const ji = jobItemFor(conv.conversation_id, s);
      if (!ji) return;
      const { item } = ji;
      if ((item.status === 'queued' || item.status === 'running') && (!processing || processing.stage !== item.stage)) {
        const first = !processing;
        processing = { stage: item.stage, startedAt: processing?.startedAt || Date.now() };
        if (first) drawShell(); else drawTab();
      }
    }
    if (s.role !== p.role || s.appeals !== p.appeals) {
      if (panel && tab === 'result' && evaluation) panel.update({ role: s.role, appeals: s.appeals.filter((a) => a.evaluationId === evaluation.evaluationId), animateFrom: null, justEvaluated: false });
    }
  }));

  unsubs.push(bus.on('evaluation:done', async (it) => {
    if (!conv || it.conversationId !== conv.conversation_id) return;
    try {
      const prevTotal = evaluation ? scoreEvaluation(checklistFor(evaluation), evaluationAnswers(evaluation).final).total : 0;
      evaluation = await api.getEvaluation(it.evaluationId);
      compareCache = null;
      if (destroyed) return;
      processing = null;
      justEvaluated = true;
      animateFrom = prevTotal ?? 0;
      tab = 'result';
      transcript?.stopScan();
      drawShell();
      toast({ kind: 'approved', title: t('proc.doneToast'), message: `${fmtScore(evaluation.total)} · ${fmtNum(evaluation.durationMs / 1000, 1)} s · ${fmtUsd(Number(evaluation.costUsd ?? 0), 3)}` });
    } catch (e) { errorToast(e); }
  }));
  unsubs.push(bus.on('evaluation:failed', (it) => {
    if (!conv || it.conversationId !== conv.conversation_id) return;
    processing = null;
    transcript?.stopScan();
    drawShell();
    toast({ kind: 'error', title: t('run.itemFailed'), message: it.error || '', action: { label: t('common.retry'), onClick: evaluate } });
  }));
  unsubs.push(bus.on('appeal:changed', async (ap) => {
    if (!conv || ap.conversationId !== conv.conversation_id) return;
    try {
      const res = await api.getConversation(conv.conversation_id);
      if (destroyed) return;
      const before = evaluation ? scoreEvaluation(checklistFor(evaluation), evaluationAnswers(evaluation).final).total : null;
      evaluation = res.evaluation;
      animateFrom = before;
      if (tab === 'result') drawTab();
    } catch { /* keep current */ }
  }));

  return {
    update(next) {
      const idChanged = next.id && next.id !== props.id;
      props = { ...props, ...next };
      if (idChanged) {
        conv = null; evaluation = null; processing = null; compareCache = null; tab = 'result';
        transcript?.destroy(); transcript = null; player?.destroy(); player = null; panel?.destroy(); panel = null;
        render(root, skeleton(8, 56));
        load();
      } else if (next.msg != null && conv) focusEvidence(next.msg);
    },
    destroy() {
      destroyed = true;
      unsubs.forEach((u) => u());
      document.removeEventListener('keydown', onKey);
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('keydown', onTabKey);
      transcript?.destroy(); player?.destroy(); panel?.destroy();
      root.innerHTML = '';
    },
  };
}
