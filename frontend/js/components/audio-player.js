/**
 * Call player: pseudo-waveform, seek, speed, karaoke callback.
 * If the recording cannot be played here (CORS, 404, offline), it falls back to a silent
 * timeline so transcript sync still works, and offers "Open recording".
 */
import { html, render, $, $$, fmtClock, seeded } from '../core/utils.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';

const BARS = 96;

/**
 * @param {HTMLElement} root
 * @param {{conversation:any, offsets:(number|null)[], onActive?:(index:number)=>void}} props
 */
export function mount(root, props) {
  const raw = props.conversation.audio_url;
  // RFC 2606 ".invalid" never resolves (used by mock data) — skip the request, play the timeline.
  const url = raw && !/^[a-z]+:\/\/[^/]+\.invalid(\/|$)/i.test(raw) ? raw : null;
  const known = props.offsets.filter((x) => x != null);
  let duration = (known.length ? Math.max(...known) : 0) + 6;
  let virtual = !url;
  let playing = false;
  let cur = 0;
  let rate = 1;
  let raf = 0;
  let last = 0;
  let activeIdx = -1;
  /** @type {HTMLAudioElement|null} */
  let audio = null;

  const rnd = seeded(props.conversation.conversation_id);
  const heights = Array.from({ length: BARS }, (_, i) => {
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 7) * Math.cos(i / 17));
    return Math.max(4, Math.round(44 * env * (0.45 + rnd() * 0.55)));
  });

  render(root, html`<div class="cqa-player">
    <div class="cqa-player__row">
      <button type="button" class="cqa-player__btn" data-act="toggle" aria-label="${t('player.play')}">${icon('play', { size: 20 })}</button>
      <svg class="cqa-player__wave" viewBox="0 0 ${BARS * 10} 48" preserveAspectRatio="none" role="slider" tabindex="0"
        aria-label="${t('player.seek')}" aria-valuemin="0" aria-valuemax="${Math.round(duration)}" aria-valuenow="0">
        ${heights.map((h, i) => html`<rect x="${i * 10}" y="${(48 - h) / 2}" width="6" height="${h}" rx="2"></rect>`)}
      </svg>
      <span class="cqa-player__time cqa-num" data-time>00:00 / ${fmtClock(duration)}</span>
    </div>
    <div class="cqa-player__foot">
      <div class="cqa-seg" role="group" aria-label="${t('player.speed')}" style="background:rgba(255,255,255,.08)">
        ${[1, 1.5, 2].map((r) => html`<button type="button" class="cqa-seg__btn ${r === 1 ? 'is-active' : ''}" data-rate="${r}" style="color:inherit">${r}×</button>`)}
      </div>
      <span data-mode class="cqa-grow">${virtual ? t('player.virtual') : t('player.loading')}</span>
      ${url ? html`<a class="cqa-btn cqa-btn--vault cqa-btn--xs" href="${url}" target="_blank" rel="noopener noreferrer">${icon('external', { size: 14 })}${t('player.open')}</a>` : ''}
    </div>
  </div>`);

  const rects = $$(root, '.cqa-player__wave rect');
  const timeEl = $(root, '[data-time]');
  const modeEl = $(root, '[data-mode]');
  const wave = $(root, '.cqa-player__wave');
  const btn = $(root, '[data-act="toggle"]');

  if (url) {
    audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) duration = audio.duration;
      virtual = false;
      modeEl.textContent = t('player.real');
      paint();
    });
    audio.addEventListener('error', () => { goVirtual(); });
    audio.addEventListener('timeupdate', () => { if (!virtual) { cur = audio.currentTime; paint(); } });
    audio.addEventListener('ended', () => setPlaying(false));
    audio.src = url;
  }

  function goVirtual() {
    if (virtual) return;
    virtual = true;
    modeEl.textContent = t('player.virtual');
    if (playing) { audio?.pause(); startClock(); }
  }

  function paint() {
    const k = duration ? cur / duration : 0;
    const n = Math.round(k * BARS);
    rects.forEach((r, i) => r.classList.toggle('is-played', i < n));
    timeEl.textContent = `${fmtClock(cur)} / ${fmtClock(duration)}`;
    wave.setAttribute('aria-valuenow', String(Math.round(cur)));
    let idx = -1;
    props.offsets.forEach((o, i) => { if (o != null && o <= cur + 0.05) idx = i; });
    if (idx !== activeIdx) { activeIdx = idx; if (idx >= 0) props.onActive?.(idx); }
  }

  function startClock() {
    cancelAnimationFrame(raf);
    last = performance.now();
    const step = (now) => {
      cur = Math.min(duration, cur + ((now - last) / 1000) * rate);
      last = now;
      paint();
      if (cur >= duration) { setPlaying(false); return; }
      if (playing && virtual) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function setPlaying(p) {
    playing = p;
    render(btn, p ? icon('pause', { size: 20 }) : icon('play', { size: 20 }));
    btn.setAttribute('aria-label', p ? t('player.pause') : t('player.play'));
    if (!p) { cancelAnimationFrame(raf); audio?.pause(); return; }
    if (cur >= duration - 0.1) cur = 0;
    if (virtual) startClock();
    else audio.play().catch(() => { goVirtual(); startClock(); });
  }

  function seek(sec, autoplay = false) {
    cur = Math.max(0, Math.min(duration, sec));
    if (!virtual && audio) audio.currentTime = cur;
    paint();
    if (autoplay && !playing) setPlaying(true);
  }

  const onClick = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest('[data-act="toggle"]')) setPlaying(!playing);
    const r = el?.closest('[data-rate]');
    if (r) {
      rate = Number(r.getAttribute('data-rate'));
      if (audio) audio.playbackRate = rate;
      $$(root, '[data-rate]').forEach((b) => b.classList.toggle('is-active', b === r));
    }
    if (el?.closest('.cqa-player__wave')) {
      const box = wave.getBoundingClientRect();
      seek(((/** @type {MouseEvent} */ (e).clientX - box.left) / box.width) * duration);
    }
  };
  const onKey = (e) => {
    if (e.target !== wave) return;
    if (e.key === 'ArrowRight') { seek(cur + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { seek(cur - 5); e.preventDefault(); }
    if (e.key === ' ' || e.key === 'Enter') { setPlaying(!playing); e.preventDefault(); }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  paint();

  return {
    update() {},
    destroy() {
      cancelAnimationFrame(raf);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      root.innerHTML = '';
    },
    seek,
    isPlaying: () => playing,
  };
}
