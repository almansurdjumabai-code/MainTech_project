/**
 * Hash router (works inside a D365 iframe).
 * Routes: #/conversations · #/conversation/:id?msg=3 · #/checklists · #/appeals?id= · #/dashboard
 */

/**
 * @typedef {{name:string, params:Record<string,string>, query:URLSearchParams, path:string}} Route
 */

const ROUTES = [
  { name: 'conversations', re: /^\/conversations\/?$/ },
  { name: 'conversation', re: /^\/conversation\/([^/]+)\/?$/, keys: ['id'] },
  { name: 'checklists', re: /^\/checklists\/?$/ },
  { name: 'appeals', re: /^\/appeals\/?$/ },
  { name: 'dashboard', re: /^\/dashboard\/?$/ },
];

/** @returns {Route} */
export function parseHash(hash = location.hash) {
  const h = hash.replace(/^#/, '') || '/conversations';
  const [path, qs = ''] = h.split('?');
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      (r.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { name: r.name, params, query: new URLSearchParams(qs), path };
    }
  }
  return { name: 'conversations', params: {}, query: new URLSearchParams(qs), path: '/conversations' };
}

/** @param {string} path e.g. '/conversation/p1-ru-001?msg=3' */
export function navigate(path) {
  const next = '#' + path;
  if (location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = next;
}

/** @param {(r: Route) => void} onRoute @returns {() => void} */
export function startRouter(onRoute) {
  const h = () => onRoute(parseHash());
  window.addEventListener('hashchange', h);
  h();
  return () => window.removeEventListener('hashchange', h);
}

export const convLink = (id, msg) => `#/conversation/${encodeURIComponent(id)}${msg != null ? `?msg=${msg}` : ''}`;
