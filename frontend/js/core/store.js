import { storage } from './utils.js';

/**
 * @template S
 * @param {S} initial
 */
export function createStore(initial) {
  let state = initial;
  /** @type {Set<(s:S, prev:S) => void>} */
  const subs = new Set();
  return {
    /** @returns {S} */
    get: () => state,
    /** @param {Partial<S> | ((s:S) => Partial<S>)} patch */
    set(patch) {
      const prev = state;
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((fn) => fn(state, prev));
    },
    /** @param {(s:S, prev:S) => void} fn */
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/**
 * @typedef {Object} AppState
 * @property {'qa'|'reviewer'} role
 * @property {'ru'|'kz'|'en'} lang
 * @property {'light'|'dark'} theme
 * @property {boolean} loading
 * @property {string|null} loadError
 * @property {any[]} conversations     list items (conversation + `evaluation` summary)
 * @property {any[]} checklists         all versions
 * @property {any[]} appeals
 * @property {any[]} models
 * @property {string|null} model        selected model id
 * @property {string|null} checklistId  selected checklist for runs (defaults to active)
 * @property {string} dataset           last loaded group id
 * @property {boolean|null} backendOnline
 * @property {any[]} jobs              evaluation jobs of this session (latest last)
 * @property {string|null} dismissedJob job id hidden from the batch panel
 */

/** @type {ReturnType<typeof createStore<AppState>>} */
export const store = createStore({
  role: storage.get('role', 'qa'),
  lang: storage.get('lang', 'ru'),
  theme: storage.get('theme', 'light'),
  loading: true,
  loadError: null,
  conversations: [],
  checklists: [],
  appeals: [],
  models: [],
  model: storage.get('model', null),
  checklistId: null,
  dataset: storage.get('dataset', 'DEV'),
  backendOnline: null,
  jobs: [],
  dismissedJob: null,
});

store.subscribe((s, p) => {
  if (s.role !== p.role) storage.set('role', s.role);
  if (s.lang !== p.lang) storage.set('lang', s.lang);
  if (s.theme !== p.theme) storage.set('theme', s.theme);
  if (s.model !== p.model) storage.set('model', s.model);
  if (s.dataset !== p.dataset) storage.set('dataset', s.dataset);
});

/** Active checklist version. */
export const activeChecklist = (s = store.get()) => s.checklists.find((c) => c.active) || s.checklists[s.checklists.length - 1] || null;

/** @param {string} id */
export const checklistById = (id, s = store.get()) => s.checklists.find((c) => c.id === id) || null;
