// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { PointerBuffer } from '../../src/content/recorder/buffer';
import { CLICK_CAP } from '../../src/content/recorder/clicks';
import { ActivityClock, IDLE_MS } from '../../src/content/recorder/idle';
import { captureDetails, liveRecorderListeners, startRecorder, summarizeCapture, type Recorder } from '../../src/content/recorder';
import { DWELL_CAP_MS } from '../../src/content/recorder/pointer';
import { MAX_ROOTS, qualifiesAsRoot, toRootCoords } from '../../src/content/recorder/roots';
import { TIMELINE_CAP } from '../../src/content/recorder/scroll';
import type { SessionCapture } from '../../src/content/recorder/types';
import { createTabRuntime } from '../../src/content/tabRuntime';
import type { TabSnapshot } from '../../src/shared/model';
import { makeRequest, type RequestEnvelope } from '../../src/shared/protocol';
import { fixtureReader, mount } from '../helpers/fixtureReader';

// ---------------------------------------------------------------------------
// Rig: fixture DOM (data-rect geometry), manual clock / rAF, fake IntersectionObserver.
// ---------------------------------------------------------------------------

function rectFromAttr(this: Element): DOMRect {
  const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rectFromAttr);
});
afterEach(() => {
  vi.restoreAllMocks();
  setVisibility('visible');
});

function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
}

/** Marks a synthetic event trusted (the recorder ignores untrusted page-generated events). */
function trusted<E extends Event>(e: E): E {
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
}

class FakeIO {
  static last: FakeIO | null = null;
  targets: Element[] = [];
  constructor(public cb: IntersectionObserverCallback) {
    FakeIO.last = this;
  }
  observe(el: Element): void {
    this.targets.push(el);
  }
  disconnect(): void {
    this.targets = [];
  }
  fire(el: Element, ratio: number): void {
    this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const PAGE = `
  <main data-rect="0 0 1280 2400">
    <button id="a" data-rect="100 100 200 50"><span id="a-inner" data-rect="120 110 60 20">A</span></button>
    <button id="b" data-rect="100 300 200 50">B</button>
    <div id="tile" style="cursor: pointer" data-rect="100 500 200 80">Tile</div>
    <p id="text" data-rect="100 700 600 80">Just text</p>
    <button id="far" data-rect="100 2200 200 50">Far</button>
    <input id="field" type="text" data-rect="100 800 300 40">
  </main>`;

function rig(opts: { pointerCap?: number; html?: string } = {}) {
  mount(opts.html ?? PAGE);
  const analyzer = createPageAnalyzer({ reader: fixtureReader({ docHeight: 2400 }) });
  let t = 10_000;
  let frames: Array<() => void> = [];
  const rec = startRecorder({
    analyzer,
    win: window,
    now: () => t,
    raf: (cb) => (frames.push(cb), frames.length),
    caf: () => {},
    IntersectionObserver: FakeIO as never,
    ...(opts.pointerCap ? { pointerCap: opts.pointerCap } : {}),
  });
  const $ = (id: string) => document.getElementById(id)!;
  const idOf = (id: string) => analyzer.registry.get($(id))!.id;
  const advance = (ms: number) => (t += ms);
  const move = (el: Element, x: number, y: number, dt = 50, pointerType = 'mouse') => {
    advance(dt);
    el.dispatchEvent(trusted(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, composed: true, pointerType })));
  };
  const over = (el: Element, dt = 0) => {
    advance(dt);
    el.dispatchEvent(trusted(new PointerEvent('pointerover', { bubbles: true, composed: true, pointerType: 'mouse' })));
  };
  const click = (el: Element, init: MouseEventInit & { pointerType?: string } = {}) =>
    el.dispatchEvent(trusted(new PointerEvent('click', { bubbles: true, composed: true, detail: 1, pointerType: 'mouse', clientX: 10, clientY: 10, ...init })));
  const leave = (dt = 0) => {
    advance(dt);
    document.documentElement.dispatchEvent(trusted(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null, pointerType: 'mouse' })));
  };
  const runFrames = () => {
    const f = frames;
    frames = [];
    f.forEach((cb) => cb());
  };
  const stat = (c: SessionCapture, id: string) => c.elements.find((e) => e.elementRef === idOf(id))!;
  return { rec, analyzer, $, idOf, advance, move, over, click, leave, runFrames, stat, now: () => t };
}

let active: Recorder | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});
const track = <T extends { rec: Recorder }>(r: T): T => ((active = r.rec), r);

// ---------------------------------------------------------------------------

describe('activity clock (idle / active time)', () => {
  it('active time stops IDLE_MS after the last input; elapsed continues; input resumes', () => {
    const c = new ActivityClock(0, true);
    expect(c.activeAt(10_000)).toBe(10_000);
    expect(c.activeAt(IDLE_MS + 20_000)).toBe(IDLE_MS); // idle after 30 s without input
    expect(c.isActive(IDLE_MS + 1)).toBe(false);
    c.input(60_000); // resume
    expect(c.activeAt(61_000)).toBe(IDLE_MS + 1_000);
  });

  it('a hidden document does not count; showing again stays paused until input (nothing synthetic)', () => {
    const c = new ActivityClock(0, true);
    c.setVisible(false, 5_000);
    expect(c.activeAt(20_000)).toBe(5_000);
    c.setVisible(true, 20_000);
    expect(c.activeAt(25_000)).toBe(5_000);
    c.input(25_000);
    expect(c.activeAt(26_000)).toBe(6_000);
    expect(c.stop(27_000)).toBe(7_000);
    c.input(28_000);
    expect(c.activeAt(40_000)).toBe(7_000); // stopped
  });
});

describe('pointer sampling and dwell', () => {
  it('30 Hz cap and 4 px threshold', () => {
    const r = track(rig());
    r.move(r.$('text'), 10, 10, 50);
    r.move(r.$('text'), 50, 50, 10); // < 33 ms after the last retained → dropped
    r.move(r.$('text'), 52, 51, 40); // < 4 px from the last retained (10,10)? no: retained (far)
    r.move(r.$('text'), 53, 52, 40); // < 4 px → dropped
    r.move(r.$('text'), 80, 80, 40);
    const c = r.rec.stop();
    expect(Array.from(c.pointer.x)).toEqual([10, 52, 80]);
  });

  it('weights are active time until the next retained sample, capped at 1 s', () => {
    const r = track(rig());
    r.move(r.$('text'), 10, 10, 0);
    r.move(r.$('text'), 30, 10, 200);
    r.move(r.$('text'), 60, 10, 5_000); // previous sample dwelt 5 s → capped
    r.advance(300);
    const c = r.rec.stop(); // stop closes the last dwell
    expect(Array.from(c.pointer.weightMs)).toEqual([200, DWELL_CAP_MS, 300]);
    expect(c.pointer.totalWeightMs).toBe(200 + DWELL_CAP_MS + 300);
  });

  it('sampling rate does not materially change total dwell', () => {
    const total = (stepMs: number) => {
      const r = rig();
      for (let i = 0; i * stepMs <= 2_000; i++) r.move(r.$('text'), 10 + i * 6, 10, i === 0 ? 0 : stepMs);
      const c = r.rec.stop();
      return c.pointer.totalWeightMs;
    };
    const fast = total(34);
    const slow = total(100);
    expect(Math.abs(fast - slow) / slow).toBeLessThan(0.05);
  });

  it('leaving the document closes the dwell; the next move is always retained', () => {
    const r = track(rig());
    r.move(r.$('text'), 10, 10, 0);
    r.leave(400);
    r.move(r.$('text'), 11, 11, 5_000); // only 1 px away, but after a leave
    r.advance(100);
    const c = r.rec.stop();
    expect(Array.from(c.pointer.weightMs)).toEqual([400, 100]);
  });

  it('hidden tab closes the dwell and pauses active time', () => {
    const r = track(rig());
    r.move(r.$('text'), 10, 10, 0);
    r.advance(250);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    r.advance(60_000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    r.move(r.$('text'), 60, 60, 100);
    r.advance(100);
    const c = r.rec.stop();
    expect(Array.from(c.pointer.weightMs)).toEqual([250, 100]);
    // Showing the tab again is not activity: active time resumes with the next move.
    expect(c.meta.activeMs).toBe(250 + 100);
    expect(c.meta.elapsedMs).toBeGreaterThan(60_000);
  });

  it('idle: no dwell or active time accumulates after 30 s without input', () => {
    const r = track(rig());
    r.move(r.$('text'), 10, 10, 0);
    r.advance(120_000);
    const c = r.rec.stop();
    expect(c.pointer.weightMs[0]).toBe(DWELL_CAP_MS);
    expect(c.meta.activeMs).toBe(IDLE_MS);
  });

  it('samples over a control are anchored (element + position within it); others are not', () => {
    const r = track(rig());
    r.move(r.$('a-inner'), 150, 125, 0); // child of #a (100,100 200×50)
    r.move(r.$('text'), 300, 720, 100);
    const c = r.rec.stop();
    expect(c.pointer.elementRef[0]).toBe(r.idOf('a'));
    expect(c.pointer.anchorX[0]).toBeCloseTo(0.25);
    expect(c.pointer.anchorY[0]).toBeCloseTo(0.5);
    expect(c.pointer.elementRef[1]).toBe(0);
    expect(Number.isNaN(c.pointer.anchorX[1])).toBe(true);
    expect(r.stat(c, 'a').pointerMs).toBe(100);
  });

  it('touch movement is ignored', () => {
    const r = track(rig());
    r.move(r.$('text'), 10, 10, 0, 'touch');
    expect(r.rec.stop().pointer.count).toBe(0);
  });
});

describe('hover', () => {
  it('< 300 ms ignored, ≥ 300 ms counted, dwell accumulates, children of one control are one hover', () => {
    const r = track(rig());
    r.over(r.$('a'));
    r.over(r.$('b'), 200); // a: 200 ms → ignored
    r.over(r.$('a'), 500); // b: 500 ms → counted
    r.over(r.$('a-inner'), 400); // same control: no new entry
    r.over(r.$('text'), 400); // a: 800 ms continuous
    const c = r.rec.stop();
    expect(r.stat(c, 'b')).toMatchObject({ hoverEntries: 1, hoverDwellMs: 500 });
    expect(r.stat(c, 'a')).toMatchObject({ hoverEntries: 1, hoverDwellMs: 800 });
  });

  it('one continuous hover is capped at 10 s; stop closes an open hover', () => {
    const r = track(rig());
    r.over(r.$('a'));
    for (let i = 0; i < 15; i++) r.move(r.$('a'), 110 + (i % 2) * 10, 110, 1_000); // keep active
    r.over(r.$('b'), 0);
    r.advance(700);
    const c = r.rec.stop();
    expect(r.stat(c, 'a').hoverDwellMs).toBe(10_000);
    expect(r.stat(c, 'b')).toMatchObject({ hoverEntries: 1, hoverDwellMs: 700 });
  });
});

describe('clicks and activation', () => {
  it('semantic control, heuristic cursor control, non-interactive content, empty background', () => {
    const r = track(rig());
    r.click(r.$('a-inner'), { clientX: 150, clientY: 120 });
    r.click(r.$('tile'));
    r.click(r.$('text'));
    r.click(document.body);
    const c = r.rec.stop();
    expect(c.clicks.map((x) => [x.elementRef ?? null, x.interactive])).toEqual([
      [r.idOf('a'), 'yes'],
      [r.idOf('tile'), 'yes'],
      [null, 'maybe-not'],
    ]);
    expect(c.clicks[0]).toMatchObject({ kind: 'pointer', rootId: 0, x: 150, y: 120, viewportX: 150, viewportY: 120, button: 0, pointerType: 'mouse' });
    expect(r.stat(c, 'a').clicks).toBe(1);
  });

  it('keyboard activation (detail 0) is recorded without coordinates', () => {
    const r = track(rig());
    r.$('b').dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, detail: 0 })));
    const c = r.rec.stop();
    expect(c.clicks[0]).toEqual({ id: 1, t: 0, kind: 'activation', elementRef: r.idOf('b'), interactive: 'yes' });
    expect(r.stat(c, 'b')).toMatchObject({ activations: 1, clicks: 0 });
  });

  it('touch and text-selection clicks are never "maybe-not"; untrusted clicks are ignored', () => {
    const r = track(rig());
    r.click(r.$('text'), { pointerType: 'touch' });
    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection);
    r.click(r.$('text'));
    r.$('b').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); // untrusted
    const c = r.rec.stop();
    expect(c.clicks.map((x) => x.interactive)).toEqual(['yes', 'yes']);
  });

  it('click events are capped; counts stay exact', () => {
    const r = track(rig());
    for (let i = 0; i < CLICK_CAP + 7; i++) r.click(r.$('b'));
    const c = r.rec.stop();
    expect(c.clicks).toHaveLength(CLICK_CAP);
    expect(c.clicksDropped).toBe(7);
    expect(r.stat(c, 'b').clicks).toBe(CLICK_CAP + 7);
    expect(summarizeCapture(c).clicks).toBe(CLICK_CAP + 7);
  });

  it('focus on candidates, without repeats inside one control', () => {
    const r = track(rig());
    const focus = (el: Element) => el.dispatchEvent(trusted(new FocusEvent('focusin', { bubbles: true })));
    focus(r.$('field'));
    focus(r.$('field'));
    focus(r.$('b'));
    focus(r.$('field'));
    const c = r.rec.stop();
    expect(r.stat(c, 'field').focusEvents).toBe(2);
    expect(r.stat(c, 'b').focusEvents).toBe(1);
    expect(r.stat(c, 'field').hasActiveInteraction).toBe(true);
  });
});

describe('exposure', () => {
  it('reached at > 0; exposure only at ≥ 50% and only while active; maxVisibleRatio', () => {
    const r = track(rig());
    const io = FakeIO.last!;
    expect(io.targets.length).toBeGreaterThan(0);
    io.fire(r.$('far'), 0.2);
    r.move(r.$('text'), 10, 10, 1_000);
    io.fire(r.$('far'), 0.6);
    r.move(r.$('text'), 30, 10, 2_000);
    io.fire(r.$('far'), 0.3);
    const c = r.rec.stop();
    expect(r.stat(c, 'far').exposure).toMatchObject({ reached: true, exposureMs: 2_000, maxVisibleRatio: 0.6 });
    expect(r.stat(c, 'b').exposure.reached).toBe(false);
  });

  it('hidden tab and idle pause exposure; activity resumes it; stop closes the interval', () => {
    const r = track(rig());
    const io = FakeIO.last!;
    io.fire(r.$('a'), 1);
    r.advance(1_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    r.advance(50_000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    r.move(r.$('text'), 10, 10, 0); // resume
    r.advance(IDLE_MS + 40_000); // goes idle after 30 s
    const c = r.rec.stop();
    expect(r.stat(c, 'a').exposure.exposureMs).toBe(1_000 + IDLE_MS);
    expect(r.stat(c, 'a').hasActiveInteraction).toBe(false); // exposure alone is not interaction
  });
});

describe('scroll and roots', () => {
  it('coordinate conversion: document space and root-content space', () => {
    expect(toRootCoords(100, 50, { kind: 'document', scrollX: 0, scrollY: 900 })).toEqual({ x: 100, y: 950 });
    expect(toRootCoords(100, 50, { kind: 'container', left: 40, top: 20, clientLeft: 2, clientTop: 2, scrollLeft: 0, scrollTop: 300 })).toEqual({ x: 58, y: 328 });
  });

  it('qualifying scroll containers: scrollable, overflowing and large enough', () => {
    const vp = { width: 1280, height: 800 };
    const box = { overflowX: 'hidden', overflowY: 'auto', clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2000 };
    expect(qualifiesAsRoot(box, vp)).toBe(true);
    expect(qualifiesAsRoot({ ...box, clientWidth: 120, clientHeight: 90 }, vp)).toBe(false); // tiny
    expect(qualifiesAsRoot({ ...box, scrollHeight: 300 }, vp)).toBe(false); // no overflow
    expect(qualifiesAsRoot({ ...box, overflowY: 'visible' }, vp)).toBe(false);
    expect(qualifiesAsRoot({ ...box, clientWidth: 260, clientHeight: 800 }, vp)).toBe(true); // ≥ 20% of viewport
  });

  const scroller = (id: string, top = 0) => {
    const el = document.getElementById(id)!;
    el.style.overflowY = 'auto';
    for (const [k, v] of Object.entries({ clientWidth: 400, clientHeight: 300, scrollWidth: 400, scrollHeight: 2000, clientLeft: 0, clientTop: 0 })) {
      Object.defineProperty(el, k, { value: v, configurable: true });
    }
    Object.defineProperty(el, 'scrollTop', { value: top, configurable: true, writable: true });
    return el;
  };
  const NESTED = `<main data-rect="0 0 1280 2400"><div id="pane" data-rect="40 100 400 300"><button id="in" data-rect="60 160 120 40">In</button><p id="pane-text" data-rect="60 260 300 40">t</p></div></main>`;

  it('nested root: pointer samples use root-content coordinates, stable through its scrolling', () => {
    const r = track(rig({ html: NESTED }));
    const pane = scroller('pane', 0);
    r.move(r.$('pane-text'), 100, 280, 0);
    pane.scrollTop = 200;
    window.dispatchEvent(trusted(new Event('scroll')));
    pane.dispatchEvent(trusted(new Event('scroll', { bubbles: false })));
    r.runFrames();
    // The same content point is now 200 px higher on screen.
    r.move(r.$('pane-text'), 100, 80, 100);
    const c = r.rec.stop();
    expect(c.pointer.rootId[0]).toBe(c.pointer.rootId[1]);
    expect(c.pointer.rootId[0]).not.toBe(0);
    expect([c.pointer.x[0], c.pointer.y[0]]).toEqual([60, 180]);
    expect([c.pointer.x[1], c.pointer.y[1]]).toEqual([60, 180]);
    const root = c.scroll.roots.find((x) => x.rootId === c.pointer.rootId[0])!;
    expect(root).toMatchObject({ kind: 'container', lazy: true, deepestPx: 500 });
  });

  it('document: deepest scroll and a throttled timeline (one measurement per frame)', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2400, configurable: true });
    const r = track(rig());
    const setY = (y: number) => Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    for (let i = 1; i <= 20; i++) {
      setY(i * 50);
      r.advance(50);
      document.dispatchEvent(trusted(new Event('scroll')));
      if (i % 2 === 0) r.runFrames();
    }
    setY(0);
    const c = r.rec.stop();
    const doc = c.scroll.roots.find((x) => x.kind === 'document')!;
    expect(doc.deepestPx).toBe(1_000 + window.innerHeight);
    expect(c.scroll.timeline.length).toBeLessThanOrEqual(5); // 1 s of scrolling at ≥ 250 ms per point
    expect(summarizeCapture(c).deepestScroll).toBeGreaterThan(0);
    setY(0);
  });

  it('root cap: beyond MAX_ROOTS a qualifying container is reported as untracked', () => {
    const html = `<main data-rect="0 0 1280 2400">${Array.from({ length: MAX_ROOTS + 2 }, (_, i) => `<div id="s${i}" data-rect="0 ${i * 300} 400 300"><p id="p${i}" data-rect="0 ${i * 300} 100 20">x</p></div>`).join('')}</main>`;
    const r = track(rig({ html }));
    for (let i = 0; i < MAX_ROOTS + 2; i++) scroller(`s${i}`);
    for (let i = 0; i < MAX_ROOTS + 2; i++) r.move(r.$(`p${i}`), 10 + i * 20, i * 300 + 10, 100);
    const c = r.rec.stop();
    expect(c.scroll.roots).toHaveLength(MAX_ROOTS);
    expect(c.limitations).toContain('NESTED_SCROLL_UNTRACKED');
  });
});

describe('memory bounds', () => {
  it('pointer cap: raw samples stop at the cap, later dwell goes to coarse cells, limitation emitted', () => {
    const r = track(rig({ pointerCap: 50 }));
    for (let i = 0; i < 120; i++) r.move(r.$('text'), 10 + (i % 40) * 10, 10 + Math.floor(i / 40) * 40, 50);
    const c = r.rec.stop();
    expect(c.pointer.count).toBe(50);
    expect(c.pointer.coarse!.cells.length).toBeGreaterThan(0);
    const raw = Array.from(c.pointer.weightMs).reduce((a, b) => a + b, 0);
    const coarse = c.pointer.coarse!.cells.reduce((a, b) => a + b.weightMs, 0);
    expect(raw + coarse + c.pointer.coarse!.droppedWeightMs).toBeCloseTo(c.pointer.totalWeightMs);
    expect(c.limitations).toContain('LONG_SESSION_COARSENED');
  });

  it('the buffer grows by doubling and never beyond its cap; stored samples are never overwritten', () => {
    const b = new PointerBuffer(20_000);
    for (let i = 0; i < 25_000; i++) {
      b.push({ t: i, rootId: 0, x: i, y: 0, elementRef: 0, anchorX: Number.NaN, anchorY: Number.NaN });
      b.closeOpen(1);
    }
    const p = b.finalize();
    expect(p.count).toBe(20_000);
    expect(p.x[19_999]).toBe(19_999);
    expect(p.totalWeightMs).toBe(25_000);
  });

  it('scroll timeline stays bounded (decimated, interval doubled)', () => {
    const r = track(rig());
    for (let i = 0; i < TIMELINE_CAP * 3; i++) {
      Object.defineProperty(window, 'scrollY', { value: i % 500, configurable: true });
      r.advance(260);
      document.dispatchEvent(trusted(new Event('scroll')));
      r.runFrames();
    }
    const c = r.rec.stop();
    expect(c.scroll.timeline.length).toBeLessThanOrEqual(TIMELINE_CAP);
    expect(c.scroll.timelineIntervalMs).toBeGreaterThan(250);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });
});

describe('capture result, stats, privacy', () => {
  it('controlled session: hovered/clicked controls have data, untouched ones none; regions aggregate', () => {
    const r = track(rig());
    r.over(r.$('a'));
    r.move(r.$('a'), 150, 120, 0);
    r.move(r.$('a'), 170, 120, 400);
    r.click(r.$('a'), { clientX: 170, clientY: 120 });
    r.over(r.$('text'), 300);
    FakeIO.last!.fire(r.$('a'), 1);
    const c = r.rec.stop();
    expect(r.stat(c, 'a')).toMatchObject({ hoverEntries: 1, clicks: 1, hasActiveInteraction: true });
    expect(r.stat(c, 'a').pointerMs).toBeGreaterThan(0);
    expect(r.stat(c, 'b')).toMatchObject({ hoverEntries: 0, clicks: 0, pointerMs: 0, hasActiveInteraction: false });
    expect(r.stat(c, 'far').exposure.reached).toBe(false);
    const region = c.regions.find((g) => g.regionId === r.stat(c, 'a').regionId)!;
    expect(region).toMatchObject({ clicks: 1, reached: true, interactedElements: 1 });
    expect(region.pointerWeightMs).toBeGreaterThan(0);
    const s = summarizeCapture(c);
    expect(s).toMatchObject({ kind: 'capture', clicks: 1, controlsInteracted: 1, controlsReached: 1 });
    expect(s.limitations).toEqual(expect.arrayContaining(['SHORT_SESSION', 'FEW_EVENTS']));
    // No scores of any kind.
    expect(JSON.stringify(s)).not.toMatch(/score|engagement|attention|frustration|rage/i);
  });

  it('capture details expose aggregates only (no samples or event lists)', () => {
    const r = track(rig());
    r.move(r.$('a'), 150, 120, 0);
    r.click(r.$('a'));
    const d = captureDetails(r.rec.stop());
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/"weightMs"|"anchorX"|"timeline"|"clicks":\[/);
    expect(d.clickCounts).toEqual({ pointer: 1, activation: 0, maybeNotClickable: 0, dropped: 0 });
    expect(d.elements.every((e) => e.hasActiveInteraction || e.pointerMs > 0 || e.exposure.reached)).toBe(true);
  });

  it('never captures typed text or field values', () => {
    const r = track(rig());
    const field = r.$('field') as HTMLInputElement;
    field.value = 'hunter2-secret';
    for (const key of ['h', 'u', 'n', 'Enter']) field.dispatchEvent(trusted(new KeyboardEvent('keydown', { key, bubbles: true })));
    field.dispatchEvent(trusted(new FocusEvent('focusin', { bubbles: true })));
    const c = r.rec.stop();
    const json = JSON.stringify(c, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v));
    expect(json).not.toContain('hunter2');
    expect(json).not.toMatch(/"key"|"Enter"/);
  });

  it('PAGE_CHANGED on a substantial DOM change; recording continues', async () => {
    const r = track(rig());
    const host = document.createElement('section');
    host.innerHTML = Array.from({ length: 120 }, () => '<div></div>').join('');
    document.body.append(host);
    await new Promise((res) => setTimeout(res, 0));
    r.move(r.$('text'), 10, 10, 50);
    const c = r.rec.stop();
    expect(c.limitations).toContain('PAGE_CHANGED');
    expect(c.pointer.count).toBe(1);
  });
});

describe('lifecycle and cleanup', () => {
  it('start attaches one set of listeners; stop removes them; stop is idempotent', () => {
    const base = liveRecorderListeners;
    const r = rig();
    const n = r.rec.listenerCount();
    expect(n).toBeGreaterThan(5);
    expect(liveRecorderListeners).toBe(base + n);
    const a = r.rec.stop();
    expect(liveRecorderListeners).toBe(base);
    expect(r.rec.stop()).toBe(a);
    r.move(r.$('text'), 10, 10, 50); // after stop: nothing recorded
    expect(a.pointer.count).toBe(0);
  });

  function runtime() {
    mount(PAGE);
    const analyzer = createPageAnalyzer({ reader: fixtureReader({ docHeight: 2400 }) });
    const modes: string[] = [];
    const analyze = analyzer.analyze.bind(analyzer);
    analyzer.analyze = ((o?: { mode?: string }) => (modes.push(o?.mode ?? 'full'), analyze(o as never))) as typeof analyzer.analyze;
    const rt = createTabRuntime({
      buildId: 'test',
      emit: () => {},
      analyzer,
      createRecorder: (a) => startRecorder({ analyzer: a, IntersectionObserver: FakeIO as never }),
    });
    const call = <T extends Parameters<typeof makeRequest>[0]>(type: T, payload: Parameters<typeof makeRequest<T>>[1]) => rt.handle(makeRequest(type, payload) as RequestEnvelope);
    const state = () => (call('GET_STATE', null) as { ok: true; data: TabSnapshot }).data;
    return { rt, call, state, modes };
  }

  it('Record again / Clear / dispose never leave duplicate listeners', () => {
    const base = liveRecorderListeners;
    const { rt, call } = runtime();
    call('START_SESSION', { source: 'sidepanel' });
    const n = liveRecorderListeners - base;
    call('STOP_SESSION', null);
    call('START_SESSION', { source: 'sidepanel' }); // Record again
    expect(liveRecorderListeners - base).toBe(n);
    call('CLEAR_SESSION', null);
    expect(liveRecorderListeners).toBe(base);
    call('START_SESSION', { source: 'sidepanel' });
    rt.dispose();
    expect(liveRecorderListeners).toBe(base);
  });

  it('Record runs only a registry-mode analysis and never runs or clears Prediction', () => {
    const { call, state, modes } = runtime();
    call('START_SESSION', { source: 'sidepanel' });
    call('STOP_SESSION', null);
    expect(modes).toEqual(['registry']);
    expect(state().prediction.state).toBe('idle'); // works without a prediction
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const pid = state().prediction.predictionId;
    modes.length = 0;
    call('START_SESSION', { source: 'sidepanel' });
    call('STOP_SESSION', null);
    expect(modes).toEqual(['registry']); // no prediction scoring during Record
    expect(state()).toMatchObject({ prediction: { state: 'ready', predictionId: pid }, session: { state: 'ready' } });
  });

  it('Stop exposes a lightweight summary; GET_SESSION_CAPTURE_SUMMARY returns aggregates', () => {
    const { call, state } = runtime();
    expect(call('GET_SESSION_CAPTURE_SUMMARY', null)).toEqual({ ok: true, data: null });
    call('START_SESSION', { source: 'sidepanel' });
    call('STOP_SESSION', null);
    const s = state().session;
    expect(s.result).toMatchObject({ kind: 'capture', pointerSamples: 0 });
    const d = call('GET_SESSION_CAPTURE_SUMMARY', null) as { ok: true; data: { summary: unknown } };
    expect(d.data.summary).toEqual(s.result);
    call('CLEAR_SESSION', null);
    expect(call('GET_SESSION_CAPTURE_SUMMARY', null)).toEqual({ ok: true, data: null });
  });
});
