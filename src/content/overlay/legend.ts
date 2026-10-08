/**
 * Floating legend: a compact visual key, always visible while the overlay is. One identity word
 * (so a screenshot of outlines cannot be mistaken for recorded data, or vice versa) and one glyph
 * per visual element. Text only via textContent.
 */
import { overlayTitle, type OverlayBandFilter, type PaintedBand } from './predicted';
import type { RecordedLayers } from '../recorded/types';

const LEGEND: Array<[PaintedBand, string]> = [
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
];

function key(doc: Document, cls: string, attr: Record<string, string>, text: string): HTMLElement {
  const k = doc.createElement('span');
  k.className = 'key';
  const g = doc.createElement('span');
  g.className = cls;
  Object.assign(g.dataset, attr);
  k.append(g, text);
  return k;
}

function frame(label: HTMLElement, kind: 'predicted' | 'recorded', title: string, keys: HTMLElement[]): void {
  const doc = label.ownerDocument;
  const head = doc.createElement('span');
  head.className = 'id';
  const mark = doc.createElement('span');
  mark.className = 'mark';
  const t = doc.createElement('span');
  t.className = 'title';
  t.textContent = title;
  head.append(mark, t);
  const legend = doc.createElement('span');
  legend.className = 'legend';
  legend.append(...keys);
  label.dataset.kind = kind;
  label.replaceChildren(head, legend);
}

function configureHost(label: HTMLElement, interactive: boolean): void {
  const root = label.getRootNode();
  if (!(root instanceof ShadowRoot)) return;
  const host = root.host as HTMLElement;
  host.style.setProperty('pointer-events', interactive ? 'auto' : 'none', 'important');
  if (interactive) host.removeAttribute('aria-hidden');
  else host.setAttribute('aria-hidden', 'true');
}

function closeButton(doc: Document, onClose: () => void): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'legend-filter legend-close';
  button.setAttribute('aria-label', 'Close visualization');
  button.addEventListener('click', onClose);
  return button;
}

export function renderLabel(label: HTMLElement, opts: { stale: boolean; showLow: boolean }): void {
  const doc = label.ownerDocument;
  const keys = LEGEND.filter(([band]) => band !== 'low' || opts.showLow).map(([band, text]) => key(doc, 'swatch', { band }, text));
  if (opts.stale) label.dataset.stale = '';
  else delete label.dataset.stale;
  frame(label, 'predicted', overlayTitle(opts.stale), keys);
}

export function renderPredictionFilter(
  label: HTMLElement,
  opts: { stale: boolean; filter: OverlayBandFilter; onFilter: (filter: OverlayBandFilter) => void; onClose?: () => void },
): void {
  configureHost(label, true);
  const doc = label.ownerDocument;
  const filters: OverlayBandFilter[] = ['all', 'high', 'medium', 'low'];
  const names: Record<OverlayBandFilter, string> = { all: 'All', high: 'High', medium: 'Medium', low: 'Low' };
  const keys = filters.map((filter) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'legend-filter';
    b.dataset.filter = filter;
    b.setAttribute('aria-pressed', String(opts.filter === filter));
    if (filter !== 'all') {
      const swatch = doc.createElement('span');
      swatch.className = 'swatch';
      swatch.dataset.band = filter;
      b.append(swatch);
    }
    b.append(names[filter]);
    b.addEventListener('click', () => opts.onFilter(filter));
    return b;
  });
  if (opts.onClose) keys.push(closeButton(doc, opts.onClose));
  if (opts.stale) label.dataset.stale = '';
  else delete label.dataset.stale;
  frame(label, 'predicted', overlayTitle(opts.stale), keys);
}

/** Recorded on-page control card: all layers stay visible as explicit toggles. */
export function renderRecordedLabel(
  label: HTMLElement,
  title: string,
  layers: RecordedLayers,
  onLayers?: (layers: RecordedLayers) => void,
  onClose?: () => void,
): void {
  configureHost(label, !!onLayers);
  const doc = label.ownerDocument;
  const choices: Array<{ id: keyof RecordedLayers; text: string; glyph: string }> = [
    { id: 'heatmap', text: 'Heatmap', glyph: 'heat' },
    { id: 'clicks', text: 'Clicks', glyph: 'click' },
    { id: 'scroll', text: 'Scroll depth', glyph: 'scroll' },
  ];
  const keys = choices.map(({ id, text, glyph }) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'legend-filter layer-toggle';
    b.dataset.layer = id;
    b.setAttribute('aria-pressed', String(layers[id]));
    const mark = doc.createElement('span');
    mark.className = 'glyph';
    mark.dataset.kind = glyph;
    b.append(mark, text);
    if (onLayers) b.addEventListener('click', () => onLayers({ ...layers, [id]: !layers[id] }));
    else b.disabled = true;
    return b;
  });
  if (onClose) keys.push(closeButton(doc, onClose));
  delete label.dataset.stale;
  frame(label, 'recorded', title, keys);
}

/** Recorded identity word (+ page position for multi-page sessions). Never mentions users, attention or AI. */
export function recordedTitle(position: number, pageCount: number): string {
  return pageCount > 1 ? `Recorded · ${position + 1}/${pageCount}` : 'Recorded';
}
