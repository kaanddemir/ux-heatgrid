/**
 * Predict mode of the inspector. Electric-blue accent, never heat. Bands only — raw scores never leave
 * the runtime, and High / Medium / Low are relative structural assessments of this page, not
 * probabilities. Layout is the shared inspector frame (see ui.ts).
 */
import type { PredictionCounts, PredictionSnapshot, TabSnapshot } from '../../shared/model';
import type { PredictionElementDetails, PredictionSummaryElement, PredictionSummaryResult } from '../../content/prediction/types';
import { el } from '../shared/render';
import { icon } from '../shared/icons';
import { BAND_COPY, CAVEAT_COPY, PREDICTED_EMPTY, confidenceQualifier, reasonText } from '../shared/predictionCopy';
import { meaningfulRegion } from '../shared/regionLabel';
import { KIND_COPY, LISTED_BANDS, groupByBand, matchesKind, predictedViewState, rowModel, type Filter, type KindFilter } from './viewModel';
import { actions, button, detail, detailPart, emptyState, filterGroup, filterPopover, footer, group, inspectorRow, loadingState, more, statGrid, summary, toggle, type NoticeIssue } from './ui';

export interface PredictedModel {
  snap: TabSnapshot | null;
  result: PredictionSummaryResult | null;
  /** Band filter. */
  filter: Filter;
  /** Item-type filter (Nav, Links, Buttons…). */
  kind?: KindFilter;
  selectedId: number | null;
  details: PredictionElementDetails | null;
  focusNote: string | null;
  busy: boolean;
  canRun: boolean;
  filterOpen?: boolean;
  /** Collapsed band groups (ids: `pred-high` …). */
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

const hasResult = (m: PredictedModel): boolean => {
  const k = predictedViewState(m.snap?.prediction as PredictionSnapshot | undefined).kind;
  return k === 'ready' || k === 'stale';
};

/** Head actions once there is a result: Re-run · Show on page · Filter (same slots as Record). */
export function predictedHeadAction(m: PredictedModel, h: PredictedHandlers): HTMLElement | null {
  if (!hasResult(m)) return null;
  return actions(
    toggle('Show on page', m.snap?.interactionView === 'predicted', !m.busy, h.onShowOverlay, 'overlay', 'eye'),
    m.result ? predictedFilters(m.result, m, h) : null,
  );
}

/** Immediate Predict status, rendered once before the inspector head. */
export function predictedWarnings(m: PredictedModel, h: PredictedHandlers): NoticeIssue[] {
  const v = predictedViewState(m.snap?.prediction as PredictionSnapshot | undefined);
  const issues: Array<NoticeIssue | null> = [
    v.kind === 'stale' ? { id: 'prediction-stale', severity: 'action' as const, message: v.notice, detail: 'This prediction may no longer match the page.', action: button('Run again', h.onRun, m.canRun && !m.busy, { key: 'predict-again', subtle: true }) } : null,
    v.kind === 'error' ? { id: 'prediction-failed', severity: 'critical' as const, message: v.message } : null,
    m.focusNote ? { id: 'prediction-focus', severity: 'info' as const, message: m.focusNote } : null,
  ];
  return issues.filter((issue): issue is NoticeIssue => !!issue);
}

export function predictedBody(m: PredictedModel, h: PredictedHandlers, bandLimits: ReadonlyMap<string, number>, onMore: (band: string) => void): DocumentFragment | HTMLElement {
  const v = predictedViewState(m.snap?.prediction as PredictionSnapshot | undefined);
  switch (v.kind) {
    case 'empty':
      return emptyState(PREDICTED_EMPTY.title, PREDICTED_EMPTY.body, button(PREDICTED_EMPTY.action, h.onRun, m.canRun && !m.busy, { primary: true, key: 'predict-empty', icon: 'predict' }), 'predict');
    case 'analyzing':
      return loadingState('Analysing page structure…');
    case 'error':
      return emptyState('Prediction failed', 'Try again on this page.', button('Try again', h.onRun, m.canRun && !m.busy, { primary: true, key: 'predict-retry', icon: 'refresh' }), 'warn', 'warn');
    default:
      break;
  }
  const r = m.result;
  if (!r) return loadingState('Loading results…');
  // When stale, the notice above carries "Run again"; one re-run affordance at a time.
  const stale = v.kind === 'stale';
  const frag = document.createDocumentFragment();
  frag.append(predictionSummary(r.summary), resultGroups(r, m, h, bandLimits, onMore), footer(el('span'), actions(button('Reset prediction', h.onClear, !m.busy, { key: 'clear', danger: true, icon: 'trash' }), stale ? null : button('Re-run prediction', h.onRun, m.canRun && !m.busy, { key: 'predict-rerun', icon: 'refresh' }))));
  return frag;
}

/** Band bar: proportions at a glance; the cells below carry the numbers. */
function bandBar(s: Pick<PredictionCounts, 'high' | 'medium' | 'low'>): HTMLElement {
  const total = Math.max(1, s.high + s.medium + s.low);
  return el('div', { class: 'band-bar', attrs: { 'aria-hidden': 'true' } }, ...LISTED_BANDS.map((b) => el('span', { attrs: { 'data-band': b, style: `flex-grow:${s[b] / total}` } })));
}

/** Predict summary: band bar · High / Medium / Low. Shared with Overview. */
export function predictionSummary(s: Pick<PredictionCounts, 'high' | 'medium' | 'low'>): HTMLElement {
  return summary(
    'Prediction summary',
    LISTED_BANDS.map((b) => ({ label: BAND_COPY[b], value: String(s[b]), quiet: !s[b], band: b })),
    { bar: bandBar(s), key: 'pred-summary' },
  );
}

/** Filter popover: Band · Type. */
export function predictedFilters(r: PredictionSummaryResult, m: PredictedModel, h: PredictedHandlers): HTMLElement | null {
  const kind = m.kind ?? 'all';
  const listed = r.elements.filter((e) => e.band !== 'not-assessed' && matchesKind(r, e, kind));
  const typed = r.elements.filter((e) => e.band !== 'not-assessed' && (m.filter === 'all' || e.band === m.filter));
  const kinds = (Object.keys(KIND_COPY) as Array<Exclude<KindFilter, 'all'>>).map((k) => ({ id: k as KindFilter, text: KIND_COPY[k], count: typed.filter((e) => matchesKind(r, e, k)).length }));
  return filterPopover(
    'Filter predictions',
    Number(m.filter !== 'all') + Number(kind !== 'all'),
    !!m.filterOpen,
    h.onToggleFilters,
    h.onResetFilters,
    filterGroup<Filter>('Band', [{ id: 'all', text: 'All' }, ...LISTED_BANDS.map((b) => ({ id: b as Filter, text: BAND_COPY[b], count: listed.filter((e) => e.band === b).length }))], m.filter, h.onFilter, !m.busy, 'band'),
    h.onKind ? filterGroup<KindFilter>('Type', [{ id: 'all', text: 'All' }, ...kinds], kind, h.onKind, !m.busy, 'kind', { keep: kinds.filter((k) => k.count > 0).length >= 2 }) : null,
  );
}

function resultGroups(r: PredictionSummaryResult, m: PredictedModel, h: PredictedHandlers, limits: ReadonlyMap<string, number>, onMore: (band: string) => void): HTMLElement {
  const groups = groupByBand(r, m.filter, m.kind ?? 'all').filter(({ items }) => items.length);
  return el(
    'div',
    { class: 'groups' },
    ...(groups.length
      ? groups.map(({ band, items }) => {
          const shown = items.slice(0, limits.get(band) ?? BAND_ROWS);
          return group(
            BAND_COPY[band],
            { count: items.length, band, collapse: h.onToggleSection ? { id: `pred-${band}`, collapsed: !!m.collapsed?.has(`pred-${band}`), onToggle: () => h.onToggleSection!(`pred-${band}`) } : undefined },
            el('ul', { class: 'rows' }, ...shown.map((e) => resultRow(r, e, m, h))),
            items.length > shown.length ? more(() => onMore(band), `more-${band}`) : null,
          );
        })
      : [el('p', { class: 'no-match', text: 'No elements match these filters.' })]),
  );
}

function resultRow(r: PredictionSummaryResult, e: PredictionSummaryElement, m: PredictedModel, h: PredictedHandlers): HTMLElement {
  const selected = e.id === m.selectedId;
  const rm = rowModel(r, e);
  const highlighted = m.snap?.overlay.focusedElementId === e.id;
  return inspectorRow({
    id: String(e.id),
    key: `row-${e.id}`,
    label: rm.label,
    meta: rm.meta,
    aria: `${rm.label} · ${BAND_COPY[e.band]}${rm.meta ? ` · ${rm.meta}` : ''}`,
    selected,
    onToggle: () => h.onSelect(e.id),
    status: statusMark(e),
    eye: selected ? { on: highlighted, enabled: !m.busy, key: highlighted ? `hl-${e.id}` : `show-${e.id}`, onClick: () => (highlighted ? h.onClearHighlight() : h.onShowOnPage(e.id)) } : null,
    detail: selected ? resultDetail(r, e, m) : null,
  });
}

/** One quiet mark when confidence is below high or a caveat applies; the tooltip says which. */
function statusMark(e: PredictionSummaryElement): HTMLElement | null {
  const q = confidenceQualifier(e.confidence);
  const notes = [q, ...e.caveats.map((c) => CAVEAT_COPY[c])].filter((t): t is string => !!t);
  if (!notes.length) return null;
  return el('span', { class: q ? 'status is-warn' : 'status', attrs: { title: notes.join('\n') } }, icon('info'));
}

const CONFIDENCE_COPY = { high: 'High', medium: 'Medium', low: 'Low' } as const;

function resultDetail(r: PredictionSummaryResult, e: PredictionSummaryElement, m: PredictedModel): HTMLElement {
  const d = m.details && m.details.predictionId === r.predictionId && m.details.element.id === e.id ? m.details : null;
  const name = e.label ?? e.tagName;
  if (!d) return detail(`Why this prediction: ${name}`, el('p', { class: 'meta', text: 'Loading…' }));
  const raises = d.reasons.filter((x) => x.polarity === 'raises');
  const lowers = d.reasons.filter((x) => x.polarity !== 'raises');
  const reason = (x: (typeof raises)[number], dir: 'raises' | 'lowers'): HTMLElement =>
    el('li', { attrs: { 'data-dir': dir } }, el('span', { class: 'sr-only', text: dir === 'raises' ? 'Raises: ' : 'Lowers: ' }), icon(dir === 'raises' ? 'up' : 'down', 'icon dir'), el('span', { text: reasonText(x.code, d.facts) }));
  // Confidence already has its own cell in the grid; Caveats lists only the specific uncertainties.
  const caveats = d.element.caveats.map((c) => CAVEAT_COPY[c]);
  if (m.snap?.prediction.state === 'stale') caveats.unshift('Page changed — these reasons describe the earlier analysis');
  const rm = rowModel(r, e);
  const area = meaningfulRegion(d.regionLabel) ?? rm.area;
  return detail(
    `Why this prediction: ${name}`,
    statGrid('Structure', [['Band', BAND_COPY[e.band]], ['Type', rm.type], area ? ['Area', area] : null, e.confidence ? ['Confidence', CONFIDENCE_COPY[e.confidence]] : null]),
    detailPart('Why', raises.length || lowers.length ? el('ul', { class: 'reasons' }, ...raises.map((x) => reason(x, 'raises')), ...lowers.map((x) => reason(x, 'lowers'))) : el('p', { class: 'meta', text: 'Typical for this page.' })),
    caveats.length ? detailPart('Caveats', el('ul', { class: 'caveats' }, ...caveats.map((t) => el('li', { text: t })))) : null,
  );
}
