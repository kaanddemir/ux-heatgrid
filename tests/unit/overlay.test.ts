// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { OverlayController } from '../../src/content/overlay/controller';
import { movedMaterially, needsScroll, overlayBox, intersect } from '../../src/content/overlay/positioning';
import { LOW_CAP, MEDIUM_CAP, overlayTitle, selectOverlayItems, type OverlayCandidate } from '../../src/content/overlay/predicted';
import { OVERLAY_CSS } from '../../src/content/overlay/root';
import { classifyMutations } from '../../src/content/prediction/stale';
import { createTabRuntime, type OverlayLike } from '../../src/content/tabRuntime';
import { OVERLAY_TAG } from '../../src/shared/constants';
import type { FocusResult, StaleReason, TabSnapshot } from '../../src/shared/model';
import { makeRequest, type RequestEnvelope, type Response } from '../../src/shared/protocol';
import { fixtureReader, mount } from '../helpers/fixtureReader';
import { pages } from '../fixtures/predictionPages';

// The test DOM has no layout engine: live rects come from data-rect (like the analyzer's fixture reader).
function rectFromAttr(this: Element): DOMRect {
  const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
const originalRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = rectFromAttr;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  vi.restoreAllMocks();
  document.querySelectorAll(OVERLAY_TAG).forEach((n) => n.remove());
});

const cand = (id: number, band: OverlayCandidate['band'], rank: number | null = id): OverlayCandidate => ({ id, band, rank });

describe('overlay visual rules (selectOverlayItems)', () => {
  it('maps bands; not assessed is never drawn; Low hidden by default', () => {
    const items = selectOverlayItems([cand(1, 'high'), cand(2, 'medium'), cand(3, 'low'), cand(4, 'not-assessed', null)], { showLow: false, selectedId: null });
    expect(items).toEqual([
      { id: 1, band: 'high', selected: false },
      { id: 2, band: 'medium', selected: false },
    ]);
  });

  it('Low appears only when enabled', () => {
    const items = selectOverlayItems([cand(1, 'high'), cand(3, 'low')], { showLow: true, selectedId: null });
    expect(items.map((i) => i.band)).toEqual(['high', 'low']);
  });

  it('caps Medium and Low by rank; High is never capped', () => {
    const many = [
      ...Array.from({ length: 5 }, (_, i) => cand(i + 1, 'high')),
      ...Array.from({ length: 200 }, (_, i) => cand(100 + i, 'medium')),
      ...Array.from({ length: 200 }, (_, i) => cand(400 + i, 'low')),
    ];
    const items = selectOverlayItems(many, { showLow: true, selectedId: null });
    expect(items.filter((i) => i.band === 'high')).toHaveLength(5);
    expect(items.filter((i) => i.band === 'medium')).toHaveLength(MEDIUM_CAP);
    expect(items.filter((i) => i.band === 'low')).toHaveLength(LOW_CAP);
    // Best-ranked are kept.
    expect(items.find((i) => i.band === 'medium')!.id).toBe(100);
    expect(items.some((i) => i.id === 100 + MEDIUM_CAP)).toBe(false);
  });

  it('the selected element is always drawn, even beyond the cap or when Low is hidden', () => {
    const many = [...Array.from({ length: 100 }, (_, i) => cand(100 + i, 'medium')), cand(900, 'low')];
    const a = selectOverlayItems(many, { showLow: false, selectedId: 199 });
    expect(a.find((i) => i.id === 199)).toEqual({ id: 199, band: 'medium', selected: true });
    const b = selectOverlayItems(many, { showLow: false, selectedId: 900 });
    expect(b.find((i) => i.id === 900)).toEqual({ id: 900, band: 'low', selected: true });
    expect(selectOverlayItems([cand(4, 'not-assessed', null)], { showLow: true, selectedId: 4 })).toEqual([]);
  });

  it('label text never implies probability or measured data', () => {
    expect(overlayTitle(false)).toBe('Predicted');
    expect(overlayTitle(true)).toBe('Predicted · Page Changed');
    for (const t of [overlayTitle(false), overlayTitle(true)]) expect(t).not.toMatch(/%|probab|attention|heat|click/i);
  });

  it('styles never override the host from inside the shadow root (it must stay position: fixed)', () => {
    // Regression: an !important :host rule beats the host's inline !important styles.
    expect(OVERLAY_CSS).not.toMatch(/:host/);
  });

  it('styles: distinct colour and line language per band; only the legend captures input', () => {
    expect(OVERLAY_CSS).toMatch(/\[data-band="high"\][^}]*solid/);
    expect(OVERLAY_CSS).toMatch(/\[data-band="medium"\][^}]*dashed/);
    expect(OVERLAY_CSS).toMatch(/\[data-band="low"\][^}]*dotted/);
    expect(OVERLAY_CSS).toMatch(/pointer-events: none !important/);
    expect(OVERLAY_CSS).toMatch(/\.label\[data-kind="predicted"\][\s\S]*\.label\[data-kind="recorded"\][\s\S]*pointer-events: auto !important/);
    expect(OVERLAY_CSS).toMatch(/\.box\[data-selected\][^{]*\{[^}]*border-width: 3px/);
    expect(OVERLAY_CSS).not.toMatch(/\.box::after|data-label|data-badge-inside/); // legend carries the band labels
  });
});

describe('overlay positioning (pure)', () => {
  const vp = { width: 1000, height: 800 };
  it('pads live rects and drops far off-screen boxes', () => {
    expect(overlayBox({ x: 10, y: 20, width: 100, height: 40 }, [], vp)).toEqual({ x: 8, y: 18, width: 104, height: 44 });
    expect(overlayBox({ x: 10, y: 2000, width: 100, height: 40 }, [], vp)).toBeNull();
    expect(overlayBox({ x: 10, y: 20, width: 0, height: 40 }, [], vp)).toBeNull();
  });
  it('clips to scroll / overflow ancestors (content scrolled out of a nested scroller is hidden)', () => {
    const scroller = { x: 0, y: 100, width: 300, height: 200 };
    expect(overlayBox({ x: 10, y: 50, width: 100, height: 100 }, [scroller], vp)).toEqual({ x: 8, y: 98, width: 104, height: 54 });
    expect(overlayBox({ x: 10, y: 400, width: 100, height: 40 }, [scroller], vp)).toBeNull();
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
  });
  it('needsScroll / movedMaterially', () => {
    expect(needsScroll({ x: 10, y: 100, width: 50, height: 20 }, vp)).toBe(false);
    expect(needsScroll({ x: 10, y: 900, width: 50, height: 20 }, vp)).toBe(true);
    expect(needsScroll({ x: 10, y: -30, width: 50, height: 20 }, vp)).toBe(true);
    const r = { x: 100, y: 100, width: 200, height: 40 };
    expect(movedMaterially(r, { ...r, x: 110 })).toBe(false);
    expect(movedMaterially(r, { ...r, y: 300 })).toBe(true);
    expect(movedMaterially(r, { ...r, width: 300 })).toBe(true);
  });
});

/** Manual rAF so tests control frames. */
function frames() {
  let cbs: Array<() => void> = [];
  return {
    raf: (cb: () => void) => (cbs.push(cb), cbs.length),
    caf: () => {},
    run: () => {
      const c = cbs;
      cbs = [];
      c.forEach((f) => f());
    },
  };
}

function setupOverlay() {
  document.body.innerHTML = `
    <button id="a" data-rect="10 10 100 40">A</button>
    <button id="b" data-rect="10 80 100 40">B</button>
    <button id="c" data-rect="10 150 100 40">C</button>
    <button id="d" data-rect="10 5000 100 40">D</button>`;
  const els = new Map<number, Element | null>([1, 2, 3, 4].map((i) => [i, document.getElementById('abcd'[i - 1]!)]));
  const f = frames();
  const o = new OverlayController({ resolve: (id) => els.get(id) ?? null, raf: f.raf, caf: f.caf });
  const preds = [cand(1, 'high'), cand(2, 'medium'), cand(3, 'low'), cand(4, 'medium'), cand(5, 'not-assessed', null)];
  return { o, f, els, preds };
}

describe('OverlayController', () => {
  it('mounts one accessible zero-size host only when visible with a prediction', () => {
    const { o, f, preds } = setupOverlay();
    o.setPrediction(preds);
    expect(document.querySelector(OVERLAY_TAG)).toBeNull(); // not visible yet
    o.setVisible(true);
    f.run();
    const hosts = document.querySelectorAll(OVERLAY_TAG);
    expect(hosts).toHaveLength(1);
    const host = hosts[0] as HTMLElement;
    expect(host.getAttribute('aria-hidden')).toBeNull();
    expect(host.getAttribute('style')).toMatch(/position: fixed !important/);
    expect(host.getAttribute('style')).toMatch(/pointer-events: auto !important/);
    expect(host.getAttribute('style')).toMatch(/width: 0(?:px)? !important; height: 0(?:px)? !important/);
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.shadowRoot).toBeNull(); // closed shadow root
    const i = o.inspect();
    expect(i.mounted).toBe(true);
    expect(i.title).toBe('Predicted');
    expect(i.boxes.map((b) => [b.id, b.band, b.drawn])).toEqual([
      [1, 'high', true],
      [2, 'medium', true],
      [3, 'low', true],
      [4, 'medium', false], // far below the viewport: not drawn
    ]);
    expect(i.boxes[0]!.box).toEqual({ x: 8, y: 8, width: 104, height: 44 });
  });

  it('view switching unmounts and remounts without duplicates', () => {
    const { o, f, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    o.setVisible(false);
    expect(document.querySelector(OVERLAY_TAG)).toBeNull();
    expect(o.inspect().mounted).toBe(false);
    o.setVisible(true);
    o.setVisible(true);
    f.run();
    expect(document.querySelectorAll(OVERLAY_TAG)).toHaveLength(1);
  });

  it('a second controller (re-injection) replaces an orphaned host — never two roots', () => {
    const a = setupOverlay();
    a.o.setPrediction(a.preds);
    a.o.setVisible(true);
    const b = new OverlayController({ resolve: () => null, raf: a.f.raf, caf: a.f.caf });
    b.setPrediction(a.preds);
    b.setVisible(true);
    expect(document.querySelectorAll(OVERLAY_TAG)).toHaveLength(1);
  });

  it('dispose removes the host and ignores later calls', () => {
    const { o, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    o.dispose();
    expect(document.querySelector(OVERLAY_TAG)).toBeNull();
    o.setVisible(true);
    expect(document.querySelector(OVERLAY_TAG)).toBeNull();
  });

  it('stale mode keeps the boxes and changes the label', () => {
    const { o, f, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    o.setStale(true);
    f.run();
    expect(o.inspect().title).toBe('Predicted · Page Changed');
    expect(o.inspect().boxes.filter((b) => b.drawn)).toHaveLength(3);
    o.setPrediction(preds); // a new result is current again
    expect(o.inspect().stale).toBe(false);
  });

  it('missing elements are not drawn (no stale location is painted)', () => {
    const { o, f, els, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    f.run();
    document.getElementById('b')!.remove();
    els.set(2, null);
    o.flush();
    window.dispatchEvent(new Event('scroll'));
    f.run();
    const b2 = o.inspect().boxes.find((b) => b.id === 2)!;
    expect(b2.drawn).toBe(false);
    expect(o.inspect().missing).toEqual([2]);
  });

  it('selection: selected box distinct, others dimmed, Low shown when selected', () => {
    const { o, f, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    o.setBandFilter('high');
    o.select(3); // a Low element while the High-only filter is active
    f.run();
    const i = o.inspect();
    expect(i.selectedId).toBe(3);
    expect(i.boxes.find((b) => b.id === 3)).toMatchObject({ band: 'low', selected: true, dimmed: false, drawn: true });
    expect(i.boxes.find((b) => b.id === 1)).toMatchObject({ selected: false, dimmed: true });
    o.select(null);
    expect(o.inspect().boxes.some((b) => b.dimmed || b.selected)).toBe(false);
    expect(o.inspect().boxes.some((b) => b.id === 3)).toBe(false);
  });

  it('the on-page filter shows only its band and All restores every painted band', () => {
    const { o, f, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    o.setBandFilter('medium');
    f.run();
    expect(o.inspect()).toMatchObject({ filter: 'medium' });
    expect(o.inspect().boxes.map((b) => b.id)).toEqual([2, 4]);
    o.setBandFilter('low');
    expect(o.inspect().boxes.map((b) => b.id)).toEqual([3]);
    o.setBandFilter('all');
    expect(o.inspect().boxes.map((b) => b.id)).toEqual([1, 2, 3, 4]);
  });

  it('showLow toggles Low outlines', () => {
    const { o, f, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    o.setShowLow(false);
    f.run();
    expect(o.inspect().boxes.map((b) => b.id)).toEqual([1, 2, 4]);
    o.setShowLow(true);
    expect(o.inspect().boxes.map((b) => b.id)).toEqual([1, 2, 3, 4]);
  });

  it('scroll schedules one frame and boxes follow live rects', () => {
    const { o, f, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    f.run();
    document.getElementById('a')!.setAttribute('data-rect', '10 -20 100 40'); // page scrolled by 30px
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    f.run();
    expect(o.inspect().boxes[0]!.box).toEqual({ x: 8, y: -22, width: 104, height: 44 });
  });

  it('clearing the prediction removes the overlay', () => {
    const { o, preds } = setupOverlay();
    o.setPrediction(preds);
    o.setVisible(true);
    o.setPrediction(null);
    expect(document.querySelector(OVERLAY_TAG)).toBeNull();
  });

  it('mounting the host is not a material page change for the stale watcher', () => {
    const host = document.createElement(OVERLAY_TAG);
    host.innerHTML = '<button>inside</button>';
    expect(classifyMutations([{ type: 'childList', target: document.documentElement, addedNodes: [host], removedNodes: [] }])).toEqual({ material: false, changedNodes: 0 });
  });
});

// ---------------------------------------------------------------------------
// TabRuntime integration (protocol handlers)
// ---------------------------------------------------------------------------

function fakeOverlay() {
  const calls: string[] = [];
  const state = { visible: false, predicted: 0, stale: false, showLow: false, selected: null as number | null, disposed: false };
  const o: OverlayLike = {
    setVisible: (v) => ((state.visible = v), calls.push(`visible:${v}`)),
    setPrediction: (c) => ((state.predicted = c?.length ?? 0), calls.push(`prediction:${c ? c.length : null}`)),
    setStale: (s) => void (state.stale = s),
    setShowLow: (s) => void (state.showLow = s),
    select: (id) => void (state.selected = id),
    dispose: () => void (state.disposed = true),
  };
  return { o, calls, state };
}

function setupRuntime(withRealOverlay = false) {
  mount(pages.landing);
  const analyzer = createPageAnalyzer({ reader: fixtureReader({ docHeight: 2200 }) });
  const fake = fakeOverlay();
  const f = frames();
  let onStale: ((r: StaleReason) => void) | null = null;
  const rt = createTabRuntime({
    buildId: 'test',
    emit: () => {},
    analyzer,
    createWatcher: (cb) => ((onStale = cb), { arm: () => {}, disarm: () => {}, dispose: () => {} }),
    ...(withRealOverlay
      ? { createOverlay: (resolve) => new OverlayController({ resolve, raf: f.raf, caf: f.caf }) }
      : { createOverlay: () => fake.o }),
  });
  const call = <T extends Parameters<typeof makeRequest>[0]>(type: T, payload: Parameters<typeof makeRequest<T>>[1]): Response<unknown> =>
    rt.handle(makeRequest(type, payload) as RequestEnvelope);
  const state = () => (call('GET_STATE', null) as { ok: true; data: TabSnapshot }).data;
  const idOf = (domId: string) => analyzer.registry.get(document.getElementById(domId)!)!.id;
  return { rt, call, state, fake, idOf, f, stale: (r: StaleReason) => onStale!(r) };
}

describe('TabRuntime: interaction view, focus, details', () => {
  it('SET_INTERACTION_VIEW predicted requires a prediction; recorded is not available yet', () => {
    const { call, state, fake } = setupRuntime();
    const r = call('SET_INTERACTION_VIEW', { view: 'predicted' });
    expect(!r.ok && r.error.code).toBe('INVALID_STATE');
    expect(state().interactionView).toBe('none');
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const rec = call('SET_INTERACTION_VIEW', { view: 'recorded' });
    expect(!rec.ok && rec.error.code).toBe('INVALID_STATE');
    const ok = call('SET_INTERACTION_VIEW', { view: 'predicted', showLow: true });
    expect(ok.ok && (ok.data as TabSnapshot)).toMatchObject({ interactionView: 'predicted', overlay: { showLow: true, focusedElementId: null } });
    expect(fake.state).toMatchObject({ visible: true, showLow: true });
    expect(fake.state.predicted).toBeGreaterThan(0);
    call('SET_INTERACTION_VIEW', { view: 'none' });
    expect(fake.state.visible).toBe(false);
    expect(state().interactionView).toBe('none');
  });

  it('the overlay is not created until it is used', () => {
    const { call, fake } = setupRuntime();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    expect(fake.calls).toEqual([]);
  });

  it('FOCUS_ELEMENT: focuses, switches to predicted view, scrolls only when needed, clears', () => {
    const { call, state, fake, idOf } = setupRuntime();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const cta = idOf('cta');
    const r = call('FOCUS_ELEMENT', { elementId: cta, scroll: true }) as { ok: true; data: FocusResult };
    expect(r.data).toMatchObject({ status: 'focused', moved: false });
    expect(r.data.snapshot).toMatchObject({ interactionView: 'predicted', overlay: { focusedElementId: cta } });
    expect(fake.state.selected).toBe(cta);
    expect(scroll).not.toHaveBeenCalled(); // already in view
    const foot = idOf('foot-0'); // y = 2100: below the viewport
    call('FOCUS_ELEMENT', { elementId: foot, scroll: true });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0]![0]).toMatchObject({ block: 'center' });
    const c = call('FOCUS_ELEMENT', { elementId: null, scroll: false }) as { ok: true; data: FocusResult };
    expect(c.data.status).toBe('cleared');
    expect(state().overlay.focusedElementId).toBeNull();
    expect(fake.state.selected).toBeNull();
  });

  it('FOCUS_ELEMENT respects prefers-reduced-motion', () => {
    const { call, idOf } = setupRuntime();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const mm = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    call('FOCUS_ELEMENT', { elementId: idOf('foot-1'), scroll: true });
    expect(mm).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(scroll.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
  });

  it('FOCUS_ELEMENT reports moved elements and unavailable (removed) elements', () => {
    const { call, state, idOf } = setupRuntime();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const sec = idOf('secondary');
    document.getElementById('secondary')!.setAttribute('data-rect', '360 700 160 48'); // moved down after prediction
    const moved = call('FOCUS_ELEMENT', { elementId: sec, scroll: false }) as { ok: true; data: FocusResult };
    expect(moved.data).toMatchObject({ status: 'focused', moved: true });
    document.getElementById('secondary')!.remove();
    const gone = call('FOCUS_ELEMENT', { elementId: sec, scroll: true }) as { ok: true; data: FocusResult };
    expect(gone.data.status).toBe('unavailable');
    expect(state().overlay.focusedElementId).toBeNull();
  });

  it('FOCUS_ELEMENT / GET_PREDICTION_DETAILS without a prediction or with unknown ids fail cleanly', () => {
    const { call } = setupRuntime();
    const a = call('FOCUS_ELEMENT', { elementId: 1, scroll: false });
    expect(!a.ok && a.error.code).toBe('INVALID_STATE');
    const b = call('GET_PREDICTION_DETAILS', { elementId: 1 });
    expect(!b.ok && b.error.code).toBe('INVALID_STATE');
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const c = call('FOCUS_ELEMENT', { elementId: 999_999, scroll: false });
    expect(!c.ok && c.error.code).toBe('INVALID_MESSAGE');
    expect(call('GET_PREDICTION_DETAILS', { elementId: 999_999 })).toEqual({ ok: true, data: null });
  });

  it('GET_PREDICTION_DETAILS returns one element of the current prediction', () => {
    const { call, idOf } = setupRuntime();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const r = call('GET_PREDICTION_DETAILS', { elementId: idOf('cta') }) as { ok: true; data: { element: { id: number }; reasons: unknown[] } };
    expect(r.data.element.id).toBe(idOf('cta'));
    expect(r.data.reasons.length).toBeGreaterThan(0);
  });

  it('stale marks the overlay stale; clear hides it and resets view and focus; re-run keeps a valid focus', () => {
    const { call, state, fake, idOf, stale } = setupRuntime();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    call('FOCUS_ELEMENT', { elementId: idOf('cta'), scroll: false });
    stale('dom-change');
    expect(state()).toMatchObject({ prediction: { state: 'stale' }, interactionView: 'predicted' });
    expect(fake.state).toMatchObject({ stale: true, visible: true });
    // Stale results stay inspectable (no automatic rerun).
    expect(call('FOCUS_ELEMENT', { elementId: idOf('cta'), scroll: false }).ok).toBe(true);
    call('RUN_PREDICTION', { source: 'sidepanel' });
    expect(fake.state.stale).toBe(false);
    expect(state().overlay.focusedElementId).toBe(idOf('cta'));
    expect(fake.state.selected).toBe(idOf('cta'));
    call('CLEAR_PREDICTION', null);
    expect(state()).toMatchObject({ interactionView: 'none', overlay: { focusedElementId: null } });
    expect(fake.state).toMatchObject({ visible: false, predicted: 0 });
  });

  it('Record hides the predicted overlay (result kept), blocks showing it, and does not re-show it after Stop', () => {
    const { call, state, fake, idOf } = setupRuntime();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    call('SET_INTERACTION_VIEW', { view: 'predicted' });
    call('FOCUS_ELEMENT', { elementId: idOf('cta'), scroll: false });
    const predictionId = state().prediction.predictionId;
    call('START_SESSION', { source: 'sidepanel' });
    expect(state()).toMatchObject({ interactionView: 'none', overlay: { focusedElementId: null }, session: { state: 'recording' }, prediction: { state: 'ready', predictionId } });
    expect(fake.state.visible).toBe(false);
    const v = call('SET_INTERACTION_VIEW', { view: 'predicted' });
    expect(!v.ok && v.error.code).toBe('INVALID_STATE');
    const f = call('FOCUS_ELEMENT', { elementId: idOf('cta'), scroll: false });
    expect(!f.ok && f.error.code).toBe('INVALID_STATE');
    call('STOP_SESSION', null);
    expect(state()).toMatchObject({ interactionView: 'none', session: { state: 'ready' }, prediction: { state: 'ready', predictionId } });
    expect(call('SET_INTERACTION_VIEW', { view: 'predicted' }).ok).toBe(true); // available again after Stop
  });

  it('dispose removes the overlay (real controller)', () => {
    const { rt, call, f } = setupRuntime(true);
    call('RUN_PREDICTION', { source: 'sidepanel' });
    call('SET_INTERACTION_VIEW', { view: 'predicted' });
    f.run();
    expect(document.querySelectorAll(OVERLAY_TAG)).toHaveLength(1);
    rt.dispose();
    expect(document.querySelector(OVERLAY_TAG)).toBeNull();
  });

  it('the analyzer ignores the overlay host (re-running with the overlay visible is unchanged)', () => {
    const { call, f } = setupRuntime(true);
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const before = (call('GET_PREDICTION', null) as { ok: true; data: { elements: unknown[]; summary: unknown } }).data;
    call('SET_INTERACTION_VIEW', { view: 'predicted' });
    f.run();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const after = (call('GET_PREDICTION', null) as { ok: true; data: { elements: unknown[]; summary: unknown } }).data;
    expect(after.summary).toEqual(before.summary);
    expect(after.elements).toEqual(before.elements);
  });
});
