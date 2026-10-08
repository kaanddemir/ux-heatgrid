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
import { recordedBody, recordedFilters, recordedHeadAction, recordedNotices } from '../../src/ui/sidepanel/recordedView';
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

// ---------------------------------------------------------------------------
// Panel app against a real runtime
// ---------------------------------------------------------------------------

function rectFromAttr(this: Element): DOMRect {
  const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
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
  beforeEach(() => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rectFromAttr));
  afterEach(() => vi.restoreAllMocks());

  it('opens on Overview: page card + Predict + Record, collapsed; no Coach, no developer/debug UI', async () => {
    const { app, root, settle } = setup();
    await app.refresh();
    await settle();
    const tabs = [...root.querySelectorAll('[role="tablist"][aria-label="HeatGrid sections"] [role="tab"]')];
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['Overview', 'true'], ['Predict', 'false'], ['Record', 'false']]);
    const actions = [...root.querySelectorAll<HTMLButtonElement>('button.workflow-toggle')];
    expect(actions.map((a) => a.dataset.key)).toEqual(['ov-page', 'ov-predict', 'ov-record']);
    expect(actions.map((a) => a.querySelector('.action-title')!.textContent)).toEqual(['This page', 'Predict', 'Record']);
    expect(root.querySelectorAll('.workflow-card')).toHaveLength(3);
    expect(root.querySelector('[data-key="ov-start-predict"]')!.textContent).toBe('Start');
    expect(root.querySelector('[data-key="ov-start-record"]')!.textContent).toBe('Start');
    expect(root.textContent).not.toMatch(/coach|finding|interaction/i);
    expect(root.querySelector('[data-kind="coach"], [data-key*="coach"], [data-key="nav-interaction"], [data-key^="itab-"]')).toBeNull();
    expect(actions.every((a) => a.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(root.querySelector('.workflow-report')).toBeNull();
    expect(actions.every((a) => a.querySelector('svg[aria-hidden="true"]'))).toBe(true);
    expect(root.querySelector('details.app-dev, pre')).toBeNull();
    expect(root.textContent).not.toMatch(/Developer details|Analysis JSON|Raw state|Run analyzer/);
    expect(root.textContent).not.toMatch(/build|protocol|Phase \d|test/i);
    expect([...root.querySelectorAll('button')].every((b) => b.type === 'button')).toBe(true);
  });

  it('Predict card only expands; its Start button runs and full report opens the Predict tab', async () => {
    const { app, root, settle, click, tab, state, sent } = setup();
    await app.refresh();
    sent.length = 0;
    await click('ov-predict');
    expect(sent).not.toContain('RUN_PREDICTION');
    expect(root.querySelector('#ov-predict-report .overview-status')!.textContent).toBe('No prediction yet.');
    await click('ov-start-predict');
    expect(app.inspect().nav).toEqual({ section: 'overview' });
    expect(state().interactionView).toBe('predicted');
    expect(root.querySelector('[data-key="ov-predict"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('#ov-predict-report .dist')).not.toBeNull();
    expect(root.querySelectorAll('#ov-predict-report .workflow-preview li').length).toBeGreaterThan(0);
    expect(root.querySelector('[data-key="ov-open-predict"]')).not.toBeNull();
    // Overview disclosures are independent: opening and closing Record does not disturb Predict.
    await click('ov-record');
    expect(root.querySelector('#ov-predict-report')).not.toBeNull();
    expect(root.querySelector('#ov-record-report')).not.toBeNull();
    await click('ov-record');
    expect(root.querySelector('#ov-predict-report')).not.toBeNull();
    await click('ov-predict');
    expect(root.querySelector('#ov-predict-report')).toBeNull();
    await click('ov-predict');
    await click('ov-open-predict');
    expect(app.inspect().nav).toEqual({ section: 'predict' });
    expect(root.querySelector('[data-key="nav-predict"]')!.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.seg-tabs, [data-key^="itab-"]')).toBeNull(); // no Predicted | Recorded sub-navigation
    const t = root.textContent!;
    expect(root.querySelector('.screen-head .title')!.textContent).toBe('Predicted');
    expect(root.querySelector('.screen-head p')).toBeNull(); // no subtitle
    expect(t).not.toContain('Estimated from page structure');
    // Header: Re-run · Show on page. Footer: Reset only (no coverage line, no Include Low).
    expect([...root.querySelectorAll('.screen-head .head-actions [data-key]')].map((e) => (e as HTMLElement).dataset.key)).toEqual(['predict-rerun', 'overlay', 'filter-toggle']);
    expect(root.querySelector('[data-key="low"]')).toBeNull();
    expect(root.querySelector('.screen-foot')!.textContent!.trim()).toBe('Reset prediction');
    expect(t).not.toMatch(/assessed/);
    expect(t).not.toMatch(/score|probability/i);
    await settle();
  });

  it('switching views never runs an engine and keeps the type filter state', async () => {
    const { app, root, sent, settle, click, tab, state } = setup();
    await app.refresh();
    await click('ov-start-predict');
    tab('nav-predict').click();
    await settle();
    await click('filter-toggle');
    expect(root.querySelector('.filter-popover [aria-label="Band"]')).toBeNull();
    const choices = [...root.querySelectorAll<HTMLElement>('[data-key^="kind-"]:not([data-key="kind-all"])')];
    const chosen = choices[0]!;
    const chosenKey = chosen.dataset.key!;
    chosen.click();
    await settle();
    expect(root.querySelectorAll('.item-row').length).toBeGreaterThan(0);
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
    expect(state().interactionView).toBe('none'); // overlay switched off stays off
  });

  it('Record turns the Record tile into Stop with live stats; Stop stays on Overview; Recorded hides empty lists', async () => {
    const { app, root, settle, click, tab, state } = setup();
    await app.refresh();
    await click('ov-start-predict');
    await click('ov-record');
    expect(state().session.state).toBe('idle');
    await click('ov-start-record');
    expect(state().interactionView).toBe('none'); // Prediction visualization hidden while recording
    expect(root.querySelector('.rec-bar, .live-pill')).toBeNull(); // Overview: the Record tile becomes the live state, no banner
    expect(root.querySelector('[data-key="ov-start-record"]')).toBeNull();
    expect(root.querySelector('[data-key="stop"]')!.textContent).toBe('Stop');
    expect(root.querySelector('.ov-workflows .live-card')!.textContent).toMatch(/Recording.*\d+s.*clicks?.*scroll.*Stop/);
    expect(root.querySelector('[data-key^="ov-go-recorded"], [data-key="ov-view-recorded"]')).toBeNull(); // one place only
    // Recorder activity and a same-tab load refresh update the live body without resetting the
    // independently-owned Overview disclosure state.
    document.getElementById('b1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('b2')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 24, clientY: 105 }));
    window.dispatchEvent(new Event('scroll'));
    await settle();
    await app.refresh(); // mirrors chrome.tabs.onUpdated(status=complete) for the same tab
    await settle();
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('#ov-record-report .live-card')).not.toBeNull();
    expect(root.querySelector('[data-key="stop"]')).not.toBeNull();
    // Switching tabs never stops, restarts or resets the session.
    const sid = state().session.sessionId;
    tab('nav-predict').click();
    await settle();
    expect(root.querySelector('[data-key="live-pill"]')!.textContent).toMatch(/\d+s/); // compact status elsewhere
    tab('nav-record').click();
    await settle();
    expect(root.querySelector('[data-key="live-pill"]')).toBeNull(); // Record shows the live tile itself
    expect(root.querySelector('.screen .live-card [data-key="stop"]')).not.toBeNull();
    tab('nav-overview').click();
    await settle();
    expect(app.inspect().nav.section).toBe('overview');
    expect(state().session).toMatchObject({ state: 'recording', sessionId: sid });
    expect(state().session.summary).not.toBeNull(); // the live session keeps its data across tab switches
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('true');
    await click('Stop');
    expect(app.inspect().nav.section).toBe('overview'); // Stop finishes in place
    expect(state().interactionView).toBe('recorded');
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('#ov-record-report .metrics')).not.toBeNull();
    expect(root.querySelector('[data-key="ov-open-record"]')).not.toBeNull();
    await click('ov-open-record');
    expect(app.inspect().nav).toEqual({ section: 'record' });
    const t = root.textContent!;
    expect(root.querySelector('.screen-head .title')!.textContent).toBe('Recorded');
    expect(t).not.toMatch(/Recorded Interaction|This session/);
    expect(t).toMatch(/Duration.*Clicks.*Scroll.*Interacted/);
    expect(root.querySelector('.screen-foot [data-key="rec-clear"]')).not.toBeNull(); // Clear at the bottom
    expect(t).not.toMatch(/Most hovered|In view, no interaction/); // nothing to list → hidden
    expect(root.querySelector('.rec-bar')).toBeNull();
    expect(root.querySelector('select')).toBeNull(); // single page: no page chrome
  });

  it('empty states: Predict and Record open directly into concise empty states with Start actions', async () => {
    const { app, root, settle, tab, sent } = setup();
    await app.refresh();
    sent.length = 0;
    tab('nav-predict').click();
    await settle();
    expect(root.querySelector('.screen-head .title')!.textContent).toBe('Predicted');
    expect(root.textContent).toContain('No prediction yet');
    expect(root.querySelector('[data-key="predict-empty"]')!.textContent).toBe('Start prediction');
    tab('nav-record').click();
    await settle();
    expect(root.querySelector('.screen-head .title')!.textContent).toBe('Recorded');
    expect(root.textContent).toContain('No recording yet');
    expect(root.textContent).toContain('Capture a live session.');
    expect(root.querySelector('[data-key="rec-start"]')!.textContent).toBe('Start recording');
    expect(sent.filter((t) => /^(RUN_|START_|STOP_|CLEAR_)/.test(t))).toEqual([]); // opening a tab never runs anything
    expect(root.textContent).not.toMatch(/coach|finding/i);
    tab('nav-overview').click();
    await settle();
    expect(app.inspect().nav).toEqual({ section: 'overview' });
  });

  it('a recording started on the Record tab opens the Overview Record card; a user collapse sticks through ticks and reloads', async () => {
    const { app, root, settle, click, tab, state } = setup();
    await app.refresh();
    tab('nav-record').click();
    await settle();
    await click('rec-start');
    expect(state().session.state).toBe('recording');
    tab('nav-overview').click();
    await settle();
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('true');
    await click('ov-record'); // user collapses
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('false');
    document.getElementById('b1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(new Event('scroll'));
    await settle();
    await app.refresh();
    await settle();
    expect(root.querySelector('[data-key="ov-record"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(state().session.state).toBe('recording');
  });

  it('band sections collapse and expand from their heading; the choice survives navigation', async () => {
    const { app, root, sent, settle, click, tab } = setup();
    await app.refresh();
    await click('ov-start-predict');
    tab('nav-predict').click();
    await settle();
    const head = () => root.querySelector<HTMLButtonElement>('[data-key="sec-pred-medium"]')!;
    const rows = () => root.querySelectorAll('section[aria-label^="Medium"] button.item').length;
    expect(head().getAttribute('aria-expanded')).toBe('true');
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
    await click('sec-pred-medium');
    expect(rows()).toBeGreaterThan(0);
  });

  it('stale prediction: compact notice with Run again (no automatic rerun)', async () => {
    const { app, root, sent, settle, click, tab, state } = setup();
    await app.refresh();
    await click('ov-start-predict');
    tab('nav-predict').click();
    await settle();
    const s = state();
    sent.length = 0;
    app.onEvent(makeEvent('STATE_CHANGED', { snapshot: { ...s, prediction: { ...s.prediction, state: 'stale', staleReason: 'dom-change' } } }), 1);
    await settle();
    const notice = root.querySelector('.notice[role="status"]')!;
    expect(notice.textContent).toContain('Page changed');
    expect(notice.querySelector('button')!.textContent).toBe('Run again');
    const zone = root.querySelector('.screen[data-kind="predicted"] > .notice-zone')!;
    const head = root.querySelector('.screen[data-kind="predicted"] > .screen-head')!;
    expect(zone.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(root.querySelectorAll('.screen[data-kind="predicted"] .notice')).toHaveLength(1);
    expect(sent).not.toContain('RUN_PREDICTION');
  });

  it('Predict filters narrow, never run', async () => {
    const { app, root, settle, click, sent } = setup();
    await app.refresh();
    await click('ov-start-predict');
    await click('nav-predict');
    await click('filter-toggle');
    const bar = () => root.querySelector('.filter-popover')!;
    expect(bar().querySelector('[aria-label="Band"]')).toBeNull();
    expect(bar().querySelector('[aria-label="Type"]')).not.toBeNull();
    expect(bar().querySelector('[data-key="kind-all"]')!.getAttribute('aria-pressed')).toBe('true');
    // Type filter: pick the first type chip; every listed row must then be of that type.
    const typeChip = bar().querySelector<HTMLButtonElement>('[data-key^="kind-"]:not([data-key="kind-all"])');
    sent.length = 0;
    if (typeChip) {
      const n = Number(typeChip.querySelector('.seg-n')!.textContent);
      typeChip.click();
      await settle();
      expect(root.querySelectorAll('.item-row').length).toBe(n);
    }
    expect(sent.filter((t) => /^(RUN_|START_|STOP_|CLEAR_)/.test(t))).toEqual([]); // filtering is presentation only
    expect([...root.querySelectorAll('.filter-popover .seg-n')].every((e) => Number(e.textContent) > 0)).toBe(true); // no empty chips
  });

  it('keyboard: tablists support arrow keys; rows expose aria-expanded', async () => {
    const { app, root, settle, click, tab } = setup();
    await app.refresh();
    tab('nav-overview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(app.inspect().nav.section).toBe('predict');
    expect(tab('nav-predict').getAttribute('aria-selected')).toBe('true');
    expect(tab('nav-overview').getAttribute('tabindex')).toBe('-1');
    tab('nav-predict').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(app.inspect().nav.section).toBe('record');
    tab('nav-record').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(app.inspect().nav.section).toBe('overview'); // wraps: three destinations only
    tab('nav-predict').click();
    await settle();
    await click('Start prediction');
    const row = root.querySelector<HTMLButtonElement>('button.item')!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    row.click();
    await settle();
    expect(root.querySelector<HTMLButtonElement>('button.item[data-selected]')!.getAttribute('aria-expanded')).toBe('true');
    // Expanded detail: Why (+ Caveats) only — the component factors are never rendered.
    const detail = root.querySelector('.detail')!;
    expect([...detail.querySelectorAll('.detail-label')].map((e) => e.textContent).filter((t) => t !== 'Caveats')).toEqual(['Why']);
    expect(detail.textContent).not.toMatch(/Factors|Prominence|Competition|Availability|Context/);
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
    expect(recordedNotices({ snap, session, page: page({}), selected: null, note: null, busy: false }).map((n) => n.textContent).join(' ')).toContain('Page not open · map not drawn');
    expect(a.textContent).toMatch(/Pages\s*2/);
    const closedPage = page({});
    const closedFilter = recordedFilters(
      { snap: snapshot({ session: { state: 'ready' }, recorded: { page: 0, pageCount: 2, layers: { heatmap: true, clicks: true, scroll: true }, focusedElementId: null, pageOpen: false } }), session, page: closedPage, selected: null, note: null, busy: false, filterOpen: true },
      closedPage,
      noop,
    )!;
    expect((closedFilter.querySelector('[data-key="rec-heat"]') as HTMLInputElement).disabled).toBe(true); // cannot draw over another page
    const b = recordedBody({ snap, session, page: page({ position: 1, path: '/checkout', pageOpen: true, elementsLive: true, layoutMayHaveChanged: true }), selected: null, note: null, busy: false }, noop);
    expect(recordedNotices({ snap, session, page: page({ position: 1, path: '/checkout', pageOpen: true, elementsLive: true, layoutMayHaveChanged: true }), selected: null, note: null, busy: false }).map((n) => n.textContent).join(' ')).toContain('Layout may have changed since recording');
    expect(b.textContent).not.toMatch(/outdated|stale/i); // historical, not Prediction-stale
    expect(b.textContent).not.toMatch(/[?#]/);
    // Phase 9: a processing failure is explained, not shown as "No recording yet".
    const failed = recordedBody({ snap: snapshot({ session: { state: 'error' } }), session: null, page: null, selected: null, note: null, busy: false }, noop);
    expect(failed.textContent).toContain('Recording could not be processed');
    expect(failed.querySelector('[data-key="rec-start"]')).not.toBeNull();
  });
});

describe('Recorded rows (Predicted-style inspector)', () => {
  it('short meta, one open row per list, eye on the open row; Never reached / May not be clickable not listed', () => {
    const item = { elementRef: 7, tagName: 'a', label: 'Work', region: 'Section 2', clicks: 1, activations: 0, hoverEntries: 1, hoverDwellMs: 1300, focusEvents: 1, exposureMs: 9000, reached: true };
    const lists = { mostInteracted: [item], clicked: [item], mostHovered: [], inViewNoInteraction: [], neverReached: { count: 1, items: [{ ...item, elementRef: 9, label: 'Skip to content', reached: false }] } };
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
    holder.append(recordedBody({ snap, session, page, selected: 7, selectedList: 'clicked', note: null, busy: false }, noop));
    expect(holder.querySelector('.metric-bar')).toBeNull();
    expect(holder.querySelector('.item-row .item-meta')).toBeNull(); // metrics live only in the expanded inspector
    expect([...holder.querySelectorAll('[aria-expanded="true"]')].map((b) => (b as HTMLElement).dataset.key)).toEqual(['rec-clicked-7']); // opens in one list only
    expect(holder.querySelectorAll('.detail')).toHaveLength(1);
    expect(holder.querySelector('[data-key="rec-show-7"]')!.getAttribute('title')).toBe('Show on page');
    // Activity: one compact 2x2 grid; no redundant heading, Type or Region.
    const stats = holder.querySelector('.detail .recorded-stat-grid')!;
    expect(stats.getAttribute('aria-label')).toBe('Activity');
    expect([...stats.querySelectorAll('.recorded-stat')].map((e) => e.textContent)).toEqual(['Clicks1', 'Hover1.3s', 'Focus1', 'In view9.0s']);
    expect(holder.querySelector('.detail-label')).toBeNull();
    // Never reached / May not be clickable are not listed: no section, no coordinates.
    expect(holder.textContent).not.toMatch(/Never reached|Not reached|May not be clickable|Unlabelled element|542|305|\bpx\b/);
    // Recorded filtering controls only the on-page visualization; activity sections stay visible.
    const withFilter = (recorded = { page: 0, pageCount: 1, layers: { heatmap: true, clicks: true, scroll: true }, focusedElementId: null, pageOpen: true }) => {
      const d = document.createElement('div');
      const model = { snap: snapshot({ session: { state: 'ready' }, recorded }), session, page, selected: null, note: null, busy: false, list: 'clicked' as const, filterOpen: true };
      const handlers = { ...noop, onList() {} };
      d.append(recordedBody(model, handlers));
      const filter = recordedFilters(model, page, handlers);
      if (filter) d.append(filter);
      return d;
    };
    const filtered = withFilter();
    expect(filtered.querySelector('.filter-view')!.getAttribute('aria-label')).toBe('View');
    expect([...filtered.querySelectorAll('.filter-view [data-key]')].map((b) => (b as HTMLElement).dataset.key)).toEqual(['rec-heat', 'rec-clicks', 'rec-scroll']);
    expect(filtered.querySelector('.filter-view .icon')).toBeNull(); // same selector + label rhythm as the other filter groups
    expect(filtered.querySelector('[data-key^="rec-list-"]')).toBeNull();
    expect([...filtered.querySelectorAll('section .section-title')].map((e) => e.textContent)).toEqual(['Most interacted', 'Clicked']);
    expect(filtered.querySelector('.layers')).toBeNull();
    const longItems = Array.from({ length: 7 }, (_, n) => ({ ...item, elementRef: 20 + n, label: `Item ${n + 1}` }));
    const longPage = { ...page, lists: { ...lists, mostInteracted: longItems } };
    const firstFive = document.createElement('div');
    firstFive.append(recordedBody({ snap, session, page: longPage, selected: null, note: null, busy: false, list: 'mostInteracted', listLimits: new Map() }, { ...noop, onList() {}, onMore() {} }));
    expect(firstFive.querySelectorAll('section[aria-label^="Most interacted"] .item-row')).toHaveLength(5);
    expect(firstFive.querySelector('[data-key="rec-more-mostInteracted"]')!.textContent).toBe('Show 5 more');
    const allSeven = document.createElement('div');
    allSeven.append(recordedBody({ snap, session, page: longPage, selected: null, note: null, busy: false, list: 'mostInteracted', listLimits: new Map([['mostInteracted', 10]]) }, { ...noop, onList() {}, onMore() {} }));
    expect(allSeven.querySelectorAll('section[aria-label^="Most interacted"] .item-row')).toHaveLength(7);
    expect(allSeven.querySelector('[data-key="rec-more-mostInteracted"]')).toBeNull();
    const head = recordedHeadAction({ snap, session, page, selected: null, note: null, busy: false }, noop)!;
    expect([...head.querySelectorAll('[data-key]')].map((e) => (e as HTMLElement).dataset.key)).toEqual(['rec-rerun', 'rec-show']); // same place as Predicted
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
