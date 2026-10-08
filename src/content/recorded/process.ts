/**
 * Recorded Interaction processing pipeline (pure apart from the optional live `rectOf`):
 *
 *   PageCaptureSegment
 *   → reproject anchored samples (same live document only; conservative)
 *   → combine raw samples + Phase 5 coarse cells (re-binned, nothing double counted)
 *   → time-weighted sparse density grid per scroll root (8 px cells, adaptive for long roots)
 *   → Gaussian smoothing (per root)
 *   → robust normalisation (page-wide 98th percentile, sqrt transfer)
 *   → packed rows (tiles are rasterised lazily by the overlay)
 *
 * Everything needed comes from the finalized segment, so pages that are no longer open can be
 * processed exactly like the current one. Rendering lives in overlay/recorded.ts.
 */
import type { PageCaptureSegment, RecordingSessionResult } from '../recorder/segment';
import { KERNEL_RADIUS, REPROJECT_UNCERTAIN_SHARE } from './config';
import { addArea, addPoint, cellSizeFor, emptyGrid, gridTotal, type DensityGrid, type RootExtent } from './density';
import { buildLists } from './lists';
import { clusterClicks, maybeNotClickableSpots } from './markers';
import { packDensity, packedBytes, upperBound } from './normalize';
import { reprojectPointer, type RectOf } from './reproject';
import { smoothGrid } from './smooth';
import type { RecordedLimitationCode, RecordedPageResult, RecordedSessionResult } from './types';

const perf = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Content extent of every root that has data: the recorded scroll extent, widened to fit the data
 * plus the smoothing radius, so the blur around a point near the far edge is never cut off.
 */
export function rootExtents(seg: PageCaptureSegment, xs: ArrayLike<number>, ys: ArrayLike<number>): RootExtent[] {
  const docId = seg.scroll.roots.find((r) => r.kind === 'document')?.rootId ?? 0;
  const recorded = new Map<number, RootExtent>();
  const dataMax = new Map<number, { x: number; y: number }>();
  const fit = (rootId: number, x: number, y: number): void => {
    if (!recorded.has(rootId)) {
      const r = seg.scroll.roots.find((v) => v.rootId === rootId);
      const doc = rootId === docId;
      recorded.set(rootId, { rootId, kind: doc ? 'document' : 'container', width: doc ? seg.viewport.width : 1, height: Math.max(r?.scrollHeight ?? 1, doc ? seg.viewport.height : 1) });
    }
    const m = dataMax.get(rootId);
    if (!m) dataMax.set(rootId, { x, y });
    else ((m.x = Math.max(m.x, x)), (m.y = Math.max(m.y, y)));
  };
  const p = seg.pointer;
  for (let i = 0; i < p.count; i++) fit(p.rootId[i]!, xs[i]!, ys[i]!);
  for (const c of p.coarse?.cells ?? []) fit(c.rootId, (c.cx + 1) * p.coarse!.cellPx, (c.cy + 1) * p.coarse!.cellPx);
  for (const c of seg.clicks) if (c.x !== undefined && c.y !== undefined) fit(c.rootId ?? docId, c.x, c.y);
  const out: RootExtent[] = [];
  for (const [rootId, e] of recorded) {
    const m = dataMax.get(rootId)!;
    const pad = (KERNEL_RADIUS + 1) * cellSizeFor(Math.max(e.width, m.x), Math.max(e.height, m.y));
    out.push({ ...e, width: Math.max(e.width, m.x + pad), height: Math.max(e.height, m.y + pad) });
  }
  return out.sort((a, b) => a.rootId - b.rootId);
}

export function densityGrids(seg: PageCaptureSegment, xs: ArrayLike<number>, ys: ArrayLike<number>): DensityGrid[] {
  const grids = new Map(rootExtents(seg, xs, ys).map((e) => [e.rootId, emptyGrid(e)]));
  const p = seg.pointer;
  for (let i = 0; i < p.count; i++) {
    const g = grids.get(p.rootId[i]!);
    if (g) addPoint(g, xs[i]!, ys[i]!, p.weightMs[i]!);
  }
  if (p.coarse) {
    for (const c of p.coarse.cells) {
      const g = grids.get(c.rootId);
      if (g) addArea(g, c.cx * p.coarse.cellPx, c.cy * p.coarse.cellPx, p.coarse.cellPx, c.weightMs);
    }
  }
  return [...grids.values()];
}

export function processPage(seg: PageCaptureSegment, opts: { local: boolean; rectOf: RectOf | null }): RecordedPageResult {
  const t0 = perf();
  const { x, y, stats } = reprojectPointer(seg.pointer, opts.local ? opts.rectOf : null);
  const raw = densityGrids(seg, x, y);
  const placedMs = raw.reduce((a, g) => a + gridTotal(g), 0);
  const smoothed = raw.map((g) => smoothGrid(g));
  const upper = upperBound(smoothed);
  const roots = smoothed.map((g) => packDensity(g, upper));

  const docStats = seg.scroll.roots.find((r) => r.kind === 'document') ?? null;
  const docGrid = roots.find((r) => r.kind === 'document');
  const limitations: RecordedLimitationCode[] = [...seg.limitations];
  if (stats.anchoredMs > 0 && stats.preservedMs / stats.anchoredMs > REPROJECT_UNCERTAIN_SHARE) limitations.push('REPROJECTION_UNCERTAIN');
  const elements = seg.elements;
  return {
    segmentId: seg.segmentId,
    index: seg.index,
    pageIdentity: { ...seg.page },
    local: opts.local,
    startedAt: seg.startedAt,
    endedAt: seg.endedAt,
    dimensions: {
      viewport: { ...seg.viewport },
      documentWidth: docGrid ? docGrid.cols * docGrid.cellPx : seg.viewport.width,
      documentHeight: docStats?.scrollHeight ?? seg.viewport.height,
      cellPx: docGrid?.cellPx ?? 8,
    },
    density: { roots, upper, placedMs: Math.round(placedMs), unplacedMs: Math.round(seg.pointer.coarse?.droppedWeightMs ?? 0), bytes: roots.reduce((a, r) => a + packedBytes(r), 0) },
    clickMarkers: clusterClicks(seg.clicks),
    scrollMetrics: {
      document: docStats ? { deepestPx: docStats.deepestPx, deepestFraction: docStats.deepestFraction, scrollHeight: docStats.scrollHeight, clientHeight: docStats.clientHeight } : null,
      nested: seg.scroll.roots
        .filter((r) => r.kind === 'container')
        .map((r) => ({ rootId: r.rootId, ...(r.elementRef !== undefined ? { elementRef: r.elementRef } : {}), deepestPx: r.deepestPx, deepestFraction: r.deepestFraction, scrollHeight: r.scrollHeight })),
    },
    elementStats: elements,
    regionStats: seg.regions,
    lists: buildLists(elements, seg.regions, seg.unreached ?? { count: 0, items: [] }),
    maybeNotClickable: maybeNotClickableSpots(seg.clicks),
    facts: {
      elapsedMs: seg.elapsedMs,
      activeMs: seg.activeMs,
      clicks: seg.summary.clicks,
      activations: seg.summary.activations,
      pointerSamples: seg.pointer.count + seg.pointer.foldedSamples,
      controlsReached: seg.summary.controlsReached,
      controlsInteracted: seg.summary.controlsInteracted,
      maybeNotClickable: seg.clicks.filter((c) => c.interactive === 'maybe-not').length,
    },
    reprojection: stats,
    limitations: [...new Set(limitations)],
    timings: { processMs: Math.round((perf() - t0) * 100) / 100 },
  };
}

/**
 * Processes every page segment independently (coordinates never merge). `localIndex` is the
 * segment recorded by the document that is still open; only that one may use live geometry.
 */
export function processSession(rs: RecordingSessionResult, opts: { localIndex: number | null; rectOf: RectOf | null }): RecordedSessionResult {
  const t0 = perf();
  const segments = [...rs.segments].sort((a, b) => a.index - b.index).map((s) => processPage(s, { local: s.index === opts.localIndex, rectOf: opts.rectOf }));
  const sum = (f: (p: RecordedPageResult) => number): number => segments.reduce((a, p) => a + f(p), 0);
  return {
    sessionId: rs.sessionId,
    startedAt: rs.startedAt,
    endedAt: rs.endedAt,
    elapsedMs: Math.max(0, rs.endedAt - rs.startedAt),
    activeMs: sum((p) => p.facts.activeMs),
    totals: { clicks: sum((p) => p.facts.clicks), activations: sum((p) => p.facts.activations), pages: segments.length, controlsInteracted: sum((p) => p.facts.controlsInteracted) },
    segments,
    limitations: [...rs.limitations],
    timings: { processMs: Math.round((perf() - t0) * 100) / 100, perPageMs: segments.map((p) => p.timings.processMs) },
  };
}
