/**
 * Predict tab. Cool indigo language (outline bands), never heat. Bands only — raw
 * scores never leave the runtime. Summary (band strip, which doubles as the filter) · controls ·
 * inspector rows · footer.
 */
import type { PredictionCounts, PredictionSnapshot, TabSnapshot } from '../../shared/model';
import type { PredictionElementDetails, PredictionSummaryElement, PredictionSummaryResult } from '../../content/prediction/types';
import { el } from '../shared/render';
import { icon } from '../shared/icons';
import { BAND_COPY, CAVEAT_COPY, PREDICTED_EMPTY, confidenceQualifier, reasonText } from '../shared/predictionCopy';
import { KIND_COPY, LISTED_BANDS, groupByBand, matchesKind, predictedViewState, rowModel, type Filter, type KindFilter } from './viewModel';
import { button, check, detailPart, emptyState, filterGroup, filterPopover, footer, loadingState, notice, section } from './ui';

export interface PredictedModel {
  snap: TabSnapshot | null;
  result: PredictionSummaryResult | null;
  filter: Filter;
  /** Item-type filter (Nav, Links, Buttons…). */
  kind?: KindFilter;
  selectedId: number | null;
  details: PredictionElementDetails | null;
  focusNote: string | null;
  busy: boolean;
  canRun: boolean;
  filterOpen?: boolean;
  /** Collapsed band sections (ids: `pred-high` …). */
  collapsed?: ReadonlySet<string>;
}

export interface PredictedHandlers {
  onRun(): void;
  onClear(): void;
  onShowOverlay(on: boolean): void;
  onFilter(f: Filter): void;
  onKind?(k: KindFilter): void;
  onToggleFilters?(open: boolean): void;
  onResetFilters?(): void;
  onSelect(id: number): void;
  onShowOnPage(id: number): void;
  onClearHighlight(): void;
  onToggleSection?(id: string): void;
}

/** Progressive disclosure step per result band. */
export const BAND_ROWS = 5;

/** Screen-head actions once there is a result: Re-run · Show on page (overlay toggle). */
export function predictedHeadAction(m: PredictedModel, h: PredictedHandlers): HTMLElement | null {
  const v = predictedViewState(m.snap?.prediction as PredictionSnapshot | undefined);
  if (v.kind !== 'ready' && v.kind !== 'stale') return null;
  const show = check('Show on page', m.snap?.interactionView === 'predicted', !m.busy, h.onShowOverlay, 'overlay', 'eye');
  show.title = 'Show on page'; // the label is visually hidden on very narrow panels
  return el(
    'div',
    { class: 'head-group' },
    v.kind === 'ready' ? button('Re-run', h.onRun, m.canRun && !m.busy, { key: 'predict-rerun', subtle: true, icon: 'refresh', label: 'Re-run prediction' }) : null,
    show,
  );
}

/** Immediate Predicted status, rendered once before the screen title. */
export function predictedNotices(m: PredictedModel, h: PredictedHandlers): HTMLElement[] {
  const v = predictedViewState(m.snap?.prediction as PredictionSnapshot | undefined);
  return [
    v.kind === 'stale' ? notice(v.notice, { action: button('Run again', h.onRun, m.canRun && !m.busy, { key: 'predict-again', subtle: true }) }) : null,
    m.focusNote ? notice(m.focusNote, { tone: 'info' }) : null,
  ].filter((n): n is HTMLElement => !!n);
}

export function predictedBody(m: PredictedModel, h: PredictedHandlers, bandLimits: ReadonlyMap<string, number>, onMore: (band: string) => void): DocumentFragment | HTMLElement {
  const v = predictedViewState(m.snap?.prediction as PredictionSnapshot | undefined);
  switch (v.kind) {
    case 'empty':
      return emptyState(PREDICTED_EMPTY.title, PREDICTED_EMPTY.body, button(PREDICTED_EMPTY.action, h.onRun, m.canRun && !m.busy, { primary: true, key: 'predict-empty', icon: 'predict' }), 'predict');
    case 'analyzing':
      return loadingState('Analysing page…', 'predict');
    case 'error':
      return emptyState('Prediction failed', 'Try again on this page.', button('Try again', h.onRun, m.canRun && !m.busy, { primary: true, key: 'predict-retry', icon: 'refresh' }), 'warn');
    default:
      break;
  }
  const r = m.result;
  const frag = document.createDocumentFragment();
  frag.append(
    ...[
      r ? distribution(r.summary) : el('p', { class: 'meta', text: 'Loading…' }),
      r ? listBlock(r, m, h, bandLimits, onMore) : null,
      footer(
        button('Reset prediction', h.onClear, !m.busy, { key: 'clear', danger: true, icon: 'trash' }),
      ),
    ].filter((n): n is HTMLElement => !!n),
  );
  return frag;
}

/** Band strip: proportional bar + counts (summary only — filtering lives in the filter bar). */
export function distribution(s: Pick<PredictionCounts, 'high' | 'medium' | 'low'>): HTMLElement {
  const total = Math.max(1, s.high + s.medium + s.low);
  return el(
    'div',
    { class: 'dist summary-metrics', attrs: { role: 'img', 'aria-label': `${s.high} High, ${s.medium} Medium, ${s.low} Low` } },
    el('div', { class: 'dist-bar', attrs: { 'aria-hidden': 'true' } }, ...LISTED_BANDS.map((b) => el('span', { class: 'dist-seg', attrs: { 'data-band': b, style: `flex-grow:${s[b] / total}` } }))),
    el('div', { class: 'dist-legend' }, ...LISTED_BANDS.map((b) => el('span', { class: s[b] ? 'dist-stat' : 'dist-stat is-zero', attrs: { 'data-band': b } }, el('span', { class: 'dist-n', text: String(s[b]) }), el('span', { class: 'dist-l', text: BAND_COPY[b] })))),
  );
}

/** Filter popover: item type only. Bands remain visible as result groups and in the summary. */
export function predictedFilters(r: PredictionSummaryResult, m: PredictedModel, h: PredictedHandlers): HTMLElement | null {
  const kind = m.kind ?? 'all';
  const listed = r.elements.filter((e) => e.band !== 'not-assessed');
  const kinds = (Object.keys(KIND_COPY) as Array<Exclude<KindFilter, 'all'>>).map((k) => ({ id: k as KindFilter, text: KIND_COPY[k], count: listed.filter((e) => matchesKind(r, e, k)).length }));
  return filterPopover(
    'Filter predictions',
    Number(kind !== 'all'),
    !!m.filterOpen,
    h.onToggleFilters,
    h.onResetFilters,
    h.onKind ? filterGroup<KindFilter>('Type', [{ id: 'all', text: 'All types' }, ...kinds], kind, h.onKind, !m.busy, 'kind', { keep: (Object.keys(KIND_COPY) as Array<Exclude<KindFilter, 'all'>>).filter((k) => listed.some((e) => matchesKind(r, e, k))).length >= 2 }) : null,
  );
}

function listBlock(r: PredictionSummaryResult, m: PredictedModel, h: PredictedHandlers, limits: ReadonlyMap<string, number>, onMore: (band: string) => void): HTMLElement {
  return el(
    'div',
    { class: 'sections' },
    // Empty bands add no scanning value; the distribution above already communicates zero counts.
    ...groupByBand(r, 'all', m.kind ?? 'all').filter(({ items }) => items.length).map(({ band, items }) => {
      const shown = items.slice(0, limits.get(band) ?? BAND_ROWS);
      return section(
        BAND_COPY[band],
        { count: items.length, band, collapse: collapse(`pred-${band}`, m, h) },
        el('ul', { class: 'list' }, ...shown.map((e) => rowItem(r, e, m, h))),
        items.length > shown.length ? button('Show 5 more', () => onMore(band), true, { key: `more-${band}`, subtle: true }) : null,
      );
    }),
  );
}

function collapse(id: string, m: PredictedModel, h: PredictedHandlers) {
  return h.onToggleSection ? { id, collapsed: !!m.collapsed?.has(id), onToggle: () => h.onToggleSection!(id) } : undefined;
}

function rowItem(r: PredictionSummaryResult, e: PredictionSummaryElement, m: PredictedModel, h: PredictedHandlers): HTMLElement {
  const selected = e.id === m.selectedId;
  const rm = rowModel(r, e);
  const detailId = `detail-${e.id}`;
  // Full-row toggle underneath; the visible content sits on top (pointer-transparent), so the
  // small action can be a real button without nesting buttons.
  const toggle = el('button', {
    class: 'item item-toggle',
    attrs: { type: 'button', 'aria-expanded': String(selected), 'aria-controls': detailId, 'aria-label': `${rm.label} · ${BAND_COPY[e.band]}${rm.meta ? ` · ${rm.meta}` : ''}` },
    on: { click: () => h.onSelect(e.id) },
  });
  toggle.dataset.key = `row-${e.id}`;
  if (selected) toggle.dataset.selected = '';
  const highlighted = m.snap?.overlay.focusedElementId === e.id;
  const show = selected
    ? el('button', {
        class: highlighted ? 'icon-btn is-on' : 'icon-btn',
        attrs: { type: 'button', title: highlighted ? 'Clear highlight' : 'Show on page', 'aria-label': highlighted ? 'Clear highlight' : 'Show on page', 'aria-pressed': String(highlighted) },
        on: { click: () => (highlighted ? h.onClearHighlight() : h.onShowOnPage(e.id)) },
      }, icon('eye'))
    : null;
  if (show) {
    (show as HTMLButtonElement).disabled = m.busy;
    show.dataset.key = highlighted ? `hl-${e.id}` : `show-${e.id}`;
  }
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'item-row', attrs: selected ? { 'data-selected': '' } : {} },
      toggle,
      el('span', { class: 'item-main', attrs: { 'aria-hidden': 'true' } }, el('span', { class: 'item-title' }, el('span', { class: 'item-label', text: rm.label }), statusIcon(e, h)), el('span', { class: 'item-meta', text: rm.meta })),
      show,
      icon('chevron', 'icon chev'),
    ),
    selected ? detailBlock(e, detailId, m) : null,
  );
}

/** One quiet icon when confidence is below high or a caveat applies; the tooltip says which. */
function statusIcon(e: PredictionSummaryElement, h: PredictedHandlers): HTMLElement | null {
  const q = confidenceQualifier(e.confidence);
  const notes = [q, ...e.caveats.map((c) => CAVEAT_COPY[c])].filter((t): t is string => !!t);
  if (!notes.length) return null;
  return el('span', { class: q ? 'status-icon is-warn' : 'status-icon', attrs: { title: notes.join('\n') }, on: { click: () => h.onSelect(e.id) } }, icon('info'));
}

function detailBlock(e: PredictionSummaryElement, id: string, m: PredictedModel): HTMLElement {
  const d = m.details && m.details.element.id === e.id ? m.details : null;
  const raises = d?.reasons.filter((x) => x.polarity === 'raises') ?? [];
  const lowers = d?.reasons.filter((x) => x.polarity !== 'raises') ?? [];
  const reasonList = (items: typeof raises, dir: 'raises' | 'lowers'): HTMLElement[] =>
    items.map((x) => el('li', { attrs: { 'data-dir': dir } }, el('span', { class: 'sr-only', text: dir === 'raises' ? 'Raises: ' : 'Lowers: ' }), icon(dir === 'raises' ? 'up' : 'down', 'icon dir'), el('span', { text: reasonText(x.code, d?.facts) })));
  const qualifier = confidenceQualifier(e.confidence);
  return el(
    'div',
    { class: 'detail', attrs: { id, role: 'region', 'aria-label': `Why this prediction: ${e.label ?? e.tagName}` } },
    !d
      ? el('p', { class: 'meta', text: 'Loading…' })
      : el(
          'div',
          { class: 'detail-parts' },
          detailPart('Why', raises.length || lowers.length ? el('ul', { class: 'reasons' }, ...reasonList(raises, 'raises'), ...reasonList(lowers, 'lowers')) : el('p', { class: 'meta', text: 'Typical for this page.' })),
          qualifier || d.element.caveats.length ? detailPart('Caveats', el('ul', { class: 'reasons caveats' }, ...[qualifier, ...d.element.caveats.map((c) => CAVEAT_COPY[c])].filter((t): t is string => !!t).map((t) => el('li', { text: t })))) : null,
        ),
  );
}
