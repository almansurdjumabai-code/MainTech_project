/**
 * Dynamics 365 web resource entry: mounts only the conversation card.
 * D365 passes custom parameters as ?data=<urlencoded "conversationId=...&msg=3&lang=kz&role=reviewer">.
 * The host page can switch the record with postMessage({type:'cqa:open', conversationId}).
 */
import { config } from './config.js';
import { html, render } from './core/utils.js';
import { initI18n, setLang, t } from './core/i18n.js';
import { store } from './core/store.js';
import { bootstrap } from './core/actions.js';
import { api } from './api/client.js';
import { notifyHost } from './core/events.js';
import * as Toast from './components/toast.js';
import { setModalHost } from './components/modal.js';
import * as ConversationCard from './components/conversation-card.js';

const root = /** @type {HTMLElement} */ (document.getElementById('cqa-d365'));

/** @returns {Record<string,string>} */
function readParams() {
  const q = new URLSearchParams(location.search);
  const out = {};
  const data = q.get('data');
  if (data) new URLSearchParams(decodeURIComponent(data)).forEach((v, k) => { out[k] = v; });
  q.forEach((v, k) => { if (k !== 'data' && !(k in out)) out[k] = v; });
  return out;
}

async function start() {
  const p = readParams();
  if (p.lang) store.set({ lang: /** @type {any} */ (p.lang) });
  if (p.role === 'qa' || p.role === 'reviewer') store.set({ role: p.role });
  root.dataset.theme = store.get().theme;
  await initI18n(store.get().lang);
  setModalHost(root);
  Toast.mount(root);
  const host = document.createElement('div');
  root.appendChild(host);
  await bootstrap();

  // D365 may pass the CRM record GUID as `id`; conversationId is the organizers' ID.
  const id = p.conversationId || p.conversation_id || p.id;
  let card = null;
  const open = (cid, msg = null) => {
    if (!cid) {
      render(host, html`<div class="cqa-page"><div class="cqa-notice">${t('card.loadError', { id: '—' })}: conversationId</div></div>`);
      return;
    }
    if (card) card.update({ id: cid, msg });
    else card = ConversationCard.mount(host, { id: cid, msg, embedded: true });
  };
  open(id, p.msg != null ? Number(p.msg) : null);

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || e.source !== window.parent) return;
    if (d.type === 'cqa:open' && typeof d.conversationId === 'string') open(d.conversationId, d.msg ?? null);
    if (d.type === 'cqa:set-lang' && typeof d.lang === 'string') { store.set({ lang: d.lang }); setLang(d.lang); card?.destroy(); card = null; open(id); }
  });
  notifyHost('cqa:ready', { conversationId: id || null, mock: config.USE_MOCK });
}

window.CQA = Object.assign(window.CQA || {}, { version: '1.0.0', config, store, api, embedded: true });
start();
