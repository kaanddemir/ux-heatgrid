/**
 * Overlay root: one fixed, zero-size host on <html> with a CLOSED shadow root.
 * - fixed + 0×0 + out of flow → no layout, no scroll extent, no reflow of page content
 * - highlight boxes never capture input; only the compact legend filter is interactive
 * - page CSS cannot reach inside the shadow root; inline !important styles protect the host
 * Only the host element itself is added to the page; no page element, class or style is touched.
 */
import { OVERLAY_TAG } from '../../shared/constants';

/** Predicted: electric-blue accent family. Recorded: warm heat ramp (canvas) — the two never share colours. */
// No :host rule: for !important declarations the shadow tree's styles beat the page's (inline
// included), so `:host { all: initial !important }` would reset the host's inline
// `position: fixed !important` and let the boxes scroll with the document.
//
// Each band keeps its own colour, fill and line language through background and selected states.
export const OVERLAY_CSS = `
/* Overlay tokens (shadow DOM, isolated from the host page) — mirror tokens.css: outlines use the
   panel's light-theme band colours (they sit on page content); the near-black dock its dark ones. */
.layer, .label {
  --hg-dock: rgba(13, 15, 19, 0.9); --hg-dock-edge: rgba(255, 255, 255, 0.12);
  --hg-dock-text: rgba(255, 255, 255, 0.9); --hg-dock-muted: rgba(255, 255, 255, 0.7);
  --hg-focus: #6fa0ff; --hg-pred: #397bfa;
  --hg-high: #5b93ff; --hg-medium: #3cc4b0; --hg-low: #dca85c;
  --hg-motion-fast: 120ms; --hg-ease: cubic-bezier(0.2, 0, 0, 1);
}
.layer, .layer * { pointer-events: none !important; box-sizing: border-box; }
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.box {
  position: absolute; left: 0; top: 0; border-radius: 6px; will-change: transform;
  color: var(--band); border-color: var(--band); background: var(--band-fill);
  box-shadow: 0 0 0 1px var(--band-contrast), 0 0 0 3px var(--band-halo);
}
.box[data-band="high"] {
  --band: #2a6ae6; --band-fill: rgba(57, 123, 250, 0.14); --band-halo: rgba(57, 123, 250, 0.18); --band-contrast: rgba(255, 255, 255, 0.6);
  border: 2px solid var(--band);
}
.box[data-band="medium"] {
  --band: #0b8475; --band-fill: rgba(11, 132, 117, 0.08); --band-halo: rgba(11, 132, 117, 0.12); --band-contrast: rgba(255, 255, 255, 0.42);
  border: 1.5px dashed var(--band);
}
.box[data-band="low"] {
  --band: #c07d22; --band-fill: rgba(192, 125, 34, 0.06); --band-halo: rgba(192, 125, 34, 0.09); --band-contrast: rgba(255, 255, 255, 0.32);
  border: 1.5px dotted var(--band);
}
.layer[data-focus] .box:not([data-selected]) { opacity: 0.20; }
.box[data-selected] {
  border-width: 3px; background: color-mix(in srgb, var(--band) 17%, transparent); z-index: 1;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.92), 0 0 0 6px color-mix(in srgb, var(--band) 34%, transparent), 0 8px 24px rgba(0, 0, 0, 0.24);
}

/* Dock: one floating HeatGrid control, bottom-right — the same family as the side panel (8px radius,
   system type, neutral glass, accent only on the identity mark). Identity word · controls · close. */
.label {
  position: fixed; right: 14px; bottom: 14px; max-width: calc(100vw - 28px);
  display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 8px;
  background: var(--hg-dock); color: var(--hg-dock-text);
  border: 1px solid var(--hg-dock-edge);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22), 0 1px 2px rgba(0, 0, 0, 0.24);
  -webkit-backdrop-filter: saturate(1.6) blur(12px); backdrop-filter: saturate(1.6) blur(12px);
  font: 500 11.5px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: 0.005em;
  -webkit-font-smoothing: antialiased;
}
.label[data-kind="predicted"], .label[data-kind="predicted"] *,
.label[data-kind="recorded"], .label[data-kind="recorded"] * { pointer-events: auto !important; }
.id {
  display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0; padding: 0 10px 0 8px; margin-right: 2px;
  border-right: 1px solid var(--hg-dock-edge); font-weight: 650; color: #fff; white-space: nowrap;
}
.mark { width: 8px; height: 8px; border-radius: 2.5px; flex-shrink: 0; }
.label[data-kind="predicted"] .mark { background: var(--hg-pred); }
.label[data-stale] .title { color: rgba(255, 255, 255, 0.62); }
.label[data-stale] .mark { background: transparent; box-shadow: inset 0 0 0 1.5px var(--hg-pred); }
.legend { display: flex; align-items: center; gap: 2px; min-width: 0; }
.key { display: inline-flex; align-items: center; gap: 5px; padding: 0 6px; white-space: nowrap; }
.swatch { display: inline-block; width: 12px; height: 9px; border-radius: 3px; }
.swatch[data-band="high"] { border: 1.5px solid var(--hg-high); background: color-mix(in srgb, var(--hg-high) 36%, transparent); }
.swatch[data-band="medium"] { border: 1.5px dashed var(--hg-medium); background: color-mix(in srgb, var(--hg-medium) 18%, transparent); }
.swatch[data-band="low"] { border: 1.5px dotted var(--hg-low); background: color-mix(in srgb, var(--hg-low) 16%, transparent); }
.legend-filter {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 30px; padding: 0 9px; border: 0; border-radius: 6px;
  background: transparent; color: var(--hg-dock-muted); cursor: pointer;
  font: 600 11.5px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  transition: background-color var(--hg-motion-fast) var(--hg-ease), color var(--hg-motion-fast) var(--hg-ease);
}
.legend-filter:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
.legend-filter[aria-pressed="true"] { color: #fff; background: rgba(255, 255, 255, 0.14); }
.legend-filter:focus-visible { outline: 2px solid var(--hg-focus); outline-offset: 1px; }
.legend-close {
  position: relative; width: 30px; min-width: 30px; padding: 0; margin-left: 2px;
  color: var(--hg-dock-muted);
}
.legend-close::before, .legend-close::after {
  content: ""; position: absolute; left: 50%; top: 50%; width: 11px; height: 1.5px;
  border-radius: 999px; background: currentColor; transform-origin: center;
}
.legend-close::before { transform: translate(-50%, -50%) rotate(45deg); }
.legend-close::after { transform: translate(-50%, -50%) rotate(-45deg); }
.legend-close:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
.layer-toggle:hover:not(:disabled) { color: #fff; }
.layer-toggle[aria-pressed="false"] { color: rgba(255, 255, 255, 0.5); }
.layer-toggle[aria-pressed="false"] .glyph { opacity: 0.4; filter: grayscale(0.6); }
.layer-toggle:disabled { cursor: default; }
@media (max-width: 520px) { .id { display: none; } }
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
@media (prefers-reduced-motion: reduce) {
  .layer, .label { --hg-motion-fast: 1ms; }
}
`;

/** Recorded Interaction: warm heat canvases and legend glyphs (never the Predicted blue). */
export const RECORDED_CSS = `
.canvas { position: fixed; left: 0; top: 0; display: block; }
.label[data-kind="recorded"] .mark { background: linear-gradient(135deg, rgb(222, 73, 104), rgb(252, 211, 77)); }
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
