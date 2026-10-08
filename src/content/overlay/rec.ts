/**
 * Minimal page REC indicator while recording: a small static chip in a corner. Closed shadow root,
 * fixed, zero-size host, pointer-events none, aria-hidden, no animation. Ignored by the analyzer,
 * the stale watcher and the recorder's page-change detection.
 */
import { REC_TAG } from '../../shared/constants';

const HOST_STYLE = ['all: initial', 'position: fixed', 'top: 0', 'left: 0', 'width: 0', 'height: 0', 'overflow: visible', 'display: block', 'z-index: 2147483647', 'pointer-events: none']
  .map((d) => `${d} !important`)
  .join('; ');

const CSS = `
.rec { position: fixed; left: 12px; bottom: 12px; pointer-events: none; display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; border-radius: 6px; background: rgba(15, 17, 32, 0.88); color: #fff; border: 1px solid rgba(255,255,255,0.28);
  font: 600 11px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0.04em; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
`;

export function createRecIndicator(doc: Document = document): { remove(): void } {
  doc.querySelectorAll(REC_TAG).forEach((n) => n.remove());
  const host = doc.createElement(REC_TAG);
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('style', HOST_STYLE);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  const chip = doc.createElement('div');
  chip.className = 'rec';
  const dot = doc.createElement('span');
  dot.className = 'dot';
  chip.append(dot, 'REC');
  shadow.append(style, chip);
  doc.documentElement.append(host);
  return { remove: () => host.remove() };
}
