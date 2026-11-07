/** Interface translations. Dictionaries are flat JSON: { "key.sub": "text {var}" }. */

export const LANGS = ['ru', 'kz', 'en'];
/** @type {Record<string, Record<string,string>>} */
const dicts = {};
let current = 'ru';

/**
 * Load all dictionaries (small) once.
 * @param {string} lang
 */
export async function initI18n(lang) {
  await Promise.all(LANGS.map(async (l) => {
    if (dicts[l]) return;
    try {
      const res = await fetch(new URL(`../i18n/${l}.json`, import.meta.url));
      dicts[l] = res.ok ? await res.json() : {};
    } catch { dicts[l] = {}; }
  }));
  setLang(lang);
}

/** @param {string} lang */
export function setLang(lang) {
  current = LANGS.includes(lang) ? lang : 'ru';
}

export const getLang = () => current;

/**
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 */
export function t(key, vars) {
  let s = dicts[current]?.[key] ?? dicts.ru?.[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}
