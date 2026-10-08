/**
 * Overlay root: one fixed, zero-size host on <html> with a CLOSED shadow root.
 * - fixed + 0×0 + out of flow → no layout, no scroll extent, no reflow of page content
 * - highlight boxes never capture input; only the compact legend filter is interactive
 * - page CSS cannot reach inside the shadow root; inline !important styles protect the host
 * Only the host element itself is added to the page; no page element, class or style is touched.
 */
import { OVERLAY_TAG } from '../../shared/constants';

/** Predicted: cool indigo accent family. Recorded: warm heat ramp (canvas) — the two never share colours. */
// No :host rule: for !important declarations the shadow tree's styles beat the page's (inline
// included), so `:host { all: initial !important }` would reset the host's inline
// `position: fixed !important` and let the boxes scroll with the document.
//
// Each band keeps its own colour, fill and line language through background and selected states.
export const OVERLAY_CSS = `
.layer, .layer * { pointer-events: none !important; box-sizing: border-box; }
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.box {
  position: absolute; left: 0; top: 0; border-radius: 6px; will-change: transform;
  color: var(--band); border-color: var(--band); background: var(--band-fill);
  box-shadow: 0 0 0 1px var(--band-contrast), 0 0 0 3px var(--band-halo);
  transition: opacity 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
}
.box[data-band="high"] {
  --band: #655cf2; --band-fill: rgba(91, 84, 234, 0.14); --band-halo: rgba(91, 84, 234, 0.16); --band-contrast: rgba(255, 255, 255, 0.52);
  border: 2px solid var(--band);
}
.box[data-band="medium"] {
  --band: #3c91c7; --band-fill: rgba(60, 145, 199, 0.075); --band-halo: rgba(60, 145, 199, 0.10); --band-contrast: rgba(255, 255, 255, 0.38);
  border: 1.5px dashed var(--band);
}
.box[data-band="low"] {
  --band: #c28a3a; --band-fill: rgba(194, 138, 58, 0.055); --band-halo: rgba(194, 138, 58, 0.08); --band-contrast: rgba(255, 255, 255, 0.30);
  border: 1.5px dotted var(--band);
}
.layer[data-focus] .box:not([data-selected]) { opacity: 0.20; }
.box[data-selected] {
  border-width: 3px; background: color-mix(in srgb, var(--band) 17%, transparent); z-index: 1;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.92), 0 0 0 6px color-mix(in srgb, var(--band) 34%, transparent), 0 8px 24px rgba(0, 0, 0, 0.24);
}

/* Legend: a small glass key, bottom-right. It explains only the visible marks; overlay state and
   page/session status live in the side panel rather than competing with the key. */
.label {
  position: fixed; right: 14px; bottom: 14px; max-width: calc(100vw - 28px);
  display: flex; align-items: center; padding: 5px; border-radius: 10px;
  background: rgba(16, 17, 24, 0.78); color: rgba(255, 255, 255, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18), 0 1px 2px rgba(0, 0, 0, 0.20);
  -webkit-backdrop-filter: saturate(1.6) blur(12px); backdrop-filter: saturate(1.6) blur(12px);
  font: 500 11px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0.01em;
  -webkit-font-smoothing: antialiased;
}
.label[data-kind="predicted"], .label[data-kind="predicted"] *,
.label[data-kind="recorded"], .label[data-kind="recorded"] * { pointer-events: auto !important; }
.id { display: none; }
.mark { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.label[data-kind="predicted"] .mark { background: #8b8cff; box-shadow: 0 0 0 3px rgba(139, 140, 255, 0.22); }
.label[data-stale] .title { color: rgba(255, 255, 255, 0.62); }
.label[data-stale] .mark { background: transparent; box-shadow: inset 0 0 0 1.5px #8b8cff; }
.legend { display: flex; align-items: center; gap: 3px; min-width: 0; }
.key { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.swatch { display: inline-block; width: 12px; height: 9px; border-radius: 3px; }
.swatch[data-band="high"] { border: 1.5px solid #8f88ff; background: rgba(101, 92, 242, 0.34); }
.swatch[data-band="medium"] { border: 1.5px dashed #65b6e8; background: rgba(60, 145, 199, 0.16); }
.swatch[data-band="low"] { border: 1.5px dotted #d9a85e; background: rgba(194, 138, 58, 0.14); }
.legend-filter {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 30px; padding: 0 9px; border: 0; border-radius: 7px;
  background: transparent; color: rgba(255, 255, 255, 0.70); cursor: pointer;
  font: 600 11px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.legend-filter:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
.legend-filter[aria-pressed="true"] { color: #fff; background: rgba(255, 255, 255, 0.14); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.legend-filter:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.legend-close {
  position: relative; width: 30px; min-width: 30px; padding: 0; margin-left: 2px;
  color: rgba(255, 255, 255, 0.62);
  border-left: 1px solid rgba(255, 255, 255, 0.10);
}
.legend-close::before, .legend-close::after {
  content: ""; position: absolute; left: 50%; top: 50%; width: 12px; height: 1.5px;
  border-radius: 999px; background: currentColor; transform-origin: center;
}
.legend-close::before { transform: translate(-50%, -50%) rotate(45deg); }
.legend-close::after { transform: translate(-50%, -50%) rotate(-45deg); }
.legend-close:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
.layer-toggle {
  gap: 6px;
}
.layer-toggle:hover:not(:disabled) { color: #fff; }
.layer-toggle[aria-pressed="false"] .glyph { opacity: 0.48; filter: grayscale(0.5); }
.layer-toggle:disabled { cursor: default; }
@media (max-width: 420px) {
  .label { right: 8px; bottom: 8px; max-width: calc(100vw - 16px); }
  .legend { flex-wrap: wrap; justify-content: flex-end; }
  .legend-filter { min-height: 30px; padding: 0 7px; }
  .legend-filter .swatch { width: 10px; }
}
@media (max-width: 340px) {
  .label[data-kind="recorded"] { width: min(216px, calc(100vw - 16px)); }
  .label[data-kind="recorded"] .legend { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
  .label[data-kind="recorded"] .layer-toggle[data-layer="scroll"] { grid-column: 1 / -1; }
  .label[data-kind="recorded"] .legend-close { grid-column: 2; justify-self: end; }
}
@media (prefers-reduced-motion: reduce) { .box { transition: none; } }
`;

/** Recorded Interaction: warm heat canvases and legend glyphs (never the Predicted indigo). */
export const RECORDED_CSS = `
.canvas { position: fixed; left: 0; top: 0; display: block; }
.label[data-kind="recorded"] .mark { background: linear-gradient(135deg, rgb(222, 73, 104), rgb(252, 211, 77)); box-shadow: 0 0 0 3px rgba(254, 159, 109, 0.22); }
.glyph { display: inline-block; flex-shrink: 0; }
.glyph[data-kind="heat"] { width: 11px; height: 11px; border-radius: 50%; background: radial-gradient(circle, rgb(252, 211, 77) 0 22%, rgb(254, 159, 109) 42%, rgba(222, 73, 104, 0.85) 62%, rgba(140, 41, 129, 0) 100%); }
.glyph[data-kind="click"] { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid #ffffff; background: radial-gradient(circle, #ffffff 0 1.6px, transparent 2.1px); }
.glyph[data-kind="scroll"] { width: 13px; height: 0; border-top: 1.5px dashed rgba(255, 255, 255, 0.9); }
`;

const HOST_STYLE = [
  'all: initial',
  'position: fixed',
  'top: 0',
  'left: 0',
  'width: 0',
  'height: 0',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'overflow: visible',
  'display: block',
  'z-index: 2147483647',
  /* Prediction enables the zero-size host after adding filter buttons; Recorded stays click-through. */
  'pointer-events: none',
].map((d) => `${d} !important`).join('; ');

export interface OverlayRoot {
  host: HTMLElement;
  layer: HTMLElement;
  label: HTMLElement;
  /** Removes the host from the page. Idempotent. */
  remove(): void;
}

/** Removes overlay hosts left behind by a runtime whose extension context was invalidated. */
export function removeOrphanHosts(doc: Document): number {
  const stale = doc.querySelectorAll(OVERLAY_TAG);
  stale.forEach((n) => n.remove());
  return stale.length;
}

export function createOverlayRoot(doc: Document): OverlayRoot {
  removeOrphanHosts(doc);
  const host = doc.createElement(OVERLAY_TAG);
  host.setAttribute('style', HOST_STYLE);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS + RECORDED_CSS;
  const layer = doc.createElement('div');
  layer.className = 'layer';
  const label = doc.createElement('div');
  label.className = 'label';
  layer.append(label);
  shadow.append(style, layer);
  doc.documentElement.append(host);
  return {
    host,
    layer,
    label,
    remove: () => host.remove(),
  };
}
