/**
 * Record mode of the inspector — the warm counterpart of Predict on the same frame (see ui.ts):
 * notices · head (Re-run · Show on page · Filter) · summary · activity groups · footer.
 * Renders only lightweight data (session view, one page view); the map itself is drawn on the page
 * by the content runtime. Factual language only: what happened in this recording.
 */
import type { SessionState, TabSnapshot } from '../../shared/model';
import type { RecordedListItem, RecordedLists } from '../../content/recorded/lists';
import type { RecordedLayers, RecordedPageView, RecordedSessionView } from '../../content/recorded/types';
import { el } from '../shared/render';
import { formatDuration } from './model';
import { actions, button, detail, detailPart, emptyState, filterPopover, footer, group, inspectorRow, loadingState, more, popoverGroup, statGrid, summary, switchRow, toggle, type NoticeIssue } from './ui';
import { icon } from '../shared/icons';
import { LAYOUT_COPY, LIST_COPY, NOT_LIVE_COPY, NOT_OPEN_COPY, RECORDED_LIMITATION_COPY, detailFacts, itemLabel, percent, shortMeta } from '../shared/recordedCopy';

export interface RecordedViewModel {
  snap: TabSnapshot | null;
  session: RecordedSessionView | null;
  page: RecordedPageView | null;
  selected: number | null;
  note: string | null;
  busy: boolean;
  /** A new recording can start here (tab available, not restricted). Defaults to true. */
  canRun?: boolean;
  /** Collapsed activity groups. */
  collapsed?: ReadonlySet<string>;
  /** Live recording block (same component as on Overview), rendered while a session runs. */
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
  onSelect(elementId: number): void;
  onFocus(elementId: number): void;
  onClearFocus?(): void;
  onToggleSection?(id: string): void;
  onToggleFilters?(open: boolean): void;
  onResetFilters?(): void;
  onMore?(list: string): void;
}

type ListKey = Extract<keyof RecordedLists, 'mostInteracted' | 'inViewNoInteraction'>;
/** One canonical interaction list plus meaningful non-interaction exposure. */
const SHOWN_LISTS: readonly ListKey[] = ['mostInteracted', 'inViewNoInteraction'];

const ACTIVE: readonly SessionState[] = ['preparing', 'recording', 'processing'];

/** Head actions. Completed: Re-run (record again) · Show on page · Filter. Live: Stop. */
export function recordedHeadAction(m: RecordedViewModel, h: RecordedHandlers): HTMLElement | null {
  const state = m.snap?.session.state ?? 'idle';
  if (ACTIVE.includes(state)) return actions(stopButton(state, m.busy, h.onStop));
  const p = m.page;
  if (!m.session || state !== 'ready' || !p) return null;
  const show = toggle('Show on page', m.snap?.interactionView === 'recorded' && p.pageOpen, !m.busy && p.pageOpen, h.onShowOnPage, 'rec-show', 'eye');
  if (!p.pageOpen) show.title = NOT_OPEN_COPY;
  return actions(show, recordedFilters(m, p, h));
}

/** The one Stop control (Overview Record panel and Record head). */
export function stopButton(state: SessionState, busy: boolean, onStop: () => void): HTMLButtonElement {
  const processing = state === 'processing';
  return button(processing ? 'Processing…' : 'Stop', onStop, !busy && state === 'recording', { stop: true, key: 'stop', icon: processing ? undefined : 'stop' });
}

/** Immediate Record status, rendered once before the inspector head. */
export function recordedWarnings(m: RecordedViewModel, h?: Pick<RecordedHandlers, 'onRecord'>): NoticeIssue[] {
  const p = m.page;
  const state = m.snap?.session.state;
  const ignored = new Set(['SHORT_SESSION', 'LITTLE_SCROLL', 'FEW_EVENTS']);
  const limitations = [...new Set([...(m.session?.limitations ?? []), ...(p?.limitations ?? [])])].filter((code) => !ignored.has(code));
  const issues: Array<NoticeIssue | null> = [
    state === 'error' ? { id: 'recording-failed', severity: 'critical', message: 'Recording could not be processed', detail: 'Start a new recording to try again.', action: h ? button('Start recording', h.onRecord, (m.canRun ?? true) && !m.busy, { key: 'recording-recover', subtle: true }) : null } : null,
    p && !p.pageOpen ? { id: 'recording-page-not-open', severity: 'action', message: NOT_OPEN_COPY } : null,
    p?.pageOpen && !p.elementsLive ? { id: 'recording-elements-not-live', severity: 'warning', message: NOT_LIVE_COPY } : null,
    p?.layoutMayHaveChanged
      ? { id: 'recording-page-changed', severity: 'action', message: LAYOUT_COPY, detail: 'The map may not line up with the page.', action: h ? button('Record again', h.onRecord, (m.canRun ?? true) && !m.busy, { key: 'record-again-layout', subtle: true }) : null }
      : null,
    m.note ? { id: 'recording-note', severity: 'info', message: m.note } : null,
    ...limitations.map((code): NoticeIssue => ({
      id: code === 'PAGE_CHANGED' ? 'recording-page-changed' : `recording-limit-${code.toLowerCase()}`,
      severity: code === 'RECORDING_INTERRUPTED_UNSUPPORTED_PAGE' ? 'critical' : code === 'FRAMES_UNSUPPORTED' || code === 'NESTED_SCROLL_UNTRACKED' ? 'warning' : 'info',
      message: RECORDED_LIMITATION_COPY[code],
    })),
  ];
  return issues.filter((issue): issue is NoticeIssue => !!issue);
}

export function recordedBody(m: RecordedViewModel, h: RecordedHandlers): HTMLElement | DocumentFragment {
  const state: SessionState = m.snap?.session.state ?? 'idle';
  if (!m.session || state !== 'ready') return emptyBody(state, m, h);
  const s = m.session;
  const p = m.page;
  const rec = m.snap?.recorded ?? null;
  const frag = document.createDocumentFragment();
  frag.append(
    ...[
      recordingSummary(s, p),
      s.pages.length > 1 ? pageContext(s, p, rec?.page ?? s.selectedPage, m.busy, h) : null,
      p ? activityGroups(m, p, h) : loadingState('Loading results…'),
      footer(
        el('span'),
        actions(
          button('Clear recording', h.onClear, !m.busy, { key: 'rec-clear', danger: true, icon: 'trash' }),
          button('Record again', h.onRecord, (m.canRun ?? true) && !m.busy, { key: 'rec-rerun', icon: 'refresh', label: 'Record again (replaces this recording)' }),
        ),
      ),
    ].filter((n): n is HTMLElement => !!n),
  );
  return frag;
}

function emptyBody(state: SessionState, m: RecordedViewModel, h: RecordedHandlers): HTMLElement {
  if (ACTIVE.includes(state) && m.live) return m.live;
  if (state === 'processing') return loadingState('Processing recording…');
  if (state === 'recording' || state === 'preparing') return loadingState('Recording…');
  if (state === 'error') return emptyState('Recording could not be processed', 'Start a new one to try again.', button('Start recording', h.onRecord, (m.canRun ?? true) && !m.busy, { primary: true, key: 'rec-start', icon: 'record' }), 'warn', 'warn');
  return emptyState('No recording yet', 'Capture a live session.', button('Start recording', h.onRecord, (m.canRun ?? true) && !m.busy, { primary: true, key: 'rec-start', icon: 'record' }), 'record');
}

/** Record summary: Duration · Clicks · Scroll (Pages for multi-page sessions) · Interacted. Shared with Overview. */
export function recordingSummary(s: RecordedSessionView, p: RecordedPageView | null): HTMLElement {
  const clicks = s.totals.clicks + s.totals.activations;
  const multi = s.pages.length > 1;
  const interacted = multi ? s.totals.controlsInteracted : (p?.facts.controlsInteracted ?? s.totals.controlsInteracted);
  return summary(
    'Recording summary',
    [
      { label: 'Duration', value: formatDuration(s.elapsedMs) },
      { label: 'Clicks', value: String(clicks), quiet: !clicks },
      multi ? { label: 'Pages', value: String(s.pages.length) } : { label: 'Scroll', value: percent(s.deepestScroll), quiet: s.deepestScroll === null },
      { label: 'Interacted', value: String(interacted), quiet: !interacted },
    ],
    { key: 'rec-summary' },
  );
}

/** Multi-page: page selector + that page's facts on one quiet line (no second metric strip). */
function pageContext(s: RecordedSessionView, p: RecordedPageView | null, current: number, busy: boolean, h: RecordedHandlers): HTMLElement {
  const select = el(
    'select',
    { attrs: { 'aria-label': 'Recorded page' }, on: { change: (e) => h.onPage(Number((e.target as HTMLSelectElement).value)) } },
    ...s.pages.map((pg) => {
      const o = el('option', { text: `Page ${pg.position + 1} of ${s.pages.length} · ${pg.path || '/'}` });
      o.value = String(pg.position);
      o.selected = pg.position === current;
      return o;
    }),
  );
  select.disabled = busy;
  select.dataset.key = 'rec-page';
  const f = p?.facts;
  const line = f
    ? [formatDuration(f.elapsedMs), `${f.clicks + f.activations} click${f.clicks + f.activations === 1 ? '' : 's'}`, `${percent(f.deepestScroll)} scroll`, `${f.controlsInteracted} interacted`].join(' · ')
    : null;
  return el('div', { class: 'page-context' }, el('label', { class: 'select' }, icon('pages'), select, icon('chevron', 'icon select-chev')), line ? el('p', { class: 'caption', text: line }) : null);
}

function activityGroups(m: RecordedViewModel, p: RecordedPageView, h: RecordedHandlers): HTMLElement {
  const groups = SHOWN_LISTS.map((k) => listGroup(m, p, k, h)).filter((g): g is HTMLElement => !!g);
  return el(
    'div',
    { class: 'groups', attrs: { role: 'region', 'aria-label': p.pageCount > 1 ? `Page ${p.position + 1} of ${p.pageCount}` : 'This page' } },
    p.facts.nestedScroll.length ? el('p', { class: 'caption', text: p.facts.nestedScroll.map((n, i) => `Scroll area ${i + 1}: ${percent(n.deepestFraction)}`).join(' · ') }) : null,
    ...(groups.length ? groups : [el('p', { class: 'no-match', text: 'No control activity on this page.' })]),
  );
}

/** Visualization settings: three independent switches (never mutually exclusive). */
export function recordedFilters(m: RecordedViewModel, p: RecordedPageView, h: RecordedHandlers): HTMLElement | null {
  const layers = m.snap?.recorded?.layers ?? { heatmap: true, clicks: true, scroll: true };
  const can = !m.busy && p.pageOpen;
  const hidden = Number(!layers.heatmap) + Number(!layers.clicks) + Number(!layers.scroll);
  return filterPopover(
    'Filter recorded activity',
    hidden,
    !!m.filterOpen,
    h.onToggleFilters,
    h.onResetFilters,
    popoverGroup(
      'Layers',
      switchRow('Heatmap', layers.heatmap, can, (v) => h.onLayers({ ...layers, heatmap: v }), 'rec-heat', 'heat'),
      switchRow('Clicks', layers.clicks, can, (v) => h.onLayers({ ...layers, clicks: v }), 'rec-clicks', 'click'),
      switchRow('Depth', layers.scroll, can, (v) => h.onLayers({ ...layers, scroll: v }), 'rec-scroll', 'scroll'),
    ),
  );
}

function listGroup(m: RecordedViewModel, p: RecordedPageView, key: ListKey, h: RecordedHandlers): HTMLElement | null {
  const items: RecordedListItem[] = p.lists[key];
  if (!items.length) return null; // empty categories are hidden
  const shown = items.slice(0, m.listLimits?.get(key) ?? 5);
  return group(
    LIST_COPY[key].title,
    { count: items.length, collapse: h.onToggleSection ? { id: `rec-${key}`, collapsed: !!m.collapsed?.has(`rec-${key}`), onToggle: () => h.onToggleSection!(`rec-${key}`) } : undefined },
    el('ul', { class: 'rows' }, ...shown.map((i) => activityRow(m, p, key, i, h))),
    items.length > shown.length && h.onMore ? more(() => h.onMore!(key), `rec-more-${key}`) : null,
  );
}

function activityRow(m: RecordedViewModel, p: RecordedPageView, key: ListKey, i: RecordedListItem, h: RecordedHandlers): HTMLElement {
  const selected = m.selected === i.elementRef;
  const id = `rec-${key}-${i.elementRef}`;
  const focused = m.snap?.recorded?.focusedElementId === i.elementRef && m.snap.interactionView === 'recorded';
  return inspectorRow({
    id,
    key: id,
    label: itemLabel(i),
    meta: shortMeta(i, key),
    selected,
    onToggle: () => h.onSelect(i.elementRef),
    eye: selected && p.elementsLive ? { on: focused, enabled: !m.busy, key: `rec-show-${i.elementRef}`, onClick: () => (focused && h.onClearFocus ? h.onClearFocus() : h.onFocus(i.elementRef)) } : null,
    detail: selected ? activityDetail(p, i) : null,
  });
}

function activityDetail(p: RecordedPageView, i: RecordedListItem): HTMLElement {
  const caveat = p.elementsLive ? null : p.pageOpen ? 'Can’t be outlined for this part of the recording' : 'Open the original page to outline it';
  return detail(`Recorded facts: ${itemLabel(i)}`, statGrid('Activity', detailFacts(i)), caveat ? detailPart('Caveats', el('ul', { class: 'caveats' }, el('li', { text: caveat }))) : null);
}
