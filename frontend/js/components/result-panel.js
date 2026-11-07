/**
 * Evaluation result: score hero (odometer + gauge), sections, "how the total is computed",
 * ledger of criteria with evidence links, appeals and audit log.
 */
import { html, raw, esc, render, $, $$, fmtScore, fmtDate, parseTimestamp } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t, getLang } from '../core/i18n.js';
import { config } from '../config.js';
import { scoreEvaluation, evaluationAnswers, maxStep, round2 } from '../core/scoring.js';
import { answerPill, answerText, appealBadge, appealTimeline, createOdometer, gaugeSvg, setGauge, deltaChip, confidenceMeter } from './ui.js';

/** "#7 · Operator · 00:45" — who said it and when. */
function refMeta(tr, i) {
  const m = tr[i];
  if (!m) return '';
  return `${t('speaker.' + (m.speaker || 'system'))} · ${parseTimestamp(m.timestamp).display}`;
}

/** Turn "#7" / "#2–4" mentions inside an explanation into jump links. */
function linkRefs(text, tr) {
  return raw(esc(text).replace(/#(\d+)(?:[–-](\d+))?/g, (m, a, b) => {
    const i = Number(a);
    if (!tr[i]) return m;
    if (b && tr[Number(b)]) return `<button type="button" class="cqa-ref" data-act="range" data-from="${i}" data-to="${Number(b)}">${m}</button>`;
    return `<button type="button" class="cqa-ref" data-act="evidence" data-msg="${i}" data-quote="" title="${esc(refMeta(tr, i))}">${m}</button>`;
  }));
}

const typeLabel = (c) => (c.type === 'scale' ? t('type.scale') : c.type === 'flag' ? t('type.flag') : t('type.binary'));

/**
 * @param {HTMLElement} root
 * @param {{evaluation:any, checklist:any, conversation:any, role:'qa'|'reviewer', appeals:any[],
 *   animateFrom?:number|null, justEvaluated?:boolean,
 *   onEvidence:(i:number, quote?:string)=>void, onRange:(r:{from:number,to:number})=>void,
 *   onAppeal:(criterionId:string)=>void, onAiReview?:(appealId:string)=>Promise<any>}} props
 */
export function mount(root, props) {
  /** @type {Set<string>} */
  const flipped = new Set();
  let focused = -1;

  function draw() {
    const { evaluation: ev, checklist: cl, conversation: conv, role, appeals } = props;
    const { ai, final } = evaluationAnswers(ev);
    const sc = scoreEvaluation(cl, final);
    const scAI = scoreEvaluation(cl, ai);
    const overridden = Object.keys(ev.overrides || {}).length > 0;
    const details = new Map((ev.criteria || []).map((d) => [d.criterionId, d]));
    const lowCount = (ev.criteria || []).filter((d) => d.confidence != null && d.confidence < config.LOW_CONFIDENCE).length;
    const criteria = cl.criteria.filter((c) => details.has(c.id));
    const missing = cl.criteria.filter((c) => !details.has(c.id));

    render(root, html`<div class="cqa-stack-y" style="gap:16px">
      <div class="cqa-vault" data-hero>
        <div class="cqa-score">
          <div class="cqa-score__ring">
            ${gaugeSvg(168, 10)}
            <div class="cqa-score__value"><span class="cqa-score__num" data-odo></span><span class="cqa-score__of">/ 100</span></div>
          </div>
          <div class="cqa-score__info">
            <span class="cqa-eyebrow">${t('result.total')} · ${t('result.checklistV', { v: cl.version })}</span>
            <div class="cqa-row" style="gap:12px">
              ${props.justEvaluated ? html`<span class="cqa-approved__circle" style="width:32px;height:32px"><svg class="cqa-check-draw" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg></span>` : ''}
              <span class="cqa-score__title">${sc.computable ? (overridden ? t('result.finalAfterReview') : t('result.signed')) : t('result.notComputable')}</span>
            </div>
            ${!sc.computable ? html`<p class="cqa-score__nc">${t('result.notComputableHint')}</p>` : ''}
            ${overridden ? html`<div class="cqa-score__orig">${t('result.aiOriginal')}: <s class="cqa-num">${fmtScore(scAI.total)}</s> → <b class="cqa-num" style="color:#fff">${fmtScore(sc.total)}</b> ${deltaChip(sc.total != null && scAI.total != null ? round2(sc.total - scAI.total) : null)}</div>` : ''}
            <div class="cqa-score__meta">
              <span>${ev.model}</span><span>${fmtDate(ev.createdAt, getLang())}</span>
              ${ev.durationMs != null ? html`<span>${(ev.durationMs / 1000).toFixed(1)}s</span>` : ''}
              ${ev.costUsd != null ? html`<span>$${Number(ev.costUsd).toFixed(4)}</span>` : ''}
            </div>
            ${sc.gross ? grossPlate() : ''}
          </div>
        </div>
      </div>

      ${sc.sections.length ? html`<div class="cqa-sections">${sc.sections.map((s) => html`
        <div class="cqa-sec">
          <span class="cqa-sec__name">${s.section}</span>
          <span class="cqa-sec__val cqa-num">${s.max ? fmtScore(s.points) : '—'} <small>/ ${s.max ? fmtScore(s.max) : 'N/A'}</small></span>
          <span class="cqa-bar"><span class="cqa-bar__fill" style="transform:scaleX(0)" data-fill="${s.max ? s.points / s.max : 0}"></span></span>
        </div>`)}</div>` : ''}

      ${calcBlock(cl, sc)}

      <div class="cqa-row cqa-row--between" style="margin-top:8px">
        <span class="cqa-eyebrow">${t('result.criteria')} · ${criteria.length}</span>
        ${lowCount ? html`<span class="cqa-badge cqa-badge--amber">${icon('info', { size: 14 })}${t('result.lowCount', { n: lowCount })}</span>` : ''}
      </div>
      ${missing.length ? html`<div class="cqa-notice">${icon('info')}<span>${t('result.missingCriteria', { n: missing.length })}</span></div>` : ''}
      <div class="cqa-ledger" role="list">
        ${criteria.map((c, i) => critRow(c, i, details.get(c.id), sc.rows.find((r) => r.criterionId === c.id), ev, conv, role, appeals))}
      </div>

      ${appeals.length ? html`<div class="cqa-card cqa-card--line cqa-stack-y">
        <span class="cqa-eyebrow">${t('result.appeals')}</span>
        ${appeals.map((a) => html`<div class="cqa-stack-y" style="gap:8px;padding:6px 0">
          <div class="cqa-row cqa-row--between cqa-row--wrap"><b>${cl.criteria.find((c) => c.id === a.criterionId)?.title || a.criterionId}</b>${appealBadge(a.status)}</div>
          ${appealTimeline(a)}
          <p class="cqa-small cqa-muted">«${a.comment}»</p>
          ${a.decision ? html`<p class="cqa-small"><b>${t('appeal.decisionBy')}:</b> ${a.decision.reason}</p>` : ''}
        </div>`)}
      </div>` : ''}

      ${(ev.audit || []).length ? html`<details class="cqa-calc">
        <summary>${icon('right', { size: 16 })}${t('result.audit')} <span class="cqa-badge cqa-badge--sm">${ev.audit.length}</span></summary>
        <div class="cqa-calc__body"><div class="cqa-audit">${ev.audit.map((a) => html`<div class="cqa-audit__row">
          <span class="cqa-mono cqa-mute">${fmtDate(a.at, getLang())}</span><span><b>${a.actor}</b></span>
          <span><span class="cqa-badge cqa-badge--sm">${t('audit.' + a.action)}</span> ${a.details || ''}</span></div>`)}</div></div>
      </details>` : ''}
    </div>`);

    const odo = createOdometer(/** @type {HTMLElement} */ ($(root, '[data-odo]')));
    if (props.animateFrom != null) {
      odo.set(props.animateFrom);
      setGauge(root, props.animateFrom);
      setTimeout(() => { odo.set(sc.total); setGauge(root, sc.total); }, 450);
    } else {
      odo.set(sc.total);
      setGauge(root, sc.total);
    }
    requestAnimationFrame(() => $$(root, '[data-fill]').forEach((el) => { el.style.transform = `scaleX(${el.dataset.fill})`; }));
    if (focused >= 0) focusCriterion(focused, false);
  }

  function grossPlate() {
    return html`<div class="cqa-gross" role="alert">
      <span class="cqa-gross__icon">${icon('shield', { size: 18 })}</span>
      <span><span class="cqa-gross__title">${t('result.gross')}</span><br><span class="cqa-gross__text">${t('result.grossHint')}</span></span>
    </div>`;
  }

  function calcBlock(cl, sc) {
    const rows = sc.rows.filter((r) => r.type !== 'flag');
    const applicable = rows.filter((r) => r.applicable);
    const na = rows.filter((r) => r.na);
    const missing = rows.filter((r) => r.missing);
    const title = (id) => cl.criteria.find((c) => c.id === id)?.title || id;
    const scales = applicable.filter((r) => r.type === 'scale');
    return html`<details class="cqa-calc" data-calc>
      <summary>${icon('right', { size: 16 })}${t('calc.title')}</summary>
      <div class="cqa-calc__body">
        <ol class="cqa-calc__steps">
          <li class="cqa-calc__step"><span>${t('calc.applicability')}: ${t('calc.applicableN', { n: applicable.length })}${na.length ? html`, N/A — ${na.map((r) => title(r.criterionId)).join(', ')}` : ''}${missing.length ? html`, ${t('calc.missingN', { n: missing.length })}` : ''}</span><span class="cqa-calc__formula">Σw = ${fmtScore(sc.applicableWeight)}</span></li>
          <li class="cqa-calc__step"><span>${t('calc.points')}</span><span class="cqa-calc__formula">${applicable.map((r) => fmtScore(r.points)).join(' + ') || '0'} = ${fmtScore(sc.rawPoints)}</span></li>
          <li class="cqa-calc__step"><span>${t('calc.scales')}${scales.length ? '' : html` — ${t('calc.none')}`}</span><span class="cqa-calc__formula">${scales.map((r) => {
            const c = cl.criteria.find((x) => x.id === r.criterionId);
            return `${r.answer}/${maxStep(c)} × ${r.weight} = ${fmtScore(r.points)}`;
          }).join(' · ')}</span></li>
          <li class="cqa-calc__step"><span>${t('calc.redistribute')}</span><span class="cqa-calc__formula">${sc.computable ? `× 100 / ${fmtScore(sc.applicableWeight)} = ×${(100 / sc.applicableWeight).toFixed(4)}` : '—'}</span></li>
          <li class="cqa-calc__step"><span>${t('calc.round')}</span><span class="cqa-calc__formula">${sc.computable ? `${fmtScore(sc.rawPoints)} / ${fmtScore(sc.applicableWeight)} × 100 = ${fmtScore(sc.total)}` : t('result.notComputable')}</span></li>
        </ol>
        <div class="cqa-stack-y" style="gap:6px">
          <div class="cqa-stack-legend"><span>${t('calc.weightsBefore')}</span><span>${fmtScore(sc.totalWeight)}</span></div>
          <div class="cqa-stack">${rows.map((r) => html`<span class="cqa-stack__seg ${r.na || r.missing ? 'cqa-stack__seg--na' : ''}" style="flex-grow:${r.weight}" title="${title(r.criterionId)}">${r.weight}</span>`)}</div>
          <div class="cqa-stack-legend" style="margin-top:8px"><span>${t('calc.weightsAfter')}</span><span>100</span></div>
          <div class="cqa-stack" data-after>${rows.map((r) => html`<span class="cqa-stack__seg ${r.na || r.missing ? 'cqa-stack__seg--na' : ''}" style="flex-grow:${r.weight}" data-to="${r.effectiveWeight}" title="${title(r.criterionId)}">${r.applicable ? fmtScore(r.effectiveWeight) : ''}</span>`)}</div>
        </div>
      </div>
    </details>`;
  }

  function critRow(c, i, d, row, ev, conv, role, appeals) {
    const ov = ev.overrides?.[c.id];
    const answer = ov ? ov.answer : d.answer;
    const ap = [...appeals].reverse().find((a) => a.criterionId === c.id);
    const openAp = ap && (ap.status === 'submitted' || ap.status === 'in_review');
    const isFlip = flipped.has(c.id) && ap?.aiReview;
    const pts = c.type === 'flag'
      ? html`<span class="cqa-crit__pts cqa-crit__pts--zero">—<small>${t('result.noPoints')}</small></span>`
      : row?.na ? html`<span class="cqa-crit__pts cqa-crit__pts--zero">N/A<small>${t('result.excluded')}</small></span>`
        : html`<span class="cqa-crit__pts cqa-num ${row?.points > 0 ? 'cqa-crit__pts--pos' : 'cqa-crit__pts--zero'}">${row?.points > 0 ? '+' : ''}${fmtScore(row?.points ?? 0)}<small>${t('result.ofWeight', { w: c.weight })}</small></span>`;
    const tr = conv.transcript || [];
    const range = d.checkedRange;
    const showRange = range && (answer === 'no' || c.type === 'flag' || (typeof answer === 'number' && answer < maxStep(c)));

    const front = html`
      <p class="cqa-crit__expl">${linkRefs(d.explanation || '', tr)}</p>
      ${answer === 'na' && (d.naReason || c.naCondition) ? html`<p class="cqa-crit__na">${icon('info', { size: 16 })}<span><b>${t('result.naReason')}:</b> ${d.naReason || c.naCondition}</span></p>` : ''}
      ${(d.evidence?.length || showRange) ? html`<div class="cqa-row cqa-row--wrap" style="gap:6px">
        ${(d.evidence || []).map((e) => html`<button type="button" class="cqa-evidence" data-act="evidence" data-msg="${e.messageIndex}" data-quote="${e.quote || ''}" title="${t('result.gotoMsg')}">
          <span class="cqa-evidence__idx">#${e.messageIndex}</span><span class="cqa-evidence__meta">${refMeta(tr, e.messageIndex)}</span><span class="cqa-evidence__q">«${e.quote || tr[e.messageIndex]?.text || ''}»</span></button>`)}
        ${showRange ? html`<button type="button" class="cqa-evidence cqa-evidence--range" data-act="range" data-from="${range.from}" data-to="${range.to}">
          <span class="cqa-evidence__idx">#${range.from}–${range.to}</span><span class="cqa-evidence__q" style="font-style:normal">${t('result.checkedRange')}</span></button>` : ''}
      </div>` : ''}
      ${ov ? html`<div class="cqa-crit__override">${icon('gavel', { size: 16 })}<span>${t('result.ai')}: <s>${answerText(c, d.answer)}</s></span> → <b>${answerText(c, ov.answer)}</b><span class="cqa-muted">· ${ov.reason}</span></div>` : ''}
      <div class="cqa-crit__meta">
        ${c.type !== 'flag' ? html`<span>${t('result.weight')} <b class="cqa-num">${c.weight}</b>${row?.applicable ? html` → <b class="cqa-num">${fmtScore(row.effectiveWeight)}</b>` : ''}</span>` : ''}
        ${confidenceMeter(d.confidence, config.LOW_CONFIDENCE)}
        ${ap ? appealBadge(ap.status) : ''}
      </div>
      <div class="cqa-crit__actions cqa-no-print">
        ${role === 'qa' && !openAp ? html`<button type="button" class="cqa-btn cqa-btn--line cqa-btn--xs" data-act="appeal" data-cid="${c.id}">${icon('flag', { size: 14 })}${t('appeal.dispute')}</button>` : ''}
        ${role === 'reviewer' && openAp ? html`<a class="cqa-btn cqa-btn--primary cqa-btn--xs" href="#/appeals?id=${ap.id}">${icon('gavel', { size: 14 })}${t('appeal.review')}</a>` : ''}
        ${ap && (ap.aiReview || (role === 'reviewer' && openAp)) ? html`<button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--xs" data-act="flip" data-cid="${c.id}" data-appeal="${ap.id}">${icon('spark', { size: 14 })}${t('appeal.aiSecond')}</button>` : ''}
      </div>`;

    const back = isFlip ? html`<div class="cqa-second">
      <span class="cqa-eyebrow">${t('appeal.aiSecond')} · ${ap.aiReview.model}</span>
      <div class="cqa-second__cols">
        <div class="cqa-stack-y" style="gap:6px"><span class="cqa-eyebrow">${t('result.ai')}</span>${answerPill(c, d.answer)}</div>
        <div class="cqa-stack-y" style="gap:6px"><span class="cqa-eyebrow">${t('appeal.secondOpinion')}</span>${answerPill(c, ap.aiReview.answer)}</div>
      </div>
      <p style="font-size:13.5px">${ap.aiReview.explanation}</p>
      <div class="cqa-row cqa-row--between"><span class="cqa-small" style="color:var(--cqa-vault-mute)">${t('result.confidence')} ${Math.round(ap.aiReview.confidence * 100)}%</span>
      <button type="button" class="cqa-btn cqa-btn--vault cqa-btn--xs" data-act="flip" data-cid="${c.id}" data-appeal="${ap.id}">${icon('left', { size: 14 })}${t('common.back')}</button></div>
    </div>` : '';

    return html`<article class="cqa-crit ${c.type === 'flag' && answer === 'yes' ? 'cqa-crit--gross' : ''}" role="listitem" tabindex="0" data-cid="${c.id}" data-n="${i}" style="--i:${i}">
      <header class="cqa-crit__head">
        <span class="cqa-crit__num">${String(i + 1).padStart(2, '0')}</span>
        <div><div class="cqa-crit__title">${c.title}</div><div class="cqa-crit__sub">${c.section} · ${typeLabel(c)}</div></div>
        ${answerPill(c, answer)}
        ${pts}
      </header>
      <div class="cqa-crit__body">${isFlip ? back : front}</div>
    </article>`;
  }

  function focusCriterion(n, scroll = true) {
    const rows = $$(root, '.cqa-crit');
    rows.forEach((r) => r.classList.remove('is-focused'));
    const el = rows[n];
    if (!el) return;
    focused = n;
    el.classList.add('is-focused');
    el.focus({ preventScroll: !scroll });
    if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function flip(cid, appealId) {
    const el = $(root, `.cqa-crit[data-cid="${cid}"]`);
    const ap = props.appeals.find((a) => a.id === appealId);
    if (!el || !ap) return;
    if (!ap.aiReview && props.onAiReview) {
      const btn = $(el, '[data-act="flip"]');
      btn?.setAttribute('disabled', '');
      if (btn) btn.innerHTML = `<span class="cqa-proc__dot" style="width:12px;height:12px;border-color:currentColor;border-top-color:transparent;animation:cqa-spin .8s linear infinite"></span>${t('appeal.aiThinking')}`;
      try { ap.aiReview = await props.onAiReview(appealId); } catch { btn?.removeAttribute('disabled'); return; }
    }
    el.classList.add('is-flip-out');
    setTimeout(() => {
      if (flipped.has(cid)) flipped.delete(cid); else flipped.add(cid);
      const n = Array.from($$(root, '.cqa-crit')).indexOf(el);
      draw();
      const fresh = $$(root, '.cqa-crit')[n];
      $$(root, '.cqa-crit').forEach((r) => { r.style.animation = 'none'; });
      if (fresh) { fresh.style.animation = ''; fresh.classList.add('is-flip-in'); }
    }, 220);
  }

  const onClick = (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (!el || !root.contains(el)) {
      const row = e.target instanceof Element ? e.target.closest('.cqa-crit') : null;
      if (row) focused = Number(row.getAttribute('data-n'));
      return;
    }
    const act = el.getAttribute('data-act');
    if (act === 'evidence') props.onEvidence(Number(el.getAttribute('data-msg')), el.getAttribute('data-quote') || '');
    if (act === 'range') props.onRange({ from: Number(el.getAttribute('data-from')), to: Number(el.getAttribute('data-to')) });
    if (act === 'appeal') props.onAppeal(el.getAttribute('data-cid'));
    if (act === 'flip') flip(el.getAttribute('data-cid'), el.getAttribute('data-appeal'));
  };
  const onToggle = (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.matches('[data-calc]')) return;
    const segs = $$(d, '[data-after] .cqa-stack__seg');
    requestAnimationFrame(() => segs.forEach((s) => { s.style.flexGrow = d.open ? s.dataset.to : ''; }));
  };
  root.addEventListener('click', onClick);
  root.addEventListener('toggle', onToggle, true);
  draw();

  return {
    update(next) { props = { ...props, ...next }; draw(); },
    destroy() { root.removeEventListener('click', onClick); root.removeEventListener('toggle', onToggle, true); root.innerHTML = ''; },
    focusCriterion,
    /** Jump to the first evidence of the focused criterion. */
    gotoEvidence() {
      const row = $$(root, '.cqa-crit')[Math.max(0, focused)];
      const b = row && /** @type {HTMLElement|null} */ ($(row, '[data-act="evidence"], [data-act="range"]'));
      b?.click();
    },
    focusedCriterionId() { return $$(root, '.cqa-crit')[focused]?.getAttribute('data-cid') || null; },
  };
}
