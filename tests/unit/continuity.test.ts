// @vitest-environment happy-dom
/**
 * Phase 5.1: cross-navigation recording continuity. Real TabRuntimes + real Recorder on fixture
 * pages, connected to the real service-worker recording store over in-memory storage.
 * A "navigation" = pagehide handoff on runtime A, dispose A, mount page B, new runtime B, resume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { startRecorder } from '../../src/content/recorder';
import { coarsenSegment, type ContinuityChannel, type PageCaptureSegment } from '../../src/content/recorder/segment';
import { createTabRuntime } from '../../src/content/tabRuntime';
import { createRecordingStore, type StorageLike } from '../../src/background/recordingStore';
import type { TabSnapshot } from '../../src/shared/model';
import { makeRequest, type RequestEnvelope } from '../../src/shared/protocol';
import { fixtureReader, mount } from '../helpers/fixtureReader';

function rectFromAttr(this: Element): DOMRect {
  const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
beforeEach(() => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rectFromAttr));
afterEach(() => vi.restoreAllMocks());

const trusted = <E extends Event>(e: E): E => (Object.defineProperty(e, 'isTrusted', { value: true }), e);
class NoIO {
  observe(): void {}
  disconnect(): void {}
}

const page = (name: string, y: number) => `<main data-rect="0 0 1280 2000"><h1 data-rect="20 20 400 40">${name}</h1>
  <button id="go" data-rect="100 ${y} 200 50">Go ${name}</button><p id="text" data-rect="100 600 600 80">text</p></main>`;

/** In-memory chrome.storage.session stand-in (JSON round-trip like the real one). */
function memoryStorage(): StorageLike & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const s = {
    data,
    writes: 0,
    async get(keys: string | string[]) {
      const out: Record<string, unknown> = {};
      for (const k of [keys].flat()) if (data.has(k)) out[k] = JSON.parse(data.get(k)!);
      return out;
    },
    async set(items: Record<string, unknown>) {
      s.writes++;
      for (const [k, v] of Object.entries(items)) data.set(k, JSON.stringify(v));
    },
    async remove(keys: string | string[]) {
      for (const k of [keys].flat()) data.delete(k);
    },
  };
  return s;
}

function harness(budget?: number) {
  const storage = memoryStorage();
  const store = createRecordingStore(storage, budget);
  const TAB = 7;
  const pending: Promise<unknown>[] = [];
  const calls: string[] = [];
  const channel: ContinuityChannel = {
    begin: (id, at) => (calls.push('begin'), void pending.push(store.begin(TAB, id, at))),
    segment: (seg) => (calls.push('segment'), void pending.push(store.addSegment(TAB, JSON.parse(JSON.stringify(seg))))),
    clear: (id) => (calls.push('clear'), void pending.push(store.clearSession(TAB, id))),
    collect: (id) => (calls.push('collect'), store.collect(TAB, id)),
  };
  const modes: string[] = [];
  const open = (html: string) => {
    mount(html);
    const analyzer = createPageAnalyzer({ reader: fixtureReader({ docHeight: 2000 }) });
    const analyze = analyzer.analyze.bind(analyzer);
    analyzer.analyze = ((o?: { mode?: string }) => (modes.push(o?.mode ?? 'full'), analyze(o as never))) as typeof analyzer.analyze;
    const rt = createTabRuntime({ buildId: 'test', emit: () => {}, analyzer, continuity: channel, createRecorder: (a) => startRecorder({ analyzer: a, IntersectionObserver: NoIO as never }) });
    const call = <T extends Parameters<typeof makeRequest>[0]>(type: T, payload: Parameters<typeof makeRequest<T>>[1]) => rt.handle(makeRequest(type, payload) as RequestEnvelope);
    const state = () => (call('GET_STATE', null) as { ok: true; data: TabSnapshot }).data;
    return { rt, call, state };
  };
  const flush = async () => {
    while (pending.length) await pending.shift();
  };
  /** Full navigation from runtime `rt` to `html`: pagehide handoff, dispose, new document, SW resume. */
  const navigate = async (from: ReturnType<typeof open>, html: string) => {
    from.rt.handoffRecording();
    from.rt.dispose();
    await flush();
    const next = open(html);
    const payload = await store.resumePayload(TAB);
    if (payload) next.call('RESUME_RECORDING', payload);
    return next;
  };
  const interact = (y: number, clicks = 1) => {
    const go = document.getElementById('go')!;
    for (let i = 0; i < 4; i++) go.dispatchEvent(trusted(new PointerEvent('pointermove', { clientX: 120 + i * 10, clientY: y + 10, bubbles: true, pointerType: 'mouse' })));
    for (let i = 0; i < clicks; i++) go.dispatchEvent(trusted(new PointerEvent('click', { clientX: 150, clientY: y + 10, bubbles: true, detail: 1, pointerType: 'mouse' })));
  };
  return { storage, store, TAB, channel, calls, open, flush, navigate, interact, modes };
}

describe('cross-navigation recording continuity', () => {
  it('A → B → C → Stop: one recording, three independent page segments, exact click totals', async () => {
    const h = harness();
    const a = h.open(page('A', 100));
    a.call('START_SESSION', { source: 'sidepanel' });
    const sessionId = a.state().session.sessionId;
    h.interact(100, 2);
    // Recording on one page never talks to the service worker (only "begin" at Record).
    expect(h.calls).toEqual(['begin']);

    // Duplicate lifecycle signals (pagehide twice) → exactly one segment.
    const segA = a.rt.handoffRecording();
    expect(segA).not.toBeNull();
    expect(a.rt.handoffRecording()).toBeNull();
    a.rt.dispose();
    await h.flush();
    expect(await h.store.addSegment(h.TAB, segA!)).toBe('duplicate');
    // Page A's capture survives its runtime.
    expect((await h.store.meta(h.TAB))!.segments).toEqual([0]);

    const b = h.open(page('B', 300));
    const payload = (await h.store.resumePayload(h.TAB))!;
    b.call('RESUME_RECORDING', payload);
    b.call('RESUME_RECORDING', payload); // idempotent
    expect(b.state().session).toMatchObject({ state: 'recording', sessionId, recording: { segmentCount: 2, currentSegmentIndex: 1, continuity: 'continuous' } });
    h.interact(300, 1);
    expect(b.state().session.summary!.clicks).toBe(3); // totals continue across pages

    const c = await h.navigate(b, page('C', 500));
    h.interact(500, 3);
    c.call('STOP_SESSION', null);
    expect(c.state().session.state).toBe('processing'); // earlier pages are collected asynchronously
    await vi.waitFor(() => expect(c.state().session.state).toBe('ready'));

    const rs = c.state().session;
    expect(rs.result).toMatchObject({ kind: 'capture', pages: 3, clicks: 6, deepestScroll: null });
    expect(rs.recording!.segmentCount).toBe(3);
    // Temporary storage is gone after Stop.
    expect(h.storage.data.size).toBe(0);
  });

  it('segments keep their own page identity and coordinate spaces (never merged)', async () => {
    const h = harness();
    const a = h.open(page('A', 100));
    a.call('START_SESSION', { source: 'sidepanel' });
    h.interact(100);
    const b = await h.navigate(a, page('B', 300));
    h.interact(300);
    const segB = b.rt.handoffRecording()!;
    await h.flush();
    const all = await h.store.collect(h.TAB, segB.sessionId);
    const [sa, sb] = all!.segments;
    expect([sa!.index, sb!.index]).toEqual([0, 1]);
    expect(sa!.pointer.y.every((y) => y >= 100 && y <= 150)).toBe(true);
    expect(sb!.pointer.y.every((y) => y >= 300 && y <= 350)).toBe(true);
    // Real clock: rapid synthetic moves are cut by the 30 Hz cap, so only ≥ 1 sample per page is certain.
    expect(sa!.pointer.count).toBeGreaterThan(0);
    expect(sb!.pointer.count).toBeGreaterThan(0);
    // Element refs are per document; each segment only references its own controls.
    expect(sa!.clicks[0]!.elementRef).toBe(sa!.elements.find((e) => e.clicks > 0)!.elementRef);
    // Page identity: origin + path + title only (no query or hash).
    expect(Object.keys(sa!.page)).toEqual(['origin', 'path', 'title']);
  });

  it('reload / back-forward cache: same document comes back and continues as a new segment', async () => {
    const h = harness();
    const a = h.open(page('A', 100));
    a.call('START_SESSION', { source: 'sidepanel' });
    h.interact(100);
    // bfcache: pagehide(persisted) hands off but the runtime is NOT disposed; pageshow → resume.
    a.rt.handoffRecording();
    await h.flush();
    a.call('RESUME_RECORDING', (await h.store.resumePayload(h.TAB))!);
    expect(a.state().session).toMatchObject({ state: 'recording', recording: { segmentCount: 2 } });
    h.interact(100);
    // Reload: a new runtime on the same page.
    const r = await h.navigate(a, page('A', 100));
    expect(r.state().session.recording!.segmentCount).toBe(3);
    r.call('STOP_SESSION', null);
    await vi.waitFor(() => expect(r.state().session.state).toBe('ready'));
    expect(r.state().session.result).toMatchObject({ pages: 3, clicks: 2 });
  });

  it('budget: over-budget sessions coarsen older pages instead of dropping them', async () => {
    const h = harness(1_500);
    const a = h.open(page('A', 100));
    a.call('START_SESSION', { source: 'sidepanel' });
    h.interact(100, 2);
    const b = await h.navigate(a, page('B', 300));
    h.interact(300, 1);
    const segB = b.rt.handoffRecording()!;
    await h.flush();
    const meta = (await h.store.meta(h.TAB))!;
    expect(meta.limitations).toContain('MULTI_PAGE_SESSION_COARSENED');
    const all = (await h.store.collect(h.TAB, segB.sessionId))!;
    expect(all.segments).toHaveLength(2); // nothing dropped
    const [sa] = all.segments;
    expect(sa!.pointer.count).toBe(0);
    expect(sa!.pointer.foldedSamples).toBeGreaterThan(0);
    // Dwell is preserved: every raw sample's weight now lives in the coarse cells.
    expect(sa!.pointer.coarse!.cells.reduce((sum, c) => sum + c.weightMs, 0)).toBe(sa!.pointer.totalWeightMs);
    expect(sa!.clicks).toHaveLength(2); // clicks and stats kept
    expect(sa!.summary.clicks).toBe(2);
  });

  it('coarsening preserves dwell exactly', () => {
    const seg = {
      pointer: { count: 3, t: [0, 1, 2], rootId: [0, 0, 1], x: [1, 5, 40], y: [1, 5, 40], weightMs: [100, 200, 300], elementRef: [0, 0, 0], anchorX: [null, null, null], anchorY: [null, null, null], coarse: null, foldedSamples: 0, totalWeightMs: 600 },
    } as unknown as PageCaptureSegment;
    const c = coarsenSegment(seg);
    expect(c.pointer.coarse!.cells).toEqual([
      { rootId: 0, cx: 0, cy: 0, weightMs: 300 },
      { rootId: 1, cx: 2, cy: 2, weightMs: 300 },
    ]);
    expect(c.pointer.totalWeightMs).toBe(600);
  });

  it('service worker restart: all recording state is recoverable from session storage', async () => {
    const storage = memoryStorage();
    const before = createRecordingStore(storage);
    await before.begin(3, 's-x', 1000);
    await before.addSegment(3, { sessionId: 's-x', index: 0, summary: { activeMs: 500, clicks: 2, activations: 1 } } as unknown as PageCaptureSegment);
    // A fresh store instance = a restarted worker with empty memory.
    const after = createRecordingStore(storage);
    expect(await after.resumePayload(3)).toEqual({ sessionId: 's-x', startedAt: 1000, segmentIndex: 1, prior: { pages: 1, activeMs: 500, clicks: 2, activations: 1 }, continuity: 'continuous' });
    // Unsupported destination: continuity interrupted, data kept.
    await after.interrupt(3);
    const p = (await after.resumePayload(3))!;
    expect(p.continuity).toBe('interrupted');
    expect(p.segmentIndex).toBe(2);
    expect((await after.collect(3, 's-x'))!).toMatchObject({ segments: [{ index: 0 }], limitations: ['RECORDING_INTERRUPTED_UNSUPPORTED_PAGE'] });
    expect(storage.data.size).toBe(0);
  });

  it('Clear removes the recording from session storage; Prediction never runs and is not touched', async () => {
    const h = harness();
    const a = h.open(page('A', 100));
    a.call('START_SESSION', { source: 'sidepanel' });
    const b = await h.navigate(a, page('B', 300));
    b.call('RUN_PREDICTION', { source: 'sidepanel' }); // user-run prediction on page B
    h.modes.length = 0;
    const c = await h.navigate(b, page('C', 500));
    expect(h.modes).toEqual(['registry']); // the resumed segment ran only the light analysis
    expect(c.state().prediction.state).toBe('idle');
    c.call('CLEAR_SESSION', null);
    await h.flush();
    expect(h.storage.data.size).toBe(0);
    expect(c.state().session).toMatchObject({ state: 'idle', recording: null });
  });
});
