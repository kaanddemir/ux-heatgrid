/**
 * HeatGrid side panel:  Overview · Predict · Record — one inspector with two modes. Event-driven (no
 * polling). Navigation only changes presentation; Predict and Record run only from explicit actions.
 * Chrome wiring lives in panel.ts; this module is testable with a fake API.
 */
import { makeError, type HeatGridError, type SessionSummary, type TabSnapshot } from '../../shared/model';
import type { PredictionElementDetails, PredictionSummaryResult } from '../../content/prediction/types';
import type { RecordedLayers, RecordedPageView, RecordedSessionView } from '../../content/recorded/types';
import type { EventEnvelope, RequestMap, RequestType, Response } from '../../shared/protocol';
import { el, errorText, mount } from '../shared/render';
import { icon, type IconName } from '../shared/icons';
import { BAND_COPY } from '../shared/predictionCopy';
import { NOT_OPEN_COPY, itemLabel, shortMeta } from '../shared/recordedCopy';
import { INITIAL_NAV, SECTIONS, formatDuration, goSection, route, type Intent, type NavState, type Section } from './model';
import { predictedBody, predictedHeadAction, predictedWarnings, predictionSummary, type PredictedHandlers, type PredictedModel } from './predictedView';
import { recordedBody, recordedHeadAction, recordedWarnings, recordingSummary, stopButton, type RecordedHandlers, type RecordedViewModel } from './recordedView';
import { button, dismissPopover, noticePanel, previewList, screen, screenHead, summary, tablist, type NoticeIssue } from './ui';
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

/** Mode title on its inspector screen (the tab label, so the two never disagree). */
const TITLE: Record<Exclude<Section, 'overview'>, string> = { predict: 'Predict', record: 'Record' };

export function createPanelApp(root: HTMLElement, api: PanelApi): PanelApp {
  let tab: chrome.tabs.Tab | null = null;
  let snap: TabSnapshot | null = null;
  let error: HeatGridError | null = null;
  let busy = false;
  let nav: NavState = { ...INITIAL_NAV };
  let intent: Intent = null;
  let refreshGeneration = 0;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  };

  // Predict
  let result: PredictionSummaryResult | null = null;
  let filter: Filter = 'all';
  let kind: KindFilter = 'all';
  let predFiltersOpen = false;
  let selectedId: number | null = null;
  let details: PredictionElementDetails | null = null;
  let focusNote: string | null = null;
  const bandLimits = new Map<string, number>();
  /** Collapsed result groups (Predict bands, Record lists); presentation only, kept across renders. */
  const collapsed = new Set<string>();
  const expandedNotices = new Set<Section>();
  const announcedNoticeSignatures = new Map<Section, string>();
  const toggleSection = (id: string): void => {
    if (!collapsed.delete(id)) collapsed.add(id);
    render();
  };
  // Record
  let recSession: RecordedSessionView | null = null;
  let recPage: RecordedPageView | null = null;
  let recSelected: number | null = null;
  let recFiltersOpen = false;
  const recListLimits = new Map<string, number>();
  let recNote: string | null = null;
  let recLoading: string | null = null;
  /** Overview mode panels open independently; actions inside one never disturb the other. */
  type ModePanel = 'predict' | 'record';
  const overviewOpen = new Set<ModePanel>();
  let autoOpenedFor: string | null = null;
  const toggleOverviewCard = (card: ModePanel): void => {
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
    fillLive();
    if (activeKey) root.querySelector<HTMLElement>(`[data-key="${activeKey.replace(/"/g, '')}"]`)?.focus();
  }

  function header(): HTMLElement {
    return el(
      'header',
      { class: 'appbar' },
      el('div', { class: 'appbar-row' }, el('div', { class: 'brand' }, el('img', { class: 'brand-mark', attrs: { src: '../icons/icon32.png', alt: '', width: '20', height: '20' } }), el('span', { class: 'brand-name', text: 'HeatGrid' })), livePill()),
      tablist('HeatGrid sections', SECTIONS.map((s) => ({ id: s.id, text: s.label, selected: nav.section === s.id, controls: 'main-view', onSelect: () => goTo(s.id) })), 'nav'),
    );
  }

  /** App-bar status while recording, on screens that don't already show the live block → Record. */
  function livePill(): HTMLElement | null {
    const onLive = nav.section === 'record' || (nav.section === 'overview' && overviewOpen.has('record'));
    if (!recordingActive() || onLive) return null;
    const processing = sessionState() === 'processing';
    const time = el('span', { class: 'live-pill-time', text: processing ? 'Processing…' : '' });
    if (!processing) liveFills.push((s) => (time.textContent = formatDuration(s?.elapsedMs ?? 0)));
    const b = el('button', { class: 'live-pill', attrs: { 'aria-label': 'Recording · open Record' }, on: { click: () => goTo('record') } }, processing ? el('span', { class: 'spinner' }) : el('span', { class: 'rec-dot', attrs: { 'aria-hidden': 'true' } }), time);
    b.type = 'button';
    b.dataset.key = 'live-pill';
    return b;
  }

  function main(): HTMLElement {
    const body = nav.section === 'predict' ? predictSection() : nav.section === 'record' ? recordSection() : overviewSection();
    return el(
      'main',
      { class: 'view', attrs: { id: 'main-view', role: 'tabpanel', 'aria-label': SECTIONS.find((s) => s.id === nav.section)!.label } },
      nav.section === 'overview' ? activeNotice('overview', globalWarnings()) : null,
      body,
    );
  }

  const globalWarnings = (): NoticeIssue[] => error ? [{ id: `app-${error.code}`, severity: 'critical', message: errorText(error) }] : [];
  const activeNotice = (section: Section, issues: NoticeIssue[]): HTMLElement | null => {
    const signature = issues.map((issue) => `${issue.id}:${issue.severity}`).sort().join('|');
    const announce = !!signature && announcedNoticeSignatures.get(section) !== signature;
    announcedNoticeSignatures.set(section, signature);
    return noticePanel(issues, {
      expanded: expandedNotices.has(section),
      onExpandedChange: (open) => ((open ? expandedNotices.add(section) : expandedNotices.delete(section)), render()),
      announce,
    });
  };

  const fillLive = (): void => liveFills.forEach((f) => f(snap?.session.summary ?? null));

  /**
   * The live recording block — one component on Overview and on the Record screen: a restrained
   * status line (dot · state · pages) over the same summary cells the finished report uses.
   */
  function liveBlock(): HTMLElement {
    const st = sessionState();
    const processing = st === 'processing';
    const pages = snap?.session.recording?.segmentCount ?? 1;
    const cell = (label: string, read: (s: SessionSummary | null) => string) => ({ label, value: '', live: (n: HTMLElement) => void liveFills.push((s) => (n.textContent = read(s))) });
    return el(
      'div',
      { class: 'live', attrs: { role: 'group', 'aria-label': 'Recording', 'data-kind': 'recorded' } },
      el(
        'p',
        { class: 'live-status', attrs: { role: 'status' } },
        processing ? el('span', { class: 'spinner' }) : el('span', { class: 'rec-dot', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'live-state', text: processing ? 'Processing' : st === 'preparing' ? 'Preparing…' : 'Recording' }),
        pages > 1 ? el('span', { class: 'live-pages', text: `${pages} pages` }) : null,
      ),
      summary('Live recording', [
        cell('Duration', (s) => formatDuration(s?.elapsedMs ?? 0)),
        cell('Clicks', (s) => String(s?.clicks ?? 0)),
        cell('Scroll', (s) => `${Math.round((s?.scrollDepth ?? 0) * 100)}%`),
      ]),
      el('p', { class: 'caption', text: processing ? 'Building the report…' : 'Use the page as usual. Results appear when you stop.' }),
    );
  }

  // ---- Overview -----------------------------------------------------------

  /**
   * Overview mode section: one header row (icon · name · action · chevron) whose whole surface is the
   * expand toggle — the same full-row mechanics as inspector rows — and the existing report below.
   */
  function modePanel(panel: ModePanel, ic: IconName, title: string, action: HTMLElement | null, body: () => Array<HTMLElement | null>): HTMLElement {
    const open = overviewOpen.has(panel);
    const bodyId = `ov-${panel}-report`;
    const toggle = el('button', { class: 'mode-toggle', attrs: { type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId, 'aria-label': title }, on: { click: () => toggleOverviewCard(panel) } });
    toggle.dataset.key = `ov-${panel}`;
    return el(
      'section',
      { class: open ? 'mode is-open' : 'mode', attrs: { 'data-kind': panel === 'predict' ? 'predicted' : 'recorded', 'aria-label': title } },
      el(
        'div',
        { class: 'mode-head' },
        toggle,
        el('span', { class: 'mode-icon', attrs: { 'aria-hidden': 'true' } }, icon(ic)),
        el('span', { class: 'mode-title', attrs: { 'aria-hidden': 'true' }, text: title }),
        action,
        icon('chevron', 'icon chev'),
      ),
      open ? el('div', { class: 'mode-body', attrs: { id: bodyId } }, ...body()) : null,
    );
  }

  const openReport = (section: Section, key: string): HTMLButtonElement => button('Open full report', () => goTo(section), true, { key, subtle: true, after: 'arrow' });

  const status = (text: string): HTMLElement => el('p', { class: 'meta', text });

  function predictPreview(): Array<HTMLElement | null> {
    if (!result) {
      const st = snap?.prediction.state;
      return [status(st === 'analyzing' ? 'Analysing page structure…' : st === 'error' ? 'Prediction could not be completed.' : 'No prediction yet.')];
    }
    const report = result;
    const rows = report.elements.filter((e) => e.band !== 'not-assessed').slice(0, 3).map((e) => ({ label: rowModel(report, e).label, meta: BAND_COPY[e.band] }));
    return [
      snap?.prediction.state === 'stale' ? noticePanel([{ id: 'prediction-stale', severity: 'action', message: 'Page changed', action: button('Run again', () => (overviewOpen.add('predict'), onPredict()), canAct() && !recordingActive(), { key: 'ov-predict-again', subtle: true }) }]) : null,
      predictionSummary(report.summary),
      previewList(rows),
      openReport('predict', 'ov-open-predict'),
    ];
  }

  function recordPreview(): Array<HTMLElement | null> {
    if (recordingActive()) return [liveBlock()];
    if (!recSession) return [snap?.session.state === 'error' ? noticePanel([{ id: 'recording-failed', severity: 'critical', message: 'Recording could not be processed.' }]) : status('No recording yet.')];
    const rows = recPage ? recPage.lists.mostInteracted.slice(0, 3).map((i) => ({ label: itemLabel(i), meta: shortMeta(i, 'mostInteracted') })) : [];
    return [recordingSummary(recSession, recPage), previewList(rows), openReport('record', 'ov-open-record')];
  }

  /** Page identity: title + host on one compact block (full address on hover). */
  function pageIdentity(): HTMLElement {
    let host = '';
    try {
      host = tab?.url ? new URL(tab.url).host : '';
    } catch {
      host = '';
    }
    return el(
      'div',
      { class: 'page-id', attrs: { title: tab?.url ?? '' } },
      el('span', { class: 'page-icon', attrs: { 'aria-hidden': 'true' } }, icon('page')),
      el('span', { class: 'page-text' }, el('span', { class: 'page-title', text: tab?.title || 'This page' }), host ? el('span', { class: 'page-host', text: host }) : null),
    );
  }

  function overviewSection(): HTMLElement {
    const analysing = snap?.prediction.state === 'analyzing';
    const live = recordingActive();
    const predictStart = button(analysing ? 'Running…' : 'Start', () => (overviewOpen.add('predict'), onPredict()), canAct() && !live && !analysing, { key: 'ov-start-predict', primary: true });
    const recordAction = live ? stopButton(sessionState(), busy, onStop) : button('Start', () => (overviewOpen.add('record'), onRecord()), canAct(), { key: 'ov-start-record', primary: true });
    return screen(
      'overview',
      pageIdentity(),
      el('div', { class: 'modes' }, modePanel('predict', 'predict', 'Predict', predictStart, predictPreview), modePanel('record', 'record', 'Record', recordAction, recordPreview)),
    );
  }

  // ---- Predict / Record ---------------------------------------------------

  function predictedModel(): PredictedModel {
    return { snap, result, filter, kind, filterOpen: predFiltersOpen, selectedId, details, focusNote, busy, canRun: canAct() && !recordingActive(), collapsed };
  }

  const resetPredictLists = (): void => bandLimits.clear();
  const predictedHandlers: PredictedHandlers = {
    onRun: () => onPredict(),
    onClear: () => onClearPrediction(),
    onShowOverlay: (on) => void setView(on ? 'predicted' : 'none'),
    onFilter: (f) => ((filter = f), resetPredictLists(), render()),
    onKind: (k) => ((kind = k), resetPredictLists(), render()),
    onToggleFilters: (open) => ((predFiltersOpen = open), render()),
    onResetFilters: () => ((filter = 'all'), (kind = 'all'), resetPredictLists(), render()),
    onSelect: (id) => onSelect(id),
    onShowOnPage: (id) => void command((tid) => focusElement(tid, id, true)),
    onClearHighlight: () => void command((tid) => focusElement(tid, null, false)),
    onToggleSection: toggleSection,
  };

  function predictSection(): HTMLElement {
    const pm = predictedModel();
    return screen(
      'predicted',
      activeNotice('predict', [...globalWarnings(), ...predictedWarnings(pm, predictedHandlers)]),
      screenHead(TITLE.predict, { trailing: predictedHeadAction(pm, predictedHandlers) }),
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
    onSelect: (id) => onRecordedSelect(id),
    onFocus: (id) => void command((tid) => focusRecorded(tid, id)),
    onClearFocus: () => void command((tid) => focusRecorded(tid, null)),
    onToggleSection: toggleSection,
    onToggleFilters: (open) => ((recFiltersOpen = open), render()),
    onResetFilters: () => onLayers({ heatmap: true, clicks: true, scroll: true }),
    onMore: (list) => (recListLimits.set(list, (recListLimits.get(list) ?? 5) + 5), render()),
  };

  function recordSection(): HTMLElement {
    const rm: RecordedViewModel = { snap, session: recSession, page: recPage, selected: recSelected, filterOpen: recFiltersOpen, listLimits: recListLimits, note: recNote, busy, canRun: canAct(), collapsed, live: recordingActive() ? liveBlock() : null };
    return screen('recorded', activeNotice('record', [...globalWarnings(), ...recordedWarnings(rm, recordedHandlers)]), screenHead(TITLE.record, { trailing: recordedHeadAction(rm, recordedHandlers) }), recordedBody(rm, recordedHandlers));
  }

  // -------------------------------------------------------------------------
  // Navigation (presentation only)
  // -------------------------------------------------------------------------

  function goTo(section: Section): void {
    if (section !== nav.section) {
      dismissPopover();
      predFiltersOpen = false;
      recFiltersOpen = false;
    }
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

  /** A command's tab stopped being the active tab: its response belongs to another page. */
  const TAB_CHANGED = Symbol('tab-changed');

  /** Request pinned to the command's tab; drops the response if the user switched tabs meanwhile. */
  async function req<T extends RequestType>(id: number, type: T, payload: RequestMap[T]['payload']): Promise<Response<RequestMap[T]['data']>> {
    const res = await api.request(id, type, payload);
    if (tabId() !== id) throw TAB_CHANGED;
    return res;
  }

  async function command(action: (id: number) => Promise<void>): Promise<void> {
    const id = tabId();
    if (id === null) return;
    busy = true;
    render();
    try {
      await action(id);
    } catch (e) {
      if (e !== TAB_CHANGED) throw e;
    } finally {
      busy = false;
      render();
    }
  }

  async function injected(id: number): Promise<boolean> {
    if (!tab || tab.id !== id) return false;
    const res = await api.ensureRuntime(tab);
    if (tabId() !== id) throw TAB_CHANGED;
    if (!res.ok) error = res.error;
    return res.ok;
  }

  function onPredict(): void {
    void command(async (id) => {
      error = null;
      if (!(await injected(id))) return;
      intent = 'predict';
      const res = await req(id, 'RUN_PREDICTION', { source: 'sidepanel' });
      if (!res.ok) {
        error = makeError(res.error.code, res.error.message);
        intent = null;
        return;
      }
      await loadSummary();
      apply(res.data);
      // Predict → see it on the page without another click.
      const view = await req(id, 'SET_INTERACTION_VIEW', { view: 'predicted' });
      if (view.ok) apply(view.data);
    });
  }

  function onClearPrediction(): void {
    void command(async (id) => {
      const res = await req(id, 'CLEAR_PREDICTION', null);
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  function onRecord(): void {
    void command(async (id) => {
      error = null;
      if (!(await injected(id))) return;
      const res = await req(id, 'START_SESSION', { source: 'sidepanel' });
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  function onStop(): void {
    intent = 'stop';
    void command(async (id) => {
      const res = await req(id, 'STOP_SESSION', null);
      if (res.ok) apply(res.data);
      else {
        error = res.error;
        intent = null;
      }
    });
  }

  function onClearSession(): void {
    void command(async (id) => {
      const res = await req(id, 'CLEAR_SESSION', null);
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  async function setView(view: 'none' | 'predicted' | 'recorded'): Promise<void> {
    await command(async (id) => {
      const res = await req(id, 'SET_INTERACTION_VIEW', { view });
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  async function focusElement(tid: number, id: number | null, scroll: boolean): Promise<void> {
    const res = await req(tid, 'FOCUS_ELEMENT', { elementId: id, scroll });
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
      void command((tid) => focusElement(tid, null, false));
      return;
    }
    selectedId = id;
    details = null;
    focusNote = null;
    void command(async (tid) => {
      const [d] = await Promise.all([req(tid, 'GET_PREDICTION_DETAILS', { elementId: id }), focusElement(tid, id, true)]);
      if (d.ok && selectedId === id && d.data?.predictionId === result?.predictionId) details = d.data;
    });
  }

  function onLayers(l: RecordedLayers): void {
    void command(async (id) => {
      const res = await req(id, 'SET_RECORDED_LAYERS', l);
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  function onPage(position: number): void {
    recSelected = null;
    recNote = null;
    void command(async (id) => {
      const res = await req(id, 'SET_RECORDED_PAGE', { page: position });
      if (res.ok) apply(res.data);
      else error = res.error;
    });
  }

  async function focusRecorded(tid: number, id: number | null): Promise<void> {
    const res = await req(tid, 'FOCUS_RECORDED_ELEMENT', { page: snap?.recorded?.page ?? 0, elementId: id, scroll: id !== null });
    if (!res.ok) {
      error = res.error;
      return;
    }
    apply(res.data.snapshot);
    recNote = res.data.status === 'not-open' ? NOT_OPEN_COPY : res.data.status === 'unavailable' && recPage?.elementsLive ? 'Not on the page now' : null;
  }

  function onRecordedSelect(id: number): void {
    recNote = null;
    if (recSelected === id) {
      recSelected = null;
      void command((tid) => focusRecorded(tid, null));
      return;
    }
    recSelected = id;
    void command((tid) => focusRecorded(tid, id));
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  async function loadSummary(forTabId = tabId()): Promise<void> {
    const id = forTabId;
    if (id === null) return;
    const res = await api.request(id, 'GET_PREDICTION', null);
    if (tabId() !== id) return;
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
      details = d.ok && d.data?.predictionId === next?.predictionId ? d.data : null;
    }
  }

  function syncRecordedData(next: TabSnapshot): void {
    const rec = next.recorded;
    if (!rec || next.session.state !== 'ready') {
      if (recSession || recPage) ((recSession = null), (recPage = null), (recSelected = null), (recNote = null), (recLoading = null));
      return;
    }
    const key = `${next.session.sessionId}:${rec.page}:${rec.pageOpen}`;
    const loaded = recSession && recPage ? `${recSession.sessionId}:${recPage.position}:${recPage.pageOpen}` : null;
    const id = tabId();
    if (key === loaded || key === recLoading || id === null) return;
    recLoading = key;
    void track(
      Promise.all([api.request(id, 'GET_RECORDED_SESSION', null), api.request(id, 'GET_RECORDED_PAGE', { page: rec.page })]).then(([s, p]) => {
        if (tabId() !== id || recLoading !== key) return;
        recLoading = null;
        recListLimits.clear();
        recSession = s.ok ? s.data : null;
        if (recPage?.position !== (p.ok ? p.data?.position : undefined)) recSelected = null;
        recPage = p.ok ? p.data : null;
        render();
      }),
    );
  }

  function apply(next: TabSnapshot): void {
    // Staleness is monotonic for one prediction. A slower focus/view command may carry an older
    // ready snapshot, but only a new prediction id can make structural evidence current again.
    if (snap?.prediction.state === 'stale' && next.prediction.state === 'ready' && next.prediction.predictionId === snap.prediction.predictionId) {
      next = { ...next, prediction: snap.prediction };
    }
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
    const generation = ++refreshGeneration;
    const previousTabId = tabId();
    const nextTab = await api.activeTab();
    if (generation !== refreshGeneration) return;
    tab = nextTab;
    const nextTabId = nextTab?.id;
    const activeTabChanged = previousTabId !== null && previousTabId !== tabId();
    snap = null;
    error = null;
    ((result = null), (selectedId = null), (details = null), (focusNote = null));
    ((recSession = null), (recPage = null), (recSelected = null), (recNote = null), (recLoading = null));
    // A same-tab load completion (including navigation during recording) refreshes runtime data,
    // not local disclosure state. Only switching to a different tab resets the Overview cards.
    if (activeTabChanged) overviewOpen.clear();
    intent = null;
    if (nextTabId === undefined) {
      render();
      return;
    }
    const res = await api.request(nextTabId, 'GET_STATE', null);
    if (generation !== refreshGeneration || tabId() !== nextTabId) return;
    if (res.ok) {
      if (res.data.prediction.predictionId) await loadSummary(nextTabId);
      if (generation !== refreshGeneration || tabId() !== nextTabId) return;
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
