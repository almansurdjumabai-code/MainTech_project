/** Use-cases: call the API and keep the store in sync. Components call these, never `api` directly for writes. */
import { api } from '../api/client.js';
import { store, activeChecklist } from './store.js';
import { bus, notifyHost } from './events.js';
import { storage } from './utils.js';

export async function bootstrap() {
  store.set({ loading: true, loadError: null });
  checkHealth();
  try {
    const [checklists, models, conversations, appeals] = await Promise.all([
      api.listChecklists(), api.listModels().catch(() => []), api.listConversations(), api.listAppeals(),
    ]);
    const s = store.get();
    // Remember only a model the user picked: an auto-choice made before an LLM key appeared must not stick.
    const picked = storage.get('modelPicked', false) ? models.find((m) => m.id === s.model)?.id : null;
    const model = picked || models[0]?.id || null;
    store.set({ checklists, models, conversations, appeals, model, loading: false });
    storage.set('cache.conversations', conversations.map(({ evaluation, ...c }) => c));
  } catch (e) {
    store.set({ loading: false, loadError: e.message });
  }
}

export async function checkHealth() {
  try { await api.health(); store.set({ backendOnline: true }); } catch { store.set({ backendOnline: false }); }
}

export async function refreshConversations() {
  const conversations = await api.listConversations();
  store.set({ conversations });
  return conversations;
}

export async function refreshAppeals() {
  const appeals = await api.listAppeals();
  store.set({ appeals });
  return appeals;
}

export async function refreshChecklists() {
  const checklists = await api.listChecklists();
  store.set({ checklists });
  return checklists;
}

/** @param {string} groupId */
export async function loadDataset(groupId) {
  const res = await api.getDataset(groupId);
  store.set({ dataset: res.data.dataset_group_id || groupId });
  await refreshConversations();
  return res.data.total_records ?? res.data.records?.length ?? 0;
}

/** @param {any[]} records organizers' record format */
export async function importRecords(records) {
  const r = await api.importConversations(records);
  await refreshConversations();
  return r;
}

/**
 * @param {any} draft checklist without id/version
 * @param {{activate?: boolean}} opts
 */
export async function saveChecklist(draft, { activate = true } = {}) {
  let saved = await api.saveChecklist(draft);
  if (activate) saved = await api.activateChecklist(saved.id);
  await refreshChecklists();
  store.set({ checklistId: saved.id });
  bus.emit('checklist:saved', saved);
  return saved;
}

export async function activateChecklist(id) {
  await api.activateChecklist(id);
  await refreshChecklists();
  store.set({ checklistId: id });
}

/** @param {{evaluationId:string, criterionId:string, comment:string}} body */
export async function createAppeal(body) {
  const ap = await api.createAppeal(body);
  await Promise.all([refreshAppeals(), refreshConversations()]);
  bus.emit('appeal:changed', ap);
  return ap;
}

export async function takeAppeal(id) {
  const ap = await api.takeAppeal(id);
  await refreshAppeals();
  return ap;
}

/** @param {string} id @param {{action:'confirm'|'change', newValue:any, reason:string}} body */
export async function decideAppeal(id, body) {
  const res = await api.decideAppeal(id, body);
  await Promise.all([refreshAppeals(), refreshConversations()]);
  bus.emit('appeal:changed', res.appeal);
  notifyHost('cqa:evaluation-updated', { conversationId: res.evaluation.conversationId, evaluationId: res.evaluation.evaluationId, total: res.evaluation.total, grossViolation: res.evaluation.grossViolation });
  return res;
}

/** Checklist selected for new runs (explicit choice or active). */
export const runChecklistId = () => store.get().checklistId || activeChecklist()?.id || null;
