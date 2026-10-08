declare const __BUILD_ID__: string;

/** Unique per build; lets the UI detect a stale injected runtime. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** Path of the bundled content runtime inside dist/. */
export const CONTENT_RUNTIME_FILE = 'content/runtime.js';

/** Global key used by the content runtime injection guard. */
export const RUNTIME_GLOBAL_KEY = '__uxHeatgridV2__';

export const SESSION_TICK_MS = 1000;

export const MIRROR_KEY_PREFIX = 'tab:';

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
  'data:',
  'javascript:',
];

const RESTRICTED_URL_PARTS = [
  'chromewebstore.google.com',
  'chrome.google.com/webstore',
  'microsoftedge.microsoft.com/addons',
];

/**
 * Known page classes where Chrome forbids script injection.
 * Returns false when the URL is unknown — injection errors are mapped separately.
 */
export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (RESTRICTED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return RESTRICTED_URL_PARTS.some((p) => lower.includes(p));
}

/**
 * Tag of the page overlay host (closed shadow root). The analyzer and the stale watcher ignore it,
 * so showing the overlay never changes analysis results or marks a prediction stale.
 */
export const OVERLAY_TAG = 'heatgrid-overlay';
/** Tag of the small REC indicator host (same isolation rules as the overlay). */
export const REC_TAG = 'heatgrid-rec';

/** runtime.connect port name for recording continuity (content ↔ service worker, page boundaries only). */
export const RECORDING_PORT = 'hg-recording';
