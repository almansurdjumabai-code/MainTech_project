/**
 * Runtime configuration.
 * Override order: defaults → window.CQA.config (set by host page before app.js) → URL query.
 *   ?mock=1 / ?mock=0   force mock / real API
 *   ?api=http://host    override API_BASE
 *   ?demo=1             enable presentation tour
 */
const params = new URLSearchParams(location.search);
const preset = (typeof window !== 'undefined' && window.CQA && window.CQA.config) || {};

export const config = {
  /** Base URL of our backend (it proxies organizers' API to avoid CORS). */
  API_BASE: 'http://localhost:8000',
  /** Use in-browser mock adapter instead of HTTP. */
  USE_MOCK: true,
  /** Default dataset group for the loader. */
  DEFAULT_GROUP_ID: 'DEV',
  /** Below this confidence a criterion gets "manual review recommended". */
  LOW_CONFIDENCE: 0.7,
  /** Batch job polling interval, ms. */
  POLL_MS: 600,
  /** Target origin for postMessage to a D365 host. */
  HOST_ORIGIN: '*',
  /** Presentation mode with guided tour. */
  DEMO: false,
  ...preset,
};

if (params.has('mock')) config.USE_MOCK = params.get('mock') !== '0';
if (params.get('api')) config.API_BASE = params.get('api');
if (params.get('demo') === '1') config.DEMO = true;
