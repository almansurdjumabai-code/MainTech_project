/** Evaluation trace: proof that the evaluation ran live (model, version, timing, tokens, raw output). */
import { html, render, raw, esc, fmtDate, downloadFile } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t, getLang } from '../core/i18n.js';

/** Syntax-highlight JSON (input is escaped first). @param {any} obj */
export function highlightJson(obj) {
  const s = esc(JSON.stringify(obj ?? null, null, 2));
  return raw(s.replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (bool) return `<span class="j-bool">${m}</span>`;
    if (m === 'null') return `<span class="j-null">${m}</span>`;
    return `<span class="j-num">${m}</span>`;
  }));
}

/**
 * @param {HTMLElement} root
 * @param {{evaluation:any, checklist:any}} props
 */
export function mount(root, props) {
  function draw() {
    const ev = props.evaluation;
    const kv = [
      [t('trace.evaluationId'), ev.evaluationId],
      [t('trace.model'), ev.model],
      [t('trace.checklist'), `${props.checklist?.name || ''} · v${props.checklist?.version ?? ev.checklistVersion ?? '?'}`],
      [t('trace.started'), fmtDate(ev.createdAt, getLang())],
      [t('trace.duration'), ev.durationMs != null ? `${(ev.durationMs / 1000).toFixed(2)} s` : '—'],
      [t('trace.tokens'), ev.tokens ? `${ev.tokens.in} in · ${ev.tokens.out} out` : '—'],
      [t('trace.cost'), ev.costUsd != null ? `$${Number(ev.costUsd).toFixed(4)}` : '—'],
      [t('trace.criteria'), String(ev.criteria?.length ?? 0)],
    ];
    render(root, html`<div class="cqa-trace">
      <div class="cqa-vault">
        <div class="cqa-row cqa-row--between" style="margin-bottom:20px"><span class="cqa-eyebrow">${t('trace.title')}</span><span class="cqa-badge cqa-badge--sm" style="background:rgba(81,175,61,.2);color:#8BE07A">● live</span></div>
        <div class="cqa-kv">${kv.map(([k, v]) => html`<div><div class="cqa-kv__k">${k}</div><div class="cqa-kv__v">${v}</div></div>`)}</div>
      </div>
      <details class="cqa-details" open>
        <summary>${icon('right', { size: 16 })}${t('trace.raw')}</summary>
        <div class="cqa-stack-y" style="margin-top:12px">
          <pre class="cqa-json" tabindex="0">${highlightJson(ev.rawModelOutput ?? { note: t('trace.noRaw') })}</pre>
          <div class="cqa-row"><button type="button" class="cqa-btn cqa-btn--secondary cqa-btn--sm" data-act="dl">${icon('download', { size: 16 })}${t('trace.download')}</button></div>
        </div>
      </details>
    </div>`);
  }
  const onClick = (e) => {
    if (e.target instanceof Element && e.target.closest('[data-act="dl"]')) {
      downloadFile(`${props.evaluation.evaluationId}.json`, JSON.stringify(props.evaluation, null, 2));
    }
  };
  root.addEventListener('click', onClick);
  draw();
  return {
    update(next) { props = { ...props, ...next }; draw(); },
    destroy() { root.removeEventListener('click', onClick); root.innerHTML = ''; },
  };
}
