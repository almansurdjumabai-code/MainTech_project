/**
 * Single network entry point. Every backend call goes through `api`.
 * USE_MOCK (config.js / ?mock=1) switches to the in-browser adapter.
 * Contract: docs/API_CONTRACT.md
 */
import { config } from '../config.js';
import { mockApi } from './mock.js';
import { ApiError } from './errors.js';

export { ApiError };

/**
 * @param {'GET'|'POST'|'PUT'} method
 * @param {string} path
 * @param {any} [body]
 */
async function request(method, path, body) {
  let res;
  try {
    res = await fetch(config.API_BASE.replace(/\/$/, '') + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(`Сервер недоступен (${config.API_BASE})`, 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError((data && (data.error || data.message || data.detail)) || `HTTP ${res.status}`, res.status);
  return data;
}

const enc = encodeURIComponent;

export const httpApi = {
  mode: 'http',
  health: () => request('GET', '/api/health'),
  async getDataset(groupId) {
    const r = await request('GET', `/api/datasets/${enc(groupId)}`);
    if (r && r.isSuccess === false) throw new ApiError(r.error || 'Организаторы вернули ошибку', 502);
    return r;
  },
  listConversations: () => request('GET', '/api/conversations'),
  getConversation: (id) => request('GET', `/api/conversations/${enc(id)}`),
  importConversations: (records) => request('POST', '/api/conversations/import', { records }),
  listChecklists: () => request('GET', '/api/checklists'),
  saveChecklist: (cl) => request('POST', '/api/checklists', cl),
  activateChecklist: (id) => request('PUT', `/api/checklists/${enc(id)}/activate`),
  listModels: () => request('GET', '/api/models'),
  startEvaluation: (body) => request('POST', '/api/evaluations', body),
  getJob: (jobId) => request('GET', `/api/evaluations/jobs/${enc(jobId)}`),
  getEvaluation: (id) => request('GET', `/api/evaluations/${enc(id)}`),
  listEvaluations: (conversationId) => request('GET', `/api/conversations/${enc(conversationId)}/evaluations`),
  createAppeal: (body) => request('POST', '/api/appeals', body),
  listAppeals: (status) => request('GET', `/api/appeals${status ? `?status=${enc(status)}` : ''}`),
  takeAppeal: (id) => request('POST', `/api/appeals/${enc(id)}/take`),
  decideAppeal: (id, body) => request('POST', `/api/appeals/${enc(id)}/decision`, body),
  aiReview: (id) => request('POST', `/api/appeals/${enc(id)}/ai-review`),
  /** Fact from saved evaluations: AI spend, machine time, tokens, models. */
  stats: () => request('GET', '/api/stats'),
};

/** @type {typeof httpApi & {reset?: () => Promise<void>}} */
export const api = config.USE_MOCK ? mockApi : httpApi;
