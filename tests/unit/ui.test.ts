// @vitest-environment happy-dom
/**
 * Side-panel UI (Overview · Predict · Record). Pure navigation/overview model, plus the real panel app driven
 * against a real TabRuntime (fixture page) through an in-memory API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { startRecorder } from '../../src/content/recorder';
import { createTabRuntime } from '../../src/content/tabRuntime';
import type { RecordedPageView, RecordedSessionView } from '../../src/content/recorded/types';
import type { TabSnapshot } from '../../src/shared/model';
import { makeEvent, makeRequest, type RequestEnvelope, type Response } from '../../src/shared/protocol';
import { createPanelApp, type PanelApi } from '../../src/ui/sidepanel/app';
import { INITIAL_NAV, SECTIONS, formatDuration, overviewModel, route } from '../../src/ui/sidepanel/model';
import { recordedBody, recordedFilters, recordedHeadAction, recordedWarnings } from '../../src/ui/sidepanel/recordedView';
import { button, noticePanel } from '../../src/ui/sidepanel/ui';
import { cleanSubject } from '../../src/ui/shared/regionLabel';
import { fixtureReader, mount } from '../helpers/fixtureReader';

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

const snapshot = (o: { prediction?: Partial<TabSnapshot['prediction']>; session?: Partial<TabSnapshot['session']>; recorded?: TabSnapshot['recorded'] } = {}): TabSnapshot => ({
  buildId: 'b',
  session: { buildId: 'b', state: 'idle', sessionId: null, summary: null, result: null, error: null, recording: null, ...o.session },
  prediction: { state: 'idle', predictionId: null, predictorId: null, createdAt: null, summary: null, staleReason: null, error: null, ...o.prediction },
  interactionView: 'none',
  overlay: { showLow: false, focusedElementId: null },
  recorded: o.recorded ?? null,
});
const capture = (o: Record<string, unknown>) => ({ kind: 'capture' as const, elapsedMs: 102_000, activeMs: 79_000, pointerSamples: 10, clicks: 8, activations: 0, pages: 1, deepestScroll: 0.72, controlsReached: 14, controlsInteracted: 6, regionsInteracted: 2, limitations: [], ...o });

describe('Panel navigation model', () => {
  it('three top-level destinations; Predict routes to Predict when ready; Stop routes to Record only after processing', () => {
    expect(SECTIONS.map((x) => x.label)).toEqual(['Overview', 'Predict', 'Record']);
    expect(INITIAL_NAV).toEqual({ section: 'overview' });
    const p = route(INITIAL_NAV, 'predict', snapshot({ prediction: { state: 'ready', predictionId: 'p' } }));
    expect(p).toEqual({ nav: { section: 'predict' }, intent: null });
    const processing = route(INITIAL_NAV, 'stop', snapshot({ session: { state: 'processing' } }));
    expect(processing).toEqual({ nav: INITIAL_NAV, intent: 'stop' }); // real state, no fake progress
    const rec = { page: 0, pageCount: 1, layers: { heatmap: true, clicks: true, scroll: true }, focusedElementId: null, pageOpen: true };
    expect(route(INITIAL_NAV, 'stop', snapshot({ session: { state: 'ready' }, recorded: rec })).nav).toEqual({ section: 'record' });
    expect(route(INITIAL_NAV, 'stop', snapshot({ session: { state: 'error' } }))).toEqual({ nav: INITIAL_NAV, intent: null });
  });

  it('Overview summaries are compact facts (single vs multi-page), never scores', () => {
    const one = overviewModel(snapshot({ session: { state: 'ready', result: capture({}) }, prediction: { state: 'ready', summary: { assessed: 22, notAssessed: 0, high: 3, medium: 11, low: 8 } } }));
    expect(one).toEqual({ predicted: { line: '3 High · 11 Medium · 8 Low', stale: false }, recorded: { line: '1m 42s · 8 clicks · 72% scroll' }, recording: null });
    const multi = overviewModel(snapshot({ session: { state: 'ready', result: capture({ elapsedMs: 138_000, pages: 3, clicks: 14, deepestScroll: null }) } }));
    expect(multi.recorded!.line).toBe('2m 18s · 3 pages · 14 clicks');
    expect(overviewModel(snapshot({ session: { state: 'recording', recording: { segmentCount: 2, currentSegmentIndex: 1, continuity: 'continuous' } } })).recording).toEqual({ state: 'recording', pages: 2 });
    expect([formatDuration(42_000), formatDuration(102_000), formatDuration(3_780_000)]).toEqual(['42s', '1m 42s', '1h 03m']);
    expect(JSON.stringify([one, multi])).not.toMatch(/score|grade|engagement/i);
  });
});

describe('Unified warning notice', () => {
  it('prioritises and de-duplicates issues, keeps the primary action visible, and expands in place', () => {
    let expanded = false;
    let recovered = 0;
    let toggles = 0;
    const issues = [
      { id: 'layout', severity: 'warning' as const, message: 'Layout changed' },
      { id: 'failed', severity: 'critical' as const, message: 'Recording interrupted', action: button('Try again', () => recovered++, true) },
      { id: 'layout', severity: 'info' as const, message: 'Duplicate layout copy' },
    ];
    const renderNotice = () => noticePanel(issues, { expanded, onExpandedChange: (open) => ((expanded = open), toggles++) })!;
    let notice = renderNotice();
    expect(notice.dataset.severity).toBe('critical');
    expect(notice.querySelector('.notice-message')!.textContent).toBe('Recording interrupted');
    expect(notice.querySelector('.notice-count')!.textContent).toBe('2 issues detected');
    notice.querySelector<HTMLButtonElement>('.notice-action button')!.click();
    expect([recovered, toggles]).toEqual([1, 0]);
    notice.querySelector<HTMLButtonElement>('.notice-toggle')!.click();
    expect([expanded, toggles]).toEqual([true, 1]);
    notice = renderNotice();
    expect(notice.querySelectorAll('.notice-list li')).toHaveLength(1);
    expect(notice.textContent).not.toContain('Duplicate layout copy');
  });

  it('renders one issue without a count or disclosure control', () => {
    const notice = noticePanel([{ id: 'stale', severity: 'action', message: 'Page changed' }])!;
    expect(notice.querySelector('.notice-count')).toBeNull();
    expect(notice.querySelector('.notice-toggle')).toBeNull();
    expect(notice.getAttribute('role')).toBe('status');
  });

  it('suppresses ordinary recording states but preserves meaningful completeness warnings', () => {
    const session: RecordedSessionView = {
      sessionId: 's', startedAt: 0, endedAt: 1, elapsedMs: 4000, activeMs: 3000,
      totals: { clicks: 0, activations: 0, pages: 1, controlsInteracted: 0 }, deepestScroll: 0,
      pages: [], selectedPage: 0,
      limitations: ['MULTI_PAGE_SESSION_COARSENED'],
      timings: { processMs: 1, perPageMs: [] },
    };
    const page: RecordedPageView = {
      position: 0, pageCount: 1, path: '/', title: 'P', pageOpen: true, elementsLive: true, layoutMayHaveChanged: false,
      facts: { elapsedMs: 4000, activeMs: 3000, clicks: 0, activations: 0, pointerSamples: 0, controlsReached: 0, controlsInteracted: 0, maybeNotClickable: 0, deepestScroll: 0, nestedScroll: [] },
      lists: { mostInteracted: [], clicked: [], mostHovered: [], inViewNoInteraction: [], neverReached: { count: 0, items: [] } },
      maybeNotClickable: [], limitations: ['SHORT_SESSION', 'FEW_EVENTS', 'FRAMES_UNSUPPORTED'],
    };
    const warnings = recordedWarnings({ snap: snapshot({ session: { state: 'ready' } }), session, page, selected: null, note: null, busy: false });
    expect(warnings.map((warning) => warning.id)).toEqual(['recording-limit-multi_page_session_coarsened', 'recording-limit-frames_unsupported']);
  });
});

// ---------------------------------------------------------------------------
// Panel app against a real runtime
// ---------------------------------------------------------------------------

function rectFromAttr(this: Element): DOMRect {
  const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
const originalRect = Element.prototype.getBoundingClientRect;
class NoIO {
  observe(): void {}
  disconnect(): void {}
}
const PAGE = `<main data-rect="0 0 1280 2400"><section data-rect="0 0 1280 300"><h1 data-rect="20 20 400 40">Hero</h1>
  ${[1, 2, 3, 4, 5, 6, 7].map((i) => `<button id="b${i}" data-rect="${20 + (i - 1) * 64} 100 60 30">Item ${i}</button>`).join('')}
  <a id="cta" href="#" data-rect="20 200 220 56">Start trial</a></section></main>`;

function setup() {
  mount(PAGE);
  const analyzer = createPageAnalyzer({ reader: fixtureReader({ docHeight: 2400 }) });
  const rt = createTabRuntime({
    buildId: 'test',
    emit: (e) => queueMicrotask(() => app.onEvent(e, 1)),
    analyzer,
    createWatcher: () => ({ arm: () => {}, disarm: () => {}, dispose: () => {} }),
    createOverlay: () => ({ setVisible: () => {}, setPrediction: () => {}, setStale: () => {}, setShowLow: () => {}, select: () => {}, dispose: () => {} }),
    createRecordedOverlay: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
    createRecorder: (a) => startRecorder({ analyzer: a, IntersectionObserver: NoIO as never }),
  });
  const sent: string[] = [];
  const api: PanelApi = {
    request: async (_tab, type, payload) => (sent.push(type), rt.handle(makeRequest(type, payload) as RequestEnvelope) as Response<never>),
    ensureRuntime: async () => ({ ok: true, data: { injected: false } }),
    activeTab: async () => ({ id: 1, windowId: 1, url: 'https://example.test/' }) as chrome.tabs.Tab,
  };
  const root = document.createElement('div'); // detached: never part of the analysed page
  const app = createPanelApp(root, api);
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await app.idle();
    }
  };
  const btn = (text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const click = async (text: string) => {
    const b = btn(text) ?? root.querySelector<HTMLButtonElement>(`[data-key="${text}"]`) ?? undefined;
    if (!b) throw new Error(`no button "${text}" in: ${root.textContent}`);
    b.click();
    await settle();
  };
  const tab = (id: string) => root.querySelector<HTMLButtonElement>(`[data-key="${id}"]`)!;
  const state = () => (rt.handle(makeRequest('GET_STATE', null) as RequestEnvelope) as { data: TabSnapshot }).data;
  return { rt, app, root, sent, settle, btn, click, tab, state };
}

describe('Panel app', () => {
  beforeEach(() => { Element.prototype.getBoundingClientRect = rectFromAttr; });
  afterEach(() => { Element.prototype.getBoundingClientRect = originalRect; vi.restoreAllMocks(); });

  const heads = (root: HTMLElement) => [...root.querySelectorAll('.screen > *')].map((n) => n.className.split(' ')[0]);

  it('ignores an older refresh that resolves after a newer active-tab refresh', async () => {
    const activeResolvers: Array<(tab: chrome.tabs.Tab) => void> = [];
    const api: PanelApi = {
      activeTab: () => new Promise((resolve) => activeResolvers.push(resolve)),
      ensureRuntime: async () => ({ ok: true, data: { injected: false } }),
      request: async () => ({ ok: true, data: snapshot() }) as never,
    };
    const root = document.createElement('div');
    const app = createPanelApp(root, api);
    const older = app.refresh();
    const newer = app.refresh();
    activeResolvers[1]!({ id: 2, windowId: 1, title: 'New tab', url: 'https://new.example/' } as chrome.tabs.Tab);
    await newer;
    activeResolvers[0]!({ id: 1, windowId: 1, title: 'Old tab', url: 'https://old.example/' } as chrome.tabs.Tab);
    await older;
    expect(app.inspect().tabId).toBe(2);
    expect(root.querySelector('.page-host')!.textContent).toBe('new.example');
  });

  it('opens on Overview: page identity + Predict + Record panels, collapsed; no Coach, no developer UI', async () => {
    const { app, root, settle } = setup();
    await app.refresh();
    await settle();
    const tabs = [...root.querySelectorAll('[role="tablist"][aria-label="HeatGrid sections"] [role="tab"]')];
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['Overview', 'true'], ['Predict', 'false'], ['Record', 'false']]);
    expect(root.querySelector('.page-id .page-host')!.textContent).toBe('example.test');
    const toggles = [...root.querySelectorAll<HTMLButtonElement>('button.mode-toggle')];
    expect(toggles.map((a) => a.dataset.key)).toEqual(['ov-predict', 'ov-record']);
    expect(toggles.map((a) => a.getAttribute('aria-label'))).toEqual(['Predict', 'Record']);
    expect([...root.querySelectorAll('.mode-head .mode-title')].map((e) => e.textContent)).toEqual(['Predict', 'Record']);
    expect(root.querySelectorAll('.modes > .mode')).toHaveLength(2); // one surface, two stacked sections
    expect(root.querySelectorAll('.mode-head button')).toHaveLength(4); // toggle + action per head; no separate chevron button
    expect(toggles.every((a) => a.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect([...root.querySelectorAll('.mode')].map((m) => m.getAttribute('data-kind'))).toEqual(['predicted', 'recorded']);
    expect(root.querySelector('.mode-body')).toBeNull();
    expect(root.querySelector('[data-key="ov-start-predict"]')!.textContent).toBe('Start');
    expect(root.querySelector('[data-key="ov-start-record"]')!.textContent).toBe('Start');
    expect(root.textContent).not.toMatch(/coach|finding|interaction/i);
    expect(root.querySelector('[data-kind="coach"], [data-key*="coach"], [data-key="nav-interaction"], [data-key^="itab-"]')).toBeNull();
    expect(root.querySelector('details.app-dev, pre')).toBeNull();
    expect(root.textContent).not.toMatch(/Developer details|Analysis JSON|Raw state|Run analyzer|build|protocol|Phase \d/i);
    expect([...root.querySelectorAll('button')].every((b) => b.type === 'button')).toBe(true);
  });

  it('Predict panel only expands; Start runs without toggling the panel; full report opens the Predict tab', async () => {
    const { app, root, settle, click, state, sent } = setup();
    await app.refresh();
    sent.length = 0;
    await click('ov-predict');
    expect(sent).not.toContain('RUN_PREDICTION');
    expect(root.querySelector('#ov-predict-report > .meta')!.textContent).toBe('No prediction yet.');
    await click('ov-predict'); // collapse, then Start from the closed head
    await click('ov-start-predict');
    expect(app.inspect().nav).toEqual({ section: 'overview' });
    expect(state().interactionView).toBe('predicted');
    expect(root.querySelector('[data-key="ov-predict"]')!.getAttribute('aria-expanded')).toBe('true'); // Start opens; the click never bubbled into a toggle
    // Overview uses the same summary component as the Predict screen.
    expect(root.querySelector('#ov-predict-report .summary [data-band="high"]')).not.toBeNull();
    expect(root.querySelectorAll('#ov-predict-report .preview li').length).toBeGreaterThan(0);
    // Panels are independent.
    await click('ov-record');
    expect(root.querySelector('#ov-predict-report')).not.toBeNull();
    expect(root.querySelector('#ov-record-report')).not.toBeNull();
    await click('ov-record');
    expect(root.querySelector('#ov-predict-report')).not.toBeNull();
    await click('ov-open-predict');
    expect(app.inspect().nav).toEqual({ section: 'predict' });
    expect(root.querySelector('[data-key="nav-predict"]')!.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('[data-key^="itab-"]')).toBeNull(); // no sub-navigation
    // Shared inspector frame: head · summary · groups · footer.
    expect(heads(root)).toEqual(['ihead', 'summary', 'groups', 'foot']);
    expect(root.querySelector('.ihead-title')!.textContent).toBe('Predict');
    expect([...root.querySelectorAll('.ihead-actions [data-key]')].map((e) => (e as HTMLElement).dataset.key)).toEqual(['overlay', 'filter-toggle']);
    expect(root.querySelector('.summary .caption')).toBeNull(); // no caption under the band counts
    expect([...root.querySelectorAll('.foot .btn')].map((b) => (b as HTMLElement).dataset.key)).toEqual(['clear', 'predict-rerun']); // re-run right of reset
    expect(root.textContent).not.toMatch(/score|probability|attention|engagement|likely to click/i);
    await settle();
  });

  it('switching views never runs an engine and keeps filters and the overlay choice', async () => {
    const { app, root, sent, settle, click, tab, state } = setup();
    await app.refresh();
    await click('ov-start-predict');
    tab('nav-predict').click();
    await settle();
    await click('filter-toggle');
    const chosen = root.querySelector<HTMLElement>('[data-key^="kind-"]:not([data-key="kind-all"])')!;
    const chosenKey = chosen.dataset.key!;
    chosen.click();
    await settle();
    expect(root.querySelectorAll('.row').length).toBeGreaterThan(0);
    const overlay = root.querySelector('[data-key="overlay"]') as HTMLInputElement;
    expect(overlay.checked).toBe(true);
    overlay.checked = false;
    overlay.dispatchEvent(new Event('change'));
    await settle();
    sent.length = 0;
    for (const id of ['nav-overview', 'nav-record', 'nav-predict', 'nav-overview', 'nav-predict']) {
      tab(id).click();
      await settle();
    }
    expect(sent.filter((t) => /^(RUN_|START_|STOP_|CLEAR_)/.test(t))).toEqual([]);
    if (!root.querySelector(`[data-key="${chosenKey}"]`)) await click('filter-toggle');
    expect(root.querySelector(`[data-key="${chosenKey}"]`)!.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.filter-count')!.textContent).toBe('1');
    expect(state().interactionView).toBe('none'); // overlay switched off stays off
  });

  it('recording: Start → live block (same summary) with Stop in the head slot; survives tabs; Stop finishes in place', async () => {
    const { app, root, settle, click, tab, state } = setup();
    await app.refresh();
    await click('ov-start-predict');
    await click('ov-start-record');
    expect(state().interactionView).toBe('none'); // Prediction visualization hidden while recording
    expect(root.querySelector('[data-key="ov-start-record"]')).toBeNull();
    const stop = root.querySelector<HTMLButtonElement>('.mode[data-kind="recorded"] .mode-head [data-key="stop"]')!;
    expect(stop.textContent).toBe('Stop');
    expect(stop.classList.contains('is-stop')).toBe(true);
    const live = root.querySelector('#ov-record-report .live')!;
    expect(live.querySelector('.live-status')!.textContent).toMatch(/Recording/);
    expect([...live.querySelectorAll('.cell-label')].map((e) => e.textContent)).toEqual(['Duration', 'Clicks', 'Scroll']);
    expect(live.querySelector('.cell-value')!.textContent).toMatch(/^\d+s$/); // filled immediately, not blank
    expect(root.querySelector('[data-key="live-pill"]')).toBeNull(); // the live block is visible already
    // Ticks update values in place without re-rendering (the panel stays open).
    const before = live.querySelector('.cell-value');
    app.onEvent(makeEvent('SESSION_TICK', { sessionId: state().session.sessionId!, summary: { ...state().session.summary!, elapsedMs: 61_000, clicks: 3 } }), 1);
    expect(before!.textContent).toBe('1m 01s');
    expect(root.querySelector('#ov-record-report .live')).toBe(live);
    // Page activity + same-tab refresh keep the disclosure.
    document.getElementById('b1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(new Event('scroll'));
    await settle();
    await app.refresh();
    await settle();
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('true');
    const sid = state().session.sessionId;
    tab('nav-predict').click();
    await settle();
    expect(root.querySelector('[data-key="live-pill"]')!.textContent).toMatch(/\d+s/); // compact status elsewhere
    tab('nav-record').click();
    await settle();
    expect(heads(root)).toEqual(['ihead', 'live']); // same frame: head (Stop) · live block
    expect(root.querySelector('.ihead-actions [data-key="stop"]')).not.toBeNull();
    tab('nav-overview').click();
    await settle();
    expect(state().session).toMatchObject({ state: 'recording', sessionId: sid });
    await click('stop');
    expect(app.inspect().nav.section).toBe('overview'); // Stop finishes in place
    expect(state().interactionView).toBe('recorded');
    expect([...root.querySelectorAll('#ov-record-report .summary .cell-label')].map((e) => e.textContent)).toEqual(['Duration', 'Clicks', 'Scroll', 'Interacted']);
    await click('ov-open-record');
    expect(app.inspect().nav).toEqual({ section: 'record' });
    // Notices (here: the fixture's geometry reads as a layout change) always come first, before the head.
    expect(heads(root).filter((h) => h !== 'notice')).toEqual(['ihead', 'summary', 'groups', 'foot']); // identical frame to Predict
    expect(root.querySelector('.ihead-title')!.textContent).toBe('Record');
    expect([...root.querySelectorAll('.ihead-actions [data-key]')].map((e) => (e as HTMLElement).dataset.key)).toEqual(['rec-show', 'filter-toggle']);
    expect([...root.querySelectorAll('.foot .btn')].map((b) => (b as HTMLElement).dataset.key)).toEqual(['rec-clear', 'rec-rerun']); // same footer as Predict
    expect(root.textContent).not.toMatch(/Most hovered|In view, no interaction/); // nothing to list → hidden
    expect(root.querySelector('select')).toBeNull(); // single page: no page chrome
  });

  it('empty states: Predict and Record open directly into concise empty states with Start actions', async () => {
    const { app, root, settle, tab, sent } = setup();
    await app.refresh();
    sent.length = 0;
    tab('nav-predict').click();
    await settle();
    expect(heads(root)).toEqual(['ihead', 'empty']);
    expect(root.querySelector('.empty-title')!.textContent).toBe('No prediction yet');
    expect(root.querySelector('[data-key="predict-empty"]')!.textContent).toBe('Start prediction');
    expect(root.querySelector('[data-key="predict-empty"]')!.classList.contains('is-primary')).toBe(true);
    tab('nav-record').click();
    await settle();
    expect(heads(root)).toEqual(['ihead', 'empty']);
    expect(root.querySelector('.empty-title')!.textContent).toBe('No recording yet');
    expect(root.querySelector('.empty-body')!.textContent).toBe('Capture a live session.');
    expect(root.querySelector('[data-key="rec-start"]')!.textContent).toBe('Start recording');
    expect(sent.filter((t) => /^(RUN_|START_|STOP_|CLEAR_)/.test(t))).toEqual([]); // opening a tab never runs anything
  });

  it('a recording started on the Record tab opens the Overview Record panel; a user collapse sticks', async () => {
    const { app, root, settle, click, tab, state } = setup();
    await app.refresh();
    tab('nav-record').click();
    await settle();
    await click('rec-start');
    expect(state().session.state).toBe('recording');
    tab('nav-overview').click();
    await settle();
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('true');
    await click('ov-record');
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('[data-key="live-pill"]')).not.toBeNull(); // collapsed → status moves to the app bar
    document.getElementById('b1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    await app.refresh();
    await settle();
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(state().session.state).toBe('recording');
  });

  it('band groups collapse from their heading; the choice survives navigation', async () => {
    const { app, root, sent, settle, click, tab } = setup();
    await app.refresh();
    await click('ov-start-predict');
    tab('nav-predict').click();
    await settle();
    const head = () => root.querySelector<HTMLButtonElement>('[data-key="sec-pred-medium"]')!;
    const rows = () => root.querySelectorAll('section[aria-label^="Medium"] .row').length;
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(head().querySelector('.band-key[data-band="medium"]')).not.toBeNull(); // same mark as the on-page outline
    expect(rows()).toBeGreaterThan(0);
    sent.length = 0;
    await click('sec-pred-medium');
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(rows()).toBe(0);
    expect(sent).toEqual([]); // presentation only
    tab('nav-overview').click();
    await settle();
    tab('nav-predict').click();
    await settle();
    expect(head().getAttribute('aria-expanded')).toBe('false');
  });

  it('stale prediction: one notice before the head, Run again, no duplicate Re-run, no automatic rerun', async () => {
    const { app, root, sent, settle, click, tab, state } = setup();
    await app.refresh();
    await click('ov-start-predict');
    tab('nav-predict').click();
    await settle();
    const s = state();
    sent.length = 0;
    app.onEvent(makeEvent('STATE_CHANGED', { snapshot: { ...s, prediction: { ...s.prediction, state: 'stale', staleReason: 'dom-change' } } }), 1);
    await settle();
    expect(heads(root)[0]).toBe('notice');
    const n = root.querySelector('.screen .notice[role="status"]')!;
    expect(n.textContent).toContain('Page changed');
    expect(n.querySelector('button')!.textContent).toBe('Run again');
    expect(root.querySelectorAll('.screen .notice')).toHaveLength(1);
    expect(root.querySelector('[data-key="predict-rerun"]')).toBeNull();
    expect(sent).not.toContain('RUN_PREDICTION');
  });

  it('Predict filters: Band and Type narrow the list, count active, Reset clears; never run', async () => {
    const { app, root, settle, click, sent } = setup();
    await app.refresh();
    await click('ov-start-predict');
    await click('nav-predict');
    await click('filter-toggle');
    const pop = () => root.querySelector('.popover')!;
    expect(pop().classList.contains('is-entering')).toBe(true);
    expect([...pop().querySelectorAll('.pop-label')].map((e) => e.textContent)).toEqual(['Band', 'Type']);
    sent.length = 0;
    const band = pop().querySelector<HTMLButtonElement>('[data-key^="band-"]:not([data-key="band-all"])')!;
    const n = Number(band.querySelector('.choice-n')!.textContent);
    band.click();
    await settle();
    expect(pop().classList.contains('is-entering')).toBe(false); // selection updates do not restart entrance motion
    expect(root.querySelectorAll('.groups .row').length).toBe(Math.min(n, 5));
    expect(root.querySelectorAll('.groups .group')).toHaveLength(1);
    expect(root.querySelector('.filter-count')!.textContent).toBe('1');
    expect(root.querySelector('.summary [data-band="high"]')).not.toBeNull(); // summary always shows the whole page
    await click('filter-reset');
    expect(root.querySelector('.filter-count')).toBeNull();
    expect(sent.filter((t) => /^(RUN_|START_|STOP_|CLEAR_)/.test(t))).toEqual([]);
    expect([...root.querySelectorAll('.popover .choice-n')].every((e) => Number(e.textContent) > 0)).toBe(true); // no empty choices
    // Escape dismisses.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(root.querySelector('.popover')).toBeNull();
    await click('filter-toggle');
    await click('nav-overview');
    await click('nav-predict');
    expect(root.querySelector('.popover')).toBeNull(); // navigation closes state and removes document listeners
  });

  it('rows: the eye never toggles the row; keyboard tabs wrap; detail = structure grid · Why · caveats', async () => {
    const { app, root, settle, click, tab } = setup();
    await app.refresh();
    tab('nav-overview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(app.inspect().nav.section).toBe('predict');
    tab('nav-predict').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    tab('nav-record').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(app.inspect().nav.section).toBe('overview'); // wraps: three destinations only
    tab('nav-predict').click();
    await settle();
    await click('Start prediction');
    const toggle = root.querySelector<HTMLButtonElement>('.row-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await settle();
    const open = root.querySelector<HTMLButtonElement>('.row-toggle[data-selected]')!;
    expect(open.getAttribute('aria-expanded')).toBe('true');
    // Opening a row outlines it on the page; the eye then clears / restores that outline only.
    expect(root.querySelector('.row.is-open .icon-btn')!.getAttribute('aria-pressed')).toBe('true');
    root.querySelector<HTMLButtonElement>('.row.is-open .icon-btn')!.click();
    await settle();
    expect(root.querySelector('.row-toggle[data-selected]')).not.toBeNull(); // the row did not collapse
    expect(root.querySelector('.row.is-open .icon-btn')!.getAttribute('aria-pressed')).toBe('false');
    root.querySelector<HTMLButtonElement>('.row.is-open .icon-btn')!.click();
    await settle();
    expect(root.querySelector('.row.is-open .icon-btn')!.getAttribute('aria-pressed')).toBe('true');
    const d = root.querySelector('.detail')!;
    expect(d.querySelector('.stat-grid')!.classList.contains('structure-grid')).toBe(true);
    expect([...d.querySelectorAll('.stat dt')].map((e) => e.textContent).slice(0, 2)).toEqual(['Band', 'Type']);
    expect([...d.querySelectorAll('.detail-label')].map((e) => e.textContent).filter((t) => t !== 'Caveats')).toEqual(['Why']);
    expect(d.textContent).not.toMatch(/Factors|Prominence|Competition|Availability|Context|\d\.\d{2}/);
  });
});

describe('Recorded multi-page view', () => {
  it('compact page selector, not-open explanation, layout notice; no query strings', () => {
    const session: RecordedSessionView = {
      sessionId: 's', startedAt: 0, endedAt: 1, elapsedMs: 138_000, activeMs: 100_000, totals: { clicks: 14, activations: 0, pages: 2, controlsInteracted: 5 }, deepestScroll: null,
      pages: [{ position: 0, path: '/pricing', title: 'P', clicks: 4, activeMs: 1 }, { position: 1, path: '/checkout', title: 'C', clicks: 10, activeMs: 1 }], selectedPage: 0, limitations: [], timings: { processMs: 1, perPageMs: [1, 1] },
    };
    const lists = { mostInteracted: [], clicked: [], mostHovered: [], inViewNoInteraction: [], neverReached: { count: 0, items: [] } };
    const page = (o: Partial<RecordedPageView>): RecordedPageView => ({
      position: 0, pageCount: 2, path: '/pricing', title: 'P', pageOpen: false, elementsLive: false, layoutMayHaveChanged: false,
      facts: { elapsedMs: 1, activeMs: 1, clicks: 4, activations: 0, pointerSamples: 1, controlsReached: 2, controlsInteracted: 1, maybeNotClickable: 0, deepestScroll: 0.5, nestedScroll: [] }, lists, maybeNotClickable: [], limitations: [], ...o,
    });
    const snap = snapshot({ session: { state: 'ready' } });
    const noop = { onRecord() {}, onStop() {}, onClear() {}, onShowOnPage() {}, onLayers() {}, onPage() {}, onSelect() {}, onFocus() {} };
    const a = recordedBody({ snap, session, page: page({}), selected: null, note: null, busy: false }, noop);
    expect([...a.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Page 1 of 2 · /pricing', 'Page 2 of 2 · /checkout']);
    expect(recordedWarnings({ snap, session, page: page({}), selected: null, note: null, busy: false }).map((n) => n.message).join(' ')).toContain('Page not open · map not drawn');
    expect(a.textContent).toMatch(/Pages\s*2/);
    expect(a.querySelector('.page-context .caption')!.textContent).toBe('0s · 4 clicks · 50% scroll · 1 interacted'); // one line, not a second strip
    expect(a.querySelectorAll('.summary')).toHaveLength(1);
    const closedPage = page({});
    const closedFilter = recordedFilters(
      { snap: snapshot({ session: { state: 'ready' }, recorded: { page: 0, pageCount: 2, layers: { heatmap: true, clicks: true, scroll: true }, focusedElementId: null, pageOpen: false } }), session, page: closedPage, selected: null, note: null, busy: false, filterOpen: true },
      closedPage,
      noop,
    )!;
    expect((closedFilter.querySelector('[data-key="rec-heat"]') as HTMLInputElement).disabled).toBe(true); // cannot draw over another page
    const b = recordedBody({ snap, session, page: page({ position: 1, path: '/checkout', pageOpen: true, elementsLive: true, layoutMayHaveChanged: true }), selected: null, note: null, busy: false }, noop);
    expect(recordedWarnings({ snap, session, page: page({ position: 1, path: '/checkout', pageOpen: true, elementsLive: true, layoutMayHaveChanged: true }), selected: null, note: null, busy: false }).map((n) => n.message).join(' ')).toContain('Layout may have changed since recording');
    expect(b.textContent).not.toMatch(/outdated|stale/i); // historical, not Prediction-stale
    expect(b.textContent).not.toMatch(/[?#]/);
    // Phase 9: a processing failure is explained, not shown as "No recording yet".
    const failed = recordedBody({ snap: snapshot({ session: { state: 'error' } }), session: null, page: null, selected: null, note: null, busy: false }, noop);
    expect(failed.textContent).toContain('Recording could not be processed');
    expect(failed.querySelector('[data-key="rec-start"]')).not.toBeNull();
  });
});

describe('Record rows (shared inspector row)', () => {
  it('shows each stable element once in two meaningful groups, with details, layers and progressive disclosure', () => {
    const item = { elementRef: 7, tagName: 'a', label: 'Work', region: 'Section 2', clicks: 1, activations: 0, hoverEntries: 1, hoverDwellMs: 1300, focusEvents: 1, exposureMs: 9000, reached: true };
    const exposed = { ...item, elementRef: 8, label: 'Browse', clicks: 0, hoverEntries: 0, hoverDwellMs: 0, focusEvents: 0, exposureMs: 5000 };
    const lists = { mostInteracted: [item], clicked: [item], mostHovered: [item], inViewNoInteraction: [exposed], neverReached: { count: 1, items: [{ ...item, elementRef: 9, label: 'Skip to content', reached: false }] } };
    const session: RecordedSessionView = {
      sessionId: 's', startedAt: 0, endedAt: 1, elapsedMs: 7000, activeMs: 7000, totals: { clicks: 1, activations: 0, pages: 1, controlsInteracted: 1 }, deepestScroll: 1,
      pages: [{ position: 0, path: '/', title: 'P', clicks: 1, activeMs: 1 }], selectedPage: 0, limitations: [], timings: { processMs: 1, perPageMs: [1] },
    };
    const page: RecordedPageView = {
      position: 0, pageCount: 1, path: '/', title: 'P', pageOpen: true, elementsLive: true, layoutMayHaveChanged: false,
      facts: { elapsedMs: 7000, activeMs: 7000, clicks: 1, activations: 0, pointerSamples: 1, controlsReached: 1, controlsInteracted: 1, maybeNotClickable: 1, deepestScroll: 1, nestedScroll: [] },
      lists, maybeNotClickable: [{ rootId: 0, x: 542, y: 305, clicks: 2 }], limitations: [],
    };
    const snap = snapshot({ session: { state: 'ready' } });
    const noop = { onRecord() {}, onStop() {}, onClear() {}, onShowOnPage() {}, onLayers() {}, onPage() {}, onSelect() {}, onFocus() {} };
    const holder = document.createElement('div');
    holder.append(recordedBody({ snap, session, page, selected: 7, note: null, busy: false }, noop));
    // Same row component as Predict: label · short meta · chevron; eye only on the open row.
    expect([...holder.querySelectorAll('.row-line')].map((r) => [r.querySelector('.row-label')!.textContent, r.querySelector('.row-meta')!.textContent])).toEqual([['Work', '1 click · 1.3s hover'], ['Browse', '5.0s in view']]);
    expect([...holder.querySelectorAll('[aria-expanded="true"]')].map((b) => (b as HTMLElement).dataset.key)).toEqual(['rec-mostInteracted-7']);
    expect(holder.querySelectorAll('.detail')).toHaveLength(1);
    expect(holder.querySelector('[data-key="rec-show-7"]')!.getAttribute('title')).toBe('Show on page');
    // Activity: the shared stat grid, measured facts only.
    const stats = holder.querySelector('.detail .stat-grid')!;
    expect(stats.getAttribute('aria-label')).toBe('Activity');
    expect([...stats.querySelectorAll('.stat')].map((e) => e.textContent)).toEqual(['Clicks1', 'Hover1.3s', 'Focus1', 'In view9.0s']);
    expect(holder.querySelector('.detail-label')).toBeNull();
    // Never reached / May not be clickable are not listed: no group, no coordinates.
    expect(holder.textContent).not.toMatch(/Never reached|Not reached|May not be clickable|Unlabelled element|542|305|\bpx\b/);
    // Filter = visualization settings only: three independent switches; activity groups stay visible.
    const recorded = { page: 0, pageCount: 1, layers: { heatmap: true, clicks: false, scroll: true }, focusedElementId: null, pageOpen: true };
    const model = { snap: snapshot({ session: { state: 'ready' }, recorded }), session, page, selected: null, note: null, busy: false, filterOpen: true };
    const changed: unknown[] = [];
    const filter = recordedFilters(model, page, { ...noop, onLayers: (l) => void changed.push(l) })!;
    expect([...filter.querySelectorAll('.pop-label')].map((e) => e.textContent)).toEqual(['Layers']);
    const inputs = [...filter.querySelectorAll<HTMLInputElement>('.switch-row input')];
    expect(inputs.map((i) => [i.dataset.key, i.checked])).toEqual([['rec-heat', true], ['rec-clicks', false], ['rec-scroll', true]]);
    expect(filter.querySelector('.filter-count')!.textContent).toBe('1'); // one layer hidden
    inputs[1]!.checked = true;
    inputs[1]!.dispatchEvent(new Event('change'));
    expect(changed).toEqual([{ heatmap: true, clicks: true, scroll: true }]); // independent, not exclusive
    expect(filter.querySelector('[data-key^="rec-list-"], .choices')).toBeNull(); // no activity-category filters
    const body = document.createElement('div');
    body.append(recordedBody(model, noop));
    expect([...body.querySelectorAll('.group-title')].map((e) => e.textContent)).toEqual(['Interacted Elements', 'No Interaction']);
    expect(body.textContent).not.toMatch(/Most interacted|Clicked|Most hovered/);
    const longItems = Array.from({ length: 7 }, (_, n) => ({ ...item, elementRef: 20 + n, label: n < 2 ? 'Same label' : `Item ${n + 1}` }));
    const longPage = { ...page, lists: { ...lists, mostInteracted: longItems } };
    const firstFive = document.createElement('div');
    firstFive.append(recordedBody({ snap, session, page: longPage, selected: null, note: null, busy: false, listLimits: new Map() }, { ...noop, onMore() {} }));
    expect(firstFive.querySelectorAll('section[aria-label^="Interacted Elements"] .row')).toHaveLength(5);
    expect(firstFive.querySelector('[data-key="rec-more-mostInteracted"]')!.textContent).toBe('Show 5 more');
    const allSeven = document.createElement('div');
    allSeven.append(recordedBody({ snap, session, page: longPage, selected: null, note: null, busy: false, listLimits: new Map([['mostInteracted', 10]]) }, { ...noop, onMore() {} }));
    expect(allSeven.querySelectorAll('section[aria-label^="Interacted Elements"] .row')).toHaveLength(7);
    expect([...allSeven.querySelectorAll('.row-label')].filter((e) => e.textContent === 'Same label')).toHaveLength(2); // identity is elementRef, not visible copy
    expect([...allSeven.querySelectorAll<HTMLElement>('[data-key^="rec-mostInteracted-"]')].slice(0, 2).map((e) => e.dataset.key)).toEqual(['rec-mostInteracted-20', 'rec-mostInteracted-21']);
    expect(allSeven.querySelector('[data-key="rec-more-mostInteracted"]')).toBeNull();
    const head = recordedHeadAction({ snap, session, page, selected: null, note: null, busy: false }, noop)!;
    expect([...head.querySelectorAll('[data-key]')].map((e) => (e as HTMLElement).dataset.key)).toEqual(['rec-show', 'filter-toggle']); // same slots as Predict
  });
});

describe('Row label copy', () => {
  it('subject names lose link-hint noise', () => {
    expect(cleanSubject('UX HeatGrid on Chrome Web Store, opens in a new tab')).toBe('UX HeatGrid on Chrome Web Store');
    expect(cleanSubject('heykaan.dev@gmail.com ↗')).toBe('heykaan.dev@gmail.com');
    expect(cleanSubject('Docs (opens in new window)')).toBe('Docs');
    expect(cleanSubject('/ ReadScore')).toBe('/ ReadScore');
  });
});

describe('side-panel stylesheet', () => {
  it('every selector is well-formed (an unbalanced one silently disables all later rules)', async () => {
    // No Node typings in this project: load fs untyped (the test runner is Node).
    const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync(path: string, enc: string): string };
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const css = fs.readFileSync(`${cwd}/src/ui/shared/tokens.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    let buf = '';
    for (const ch of css) {
      if (ch === '{') {
        const sel = buf.trim();
        expect(sel.split('(').length, sel).toBe(sel.split(')').length); // selector / at-rule prelude
        depth++;
        buf = '';
      } else if (ch === '}' || ch === ';') {
        if (ch === '}') depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
        buf = '';
      } else buf += ch;
    }
    expect(depth).toBe(0);
  });
});
