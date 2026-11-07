/** Evaluation jobs: start, poll, retry. Progress lives in store.jobs. */
import { api } from '../api/client.js';
import { config } from '../config.js';
import { store } from './store.js';
import { bus, notifyHost } from './events.js';
import { refreshConversations, runChecklistId } from './actions.js';
import { debounce } from './utils.js';

const refreshSoon = debounce(() => refreshConversations().catch(() => {}), 250);

function putJob(job) {
  store.set((s) => {
    const jobs = s.jobs.filter((j) => j.jobId !== job.jobId);
    return { jobs: [...jobs, job] };
  });
}

/**
 * @param {string[]} conversationIds
 * @param {{checklistId?:string, model?:string}} [opts]
 * @returns {Promise<string>} jobId
 */
export async function runEvaluation(conversationIds, opts = {}) {
  const checklistId = opts.checklistId || runChecklistId();
  const model = opts.model || store.get().model;
  const { jobId } = await api.startEvaluation({ conversationIds, checklistId, model });
  const startedAt = new Date().toISOString();
  putJob({
    jobId, checklistId, model, status: 'running', startedAt, clientStartedAt: Date.now(),
    total: conversationIds.length, done: 0, failed: 0, etaMs: null,
    items: conversationIds.map((id) => ({ conversationId: id, status: 'queued', stage: 0, evaluationId: null, error: null })),
  });
  if (conversationIds.length > 1) store.set({ dismissedJob: null });
  poll(jobId);
  return jobId;
}

function poll(jobId) {
  const seen = new Set();
  const tick = async () => {
    let j;
    try { j = await api.getJob(jobId); } catch (e) {
      const prev = store.get().jobs.find((x) => x.jobId === jobId);
      if (prev) putJob({ ...prev, status: 'error', error: e.message });
      bus.emit('job:error', { jobId, message: e.message });
      return;
    }
    const prev = store.get().jobs.find((x) => x.jobId === jobId);
    putJob({ ...prev, ...j });
    let changed = false;
    j.items.forEach((it) => {
      const key = it.conversationId + ':' + it.status;
      if ((it.status === 'done' || it.status === 'error') && !seen.has(key)) {
        seen.add(key);
        changed = true;
        if (it.status === 'done') {
          bus.emit('evaluation:done', { ...it, jobId });
          notifyHost('cqa:evaluation-updated', { conversationId: it.conversationId, evaluationId: it.evaluationId });
        } else bus.emit('evaluation:failed', { ...it, jobId });
      }
    });
    if (changed) refreshSoon();
    if (j.status === 'done') { bus.emit('job:finished', j); return; }
    setTimeout(tick, config.POLL_MS);
  };
  tick();
}

/** Re-run only failed items of a job. */
export function retryFailed(jobId) {
  const job = store.get().jobs.find((j) => j.jobId === jobId);
  if (!job) return null;
  const ids = job.items.filter((i) => i.status === 'error').map((i) => i.conversationId);
  return ids.length ? runEvaluation(ids, { checklistId: job.checklistId, model: job.model }) : null;
}

/** Latest job item for a conversation (any job). */
export function jobItemFor(conversationId, s = store.get()) {
  for (let i = s.jobs.length - 1; i >= 0; i--) {
    const it = s.jobs[i].items.find((x) => x.conversationId === conversationId);
    if (it) return { job: s.jobs[i], item: it };
  }
  return null;
}
