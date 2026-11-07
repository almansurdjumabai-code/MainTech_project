/**
 * Messenger-style transcript. Keeps original timestamps.
 * Extra API: focusMessage, setRange, setActive (karaoke), startScan/markRead/stopScan.
 */
import { html, render, esc, $, $$, parseTimestamp, transcriptOffsets, prefersReducedMotion } from '../core/utils.js';
import { t } from '../core/i18n.js';

const SPEAKERS = ['client', 'operator', 'bot', 'system'];

/**
 * @param {HTMLElement} root
 * @param {{conversation:any, onMessageClick?:(index:number, offsetSec:number|null)=>void, compact?:boolean, only?:number[]}} props
 */
export function mount(root, props) {
  let offsets = [];
  let scanTimer = null;

  function draw() {
    const conv = props.conversation;
    offsets = transcriptOffsets(conv.transcript || []);
    const items = (conv.transcript || []).map((m, i) => ({ m, i })).filter(({ i }) => !props.only || props.only.includes(i));
    render(root, html`<div class="cqa-transcript" role="log" aria-label="${t('card.transcript')}">
      <div class="cqa-transcript__scan" hidden></div>
      <ol class="cqa-transcript__list">${items.map(({ m, i }) => msg(m, i))}</ol>
    </div>`);
  }

  function msg(m, i) {
    const sp = SPEAKERS.includes(m.speaker) ? m.speaker : 'system';
    const ts = parseTimestamp(m.timestamp);
    return html`<li class="cqa-msg cqa-msg--${sp}" data-index="${i}" id="cqa-msg-${i}">
      <div class="cqa-msg__meta">
        <span class="cqa-msg__who">${t('speaker.' + sp)}</span>
        <time datetime="${ts.full}" title="${ts.full}">${ts.display}</time>
        <span class="cqa-msg__idx">#${i}</span>
      </div>
      <div class="cqa-msg__bubble" role="button" tabindex="0" aria-label="${t('speaker.' + sp)} ${ts.display}: ${m.text}">${m.text}</div>
    </li>`;
  }

  const onClick = (e) => {
    const b = e.target instanceof Element ? e.target.closest('.cqa-msg__bubble') : null;
    if (!b || !props.onMessageClick) return;
    const i = Number(b.parentElement?.dataset.index);
    props.onMessageClick(i, offsets[i] ?? null);
  };
  const onKey = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.matches('.cqa-msg__bubble')) { e.preventDefault(); onClick(e); } };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  draw();

  const msgEl = (i) => /** @type {HTMLElement|null} */ ($(root, `.cqa-msg[data-index="${i}"]`));

  function clearMarks() {
    $$(root, '.cqa-msg.is-evidence').forEach((el) => el.classList.remove('is-evidence', 'is-pulse'));
    $$(root, '.cqa-mark').forEach((m) => {
      const b = m.closest('.cqa-msg__bubble');
      const i = Number(b?.parentElement?.dataset.index);
      if (b) b.textContent = props.conversation.transcript[i]?.text ?? b.textContent;
    });
  }

  return {
    update(next) {
      const redraw = next.conversation !== props.conversation;
      props = { ...props, ...next };
      if (redraw) draw();
    },
    destroy() {
      clearInterval(scanTimer);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
      root.innerHTML = '';
    },
    offsets: () => offsets,
    /**
     * Scroll to a message, pulse it and highlight a quote.
     * @param {number} i @param {{quote?:string, keepRange?:boolean}} [o]
     */
    focusMessage(i, o = {}) {
      const el = msgEl(i);
      if (!el) return false;
      clearMarks();
      if (!o.keepRange) this.setRange(null);
      el.classList.add('is-evidence');
      el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      void el.offsetWidth;
      el.classList.add('is-pulse');
      const bubble = $(el, '.cqa-msg__bubble');
      const text = props.conversation.transcript[i]?.text || '';
      const q = (o.quote || '').trim();
      const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
      if (bubble && at >= 0) {
        bubble.innerHTML = `${esc(text.slice(0, at))}<mark class="cqa-mark">${esc(text.slice(at, at + q.length))}</mark>${esc(text.slice(at + q.length))}`;
      }
      /** @type {HTMLElement|null} */ (bubble)?.focus({ preventScroll: true });
      return true;
    },
    /** Highlight a checked range (missed action). @param {{from:number,to:number}|null} r */
    setRange(r) {
      $$(root, '.cqa-msg.is-range').forEach((el) => el.classList.remove('is-range'));
      if (!r) return;
      for (let i = r.from; i <= r.to; i++) msgEl(i)?.classList.add('is-range');
      const first = msgEl(r.from);
      first?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    },
    /** Karaoke highlight. @param {number} i */
    setActive(i) {
      const prev = $(root, '.cqa-msg.is-active');
      const el = msgEl(i);
      if (prev === el) return;
      prev?.classList.remove('is-active');
      if (!el) return;
      el.classList.add('is-active');
      el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    },
    /** Evaluation scan-line; messages "read" one by one. @param {number} [ms] expected duration */
    startScan(ms = 2400) {
      const box = $(root, '.cqa-transcript');
      if (!box) return;
      box.classList.add('cqa-transcript--scanning');
      $(root, '.cqa-transcript__scan')?.removeAttribute('hidden');
      $$(root, '.cqa-msg').forEach((m) => m.classList.remove('is-read'));
      const all = $$(root, '.cqa-msg');
      let k = 0;
      clearInterval(scanTimer);
      scanTimer = setInterval(() => {
        if (k >= all.length) { clearInterval(scanTimer); return; }
        all[k++].classList.add('is-read');
      }, Math.max(60, ms / Math.max(1, all.length)));
    },
    stopScan() {
      clearInterval(scanTimer);
      $(root, '.cqa-transcript')?.classList.remove('cqa-transcript--scanning');
      $(root, '.cqa-transcript__scan')?.setAttribute('hidden', '');
      $$(root, '.cqa-msg').forEach((m) => m.classList.remove('is-read'));
    },
  };
}
