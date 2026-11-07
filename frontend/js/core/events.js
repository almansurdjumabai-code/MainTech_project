import { config } from '../config.js';

/**
 * Minimal event emitter.
 * @returns {{on:(t:string,f:Function)=>()=>void, emit:(t:string,p?:any)=>void}}
 */
export function createEmitter() {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    emit(type, payload) {
      map.get(type)?.forEach((fn) => {
        try { fn(payload); } catch (e) { console.error('[cqa] listener failed', type, e); }
      });
    },
  };
}

/** App-wide bus. Events: evaluation:done, evaluation:failed, appeal:changed, checklist:saved, job:update */
export const bus = createEmitter();

/**
 * Notify a hosting page (Dynamics 365 form) — safe without a parent.
 * @param {string} type e.g. 'cqa:evaluation-updated'
 * @param {object} payload
 */
export function notifyHost(type, payload) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type, payload, source: 'cqa' }, config.HOST_ORIGIN);
    }
  } catch { /* cross-origin parent or sandbox: ignore */ }
}
