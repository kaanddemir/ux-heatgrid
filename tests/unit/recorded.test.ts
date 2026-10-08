// @vitest-environment happy-dom
/**
 * Phase 6: Recorded Interaction processing (pure), rendering plan, overlay host, lists, and the
 * runtime/protocol integration (real Recorder + recording store on fixture pages).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { startRecorder } from '../../src/content/recorder';
import type { ContinuityChannel, PageCaptureSegment, SerializedPointer } from '../../src/content/recorder/segment';
import type { ClickEvent, RecordedElementStats } from '../../src/content/recorder/types';
import { heatAlpha, heatLut, heatRgb, HEAT_STOPS } from '../../src/content/recorded/colormap';
import { MAX_ROWS, MIN_INTENSITY } from '../../src/content/recorded/config';
import { cellSizeFor, gridTotal } from '../../src/content/recorded/density';
import { buildLists } from '../../src/content/recorded/lists';
import { clusterClicks } from '../../src/content/recorded/markers';
import { intensity, upperBound } from '../../src/content/recorded/normalize';
import { densityGrids, processPage, processSession } from '../../src/content/recorded/process';
import { smoothGrid } from '../../src/content/recorded/smooth';
import { tilePixels, tilesForBand } from '../../src/content/recorded/tiles';
import type { RecordedPageResult } from '../../src/content/recorded/types';
import { planFrame, RecordedOverlay } from '../../src/content/overlay/recorded';
import { renderRecordedLabel } from '../../src/content/overlay/legend';
import { OVERLAY_CSS, RECORDED_CSS } from '../../src/content/overlay/root';
import { createTabRuntime, type RecordedOverlayLike } from '../../src/content/tabRuntime';
import { createRecordingStore, type StorageLike } from '../../src/background/recordingStore';
import { OVERLAY_TAG } from '../../src/shared/constants';
import type { TabSnapshot } from '../../src/shared/model';
import { makeRequest, type RequestEnvelope } from '../../src/shared/protocol';
import { fixtureReader, mount } from '../helpers/fixtureReader';

// ---------------------------------------------------------------------------
// Synthetic segments
// ---------------------------------------------------------------------------

type Sample = { x: number; y: number; w: number; rootId?: number; ref?: number; ax?: number; ay?: number };

function pointer(samples: Sample[], coarse: SerializedPointer['coarse'] = null): SerializedPointer {
  return {
    count: samples.length,
    t: samples.map((_, i) => i * 40),
    rootId: samples.map((s) => s.rootId ?? 0),
    x: samples.map((s) => s.x),
    y: samples.map((s) => s.y),
    weightMs: samples.map((s) => s.w),
    elementRef: samples.map((s) => s.ref ?? 0),
    anchorX: samples.map((s) => (s.ref ? (s.ax ?? 0.5) : null)),
    anchorY: samples.map((s) => (s.ref ? (s.ay ?? 0.5) : null)),
    coarse,
    foldedSamples: 0,
    totalWeightMs: samples.reduce((a, s) => a + s.w, 0) + (coarse?.cells.reduce((a, c) => a + c.weightMs, 0) ?? 0),
  };
}

function segment(p: SerializedPointer, o: Partial<PageCaptureSegment> = {}): PageCaptureSegment {
  return {
    segmentId: `s#${o.index ?? 0}`,
    sessionId: 's',
    index: 0,
    startedAt: 1000,
    endedAt: 21_000,
    elapsedMs: 20_000,
    activeMs: 18_000,
    page: { origin: 'https://example.test', path: '/a', title: 'A' },
    viewport: { width: 1280, height: 800 },
    layoutVersion: 1,
    pointer: p,
    clicks: [],
    clicksDropped: 0,
    elements: [],
    unreached: { count: 0, items: [] },
    regions: [],
    scroll: {
      roots: [{ rootId: 0, kind: 'document', lazy: false, scrollTop: 0, scrollHeight: 2400, clientHeight: 800, deepestPx: 1600, deepestFraction: 1600 / 2400 }],
      timeline: [],
      timelineIntervalMs: 250,
    },
    limitations: [],
    summary: { kind: 'capture', elapsedMs: 20_000, activeMs: 18_000, pointerSamples: p.count, clicks: 0, activations: 0, pages: 1, deepestScroll: 0.667, controlsReached: 0, controlsInteracted: 0, regionsInteracted: 0, limitations: [] },
    ...o,
  };
}

/** Packed intensity (0–255) at a root-content point, or 0. */
function valueAt(page: RecordedPageResult, rootId: number, x: number, y: number): number {
  const d = page.density.roots.find((r) => r.rootId === rootId)!;
  const row = Math.floor(y / d.cellPx);
  const col = Math.floor(x / d.cellPx);
  for (let i = d.rowStart[row]!; i < d.rowStart[row + 1]!; i++) if (d.col[i] === col) return d.value[i]!;
  return 0;
}

const dwell = (x: number, y: number, ms: number, step = 40): Sample[] => Array.from({ length: Math.round(ms / step) }, () => ({ x, y, w: step }));
const click = (id: number, x: number, y: number, t: number, extra: Partial<ClickEvent> = {}): ClickEvent => ({ id, t, kind: 'pointer', rootId: 0, x, y, interactive: 'yes', ...extra });

// ---------------------------------------------------------------------------

describe('Recorded processing', () => {
  it('density is time-weighted dwell: more dwell → more heat; clicks alone add no density', () => {
    // 2 s parked at A vs. 40 quick crossings (10 ms each) at B.
    const crossings: Sample[] = Array.from({ length: 40 }, () => ({ x: 900, y: 300, w: 10 }));
    const page = processPage(segment(pointer([...dwell(200, 300, 2000), ...crossings]), { clicks: [click(1, 600, 600, 10), click(2, 600, 600, 900)] }), { local: false, rectOf: null });
    const a = valueAt(page, 0, 200, 300);
    const b = valueAt(page, 0, 900, 300);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b);
    expect(valueAt(page, 0, 600, 600)).toBe(0); // clicks are markers, not density
    expect(page.clickMarkers).toHaveLength(2);
    expect(page.density.placedMs).toBe(2400);
  });

  it('raw samples + Phase 5 coarse cells combine into one grid without double counting or a seam', () => {
    // Uniform dwell over x 400–600: rows y < 512 as raw samples (every 8 px), rows ≥ 512 as 16 px coarse cells.
    const raw: Sample[] = [];
    for (let y = 4; y < 512; y += 8) for (let x = 404; x < 600; x += 8) raw.push({ x, y, w: 10 });
    const cells: NonNullable<SerializedPointer['coarse']>['cells'] = [];
    for (let cy = 32; cy < 64; cy++) for (let cx = 25; cx < 37; cx++) cells.push({ rootId: 0, cx, cy, weightMs: 40 }); // 16 px = 4 × 8 px cells × 10 ms
    const seg = segment(pointer(raw, { cellPx: 16, cells, droppedWeightMs: 120 }));
    const grids = densityGrids(seg, seg.pointer.x, seg.pointer.y);
    const rawMs = raw.length * 10;
    const coarseMs = cells.length * 40;
    expect(gridTotal(grids[0]!)).toBeCloseTo(rawMs + coarseMs, 6); // each source counted exactly once
    const page = processPage(seg, { local: false, rectOf: null });
    expect(page.density.placedMs).toBe(rawMs + coarseMs);
    expect(page.density.unplacedMs).toBe(120);
    // Across the switch (y = 512) the map is continuous.
    const above = valueAt(page, 0, 500, 496);
    const below = valueAt(page, 0, 500, 528);
    expect(above).toBeGreaterThan(0);
    expect(Math.abs(above - below) / above).toBeLessThan(0.05);
  });

  it('anchored samples follow a moderately moved control; radical geometry or a missing control keeps the original point', () => {
    const samples: Sample[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ x: 110 + i, y: 220, w: 100, ref: 5, ax: (10 + i) / 200, ay: 0.4 })), // button 5 at (100,200) 200×50
      ...Array.from({ length: 10 }, () => ({ x: 610, y: 820, w: 100, ref: 6, ax: 0.1, ay: 0.4 })), // control 6
      ...Array.from({ length: 10 }, () => ({ x: 900, y: 900, w: 100, ref: 7, ax: 0.5, ay: 0.5 })), // control 7 (removed)
      { x: 50, y: 50, w: 100 }, // unanchored
    ];
    const rects: Record<number, { x: number; y: number; width: number; height: number }> = {
      5: { x: 100, y: 320, width: 200, height: 50 }, // moved down 120 px → reproject
      6: { x: 0, y: 4000, width: 1280, height: 30 }, // implausible jump → preserve
    };
    const asked: number[] = [];
    const rectOf = (ref: number) => (asked.push(ref), rects[ref] ?? null);
    const page = processPage(segment(pointer(samples)), { local: true, rectOf });
    expect(page.reprojection).toMatchObject({ controlsReprojected: 1, controlsPreserved: 1, reprojectedMs: 1000, preservedMs: 1000, unresolvedMs: 1000, anchoredMs: 3000 });
    expect(valueAt(page, 0, 120, 340)).toBeGreaterThan(valueAt(page, 0, 120, 220)); // heat moved with control 5
    expect(valueAt(page, 0, 610, 820)).toBeGreaterThan(0); // control 6 kept its recorded spot
    expect(valueAt(page, 0, 900, 900)).toBeGreaterThan(0); // control 7 fell back, not discarded
    expect(page.density.placedMs).toBe(3100);
    expect(page.limitations).toContain('REPROJECTION_UNCERTAIN'); // 1/3 of anchored dwell preserved > 20%
    // Segments from another document never consult live geometry.
    asked.length = 0;
    processPage(segment(pointer(samples)), { local: false, rectOf });
    expect(asked).toEqual([]);
  });

  it('adaptive grid keeps long documents ≤ 4096 rows (8 → 16 → 32 px …); normal pages stay at 8 px', () => {
    expect(cellSizeFor(1280, 2400)).toBe(8);
    expect(cellSizeFor(1280, 32_768)).toBe(8);
    expect(cellSizeFor(1280, 32_769)).toBe(16);
    expect(cellSizeFor(1280, 100_000)).toBe(32);
    const long = segment(pointer([...dwell(300, 90_000, 400), ...dwell(300, 200, 400)]), {
      scroll: { roots: [{ rootId: 0, kind: 'document', lazy: false, scrollTop: 0, scrollHeight: 100_000, clientHeight: 800, deepestPx: 100_000, deepestFraction: 1 }], timeline: [], timelineIntervalMs: 250 },
    });
    const page = processPage(long, { local: false, rectOf: null });
    const d = page.density.roots[0]!;
    expect(d.cellPx).toBe(32);
    expect(d.rows).toBeLessThanOrEqual(MAX_ROWS);
    expect(valueAt(page, 0, 300, 90_000)).toBeGreaterThan(0);
    expect(page.density.bytes).toBeLessThan(40_000); // sparse: proportional to visited area, not page size
  });

  it('smoothing is deterministic, preserves the total (also at edges) and keeps sparse areas sparse', () => {
    const seg = segment(pointer([{ x: 0, y: 0, w: 500 }, { x: 640, y: 1200, w: 300 }]));
    const [g] = densityGrids(seg, seg.pointer.x, seg.pointer.y);
    const a = smoothGrid(g!);
    const b = smoothGrid(g!);
    expect([...a.cells.entries()]).toEqual([...b.cells.entries()]);
    expect(gridTotal(a)).toBeCloseTo(800, 6); // corner mass is renormalised, not lost
    // Nothing beyond the kernel radius (3σ = 6 cells) of either point.
    for (const k of a.cells.keys()) {
      const row = Math.floor(k / a.cols);
      const col = k % a.cols;
      const near = (r: number, c: number) => Math.abs(row - r) <= 6 && Math.abs(col - c) <= 6;
      expect(near(0, 0) || near(150, 80)).toBe(true);
    }
    // Symmetric spread around an interior point.
    const at = (r: number, c: number) => a.cells.get(r * a.cols + c) ?? 0;
    expect(at(150, 82)).toBeCloseTo(at(150, 78), 9);
    expect(at(148, 80)).toBeCloseTo(at(152, 80), 9);
  });

  it('98th-percentile normalisation resists a single extreme hot spot', () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 120; i++) samples.push({ x: 40 + (i % 12) * 100, y: 100 + Math.floor(i / 12) * 100, w: 200 });
    samples.push(...dwell(700, 1500, 60_000, 1000)); // one extreme spot (60 s)
    const page = processPage(segment(pointer(samples)), { local: false, rectOf: null });
    expect(valueAt(page, 0, 700, 1500)).toBe(255); // clamped at the top
    expect(valueAt(page, 0, 440, 400)).toBeGreaterThan(110); // ordinary spots stay clearly visible (a max-normalised map would make them ~15)
    expect(intensity(0, 10)).toBe(0);
    expect(intensity(10 * MIN_INTENSITY * MIN_INTENSITY * 0.5, 10)).toBe(0); // faint tails are transparent
    expect(upperBound([])).toBe(0);
  });
});

describe('Recorded multi-page processing', () => {
  it('page segments are processed independently: own grids, own coordinates, live geometry only for the local one', () => {
    const a = segment(pointer(dwell(200, 300, 1500)), { index: 0, segmentId: 's#0' });
    const b = segment(pointer(dwell(1000, 1800, 1500)), { index: 1, segmentId: 's#1', page: { origin: 'https://example.test', path: '/b', title: 'B' } });
    const asked: number[] = [];
    const r = processSession({ sessionId: 's', startedAt: 1000, endedAt: 60_000, segments: [b, a], limitations: [] }, { localIndex: 1, rectOf: (ref) => (asked.push(ref), null) });
    expect(r.segments.map((p) => [p.index, p.pageIdentity.path, p.local])).toEqual([[0, '/a', false], [1, '/b', true]]);
    expect(valueAt(r.segments[0]!, 0, 200, 300)).toBeGreaterThan(0);
    expect(valueAt(r.segments[0]!, 0, 1000, 1800)).toBe(0); // B's dwell never lands on A's map
    expect(valueAt(r.segments[1]!, 0, 200, 300)).toBe(0);
    expect(valueAt(r.segments[1]!, 0, 1000, 1800)).toBeGreaterThan(0);
    expect(r.totals.pages).toBe(2);
    expect(r.elapsedMs).toBe(59_000);
    expect(r.timings.perPageMs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

const PREDICTION_INDIGO = ['#397bfa', '#2a6ae6', '#1f5fd6', '#6fa0ff', '#5b93ff'];
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
function hue([r, g, b]: number[]): number {
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g! - b!) / d) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('Recorded rendering', () => {
  it('uses one compact on-page control card with clear layer toggle states', () => {
    const label = document.createElement('div');
    const changed: Array<{ heatmap: boolean; clicks: boolean; scroll: boolean }> = [];
    let closed = 0;
    renderRecordedLabel(label, 'Recorded', { heatmap: true, clicks: false, scroll: true }, (layers) => changed.push(layers), () => closed++);
    const toggles = [...label.querySelectorAll<HTMLButtonElement>('.layer-toggle')];
    expect(toggles.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Heatmap', 'true'],
      ['Clicks', 'false'],
      ['Scroll Depth', 'true'],
    ]);
    toggles[1]!.click();
    expect(changed).toEqual([{ heatmap: true, clicks: true, scroll: true }]);
    const close = label.querySelector<HTMLButtonElement>('.legend-close')!;
    expect(close.getAttribute('aria-label')).toBe('Close visualization');
    close.click();
    expect(closed).toBe(1);
    expect(toggles.every((b) => b.classList.contains('legend-filter'))).toBe(true);
    expect(OVERLAY_CSS).toMatch(/\.legend-filter[^}]*border-radius: 6px/); // same radius scale as the side panel
    expect(label.querySelector('.id .title')!.textContent).toBe('Recorded'); // identity word on the dock
  });

  it('warm heat ramp only (never Prediction indigo); zero is transparent, peak stays see-through', () => {
    const lut = heatLut();
    expect(lut[3]).toBe(0); // intensity 0
    const indigo = PREDICTION_INDIGO.map(hex);
    for (let i = 1; i < 256; i++) {
      const c = [lut[i * 4]!, lut[i * 4 + 1]!, lut[i * 4 + 2]!];
      const h = hue(c);
      expect(h >= 260 || h <= 60, `hue ${h} at ${i}`).toBe(true); // purple → magenta → orange → yellow
      for (const p of indigo) expect(Math.hypot(c[0]! - p[0], c[1]! - p[1], c[2]! - p[2])).toBeGreaterThan(55);
    }
    expect(heatRgb(1)[0]).toBeGreaterThan(heatRgb(1)[2]); // ends warm yellow
    expect(HEAT_STOPS[HEAT_STOPS.length - 1]![1]).toBeGreaterThan(240);
    expect(heatAlpha(0)).toBe(0);
    expect(heatAlpha(0.3)).toBeLessThan(heatAlpha(0.6));
    expect(heatAlpha(1)).toBeLessThanOrEqual(0.6); // page underneath stays readable
    for (const p of PREDICTION_INDIGO) expect(RECORDED_CSS.toLowerCase()).not.toContain(p);
    expect(OVERLAY_CSS).not.toMatch(/rgb\(252, 211, 77\)/); // and Predicted CSS never carries the heat ramp
  });

  const page = (): RecordedPageResult => {
    const samples: Sample[] = [...dwell(300, 200, 2000), ...dwell(300, 3000, 2000), ...dwell(100, 150, 2000).map((s) => ({ ...s, rootId: 1 }))];
    return processPage(
      segment(pointer(samples), {
        clicks: [click(1, 300, 210, 100), click(2, 305, 212, 400), click(3, 302, 208, 700), click(4, 300, 3000, 5000), click(5, 100, 150, 6000, { rootId: 1 }), { id: 6, t: 7000, kind: 'activation', interactive: 'yes' }],
        scroll: {
          roots: [
            { rootId: 0, kind: 'document', lazy: false, scrollTop: 0, scrollHeight: 4000, clientHeight: 800, deepestPx: 3400, deepestFraction: 0.85 },
            { rootId: 1, kind: 'container', elementRef: 42, lazy: false, scrollTop: 0, scrollHeight: 900, clientHeight: 300, deepestPx: 600, deepestFraction: 0.667 },
          ],
          timeline: [],
          timelineIntervalMs: 250,
        },
      }),
      { local: true, rectOf: null },
    );
  };
  const ALL = { heatmap: true, clicks: true, scroll: true };

  it('scrolling only selects the tiles intersecting the viewport (cached rasters, cell resolution)', () => {
    const p = page();
    const d = p.density.roots.find((r) => r.kind === 'document')!;
    expect(tilesForBand(d, 0, 800)).toEqual([0]); // data in tile 0 only (tile 1 is empty)
    expect(tilesForBand(d, 2800, 3600)).toEqual([5]);
    const top = planFrame(p, { width: 1280, height: 800, scrollX: 0, scrollY: 0 }, new Map([[1, null]]), ALL);
    const down = planFrame(p, { width: 1280, height: 800, scrollX: 0, scrollY: 2600 }, new Map([[1, null]]), ALL);
    expect(top.heat.map((h) => h.tile)).toEqual([0]);
    expect(down.heat.map((h) => [h.tile, h.dy])).toEqual([[5, 5 * 512 - 2600]]);
    const px = tilePixels(d, 0);
    expect(px.width).toBe(d.cols);
    expect(px.height).toBe(512 / d.cellPx + 2); // + one blending row above and below
    expect(px.data[3]).toBe(0); // far corner: transparent
  });

  it('overlapping click markers are drawn as one with the summed count (Phase 9 real-site finding)', () => {
    const p = page();
    const markers = Array.from({ length: 50 }, (_, i) => ({ rootId: 0, x: 5 + i, y: 400, count: 6, t: i, maybeNotClickable: i === 3 }));
    const plan = planFrame({ ...p, clickMarkers: markers }, { width: 1280, height: 800, scrollX: 0, scrollY: 0 }, new Map([[1, null]]), ALL);
    expect(plan.markers.length).toBeLessThanOrEqual(4); // 50 px strip → a few readable markers
    expect(plan.markers.reduce((n, m) => n + m.count, 0)).toBe(300); // nothing lost
    expect(plan.markers.some((m) => m.maybeNotClickable)).toBe(true);
  });

  it('nested roots move with their container and are clipped to it; unresolved containers are not painted', () => {
    const p = page();
    const view = { width: 1280, height: 800, scrollX: 0, scrollY: 0 };
    const clip = { x: 500, y: 100, width: 400, height: 300 };
    const plan = planFrame(p, view, new Map([[1, { originX: 500, originY: 100 - 120, clip }]]), ALL); // container scrolled by 120
    const nested = plan.heat.filter((h) => h.rootId === 1);
    expect(nested.length).toBeGreaterThan(0);
    for (const h of nested) {
      expect(h.clip).toEqual(clip);
      expect(h.dx).toBe(500);
    }
    expect(nested[0]!.dy).toBe(-20);
    expect(plan.holes).toEqual([clip]); // document heat is cleared under the container
    expect(plan.markers).toContainEqual({ x: 600, y: 130, count: 1, maybeNotClickable: false }); // root-content (100,150) → viewport
    const missing = planFrame(p, view, new Map([[1, null]]), ALL);
    expect(missing.heat.some((h) => h.rootId === 1)).toBe(false);
    expect(missing.skippedRoots).toEqual([1]);
    expect(missing.markers.some((m) => m.x === 600)).toBe(false);
  });

  it('click markers cluster repeats (×N), stay separate from density, and the deepest-scroll line tracks scroll', () => {
    const p = page();
    expect(clusterClicks([click(1, 10, 10, 0), click(2, 14, 12, 500), click(3, 30, 10, 900), click(4, 30, 10, 2000)]).map((m) => m.count)).toEqual([2, 1, 1]);
    expect(p.clickMarkers.map((m) => [m.rootId, m.count])).toEqual([[0, 3], [0, 1], [1, 1]]); // time order; the activation has no position
    const plan = planFrame(p, { width: 1280, height: 800, scrollX: 0, scrollY: 2900 }, new Map([[1, null]]), ALL);
    expect(plan.line).toBe(500); // 3400 − 2900
    expect(plan.markers).toEqual([{ x: 300, y: 100, count: 1, maybeNotClickable: false }]);
    expect(planFrame(p, { width: 1280, height: 800, scrollX: 0, scrollY: 0 }, new Map(), ALL).line).toBeNull(); // off screen
    const off = planFrame(p, { width: 1280, height: 800, scrollX: 0, scrollY: 2900 }, new Map(), { heatmap: false, clicks: false, scroll: false });
    expect(off).toMatchObject({ heat: [], markers: [], line: null });
  });

  it('overlay host is click-through and aria-hidden, labelled "Recorded", and fully removed on hide', () => {
    const frames: Array<() => void> = [];
    const o = new RecordedOverlay({ resolve: () => null, raf: (cb) => frames.push(cb), caf: () => {} });
    o.show(page(), { title: 'Recorded · 2/4', layers: ALL, focusedElementId: null });
    const host = document.querySelector(OVERLAY_TAG) as HTMLElement;
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.getAttribute('style')).toContain('pointer-events: none !important');
    expect(o.inspect()).toMatchObject({ mounted: true, title: 'Recorded · 2/4' });
    o.flush();
    expect(o.inspect().plan?.heat.length).toBeGreaterThan(0);
    o.hide();
    expect(document.querySelector(OVERLAY_TAG)).toBeNull();
    o.dispose();
  });
});

describe('Recorded lists', () => {
  const stat = (ref: number, o: Partial<RecordedElementStats> & { exposureMs?: number; reached?: boolean } = {}): RecordedElementStats => {
    const { exposureMs = 0, reached = true, ...rest } = o;
    const s: RecordedElementStats = { elementRef: ref, tagName: 'button', label: `B${ref}`, regionId: 1, hoverEntries: 0, hoverDwellMs: 0, pointerMs: 0, clicks: 0, activations: 0, focusEvents: 0, exposure: { elementRef: ref, reached, exposureMs, maxVisibleRatio: 1 }, hasActiveInteraction: false, ...rest };
    s.hasActiveInteraction = s.hoverEntries + s.clicks + s.activations + s.focusEvents > 0;
    return s;
  };

  it('Most interacted is lexicographic (clicks+activations → hover entries → hover dwell → focus); other lists are factual filters', () => {
    const els = [
      stat(1, { hoverEntries: 9, hoverDwellMs: 9000 }),
      stat(2, { clicks: 1 }),
      stat(3, { activations: 1, hoverEntries: 1 }),
      stat(4, { hoverEntries: 9, hoverDwellMs: 100 }),
      stat(5, { focusEvents: 1 }),
      stat(6, { exposureMs: 8000 }),
      stat(7, { exposureMs: 2000 }),
    ];
    const l = buildLists(els, [{ regionId: 1, label: 'Hero', pointerWeightMs: 0, clicks: 0, reached: true, interactedElements: 0 }], { count: 3, items: [{ elementRef: 8, tagName: 'a', label: 'Footer' }] });
    expect(l.mostInteracted.map((i) => i.elementRef)).toEqual([3, 2, 1, 4, 5]);
    expect(l.clicked.map((i) => i.elementRef)).toEqual([3, 2]);
    expect(l.mostHovered.map((i) => i.elementRef)).toEqual([1]); // 100 ms is not meaningful hover
    expect(l.inViewNoInteraction.map((i) => i.elementRef)).toEqual([6]); // ≥ 5 s in view, no interaction
    expect(l.neverReached).toMatchObject({ count: 3, items: [{ elementRef: 8, label: 'Footer', reached: false }] });
    expect(l.mostInteracted[0]).toMatchObject({ region: 'Hero', label: 'B3' });
    expect(JSON.stringify(l)).not.toMatch(/score|engagement|attention/i);
  });
});

// ---------------------------------------------------------------------------
// Runtime integration
// ---------------------------------------------------------------------------

function rectFromAttr(this: Element): DOMRect {
  const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
const originalRect = Element.prototype.getBoundingClientRect;
const trusted = <E extends Event>(e: E): E => (Object.defineProperty(e, 'isTrusted', { value: true }), e);
class NoIO {
  observe(): void {}
  disconnect(): void {}
}

describe('Recorded runtime + protocol', () => {
  beforeEach(() => { Element.prototype.getBoundingClientRect = rectFromAttr; });
  afterEach(() => { Element.prototype.getBoundingClientRect = originalRect; vi.restoreAllMocks(); });

  const html = (name: string) => `<main data-rect="0 0 1280 2000"><h1 data-rect="20 20 400 40">${name}</h1>
    <button id="go" data-rect="100 100 200 50">Go ${name}</button><button id="other" data-rect="100 1700 200 50">Other</button></main>`;

  function harness() {
    const data = new Map<string, string>();
    const storage: StorageLike = {
      get: async (keys) => Object.fromEntries([keys].flat().filter((k) => data.has(k)).map((k) => [k, JSON.parse(data.get(k)!)])),
      set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, JSON.stringify(v))),
      remove: async (keys) => void [keys].flat().forEach((k) => data.delete(k)),
    };
    const store = createRecordingStore(storage);
    const pending: Promise<unknown>[] = [];
    const channel: ContinuityChannel = {
      begin: (id, at) => void pending.push(store.begin(1, id, at)),
      segment: (seg) => void pending.push(store.addSegment(1, JSON.parse(JSON.stringify(seg)))),
      clear: (id) => void pending.push(store.clearSession(1, id)),
      collect: (id) => store.collect(1, id),
    };
    const setHref = (h: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(h);
    setHref('https://example.test/a?secret=1#h');
    const shown: Array<{ path: string; title: string } | null> = [];
    const fakeOverlay: RecordedOverlayLike = {
      show: (p, o) => void shown.push({ path: p.pageIdentity.path, title: o.title }),
      hide: () => void shown.push(null),
      dispose: () => {},
    };
    const predicted: boolean[] = [];
    const open = () => {
      const analyzer = createPageAnalyzer({ reader: fixtureReader({ docHeight: 2000 }) });
      const rt = createTabRuntime({
        buildId: 'test',
        emit: () => {},
        analyzer,
        continuity: channel,
        createRecorder: (a) => startRecorder({ analyzer: a, IntersectionObserver: NoIO as never }),
        createRecordedOverlay: () => fakeOverlay,
        createOverlay: () => ({ setVisible: (v: boolean) => void predicted.push(v), setPrediction: () => {}, setStale: () => {}, setShowLow: () => {}, select: () => {}, dispose: () => {} }),
      });
      const call = <T extends Parameters<typeof makeRequest>[0]>(type: T, payload: Parameters<typeof makeRequest<T>>[1]) => rt.handle(makeRequest(type, payload) as RequestEnvelope) as { ok: boolean; data: never; error?: { code: string } };
      const state = () => (call('GET_STATE', null) as { data: TabSnapshot }).data;
      return { rt, call, state };
    };
    const flush = async () => {
      while (pending.length) await pending.shift();
    };
    const interact = (id: string, n = 6) => {
      const el = document.getElementById(id)!;
      const [x, y] = (el.getAttribute('data-rect') ?? '').split(' ').map(Number);
      for (let i = 0; i < n; i++) el.dispatchEvent(trusted(new PointerEvent('pointermove', { clientX: x! + 20 + i * 8, clientY: y! + 20, bubbles: true, pointerType: 'mouse' })));
      el.dispatchEvent(trusted(new PointerEvent('click', { clientX: x! + 30, clientY: y! + 20, bubbles: true, detail: 1, pointerType: 'mouse' })));
    };
    return { open, flush, interact, store, shown, predicted, setHref };
  }

  it('Stop → processing → ready with a Recorded result; view shows only on the matching page; lightweight protocol', async () => {
    const h = harness();
    mount(html('A'));
    let rt = h.open();
    expect(rt.call('SET_INTERACTION_VIEW', { view: 'recorded' }).error?.code).toBe('INVALID_STATE'); // nothing recorded yet
    rt.call('RUN_PREDICTION', { source: 'sidepanel' });
    rt.call('SET_INTERACTION_VIEW', { view: 'predicted' });
    rt.call('START_SESSION', { source: 'sidepanel' });
    h.interact('go');
    // Full navigation A → B.
    rt.rt.handoffRecording();
    rt.rt.dispose();
    await h.flush();
    h.setHref('https://example.test/b');
    mount(html('B'));
    rt = h.open();
    rt.call('RESUME_RECORDING', (await h.store.resumePayload(1))!);
    h.interact('other');
    rt.call('STOP_SESSION', null);
    expect(rt.state().session.state).toBe('processing');
    await vi.waitFor(() => expect(rt.state().session.state).toBe('ready'));

    const s = rt.state();
    expect(s.recorded).toEqual({ page: 1, pageCount: 2, layers: { heatmap: true, clicks: true, scroll: true }, focusedElementId: null, pageOpen: true });
    rt.call('RUN_PREDICTION', { source: 'sidepanel' });
    rt.call('SET_INTERACTION_VIEW', { view: 'predicted' });
    h.predicted.length = 0;
    expect(rt.call('SET_INTERACTION_VIEW', { view: 'recorded' }).ok).toBe(true);
    expect(h.predicted.at(-1)).toBe(false); // Predicted hidden: one visualization at a time
    expect(h.shown.at(-1)).toEqual({ path: '/b', title: 'Recorded · 2/2' });

    const session = rt.call('GET_RECORDED_SESSION', null).data as { pages: Array<{ path: string }>; totals: { pages: number; clicks: number } };
    expect(session.pages.map((p) => p.path)).toEqual(['/a', '/b']); // no query string, no hash
    expect(session.totals).toMatchObject({ pages: 2, clicks: 2 });
    const pageB = rt.call('GET_RECORDED_PAGE', { page: 1 }).data as { pageOpen: boolean; elementsLive: boolean; lists: { clicked: Array<{ label: string }> } };
    expect(pageB).toMatchObject({ pageOpen: true, elementsLive: true });
    expect(pageB.lists.clicked.map((i) => i.label)).toEqual(['Other']);
    const wire = JSON.stringify([session, pageB]);
    expect(wire).not.toMatch(/rowStart|"value"|weightMs|anchorX/); // no density, tiles or samples
    expect(wire.length).toBeLessThan(8000);

    // Selecting page A (previous document): never painted on page B.
    rt.call('SET_RECORDED_PAGE', { page: 0 });
    expect(rt.state().recorded).toMatchObject({ page: 0, pageOpen: false });
    expect(h.shown.at(-1)).toBeNull();
    const pageA = rt.call('GET_RECORDED_PAGE', { page: 0 }).data as { pageOpen: boolean; lists: { clicked: Array<{ label: string; elementRef: number }> } };
    expect(pageA.pageOpen).toBe(false);
    expect(pageA.lists.clicked.map((i) => i.label)).toEqual(['Go A']); // facts still available without the old DOM
    expect((rt.call('FOCUS_RECORDED_ELEMENT', { page: 0, elementId: pageA.lists.clicked[0]!.elementRef, scroll: true }).data as { status: string }).status).toBe('not-open');
    expect(h.shown.at(-1)).toBeNull();

    // Back to page B: control can be shown on the live page.
    const other = (rt.call('GET_RECORDED_PAGE', { page: 1 }).data as { lists: { clicked: Array<{ elementRef: number }> } }).lists.clicked[0]!.elementRef;
    const f = rt.call('FOCUS_RECORDED_ELEMENT', { page: 1, elementId: other, scroll: false }).data as { status: string; snapshot: TabSnapshot };
    expect(f.status).toBe('focused');
    expect(f.snapshot).toMatchObject({ interactionView: 'recorded', recorded: { page: 1, focusedElementId: other } });

    // Navigating the live page elsewhere: the map is not painted on the wrong document.
    h.setHref('https://example.test/c');
    rt.call('SET_RECORDED_LAYERS', { heatmap: true, clicks: false, scroll: true });
    expect(h.shown.at(-1)).toBeNull();
    expect(rt.state().recorded).toMatchObject({ pageOpen: false, layers: { clicks: false } });

    // Clear removes the Recorded result.
    rt.call('CLEAR_SESSION', null);
    expect(rt.state()).toMatchObject({ recorded: null, interactionView: 'none' });
    expect(rt.call('GET_RECORDED_SESSION', null).data).toBeNull();
  });
});
