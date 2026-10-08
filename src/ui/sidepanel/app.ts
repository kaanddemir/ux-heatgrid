/**
 * HeatGrid side panel:  Overview · Predict · Record. Event-driven (no polling). Navigation only
 * changes presentation — Predict and Record run only from explicit actions. Chrome wiring lives in panel.ts; this module is testable with a fake API.
 */
import { makeError, type HeatGridError, type SessionSummary, type TabSnapshot } from '../../shared/model';
import type { PredictionElementDetails, PredictionSummaryResult } from '../../content/prediction/types';
import type { RecordedLayers, RecordedPageView, RecordedSessionView } from '../../content/recorded/types';
import type { EventEnvelope, RequestMap, RequestType, Response } from '../../shared/protocol';
import { el, errorText, mount } from '../shared/render';
import { BAND_COPY, PREDICTED_TITLE } from '../shared/predictionCopy';
import { NOT_OPEN_COPY, RECORDED_TITLE, itemLabel, shortMeta } from '../shared/recordedCopy';
import { INITIAL_NAV, SECTIONS, formatDuration, goSection, route, type Intent, type NavState, type Section } from './model';
import { distribution, predictedBody, predictedFilters, predictedHeadAction, predictedNotices, type PredictedHandlers, type PredictedModel } from './predictedView';
import { recordedBody, recordedFilters, recordedHeadAction, recordedNotices, type ListFilter, type RecordedHandlers, type RecordedViewModel } from './recordedView';
import { button, metrics, notice, noticeZone, screen, screenHead, tablist } from './ui';
import { icon } from '../shared/icons';
import { rowModel, type Filter, type KindFilter } from './viewModel';

export interface PanelApi {
  request<T extends RequestType>(tabId: number, type: T, payload: RequestMap[T]['payload']): Promise<Response<RequestMap[T]['data']>>;
  ensureRuntime(tab: chrome.tabs.Tab): Promise<Response<{ injected: boolean }>>;
  activeTab(): Promise<chrome.tabs.Tab | null>;
}

export interface PanelApp {
  refresh(): Promise<void>;
  onEvent(event: EventEnvelope, tabId: number | null): void;
  render(): void;
  /** Test/diagnostic view of the UI state (never sent anywhere). */
  inspect(): { nav: NavState; intent: Intent; tabId: number | null };
  /** Resolves when pending loads triggered by the last render/apply are done (tests). */
  idle(): Promise<void>;
}

/** Overview card → shared accent kind (data-kind drives the Predict / Record colour language). */
const VISUAL_KIND = { page: 'overview', predict: 'predicted', record: 'recorded' } as const;

export function createPanelApp(root: HTMLElement, api: PanelApi): PanelApp {
  let tab: chrome.tabs.Tab | null = null;
  let snap: TabSnapshot | null = null;
  let error: HeatGridError | null = null;
  let busy = false;
  let nav: NavState = { ...INITIAL_NAV };
  let intent: Intent = null;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  };

  // Predicted
  let result: PredictionSummaryResult | null = null;
  let filter: Filter = 'all';
  let kind: KindFilter = 'all';
  let predFiltersOpen = false;
  let selectedId: number | null = null;
  let details: PredictionElementDetails | null = null;
  let focusNote: string | null = null;
  const bandLimits = new Map<string, number>();
  /** Collapsed sections (Predicted bands, Recorded lists); presentation only, kept across renders. */
  const collapsed = new Set<string>();
  const toggleSection = (id: string): void => {
    if (!collapsed.delete(id)) collapsed.add(id);
    render();
  };
  // Recorded
  let recSession: RecordedSessionView | null = null;
  let recPage: RecordedPageView | null = null;
  let recSelected: number | null = null;
  /** List the selected Recorded row was opened from (the same control can be in several lists). */
  let recSelectedList: string | null = null;
  let recList: ListFilter = 'all';
  let recFiltersOpen = false;
  const recListLimits = new Map<string, number>();
  let recNote: string | null = null;
  let recLoading: string | null = null;
  /** Overview disclosures are independent; actions inside one card never disturb another. */
  type OverviewCard = 'page' | 'predict' | 'record';
  const overviewOpen = new Set<OverviewCard>();
  let autoOpenedFor: string | null = null;
  const toggleOverviewCard = (card: OverviewCard): void => {
    if (!overviewOpen.delete(card)) overviewOpen.add(card);
    render();
  };
  /** Live recording nodes of the current render, refreshed by SESSION_TICK without a full render. */
  let liveFills: Array<(s: SessionSummary | null) => void> = [];

  const tabId = (): number | null => tab?.id ?? null;
  const restricted = (): boolean => error?.code === 'RESTRICTED_PAGE';
  const sessionState = () => snap?.session.state ?? 'idle';
  const recordingActive = (): boolean => ['preparing', 'recording', 'processing'].includes(sessionState());
  const canAct = (): boolean => !!tab?.id && !busy && !restricted();

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render(): void {
    const activeKey = (root.ownerDocument.activeElement as HTMLElement | null)?.dataset?.key;
    liveFills = [];
    mount(root, header(), main());
    if (activeKey) root.querySelector<HTMLElement>(`[data-key="${activeKey.replace(/"/g, '')}"]`)?.focus();
  }

  function header(): HTMLElement {
    return el(
      'header',
      { class: 'app-head' },
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }), el('span', { class: 'brand-name', text: 'HeatGrid' })),
      livePill(),
      tablist('HeatGrid sections', SECTIONS.map((s) => ({ id: s.id, text: s.label, selected: nav.section === s.id, controls: 'main-view', onSelect: () => goTo(s.id) })), 'nav'),
    );
  }

  /** Header status while recording on a screen without the live tile: dot · elapsed → Overview. */
  function livePill(): HTMLElement | null {
    const onLiveTile = nav.section === 'overview' || nav.section === 'record';
    if (!recordingActive() || onLiveTile) return null;
    const processing = sessionState() === 'processing';
    const time = el('span', { class: 'live-pill-time' });
    if (!processing) liveFills.push((s) => (time.textContent = formatDuration(s?.elapsedMs ?? 0)));
    else time.textContent = 'Processing…';
    const b = el('button', { class: 'live-pill', attrs: { 'aria-label': 'Recording · open Overview' }, on: { click: () => ((nav = goSection(nav, 'overview')), render()) } }, processing ? el('span', { class: 'spinner' }) : el('span', { class: 'rec-dot', attrs: { 'aria-hidden': 'true' } }), time);
    b.type = 'button';
    b.dataset.key = 'live-pill';
    fillLive();
    return b;
  }

  function main(): HTMLElement {
    const body = nav.section === 'predict' ? predictSection() : nav.section === 'record' ? recordSection() : overviewSection();
    return el(
      'main',
      { class: 'view', attrs: { id: 'main-view', role: 'tabpanel', 'aria-label': SECTIONS.find((s) => s.id === nav.section)!.label } },
      noticeZone(error ? notice(errorText(error), { tone: 'error', role: 'alert' }) : null),
      body,
    );
  }

  const fillLive = (): void => liveFills.forEach((f) => f(snap?.session.summary ?? null));

  /**
   * The Record action while a session runs: Recording · elapsed · clicks · scroll · Stop.
   * One component, shown inside the Overview Record card and on the Record screen.
   */
  function liveTile(): HTMLElement {
    const st = sessionState();
    const processing = st === 'processing';
    const pages = snap?.session.recording?.segmentCount ?? 1;
    const time = el('span', { class: 'live-time' });
    const clicks = el('span', { class: 'live-n' });
    const clicksL = el('span', { class: 'live-l' });
    const scroll = el('span', { class: 'live-n' });
    const fill = el('span');
    liveFills.push((s) => {
      time.textContent = formatDuration(s?.elapsedMs ?? 0);
      clicks.textContent = String(s?.clicks ?? 0);
      clicksL.textContent = s?.clicks === 1 ? 'click' : 'clicks';
      const pct = Math.round((s?.scrollDepth ?? 0) * 100);
      scroll.textContent = `${pct}%`;
      fill.style.width = `${Math.max(2, pct)}%`;
    });
    const stop = button(processing ? 'Processing…' : 'Stop', onStop, !busy && st === 'recording', { key: 'stop', icon: processing ? undefined : 'stop' });
    stop.classList.add('stop');
    const tile = el(
      'div',
      { class: 'live-card', attrs: { role: 'group', 'aria-label': 'Recording', 'data-kind': 'recorded' } },
      el(
        'div',
        { class: 'live-head' },
        processing ? el('span', { class: 'spinner' }) : el('span', { class: 'rec-dot', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'live-state', text: processing ? 'Processing' : st === 'preparing' ? 'Preparing…' : 'Recording' }),
        pages > 1 ? el('span', { class: 'tag', text: `${pages} pages` }) : null,
      ),
      time,
      el('div', { class: 'live-stats' }, el('span', { class: 'live-stat' }, icon('click'), clicks, ' ', clicksL), el('span', { class: 'live-stat' }, icon('scroll'), scroll, ' scroll')),
      el('span', { class: 'live-track', attrs: { 'aria-hidden': 'true' } }, fill),
      stop,
    );
    fillLive();
    return tile;
  }

  /** Full-width Overview workflow header. The report expands inside the same card. */
  function workflowHead(
    kind: OverviewCard,
    ic: 'page' | 'predict' | 'record',
    title: string,
    onToggle: () => void,
    expanded: boolean,
    key: string,
    action: HTMLButtonElement | null = null,
  ): HTMLElement {
    const visualKind = VISUAL_KIND[kind];
    const toggle = el(
      'button',
      { class: 'workflow-toggle', attrs: { 'aria-expanded': String(expanded), 'aria-controls': `ov-${kind}-report` }, on: { click: onToggle } },
      el('span', { class: 'action-icon' }, icon(ic)),
      el('span', { class: 'action-title', text: title }),
    );
    toggle.type = 'button';
    toggle.dataset.key = key;
    const chevron = el('button', { class: 'workflow-chevron', attrs: { type: 'button', 'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${title}`, 'aria-expanded': String(expanded), 'aria-controls': `ov-${kind}-report` }, on: { click: onToggle } }, icon('chevron', 'icon workflow-chev'));
    return el('div', { class: 'workflow-head', attrs: { 'data-kind': visualKind } }, toggle, action, chevron);
  }

  function workflowCard(kind: OverviewCard, head: HTMLElement, body: HTMLElement | null): HTMLElement {
    const label = kind === 'predict' ? 'Predict' : kind === 'record' ? 'Record' : 'Page';
    return el('section', { class: body ? 'workflow-card is-open' : 'workflow-card', attrs: { 'data-kind': VISUAL_KIND[kind], 'aria-label': label } }, head, body);
  }

  function previewRows(rows: Array<{ title: string; meta: string }>): HTMLElement | null {
    return rows.length
      ? el('ul', { class: 'workflow-preview' }, ...rows.map((r) => el('li', {}, el('span', { class: 'item-label', text: r.title }), el('span', { class: 'item-meta', text: r.meta }))))
      : null;
  }

  function predictionReport(): HTMLElement | null {
    if (!overviewOpen.has('predict')) return null;
    if (!result) {
      const text = snap?.prediction.state === 'analyzing' ? 'Analysing this page…' : snap?.prediction.state === 'error' ? 'Prediction could not be completed.' : 'No prediction yet.';
      return el('div', { class: 'workflow-report', attrs: { id: 'ov-predict-report' } }, el('div', { class: 'overview-status', text }));
    }
    const report = result;
    const rows = report.elements.filter((e) => e.band !== 'not-assessed').slice(0, 3).map((e) => {
      const r = rowModel(report, e);
      return { title: r.label, meta: BAND_COPY[e.band] };
    });
    return el(
      'div',
      { class: 'workflow-report', attrs: { id: 'ov-predict-report' } },
      snap?.prediction.state === 'stale' ? noticeZone(notice('Page changed', { action: button('Run again', startPredictFromReport, canAct() && !recordingActive(), { key: 'ov-predict-again', subtle: true }) })) : null,
      distribution(report.summary),
      previewRows(rows),
      button('Open full report', () => goTo('predict'), true, { key: 'ov-open-predict', subtle: true, icon: 'arrow' }),
    );
  }

  const startPredictFromReport = (): void => {
    overviewOpen.add('predict');
    onPredict();
  };

  function recordedReport(): HTMLElement | null {
    if (!overviewOpen.has('record')) return null;
    if (!recSession || !recPage) {
      const text = snap?.session.state === 'error' ? 'Recording could not be processed.' : 'No recording yet.';
      return el('div', { class: 'workflow-report', attrs: { id: 'ov-record-report' } }, snap?.session.state === 'error' ? noticeZone(notice(text, { tone: 'error' })) : el('div', { class: 'overview-status', text }));
    }
    const f = recPage.facts;
    const candidates = [...recPage.lists.mostInteracted, ...recPage.lists.clicked];
    const seen = new Set<number>();
    const rows = candidates.filter((i) => !seen.has(i.elementRef) && !!seen.add(i.elementRef)).slice(0, 3).map((i) => ({ title: itemLabel(i), meta: shortMeta(i, 'mostInteracted') }));
    return el(
      'div',
      { class: 'workflow-report', attrs: { id: 'ov-record-report' } },
      metrics('Recording summary', [
        { label: 'Duration', value: formatDuration(recSession.elapsedMs) },
        { label: 'Clicks', value: String(recSession.totals.clicks + recSession.totals.activations), quiet: !(recSession.totals.clicks + recSession.totals.activations) },
        { label: 'Scroll', value: f.deepestScroll === null ? '—' : `${Math.round(f.deepestScroll * 100)}%`, quiet: f.deepestScroll === null },
        { label: 'Interacted', value: String(f.controlsInteracted), quiet: !f.controlsInteracted },
      ], 'sm', false, 'summary-metrics'),
      previewRows(rows),
      button('Open full report', () => goTo('record'), true, { key: 'ov-open-record', subtle: true, icon: 'arrow' }),
    );
  }

  function pageCard(): HTMLElement {
    let host = '';
    try {
      host = tab?.url ? new URL(tab.url).host : '';
    } catch {
      host = '';
    }
    const open = overviewOpen.has('page');
    const toggle = () => toggleOverviewCard('page');
    const report = open
      ? el(
          'div',
          { class: 'workflow-report page-report', attrs: { id: 'ov-page-report' } },
          el('dl', { class: 'facts' }, el('dt', { text: 'Title' }), el('dd', { text: tab?.title || 'This page' }), el('dt', { text: 'Address' }), el('dd', { text: tab?.url || '—' })),
        )
      : null;
    return workflowCard(
      'page',
      workflowHead('page', 'page', tab?.title || 'This page', toggle, open, 'ov-page'),
      report,
    );
  }

  function overviewSection(): HTMLElement {
    const analysing = snap?.prediction.state === 'analyzing';
    const live = recordingActive();
    const togglePredict = () => toggleOverviewCard('predict');
    const toggleRecord = () => toggleOverviewCard('record');
    const startPredict = () => (overviewOpen.add('predict'), onPredict());
    const startRecord = () => (overviewOpen.add('record'), onRecord());
    const predictStart = button(analysing ? 'Running…' : 'Start', startPredict, canAct() && !live && !analysing, { key: 'ov-start-predict' });
    predictStart.classList.add('workflow-action');
    const recordStart = button('Start', startRecord, canAct(), { key: 'ov-start-record' });
    recordStart.classList.add('workflow-action');
    return screen(
      'overview',
      el(
        'div',
        { class: 'ov-workflows' },
        pageCard(),
        workflowCard('predict', workflowHead('predict', 'predict', 'Predict', togglePredict, overviewOpen.has('predict'), 'ov-predict', predictStart), predictionReport()),
        live
          ? workflowCard('record', workflowHead('record', 'record', 'Record', toggleRecord, overviewOpen.has('record'), 'ov-record'), overviewOpen.has('record') ? el('div', { class: 'workflow-report live-report', attrs: { id: 'ov-record-report' } }, liveTile()) : null)
          : workflowCard('record', workflowHead('record', 'record', 'Record', toggleRecord, overviewOpen.has('record'), 'ov-record', recordStart), recordedReport()),
      ),
    );
  }

  function predictedModel(): PredictedModel {
    return { snap, result, filter, kind, filterOpen: predFiltersOpen, selectedId, details, focusNote, busy, canRun: canAct() && !recordingActive(), collapsed };
  }

  const predictedHandlers: PredictedHandlers = {
    onRun: () => onPredict(),
    onClear: () => onClearPrediction(),
    onShowOverlay: (on) => void setView(on ? 'predicted' : 'none'),
    onFilter: (f) => ((filter = f), bandLimits.clear(), render()),
    onKind: (k) => ((kind = k), bandLimits.clear(), render()),
    onToggleFilters: (open) => ((predFiltersOpen = open), render()),
    onResetFilters: () => ((filter = 'all'), (kind = 'all'), bandLimits.clear(), render()),
    onSelect: (id) => onSelect(id),
    onShowOnPage: (id) => void command(() => focusElement(id, true)),
    onClearHighlight: () => void command(() => focusElement(null, false)),
    onToggleSection: toggleSection,
  };

  function predictSection(): HTMLElement {
    const pm = predictedModel();
    return screen(
      'predicted',
      noticeZone(...predictedNotices(pm, predictedHandlers)),
      screenHead(PREDICTED_TITLE, { trailing: el('div', { class: 'head-group' }, predictedHeadAction(pm, predictedHandlers), pm.result ? predictedFilters(pm.result, pm, predictedHandlers) : null) }),
      predictedBody(pm, predictedHandlers, bandLimits, (band) => (bandLimits.set(band, (bandLimits.get(band) ?? 5) + 5), render())),
    );
  }

  const recordedHandlers: RecordedHandlers = {
    onRecord: () => onRecord(),
    onStop: () => onStop(),
    onClear: () => onClearSession(),
    onShowOnPage: (on) => void setView(on ? 'recorded' : 'none'),
    onLayers: (l) => onLayers(l),
    onPage: (position) => onPage(position),
    onSelect: (id, list) => onRecordedSelect(id, list),
    onFocus: (id) => void command(() => focusRecorded(id)),
    onClearFocus: () => void command(() => focusRecorded(null)),
    onToggleSection: toggleSection,
    onList: (l) => ((recList = l), recListLimits.clear(), render()),
    onToggleFilters: (open) => ((recFiltersOpen = open), render()),
    onResetFilters: () => {
      recList = 'all';
      recListLimits.clear();
      onLayers({ heatmap: true, clicks: true, scroll: true });
    },
    onMore: (list) => (recListLimits.set(list, (recListLimits.get(list) ?? 5) + 5), render()),
  };

  function recordSection(): HTMLElement {
    const rm: RecordedViewModel = { snap, session: recSession, page: recPage, selected: recSelected, selectedList: recSelectedList, list: recList, filterOpen: recFiltersOpen, listLimits: recListLimits, note: recNote, busy, canRun: canAct(), collapsed, live: recordingActive() ? liveTile() : null };
    return screen(
      'recorded',
      noticeZone(...recordedNotices(rm)),
      screenHead(RECORDED_TITLE, { trailing: el('div', { class: 'head-group' }, recordedHeadAction(rm, recordedHandlers), rm.page ? recordedFilters(rm, rm.page, recordedHandlers) : null) }),
      recordedBody(rm, recordedHandlers),
    );
  }

  // -------------------------------------------------------------------------
  // Navigation (presentation only)
  // -------------------------------------------------------------------------

  function goTo(section: Section): void {
    nav = goSection(nav, section);
    render();
    if (section !== 'overview') void syncOverlayToTab();
  }

  /** The page shows the overlay of the feature tab in view (only switches an existing one). */
  async function syncOverlayToTab(): Promise<void> {
    if (!snap || tabId() === null) return;
    const t = nav.section;
    if (t === 'predict' && snap.interactionView === 'recorded' && (snap.prediction.state === 'ready' || snap.prediction.state === 'stale')) await setView('predicted');
    else if (t === 'predict' && snap.interactionView === 'recorded') await setView('none');
    else if (t === 'record' && snap.session.state === 'ready' && snap.recorded?.pageOpen && snap.interactionView !== 'recorded') await setView('recorded');
  }


  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function command(action: () => Promise<void>): Promise<void> {
    busy = true;
    render();
    try {
      await action();
    } finally {
      busy = false;
      render();
    }
  }

  async function injected(): Promise<boolean> {
    if (!tab?.id) return false;
    const res = await api.ensureRuntime(tab);
    if (!res.ok) error = res.error;
    return res.ok;
  }

  function onPredict(): void {
    void command(async () => {
      error = null;
      if (!(await injected())) return;
      intent = 'predict';
      const res = await api.request(tab!.id!, 'RUN_PREDICTION', { source: 'sidepanel' });
      if (!res.ok) {
        error = makeError(res.error.code, res.error.message);
        intent = null;
        return;
      }
      await loadSummary();
      apply(res.data);
      // Predict → see it on the page without another click.
      const view = await api.request(tab!.id!, 'SET_INTERACTION_VIEW', { view: 'predicted' });
      if (view.ok) apply(view.data);
    });
  }

  function onClearPrediction(): void {
    void command(async () => {
      const res = await api.request(tab!.id!, 'CLEAR_PREDICTION', null);
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  function onRecord(): void {
    void command(async () => {
      error = null;
      if (!(await injected())) return;
      const res = await api.request(tab!.id!, 'START_SESSION', { source: 'sidepanel' });
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  function onStop(): void {
    intent = 'stop';
    void command(async () => {
      const res = await api.request(tab!.id!, 'STOP_SESSION', null);
      if (res.ok) apply(res.data);
      else {
        error = res.error;
        intent = null;
      }
    });
  }

  function onClearSession(): void {
    void command(async () => {
      const res = await api.request(tab!.id!, 'CLEAR_SESSION', null);
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  async function setView(view: 'none' | 'predicted' | 'recorded'): Promise<void> {
    await command(async () => {
      const res = await api.request(tab!.id!, 'SET_INTERACTION_VIEW', { view });
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  async function focusElement(id: number | null, scroll: boolean): Promise<void> {
    const res = await api.request(tab!.id!, 'FOCUS_ELEMENT', { elementId: id, scroll });
    if (!res.ok) {
      error = res.error;
      return;
    }
    apply(res.data.snapshot);
    focusNote =
      res.data.status === 'unavailable'
        ? 'No longer on the page'
        : res.data.moved
          ? 'Moved since the prediction · shown where it is now'
          : null;
  }

  function onSelect(id: number): void {
    if (selectedId === id) {
      selectedId = null;
      details = null;
      focusNote = null;
      void command(() => focusElement(null, false));
      return;
    }
    selectedId = id;
    details = null;
    focusNote = null;
    void command(async () => {
      const [d] = await Promise.all([api.request(tab!.id!, 'GET_PREDICTION_DETAILS', { elementId: id }), focusElement(id, true)]);
      if (d.ok && selectedId === id) details = d.data;
    });
  }

  function onLayers(l: RecordedLayers): void {
    void command(async () => {
      const res = await api.request(tab!.id!, 'SET_RECORDED_LAYERS', l);
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  function onPage(position: number): void {
    recSelected = null;
    recSelectedList = null;
    recNote = null;
    void command(async () => {
      const res = await api.request(tab!.id!, 'SET_RECORDED_PAGE', { page: position });
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  async function focusRecorded(id: number | null): Promise<void> {
    const res = await api.request(tab!.id!, 'FOCUS_RECORDED_ELEMENT', { page: snap?.recorded?.page ?? 0, elementId: id, scroll: id !== null });
    if (!res.ok) {
      error = res.error;
      return;
    }
    apply(res.data.snapshot);
    recNote = res.data.status === 'not-open' ? NOT_OPEN_COPY : res.data.status === 'unavailable' && recPage?.elementsLive ? 'Not on the page now' : null;
  }

  function onRecordedSelect(id: number, list?: string): void {
    recNote = null;
    if (recSelected === id && recSelectedList === (list ?? null)) {
      recSelected = null;
      recSelectedList = null;
      void command(() => focusRecorded(null));
      return;
    }
    const same = recSelected === id;
    recSelected = id;
    recSelectedList = list ?? null;
    if (same) render(); // same control from another list: just move the open row
    else void command(() => focusRecorded(id));
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  async function loadSummary(): Promise<void> {
    const id = tabId();
    if (id === null) return;
    const res = await api.request(id, 'GET_PREDICTION', null);
    const next = res.ok ? res.data : null;
    if (next?.predictionId === result?.predictionId) return;
    bandLimits.clear();
    const keep = selectedId !== null && next?.elements.some((e) => e.id === selectedId && e.band !== 'not-assessed');
    result = next;
    details = null;
    if (!keep) {
      selectedId = null;
      focusNote = null;
    } else if (selectedId !== null) {
      const d = await api.request(id, 'GET_PREDICTION_DETAILS', { elementId: selectedId });
      details = d.ok ? d.data : null;
    }
  }

  function syncRecordedData(next: TabSnapshot): void {
    const rec = next.recorded;
    if (!rec || next.session.state !== 'ready') {
      if (recSession || recPage) ((recSession = null), (recPage = null), (recSelected = null), (recSelectedList = null), (recNote = null), (recLoading = null));
      return;
    }
    const key = `${next.session.sessionId}:${rec.page}:${rec.pageOpen}`;
    const loaded = recSession && recPage ? `${recSession.sessionId}:${recPage.position}:${recPage.pageOpen}` : null;
    const id = tabId();
    if (key === loaded || key === recLoading || id === null) return;
    recLoading = key;
    void track(
      Promise.all([api.request(id, 'GET_RECORDED_SESSION', null), api.request(id, 'GET_RECORDED_PAGE', { page: rec.page })]).then(([s, p]) => {
        if (recLoading !== key) return;
        recLoading = null;
        recListLimits.clear();
        recSession = s.ok ? s.data : null;
        if (recPage?.position !== (p.ok ? p.data?.position : undefined)) ((recSelected = null), (recSelectedList = null));
        recPage = p.ok ? p.data : null;
        render();
      }),
    );
  }

  function apply(next: TabSnapshot): void {
    snap = next;
    // A session that starts (from any tab) opens the Overview Record card once per session; ticks,
    // page navigations and re-renders never touch it again, so only the user can collapse it.
    const sid = next.session.sessionId ?? null;
    if (recordingActive() && sid !== autoOpenedFor) ((autoOpenedFor = sid), overviewOpen.add('record'));
    if (next.session.error) error = next.session.error;
    const p = next.prediction;
    if (p.state === 'idle' || p.state === 'error') ((result = null), (selectedId = null), (details = null), (focusNote = null));
    else if (p.predictionId && p.predictionId !== result?.predictionId) void track(loadSummary().then(render));
    syncRecordedData(next);
    const r = route(nav, intent, next);
    // Predict / Stop finish in place: the panel stays where it is; only the page shows the new map.
    if (r.nav !== nav && r.nav.section === 'record' && next.recorded?.pageOpen && next.interactionView !== 'recorded') void setView('recorded');
    intent = r.intent;
    render();
  }

  async function refresh(): Promise<void> {
    const previousTabId = tabId();
    tab = await api.activeTab();
    const activeTabChanged = previousTabId !== null && previousTabId !== tabId();
    snap = null;
    error = null;
    ((result = null), (selectedId = null), (details = null), (focusNote = null));
    ((recSession = null), (recPage = null), (recSelected = null), (recSelectedList = null), (recNote = null), (recLoading = null));
    // A same-tab load completion (including navigation during recording) refreshes runtime data,
    // not local disclosure state. Only switching to a different tab resets the Overview cards.
    if (activeTabChanged) overviewOpen.clear();
    intent = null;
    if (tab?.id === undefined) {
      render();
      return;
    }
    const res = await api.request(tab.id, 'GET_STATE', null);
    if (res.ok) {
      if (res.data.prediction.predictionId) await loadSummary();
      apply(res.data);
      return;
    }
    render();
  }

  function onEvent(event: EventEnvelope, id: number | null): void {
    if (!tab || id !== tab.id) return;
    switch (event.type) {
      case 'STATE_CHANGED':
        apply((event as EventEnvelope<'STATE_CHANGED'>).payload.snapshot);
        return;
      case 'SESSION_TICK': {
        const s = (event as EventEnvelope<'SESSION_TICK'>).payload.summary;
        if (snap?.session.summary) snap = { ...snap, session: { ...snap.session, summary: s } };
        liveFills.forEach((f) => f(s));
        return;
      }
      case 'PREDICTION_READY':
        void track(loadSummary().then(render));
        return;
      case 'SESSION_ENDED':
        // The runtime is gone (other site / extension reload): reset to a clean Overview.
        snap = null;
        render();
        return;
    }
  }

  return {
    refresh,
    onEvent,
    render,
    inspect: () => ({ nav: { ...nav }, intent, tabId: tabId() }),
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
