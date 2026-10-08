/**
 * Record tab — the warm counterpart of Predicted, same rhythm:
 * metric strip · compact layer controls · grouped inspector rows · footer.
 * Renders only lightweight data (session view, one page view); the map itself is drawn on the
 * page by the content runtime. Rows select a control; nothing on the page captures input.
 */
import type { SessionState, TabSnapshot } from '../../shared/model';
import type { RecordedListItem, RecordedLists } from '../../content/recorded/lists';
import type { RecordedLayers, RecordedPageView, RecordedSessionView } from '../../content/recorded/types';
import { el } from '../shared/render';
import { formatDuration } from './model';
import { button, check, detailPart, emptyState, filterPopover, footer, loadingState, metrics, notice, section } from './ui';
import { icon } from '../shared/icons';
import { LAYOUT_COPY, LIST_COPY, NOT_LIVE_COPY, NOT_OPEN_COPY, RECORDED_LIMITATION_COPY, detailFacts, itemLabel, percent } from '../shared/recordedCopy';

export interface RecordedViewModel {
  snap: TabSnapshot | null;
  session: RecordedSessionView | null;
  page: RecordedPageView | null;
  selected: number | null;
  /** List the selected row was opened from: the same control appears in several lists, but expands in one. */
  selectedList?: string | null;
  note: string | null;
  busy: boolean;
  /** A new recording can start here (tab available, not restricted). Defaults to true. */
  canRun?: boolean;
  /** List filter (one category, or all). */
  list?: ListFilter;
  /** Collapsed list sections (ids: `rec-clicked` …). */
  collapsed?: ReadonlySet<string>;
  /** Live recording tile (same component as on Overview), rendered while a session runs. */
  live?: HTMLElement | null;
  filterOpen?: boolean;
  listLimits?: ReadonlyMap<string, number>;
}

export interface RecordedHandlers {
  onRecord(): void;
  onStop(): void;
  onClear(): void;
  onShowOnPage(on: boolean): void;
  onLayers(layers: RecordedLayers): void;
  onPage(position: number): void;
  onSelect(elementId: number, list?: string): void;
  onFocus(elementId: number): void;
  onClearFocus?(): void;
  onToggleSection?(id: string): void;
  onList?(l: ListFilter): void;
  onToggleFilters?(open: boolean): void;
  onResetFilters?(): void;
  onMore?(list: string): void;
}

type ListKey = Exclude<keyof RecordedLists, 'neverReached'>;
const SHOWN_LISTS: readonly ListKey[] = ['mostInteracted', 'clicked', 'mostHovered', 'inViewNoInteraction'];
export type ListFilter = 'all' | ListKey;

/** Screen-head actions once there is a map: Re-run (records again) · Show on page — as on Predicted. */
export function recordedHeadAction(m: RecordedViewModel, h: RecordedHandlers): HTMLElement | null {
  const p = m.page;
  if (!m.session || m.snap?.session.state !== 'ready' || !p) return null;
  const show = check('Show on page', m.snap?.interactionView === 'recorded' && p.pageOpen, !m.busy && p.pageOpen, h.onShowOnPage, 'rec-show', 'eye');
  show.title = p.pageOpen ? 'Show on page' : NOT_OPEN_COPY;
  const rerun = button('Re-run', h.onRecord, (m.canRun ?? true) && !m.busy, { key: 'rec-rerun', subtle: true, icon: 'refresh', label: 'Record again' });
  rerun.title = 'Record again (replaces this recording)';
  return el('div', { class: 'head-group' }, rerun, show);
}

/** Immediate Recorded status, rendered once before the screen title. */
export function recordedNotices(m: RecordedViewModel): HTMLElement[] {
  const p = m.page;
  return [
    p && !p.pageOpen ? notice(NOT_OPEN_COPY, { tone: 'info' }) : null,
    p?.pageOpen && !p.elementsLive ? notice(NOT_LIVE_COPY, { tone: 'info', role: null }) : null,
    p?.layoutMayHaveChanged ? notice(LAYOUT_COPY) : null,
    m.note ? notice(m.note, { tone: 'info' }) : null,
  ].filter((n): n is HTMLElement => !!n);
}

export function recordedBody(m: RecordedViewModel, h: RecordedHandlers): HTMLElement | DocumentFragment {
  const state: SessionState = m.snap?.session.state ?? 'idle';
  if (!m.session || state !== 'ready') return emptyBody(state, m, h);
  const s = m.session;
  const p = m.page;
  const rec = m.snap?.recorded ?? null;
  const multi = s.pages.length > 1;
  const limits = [...new Set([...s.limitations, ...(p?.limitations ?? [])])];
  const frag = document.createDocumentFragment();
  frag.append(
    ...[
      sessionMetrics(s, p),
      multi ? pageSelector(s, rec?.page ?? s.selectedPage, m.busy, h) : null,
      p ? pageBlock(m, p, h) : el('p', { class: 'meta', text: 'Loading…' }),
      footer(
        limits.length ? limitations(limits) : el('span'),
        button('Clear recording', h.onClear, !m.busy, { key: 'rec-clear', danger: true, icon: 'trash' }),
      ),
    ].filter((n): n is HTMLElement => !!n),
  );
  return frag;
}

function emptyBody(state: SessionState, m: RecordedViewModel, h: RecordedHandlers): HTMLElement {
  if ((state === 'recording' || state === 'preparing' || state === 'processing') && m.live) return el('div', { class: 'live-screen' }, m.live);
  if (state === 'recording' || state === 'preparing') return emptyState('Recording…', 'Stop to see the results.', button('Stop', h.onStop, !m.busy && state === 'recording', { primary: true, key: 'rec-stop', icon: 'stop' }), 'record');
  if (state === 'processing') return loadingState('Processing recording…', 'record');
  if (state === 'error') return emptyState('Recording could not be processed', 'Start a new one to try again.', button('Start recording', h.onRecord, !m.busy, { primary: true, key: 'rec-start', icon: 'record' }), 'warn');
  return emptyState('No recording yet', 'Capture a live session.', button('Start recording', h.onRecord, !m.busy, { primary: true, key: 'rec-start', icon: 'record' }), 'record');
}

function sessionMetrics(s: RecordedSessionView, p: RecordedPageView | null): HTMLElement {
  const clicks = s.totals.clicks + s.totals.activations;
  if (s.pages.length > 1) {
    return metrics('Session summary', [
      { label: 'Duration', value: formatDuration(s.elapsedMs) },
      { label: 'Clicks', value: String(clicks), quiet: !clicks },
      { label: 'Pages', value: String(s.pages.length) },
      { label: 'Interacted', value: String(s.totals.controlsInteracted), quiet: !s.totals.controlsInteracted },
    ], 'md', false, 'summary-metrics');
  }
  const f = p?.facts;
  return metrics('Session summary', [
    { label: 'Duration', value: formatDuration(s.elapsedMs) },
    { label: 'Clicks', value: String(clicks), quiet: !clicks },
    { label: 'Scroll', value: percent(s.deepestScroll), quiet: s.deepestScroll === null },
    f ? { label: 'Interacted', value: String(f.controlsInteracted), quiet: !f.controlsInteracted } : null,
  ], 'md', false, 'summary-metrics');
}

function pageSelector(s: RecordedSessionView, current: number, busy: boolean, h: RecordedHandlers): HTMLElement {
  const select = el(
    'select',
    { attrs: { 'aria-label': 'Recorded page' }, on: { change: (e) => h.onPage(Number((e.target as HTMLSelectElement).value)) } },
    ...s.pages.map((p) => {
      const o = el('option', { text: `Page ${p.position + 1} of ${s.pages.length} · ${p.path || '/'}` });
      o.value = String(p.position);
      o.selected = p.position === current;
      return o;
    }),
  );
  select.disabled = busy;
  select.dataset.key = 'rec-page';
  return el('label', { class: 'select' }, icon('pages'), select, icon('chevron', 'icon select-chev'));
}

const collapseOf = (id: string, m: RecordedViewModel, h: RecordedHandlers) => (h.onToggleSection ? { id, collapsed: !!m.collapsed?.has(id), onToggle: () => h.onToggleSection!(id) } : undefined);

function pageBlock(m: RecordedViewModel, p: RecordedPageView, h: RecordedHandlers): HTMLElement {
  const multi = p.pageCount > 1;
  return el(
    'div',
    { class: 'sections', attrs: { role: 'region', 'aria-label': multi ? `Page ${p.position + 1} of ${p.pageCount}` : 'This page' } },
    multi
      ? metrics('This page', [
          { label: 'Time', value: formatDuration(p.facts.elapsedMs) },
          { label: 'Clicks', value: String(p.facts.clicks + p.facts.activations), quiet: !(p.facts.clicks + p.facts.activations) },
          { label: 'Scroll', value: percent(p.facts.deepestScroll), quiet: p.facts.deepestScroll === null },
          { label: 'Interacted', value: String(p.facts.controlsInteracted), quiet: !p.facts.controlsInteracted },
        ], 'sm', false, 'summary-metrics')
      : null,
    p.facts.nestedScroll.length ? el('p', { class: 'meta', text: p.facts.nestedScroll.map((n, i) => `Scroll area ${i + 1}: ${percent(n.deepestFraction)}`).join(' · ') }) : null,
    // "Never reached" and "May not be clickable" are not listed: as raw lists they are too weak to
    // act on — one is mostly a function of scroll depth (already in the summary), the other has
    // no identifiable target.
    ...SHOWN_LISTS.map((k) => listSection(m, p, k, h)),
  );
}

export function recordedFilters(m: RecordedViewModel, p: RecordedPageView, h: RecordedHandlers): HTMLElement | null {
  const layers = m.snap?.recorded?.layers ?? { heatmap: true, clicks: true, scroll: true };
  const can = !m.busy && p.pageOpen;
  const hidden = Number(!layers.heatmap) + Number(!layers.clicks) + Number(!layers.scroll);
  const view = el(
    'div',
    { class: 'filter-view', attrs: { role: 'group', 'aria-label': 'View', 'data-label': 'View' } },
    check('Heatmap', layers.heatmap, can, (v) => h.onLayers({ ...layers, heatmap: v }), 'rec-heat'),
    check('Clicks', layers.clicks, can, (v) => h.onLayers({ ...layers, clicks: v }), 'rec-clicks'),
    check('Depth', layers.scroll, can, (v) => h.onLayers({ ...layers, scroll: v }), 'rec-scroll'),
  );
  return filterPopover(
    'Filter recorded activity',
    hidden,
    !!m.filterOpen,
    h.onToggleFilters,
    h.onResetFilters,
    view,
  );
}

function listSection(m: RecordedViewModel, p: RecordedPageView, key: ListKey, h: RecordedHandlers): HTMLElement | null {
  const copy = LIST_COPY[key];
  const items: RecordedListItem[] = p.lists[key];
  const count = items.length;
  if (!count) return null; // empty categories are hidden
  const shown = items.slice(0, m.listLimits?.get(key) ?? 5);
  return section(
    copy.title,
    { count, collapse: collapseOf(`rec-${key}`, m, h) },
    el('ul', { class: 'list' }, ...shown.map((i) => row(m, p, key, i, h))),
    count > shown.length && h.onMore ? button('Show 5 more', () => h.onMore!(key), true, { key: `rec-more-${key}`, subtle: true }) : null,
  );
}

/** Same row as Predicted: title · eye (selected) · chevron; details only when open. */
function row(m: RecordedViewModel, p: RecordedPageView, key: ListKey, i: RecordedListItem, h: RecordedHandlers): HTMLElement {
  const selected = m.selected === i.elementRef && (m.selectedList == null || m.selectedList === key);
  const id = `rec-${key}-${i.elementRef}`;
  const toggle = el('button', {
    class: 'item item-toggle',
    attrs: { type: 'button', 'aria-expanded': String(selected), 'aria-controls': id, 'aria-label': itemLabel(i) },
    on: { click: () => h.onSelect(i.elementRef, key) },
  });
  toggle.dataset.key = id;
  if (selected) toggle.dataset.selected = '';
  const focused = m.snap?.recorded?.focusedElementId === i.elementRef && m.snap.interactionView === 'recorded';
  let eye: HTMLElement | null = null;
  if (selected && p.elementsLive) {
    const label = focused ? 'Clear highlight' : 'Show on page';
    const b = el('button', { class: focused ? 'icon-btn is-on' : 'icon-btn', attrs: { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(focused) }, on: { click: () => (focused && h.onClearFocus ? h.onClearFocus() : h.onFocus(i.elementRef)) } }, icon('eye'));
    (b as HTMLButtonElement).disabled = m.busy;
    b.dataset.key = `rec-show-${i.elementRef}`;
    eye = b;
  }
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'item-row', attrs: selected ? { 'data-selected': '' } : {} },
      toggle,
      el('span', { class: 'item-main', attrs: { 'aria-hidden': 'true' } }, el('span', { class: 'item-title' }, el('span', { class: 'item-label', text: itemLabel(i) }))),
      eye,
      icon('chevron', 'icon chev'),
    ),
    selected ? detail(m, p, i, id) : null,
  );
}

function detail(m: RecordedViewModel, p: RecordedPageView, i: RecordedListItem, id: string): HTMLElement {
  const caveat = p.elementsLive ? null : p.pageOpen ? 'Can’t be outlined for this part of the recording' : 'Open the original page to outline it';
  const stats = el(
    'dl',
    { class: 'recorded-stat-grid', attrs: { 'aria-label': 'Activity' } },
    ...detailFacts(i).map(([label, value]) => el('div', { class: 'recorded-stat' }, el('dt', { text: label }), el('dd', { text: value }))),
  );
  return el(
    'div',
    { class: 'detail', attrs: { id, role: 'region', 'aria-label': `Recorded facts: ${itemLabel(i)}` } },
    el(
      'div',
      { class: 'detail-parts' },
      stats,
      caveat ? detailPart('Caveats', el('ul', { class: 'reasons caveats' }, el('li', { text: caveat }))) : null,
    ),
  );
}

function limitations(codes: readonly (keyof typeof RECORDED_LIMITATION_COPY)[]): HTMLElement {
  return el(
    'details',
    { class: 'info' },
    el('summary', {}, icon('warn'), `Limitations · ${codes.length}`),
    el('div', { class: 'info-body' }, el('ul', { class: 'reasons' }, ...codes.map((c) => el('li', { text: RECORDED_LIMITATION_COPY[c] })))),
  );
}
