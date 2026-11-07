/**
 * Checklist builder: versions, drag & drop (FLIP), weights ring, live preview,
 * control scenario "Edit criterion → Save version → Re-evaluate".
 */
import { html, render, $, $$, clone, storage, flip, debounce, fmtDate, fmtScore, downloadFile, round2 } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t, getLang } from '../core/i18n.js';
import { store, activeChecklist } from '../core/store.js';
import { validateChecklist, diffChecklists, scoreEvaluation, evaluationAnswers } from '../core/scoring.js';
import { saveChecklist, activateChecklist } from '../core/actions.js';
import { runEvaluation } from '../core/jobs.js';
import { navigate } from '../core/router.js';
import { openModal, confirmDialog } from './modal.js';
import { toast, errorToast } from './toast.js';
import { deltaChip, skeleton, langBadge } from './ui.js';
import { renderHero, meter } from './hero.js';
import { pageArt } from './page-art.js';

const DRAFT_KEY = 'draft.checklist';
const FIELDS = ['sections', 'criteria', 'name'];
const strip = (cl) => ({ name: cl.name, sections: clone(cl.sections || []), criteria: clone(cl.criteria || []) });

/** @param {HTMLElement} root */
export function mount(root) {
  let selectedId = null;
  let draft = null;
  let base = null;
  const open = new Set();
  let lastSaved = null;
  let previewId = null;
  let drag = null; // {id, sig}

  render(root, html`<div class="cqa-page">
    <div class="cqa-page__head"><div class="cqa-page__title">
      <h1 class="cqa-display">${t('checklist.title')}</h1>
      <p class="cqa-lead">${t('checklist.lead')}</p>
    </div>${pageArt('checklists')}</div>
    <div data-hero></div>
    <div data-bar></div>
    <div class="cqa-editor__grid">
      <aside data-versions aria-label="${t('checklist.versions')}"></aside>
      <section data-criteria aria-label="${t('checklist.criteria')}"></section>
      <aside class="cqa-editor__aside" data-preview></aside>
    </div>
  </div>`);
  const $bar = $(root, '[data-bar]');
  const $versions = $(root, '[data-versions]');
  const $criteria = $(root, '[data-criteria]');
  const $preview = $(root, '[data-preview]');

  function init() {
    const s = store.get();
    if (!s.checklists.length) { render($criteria, skeleton(6, 56)); return false; }
    const saved = storage.get(DRAFT_KEY, null);
    const fallback = activeChecklist();
    const sel = (saved && s.checklists.find((c) => c.id === saved.baseId)) || fallback;
    selectedId = sel.id;
    base = strip(sel);
    draft = saved && saved.baseId === sel.id ? saved.data : strip(sel);
    return true;
  }

  const dirty = () => JSON.stringify(FIELDS.map((f) => draft[f])) !== JSON.stringify(FIELDS.map((f) => base[f]));
  const persist = debounce(() => {
    if (dirty()) storage.set(DRAFT_KEY, { baseId: selectedId, data: draft });
    else storage.remove(DRAFT_KEY);
  }, 200);
  const sections = () => {
    const out = [...draft.sections];
    draft.criteria.forEach((c) => { if (!out.includes(c.section)) out.push(c.section); });
    return out;
  };
  const ordered = () => sections().flatMap((s) => draft.criteria.filter((c) => c.section === s));
  const crit = (id) => draft.criteria.find((c) => c.id === id);

  /* ───────── masthead ───────── */
  function drawHero() {
    const s = store.get();
    const act = activeChecklist(s);
    const latest = [...s.checklists].sort((a, b) => b.version - a.version)[0];
    const sum = validateChecklist(draft).weightSum;
    renderHero(/** @type {HTMLElement} */ ($(root, '[data-hero]')), [
      { label: t('hero.activeVersion'), value: act?.version ?? null, prefix: 'v', tone: 'green', sub: act?.note || t('checklist.active') },
      { label: t('hero.criteria'), value: draft.criteria.length, sub: t('hero.sections', { n: sections().length }) },
      { label: t('checklist.weightSum'), value: sum, suffix: '/ 100', tone: sum === 100 ? 'green' : 'amber', sub: meter(Math.min(sum, 100) / 100) },
      { label: t('hero.versions'), value: s.checklists.length, sub: latest ? fmtDate(latest.createdAt, getLang()) : '' },
    ]);
  }

  /* ───────── bar ───────── */
  function drawBar() {
    drawHero();
    const v = validateChecklist(draft);
    const sum = v.weightSum;
    const C = 2 * Math.PI * 18;
    const ok = sum === 100;
    const color = ok ? 'var(--cqa-green)' : sum > 100 ? 'var(--cqa-red)' : 'var(--cqa-amber)';
    const errors = v.issues.filter((i) => i.level === 'error');
    const warns = v.issues.filter((i) => i.level === 'warn');
    const isDirty = dirty();
    const sel = store.get().checklists.find((c) => c.id === selectedId);
    const step = lastSaved ? 3 : isDirty ? 2 : 1;
    render($bar, html`<div class="cqa-editor__bar" data-tour="checklist-bar">
      <div class="cqa-weight-ring" title="${t('checklist.weightSum')}">
        <svg class="cqa-weight-ring__svg" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true" style="transform:rotate(-90deg)">
          <circle cx="22" cy="22" r="18" fill="none" stroke="var(--cqa-line)" stroke-width="5"/>
          <circle cx="22" cy="22" r="18" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - Math.min(sum, 100) / 100)}"/>
        </svg>
        <div><div class="cqa-weight-ring__val cqa-num" aria-live="polite">${sum} <span class="cqa-mute" style="font-size:14px">/ 100</span></div>
          <div class="cqa-small ${ok ? 'cqa-muted' : ''}" style="${ok ? '' : 'color:var(--cqa-amber-text)'}">${ok ? t('checklist.weightsOk') : t('checklist.weightsWarn')}</div></div>
      </div>
      <div class="cqa-flow" aria-label="${t('checklist.flow')}">
        <span class="cqa-flow__step ${step > 1 ? 'is-done' : 'is-current'}">1 · ${t('checklist.flow1')}</span><span class="cqa-flow__arrow">→</span>
        <span class="cqa-flow__step ${step > 2 ? 'is-done' : step === 2 ? 'is-current' : ''}">2 · ${t('checklist.flow2')}</span><span class="cqa-flow__arrow">→</span>
        <span class="cqa-flow__step ${step === 3 ? 'is-current' : ''}">3 · ${t('checklist.flow3')}</span>
      </div>
      <span class="cqa-grow"></span>
      <div class="cqa-row cqa-row--wrap">
        <button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--sm" data-act="add">${icon('plus', { size: 16 })}${t('checklist.addCriterion')}</button>
        <button type="button" class="cqa-btn cqa-btn--line cqa-btn--icon cqa-btn--sm" data-act="import" title="${t('checklist.importJson')}" aria-label="${t('checklist.importJson')}">${icon('upload', { size: 16 })}</button>
        <button type="button" class="cqa-btn cqa-btn--line cqa-btn--icon cqa-btn--sm" data-act="export" title="${t('checklist.exportJson')}" aria-label="${t('checklist.exportJson')}">${icon('download', { size: 16 })}</button>
        ${isDirty ? html`<button type="button" class="cqa-btn cqa-btn--line cqa-btn--sm" data-act="reset">${t('checklist.discard')}</button>` : ''}
        ${!isDirty && sel && !sel.active ? html`<button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--sm" data-act="activate">${t('checklist.makeActive')}</button>` : ''}
        <button type="button" class="cqa-btn cqa-btn--primary cqa-btn--sm" data-act="save" ${isDirty && !errors.length ? '' : 'disabled'}>${icon('check', { size: 16 })}${t('checklist.saveVersion')}</button>
        <button type="button" class="cqa-btn ${lastSaved ? 'cqa-btn--primary cqa-btn--attention' : 'cqa-btn--secondary'} cqa-btn--sm" data-act="reeval" ${isDirty ? 'disabled' : ''}>${icon('refresh', { size: 16 })}${t('checklist.reevaluate')}</button>
      </div>
      ${errors.length || warns.length ? html`<div style="flex-basis:100%" class="cqa-row cqa-row--wrap">
        ${errors.map((i) => html`<span class="cqa-badge cqa-badge--red cqa-badge--sm">${t(i.key, i.vars)}</span>`)}
        ${warns.filter((i) => i.key !== 'val.weightSum').map((i) => html`<span class="cqa-badge cqa-badge--amber cqa-badge--sm">${t(i.key, i.vars)}</span>`)}
      </div>` : ''}
      <input type="file" accept=".json,application/json" hidden data-import>
    </div>`);
  }

  /* ───────── versions ───────── */
  function drawVersions() {
    const list = [...store.get().checklists].sort((a, b) => b.version - a.version);
    render($versions, html`<div class="cqa-versions">
      <span class="cqa-eyebrow" style="padding:0 14px 6px">${t('checklist.versions')}</span>
      ${list.map((c) => {
        const prev = store.get().checklists.find((x) => x.version === c.version - 1) || null;
        const d = c.id === selectedId && prev ? diffChecklists(prev, c) : [];
        return html`<button type="button" class="cqa-version ${c.id === selectedId ? 'is-selected' : ''}" data-version="${c.id}" aria-pressed="${c.id === selectedId}">
          <span class="cqa-version__top"><span class="cqa-version__v">v${c.version}</span>${c.active ? html`<span class="cqa-badge cqa-badge--solid cqa-badge--sm">${t('checklist.active')}</span>` : ''}${c.id === selectedId && dirty() ? html`<span class="cqa-badge cqa-badge--amber cqa-badge--sm">${t('checklist.draft')}</span>` : ''}</span>
          <span class="cqa-small cqa-muted">${fmtDate(c.createdAt, getLang())} · ${c.criteria.length} ${t('checklist.criteriaShort')}</span>
          ${c.note ? html`<span class="cqa-small" style="color:var(--cqa-graphite)">${c.note}</span>` : ''}
          ${d.length ? html`<span class="cqa-version__diff">${diffLines(d)}</span>` : ''}
        </button>`;
      })}
    </div>`);
  }

  function diffLines(d) {
    return d.map((x) => html`<span class="cqa-diff--${x.kind}">${x.kind === 'added' ? '+ ' : x.kind === 'removed' ? '− ' : '~ '}${x.id === '*' ? t('diff.order') : x.title}${x.fields && x.id !== '*' ? html` <span class="cqa-mute">(${x.fields.map((f) => t('field.' + f)).join(', ')})</span>` : ''}</span>`);
  }

  /* ───────── criteria ───────── */
  function drawCriteria() {
    const v = validateChecklist(draft);
    const bad = new Set(v.issues.filter((i) => i.level === 'error' && i.criterionId).map((i) => i.criterionId));
    const baseMap = new Map(base.criteria.map((c) => [c.id, JSON.stringify(c)]));
    let n = 0;
    render($criteria, html`${sections().map((sec) => {
      const items = draft.criteria.filter((c) => c.section === sec);
      return html`<div class="cqa-secgroup" data-section="${sec}">
        <div class="cqa-secgroup__head"><span class="cqa-eyebrow" style="color:var(--cqa-green-text)">${sec}</span><span class="cqa-badge cqa-badge--sm">${items.length}</span>
          <span class="cqa-grow"></span><button type="button" class="cqa-btn cqa-btn--line cqa-btn--xs" data-act="add-in" data-sec="${sec}">${icon('plus', { size: 14 })}${t('checklist.addHere')}</button></div>
        ${items.map((c) => item(c, n++, bad.has(c.id), baseMap.get(c.id) !== JSON.stringify(c)))}
        <div class="cqa-secgroup__drop" data-drop-sec="${sec}" aria-hidden="true"></div>
      </div>`;
    })}
    <button type="button" class="cqa-btn cqa-btn--line" data-act="add-section">${icon('plus', { size: 16 })}${t('checklist.addSection')}</button>`);
  }

  function item(c, n, invalid, changed) {
    const isOpen = open.has(c.id);
    const typeChip = c.type === 'scale' ? t('type.scale') : c.type === 'flag' ? t('type.flag') : t('type.binary');
    return html`<article class="cqa-item ${isOpen ? 'is-open' : ''} ${invalid ? 'is-invalid' : ''} ${changed ? 'is-changed' : ''}" data-id="${c.id}" data-flip="${c.id}">
      <div class="cqa-item__row">
        <span class="cqa-item__handle" data-handle title="${t('checklist.drag')}" aria-hidden="true">${icon('drag', { size: 18 })}</span>
        <span class="cqa-item__num">${String(n + 1).padStart(2, '0')}</span>
        <button type="button" class="cqa-item__title" data-act="toggle" style="text-align:left" aria-expanded="${isOpen}" data-title>${c.title || t('checklist.untitled')}</button>
        <span class="cqa-item__chips">
          <span class="cqa-badge cqa-badge--sm">${typeChip}${c.type === 'scale' ? ` ${c.scale.map((s) => s.value).join('/')}` : ''}</span>
          ${c.allowNA ? html`<span class="cqa-badge cqa-badge--amber cqa-badge--sm">N/A</span>` : ''}
        </span>
        ${c.type === 'flag' ? html`<span class="cqa-small cqa-mute" style="text-align:right">${t('result.noPoints')}</span>` : html`<span class="cqa-item__weight">
          <input type="range" class="cqa-range" min="0" max="50" step="1" value="${c.weight}" data-k="weight" aria-label="${t('field.weight')} — ${c.title}">
          <input type="number" class="cqa-input cqa-num" min="0" max="100" step="0.5" value="${c.weight}" data-k="weight" aria-label="${t('field.weight')}"></span>`}
        <span class="cqa-item__tools">
          <button type="button" class="cqa-btn cqa-btn--icon cqa-btn--xs cqa-btn--line" data-act="up" title="${t('checklist.moveUp')}" aria-label="${t('checklist.moveUp')}">${icon('up', { size: 14 })}</button>
          <button type="button" class="cqa-btn cqa-btn--icon cqa-btn--xs cqa-btn--line" data-act="down" title="${t('checklist.moveDown')}" aria-label="${t('checklist.moveDown')}">${icon('down', { size: 14 })}</button>
          <button type="button" class="cqa-btn cqa-btn--icon cqa-btn--xs cqa-btn--line" data-act="toggle" title="${t('common.edit')}" aria-label="${t('common.edit')}">${icon('edit', { size: 14 })}</button>
          <button type="button" class="cqa-btn cqa-btn--icon cqa-btn--xs cqa-btn--line" data-act="dup" title="${t('checklist.duplicate')}" aria-label="${t('checklist.duplicate')}">${icon('copy', { size: 14 })}</button>
          <button type="button" class="cqa-btn cqa-btn--icon cqa-btn--xs cqa-btn--danger" data-act="del" title="${t('common.delete')}" aria-label="${t('common.delete')}">${icon('trash', { size: 14 })}</button>
        </span>
      </div>
      ${isOpen ? form(c) : ''}
    </article>`;
  }

  function form(c) {
    return html`<div class="cqa-item__form">
      <label class="cqa-field cqa-field--full"><span class="cqa-field__label">${t('field.title')}</span><input class="cqa-input" data-k="title" value="${c.title}" aria-invalid="${!c.title.trim()}"></label>
      <label class="cqa-field cqa-field--full"><span class="cqa-field__label">${t('field.description')}</span><textarea class="cqa-textarea" rows="2" data-k="description">${c.description}</textarea></label>
      <label class="cqa-field"><span class="cqa-field__label">${t('field.section')}</span><select class="cqa-select" data-k="section">${sections().map((s) => html`<option ${s === c.section ? 'selected' : ''}>${s}</option>`)}</select></label>
      <label class="cqa-field"><span class="cqa-field__label">${t('field.type')}</span><select class="cqa-select" data-k="type">
        ${['binary', 'scale', 'flag'].map((tp) => html`<option value="${tp}" ${tp === c.type ? 'selected' : ''}>${t('type.' + tp)}</option>`)}</select></label>
      ${c.type !== 'flag' ? html`<div class="cqa-field cqa-field--full">
        <label class="cqa-switch"><input type="checkbox" data-k="allowNA" ${c.allowNA ? 'checked' : ''}><span class="cqa-switch__track"></span>${t('field.allowNA')}</label>
        ${c.allowNA ? html`<input class="cqa-input" data-k="naCondition" value="${c.naCondition}" placeholder="${t('field.naConditionPh')}" aria-label="${t('field.naCondition')}" style="margin-top:8px">` : ''}
      </div>` : ''}
      ${c.type === 'scale' ? html`<div class="cqa-field cqa-field--full"><span class="cqa-field__label">${t('field.scale')}</span>
        <div class="cqa-scale-editor">${c.scale.map((s, i) => html`<div class="cqa-scale-editor__row">
          <input type="number" class="cqa-input cqa-num" value="${s.value}" data-scale-i="${i}" data-scale-f="value" aria-label="${t('field.stepValue')}">
          <input class="cqa-input" value="${s.label}" data-scale-i="${i}" data-scale-f="label" aria-label="${t('field.stepLabel')}">
          <button type="button" class="cqa-btn cqa-btn--icon cqa-btn--sm cqa-btn--line" data-act="step-del" data-i="${i}" aria-label="${t('common.delete')}">${icon('minus', { size: 14 })}</button></div>`)}
          <div><button type="button" class="cqa-btn cqa-btn--line cqa-btn--xs" data-act="step-add">${icon('plus', { size: 14 })}${t('field.addStep')}</button></div>
        </div><span class="cqa-field__hint">${t('field.scaleHint')}</span></div>` : ''}
      <label class="cqa-field cqa-field--full"><span class="cqa-field__label">${t('field.aiGuidance')}</span><textarea class="cqa-textarea" rows="3" data-k="aiGuidance" placeholder="${t('field.aiGuidancePh')}">${c.aiGuidance}</textarea></label>
      <span class="cqa-mono cqa-mute">id: ${c.id}</span>
    </div>`;
  }

  /* ───────── preview ───────── */
  function drawPreview() {
    const evaluated = store.get().conversations.filter((c) => c.evaluation);
    if (!evaluated.length) { render($preview, ''); return; }
    if (!previewId || !evaluated.some((c) => c.conversation_id === previewId)) previewId = evaluated[0].conversation_id;
    const conv = evaluated.find((c) => c.conversation_id === previewId);
    const ev = conv.evaluation;
    const { final } = evaluationAnswers(ev);
    const before = ev.total;
    const sc = scoreEvaluation(draft, final);
    const missing = draft.criteria.filter((c) => !(c.id in final)).length;
    render($preview, html`<div class="cqa-card cqa-preview" style="position:sticky;top:calc(var(--cqa-header-h) + 96px)">
      <span class="cqa-eyebrow">${t('checklist.preview')}</span>
      <select class="cqa-select cqa-select--sm" data-preview-sel aria-label="${t('checklist.preview')}">${evaluated.map((c) => html`<option value="${c.conversation_id}" ${c.conversation_id === previewId ? 'selected' : ''}>${c.conversation_id} · ${c.language}</option>`)}</select>
      <div class="cqa-row" style="align-items:baseline;gap:12px"><span class="cqa-preview__num cqa-num">${fmtScore(sc.total)}</span>${deltaChip(sc.total != null && before != null ? round2(sc.total - before) : null, true)}</div>
      <span class="cqa-small cqa-muted">${t('checklist.previewWas', { v: fmtScore(before) })} ${langBadge(conv.language)}</span>
      ${sc.gross ? html`<span class="cqa-badge cqa-badge--red">${icon('shield', { size: 14 })}${t('result.gross')}</span>` : ''}
      ${missing ? html`<div class="cqa-notice">${icon('info')}<span>${t('checklist.previewMissing', { n: missing })}</span></div>` : ''}
      <p class="cqa-small cqa-mute">${t('checklist.previewHint')}</p>
    </div>`);
  }

  function drawAll(animate = false) {
    if (!draft) return;
    drawBar();
    drawVersions();
    if (animate) flip($criteria, drawCriteria); else drawCriteria();
    drawPreview();
  }
  const light = () => { drawBar(); drawPreview(); persist(); };

  /* ───────── mutations ───────── */
  function nextId() {
    const nums = draft.criteria.map((c) => Number(/^c(\d+)$/.exec(c.id)?.[1] || 0));
    return `c${Math.max(0, ...nums) + 1}`;
  }
  function addCriterion(section) {
    const sec = section || sections().find((s) => draft.criteria.some((c) => c.section === s && c.type !== 'flag')) || sections()[0] || t('checklist.newSection');
    const c = { id: nextId(), title: t('checklist.newCriterion'), description: '', section: sec, weight: 0, type: 'binary', allowNA: false, naCondition: '', scale: [], aiGuidance: '' };
    const lastIdx = draft.criteria.map((x) => x.section).lastIndexOf(sec);
    draft.criteria.splice(lastIdx + 1, 0, c);
    if (!draft.sections.includes(sec)) draft.sections.push(sec);
    open.add(c.id);
    drawAll(true); persist();
    const el = $(root, `.cqa-item[data-id="${c.id}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { const inp = /** @type {HTMLInputElement|null} */ (el && $(el, '[data-k="title"]')); inp?.focus(); inp?.select(); }, 250);
  }
  function move(id, delta) {
    const list = ordered();
    const i = list.findIndex((c) => c.id === id);
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    const a = list[i]; const b = list[j];
    a.section = b.section;
    const ai = draft.criteria.indexOf(a); const bi = draft.criteria.indexOf(b);
    draft.criteria[ai] = b; draft.criteria[bi] = a;
    drawAll(true); persist();
    /** @type {HTMLElement|null} */ ($(root, `.cqa-item[data-id="${id}"] [data-act="${delta < 0 ? 'up' : 'down'}"]`))?.focus();
  }
  function moveTo(id, targetId, after, section) {
    const c = crit(id);
    if (!c) return;
    draft.criteria.splice(draft.criteria.indexOf(c), 1);
    c.section = section;
    if (targetId) {
      const ti = draft.criteria.findIndex((x) => x.id === targetId);
      draft.criteria.splice(ti + (after ? 1 : 0), 0, c);
    } else {
      const last = draft.criteria.map((x) => x.section).lastIndexOf(section);
      draft.criteria.splice(last + 1, 0, c);
    }
  }

  async function doSave() {
    const prev = store.get().checklists.find((c) => c.id === selectedId);
    const d = diffChecklists(prev, { ...draft });
    const m = openModal({
      eyebrow: t('checklist.saveEyebrow'), title: t('checklist.saveTitle', { v: Math.max(...store.get().checklists.map((c) => c.version)) + 1 }),
      body: html`<div class="cqa-card" style="padding:16px 18px"><span class="cqa-eyebrow">${t('checklist.changesVs', { v: prev?.version })}</span>
          <div class="cqa-version__diff" style="font-size:13.5px;margin-top:8px">${d.length ? diffLines(d) : t('checklist.noChanges')}</div></div>
        <label class="cqa-field"><span class="cqa-field__label">${t('checklist.note')}</span><input class="cqa-input" name="note" placeholder="${t('checklist.notePh')}"></label>
        <label class="cqa-switch"><input type="checkbox" name="activate" checked><span class="cqa-switch__track"></span>${t('checklist.activateNow')}</label>`,
      footer: html`<button type="button" class="cqa-btn cqa-btn--secondary" data-close="">${t('common.cancel')}</button><button type="button" class="cqa-btn cqa-btn--primary" data-submit>${icon('check', { size: 16 })}${t('checklist.saveVersion')}</button>`,
      async onSubmit(el) {
        try {
          const note = /** @type {HTMLInputElement} */ ($(el, '[name=note]')).value.trim();
          const activate = /** @type {HTMLInputElement} */ ($(el, '[name=activate]')).checked;
          return await saveChecklist({ ...clone(draft), note }, { activate });
        } catch (e) { errorToast(e, t('checklist.saveError')); return undefined; }
      },
    });
    const saved = await m.result;
    if (!saved) return;
    storage.remove(DRAFT_KEY);
    selectedId = saved.id;
    base = strip(saved);
    draft = strip(saved);
    lastSaved = saved.id;
    toast({ kind: 'approved', title: t('checklist.savedToast', { v: saved.version }), message: saved.active ? t('checklist.nowActive') : '', action: { label: t('checklist.reevaluate'), onClick: () => reevaluate() } });
    drawAll();
  }

  async function reevaluate() {
    const s = store.get();
    const clId = lastSaved || selectedId;
    const cl = s.checklists.find((c) => c.id === clId);
    const convs = s.conversations;
    const preselect = new Set(convs.filter((c) => c.evaluation).map((c) => c.conversation_id));
    const m = openModal({
      eyebrow: t('checklist.flow3'), title: t('checklist.reevalTitle', { v: cl?.version }), size: 'lg',
      body: html`<p class="cqa-muted">${t('checklist.reevalLead')}</p>
        <div class="cqa-row cqa-row--wrap" style="gap:6px">
          <button type="button" class="cqa-btn cqa-btn--line cqa-btn--xs" data-pick="evaluated">${t('checklist.pickEvaluated')}</button>
          <button type="button" class="cqa-btn cqa-btn--line cqa-btn--xs" data-pick="all">${t('common.all')}</button>
          <button type="button" class="cqa-btn cqa-btn--line cqa-btn--xs" data-pick="none">${t('checklist.pickNone')}</button>
          ${[...new Set(convs.map((c) => c.dataset).filter(Boolean))].map((d) => html`<button type="button" class="cqa-btn cqa-btn--line cqa-btn--xs" data-pick="ds:${d}">${d}</button>`)}
        </div>
        <div style="max-height:46vh;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px">
          ${convs.map((c) => html`<label class="cqa-check" style="padding:8px 10px;border-radius:10px;background:var(--cqa-mist)"><input type="checkbox" value="${c.conversation_id}" ${preselect.has(c.conversation_id) ? 'checked' : ''}><span class="cqa-mono">${c.conversation_id}</span>${langBadge(c.language)}</label>`)}
        </div>`,
      footer: html`<button type="button" class="cqa-btn cqa-btn--secondary" data-close="">${t('common.cancel')}</button><button type="button" class="cqa-btn cqa-btn--primary" data-submit data-count>${icon('spark', { size: 16 })}${t('checklist.reevalGo')}</button>`,
      onMount(el) {
        const boxes = () => /** @type {HTMLInputElement[]} */ ($$(el, 'input[type=checkbox]'));
        const count = () => { $(el, '[data-count]').lastChild.textContent = ` ${t('checklist.reevalGo')} · ${boxes().filter((b) => b.checked).length}`; };
        el.addEventListener('change', count);
        el.addEventListener('click', (e) => {
          const p = e.target instanceof Element ? e.target.closest('[data-pick]')?.getAttribute('data-pick') : null;
          if (!p) return;
          boxes().forEach((b) => {
            const c = convs.find((x) => x.conversation_id === b.value);
            b.checked = p === 'all' ? true : p === 'none' ? false : p === 'evaluated' ? !!c.evaluation : c.dataset === p.slice(3);
          });
          count();
        });
        count();
      },
      onSubmit(el) {
        const ids = /** @type {HTMLInputElement[]} */ ($$(el, 'input[type=checkbox]')).filter((b) => b.checked).map((b) => b.value);
        return ids.length ? ids : undefined;
      },
    });
    const ids = await m.result;
    if (!ids) return;
    try {
      await runEvaluation(ids, { checklistId: clId, model: s.model });
      lastSaved = null;
      navigate('/conversations');
    } catch (e) { errorToast(e, t('run.error')); }
  }

  /* ───────── events ───────── */
  const onClick = async (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !draft) return;
    const ver = el.closest('[data-version]');
    if (ver) {
      const id = ver.getAttribute('data-version');
      if (id === selectedId) return;
      if (dirty() && !(await confirmDialog({ title: t('checklist.discardTitle'), message: t('checklist.discardText'), confirmLabel: t('checklist.discard'), danger: true }))) return;
      storage.remove(DRAFT_KEY);
      const cl = store.get().checklists.find((c) => c.id === id);
      selectedId = id; base = strip(cl); draft = strip(cl); open.clear(); lastSaved = null;
      store.set({ checklistId: id });
      drawAll();
      return;
    }
    const actEl = el.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.getAttribute('data-act');
    const id = el.closest('.cqa-item')?.getAttribute('data-id');
    const c = id ? crit(id) : null;
    switch (act) {
      case 'add': addCriterion(); break;
      case 'add-in': addCriterion(actEl.getAttribute('data-sec')); break;
      case 'add-section': {
        const m = openModal({ title: t('checklist.addSection'), body: html`<label class="cqa-field"><span class="cqa-field__label">${t('field.section')}</span><input class="cqa-input" name="sec" autofocus></label>`,
          footer: html`<button type="button" class="cqa-btn cqa-btn--secondary" data-close="">${t('common.cancel')}</button><button type="button" class="cqa-btn cqa-btn--primary" data-submit>${t('common.add')}</button>`,
          onSubmit: (mel) => /** @type {HTMLInputElement} */ ($(mel, 'input')).value.trim() || undefined });
        const name = await m.result;
        if (name && !draft.sections.includes(name)) { draft.sections.push(name); addCriterion(name); }
        break;
      }
      case 'toggle': if (c) { open.has(c.id) ? open.delete(c.id) : open.add(c.id); drawCriteria(); /** @type {HTMLElement|null} */ ($(root, `.cqa-item[data-id="${c.id}"] [data-act="toggle"]`))?.focus(); } break;
      case 'up': if (c) move(c.id, -1); break;
      case 'down': if (c) move(c.id, 1); break;
      case 'dup': if (c) {
        const copy = { ...clone(c), id: nextId(), title: `${c.title} ${t('checklist.copySuffix')}` };
        draft.criteria.splice(draft.criteria.indexOf(c) + 1, 0, copy);
        open.add(copy.id); drawAll(true); persist();
      } break;
      case 'del': if (c && await confirmDialog({ title: t('checklist.deleteTitle'), message: t('checklist.deleteText', { title: c.title }), confirmLabel: t('common.delete'), danger: true })) {
        draft.criteria.splice(draft.criteria.indexOf(c), 1); open.delete(c.id); drawAll(true); persist();
      } break;
      case 'step-add': if (c) { const min = Math.min(...c.scale.map((s) => Number(s.value)), 0); c.scale.push({ value: Math.max(0, min - 1), label: '' }); drawCriteria(); light(); } break;
      case 'step-del': if (c) { c.scale.splice(Number(actEl.getAttribute('data-i')), 1); drawCriteria(); light(); } break;
      case 'reset': storage.remove(DRAFT_KEY); draft = clone(base); open.clear(); drawAll(true); break;
      case 'save': doSave(); break;
      case 'reeval': reevaluate(); break;
      case 'activate': try { await activateChecklist(selectedId); toast({ kind: 'success', title: t('checklist.activated') }); } catch (er) { errorToast(er); } break;
      case 'export': {
        const sel = store.get().checklists.find((x) => x.id === selectedId);
        const data = dirty() ? { ...draft, draftOf: selectedId } : sel;
        downloadFile(`checklist_v${sel?.version}${dirty() ? '_draft' : ''}.json`, JSON.stringify(data, null, 2));
        break;
      }
      case 'import': /** @type {HTMLInputElement} */ ($(root, '[data-import]')).click(); break;
      default: break;
    }
  };

  const onInput = (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !draft) return;
    const itemEl = el.closest('.cqa-item');
    const c = itemEl ? crit(itemEl.getAttribute('data-id')) : null;
    if (!c) return;
    const k = el.dataset.k;
    if (k === 'weight') {
      const v = Math.max(0, Number(el.value) || 0);
      c.weight = v;
      $$(itemEl, '[data-k="weight"]').forEach((x) => { if (x !== el) /** @type {HTMLInputElement} */ (x).value = String(v); });
      light();
    } else if (k === 'title' || k === 'description' || k === 'naCondition' || k === 'aiGuidance') {
      c[k] = el.value;
      if (k === 'title') { $(itemEl, '[data-title]').textContent = el.value || t('checklist.untitled'); el.setAttribute('aria-invalid', String(!el.value.trim())); }
      light();
    } else if (el.dataset.scaleI != null) {
      const s = c.scale[Number(el.dataset.scaleI)];
      if (el.dataset.scaleF === 'value') s.value = Number(el.value); else s.label = el.value;
      light();
    }
    itemEl.classList.add('is-changed');
  };

  const onChange = (e) => {
    const el = e.target;
    if (!draft) return;
    if (el instanceof HTMLInputElement && el.hasAttribute('data-import')) {
      const f = el.files?.[0];
      el.value = '';
      if (!f) return;
      f.text().then((txt) => {
        const data = JSON.parse(txt);
        if (!Array.isArray(data.criteria) || !data.criteria.every((c) => c.id && c.type)) throw new Error(t('checklist.importBad'));
        draft = { name: data.name || draft.name, sections: data.sections || [...new Set(data.criteria.map((c) => c.section))], criteria: data.criteria.map((c) => ({ description: '', section: '', weight: 0, allowNA: false, naCondition: '', scale: [], aiGuidance: '', ...c })) };
        open.clear(); drawAll(true); persist();
        toast({ kind: 'success', title: t('checklist.imported', { n: draft.criteria.length }) });
      }).catch((er) => errorToast(er, t('checklist.importBad')));
      return;
    }
    if (el instanceof HTMLSelectElement && el.hasAttribute('data-preview-sel')) { previewId = el.value; drawPreview(); return; }
    const itemEl = el instanceof Element ? el.closest('.cqa-item') : null;
    const c = itemEl ? crit(itemEl.getAttribute('data-id')) : null;
    if (!c) return;
    const k = /** @type {HTMLElement} */ (el).dataset.k;
    if (k === 'type') {
      c.type = /** @type {HTMLSelectElement} */ (el).value;
      if (c.type === 'scale' && c.scale.length < 2) c.scale = [{ value: 10, label: '' }, { value: 5, label: '' }, { value: 0, label: '' }];
      if (c.type === 'flag') { c.weight = 0; c.allowNA = false; }
      drawAll(); persist();
    } else if (k === 'section') {
      c.section = /** @type {HTMLSelectElement} */ (el).value; drawAll(true); persist();
    } else if (k === 'allowNA') {
      c.allowNA = /** @type {HTMLInputElement} */ (el).checked; drawCriteria(); light();
    }
  };

  /* drag & drop with FLIP */
  const onMouseDown = (e) => {
    const h = e.target instanceof Element ? e.target.closest('[data-handle]') : null;
    if (h) h.closest('.cqa-item')?.setAttribute('draggable', 'true');
  };
  const onDragStart = (e) => {
    const it = e.target instanceof Element ? e.target.closest('.cqa-item') : null;
    if (!it) return;
    drag = { id: it.getAttribute('data-id'), sig: '' };
    root.classList.add('cqa-dragging'); // no text selection while dragging
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', drag.id); } catch { /* old browsers */ }
    requestAnimationFrame(() => it.classList.add('is-dragging'));
  };
  const onDragOver = (e) => {
    if (!drag) return;
    const el = e.target instanceof Element ? e.target : null;
    const over = el?.closest('.cqa-item');
    const zone = el?.closest('[data-drop-sec]');
    if (!over && !zone) return;
    e.preventDefault();
    const dragEl = $(root, `.cqa-item[data-id="${drag.id}"]`);
    if (!dragEl) return;
    let sig; let apply;
    if (over) {
      const tid = over.getAttribute('data-id');
      if (tid === drag.id) return;
      const r = over.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const sec = crit(tid).section;
      sig = `${tid}:${after}`;
      // Move the same DOM node (re-rendering would detach the drag source and lose dragend).
      apply = () => { moveTo(drag.id, tid, after, sec); over.parentElement.insertBefore(dragEl, after ? over.nextSibling : over); };
    } else {
      const sec = zone.getAttribute('data-drop-sec');
      sig = `sec:${sec}`;
      apply = () => { moveTo(drag.id, null, true, sec); zone.parentElement.insertBefore(dragEl, zone); };
    }
    if (sig === drag.sig) return;
    drag.sig = sig;
    flip($criteria, apply);
  };
  const onDragEnd = () => {
    if (!drag) return;
    drag = null;
    root.classList.remove('cqa-dragging');
    $$(root, '.cqa-item').forEach((x) => { x.classList.remove('is-dragging'); x.removeAttribute('draggable'); });
    drawAll(); persist();
  };
  const onDrop = (e) => { if (drag) e.preventDefault(); };

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragend', onDragEnd);
  root.addEventListener('drop', onDrop);

  if (init()) drawAll();

  /** Unsaved changes: the browser warns on tab close; in-app navigation keeps the draft and says so. */
  const onBeforeUnload = (e) => { if (draft && dirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  const unsub = store.subscribe((s, p) => {
    if (s.checklists !== p.checklists) {
      if (!draft) { if (init()) drawAll(); return; }
      drawVersions(); drawBar();
    }
    if (s.conversations !== p.conversations && draft) drawPreview();
  });

  return {
    update() {},
    destroy() {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (draft && dirty()) toast({ kind: 'info', title: t('checklist.draftKept'), message: t('checklist.draftKeptHint'), timeout: 6000 });
      unsub();
      root.removeEventListener('click', onClick);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onChange);
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('dragstart', onDragStart);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragend', onDragEnd);
      root.removeEventListener('drop', onDrop);
      root.innerHTML = '';
    },
  };
}
