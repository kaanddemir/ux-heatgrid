/**
 * Cross-navigation recording continuity (pure; used by the content runtime and the service worker).
 *
 * A recording belongs to the TAB; each document owns one independent page segment with its own
 * coordinate spaces. Segments are only created when a page segment ends (pagehide or Stop), never
 * during recording. Serialized size is bounded by SESSION_BUDGET_BYTES: when exceeded, older
 * segments' raw pointer samples are folded into the existing 16 px coarse cells (clicks, element,
 * region and scroll facts are kept). A page is never dropped.
 */
import { COARSE_CELL_PX } from './buffer';
import { summarizeCapture } from './summary';
import type { ClickEvent, ElementBrief, LimitationCode, RecordedElementStats, RecordedRegionStats, ScrollRootStats, ScrollTimelinePoint, SessionCapture, SessionCaptureSummary } from './types';

export const SESSION_BUDGET_BYTES = 6 * 1024 * 1024;
export const TITLE_MAX = 80;
export const UNREACHED_MAX = 50;

export type SessionLimitationCode = Extract<LimitationCode, 'MULTI_PAGE_SESSION_COARSENED' | 'RECORDING_INTERRUPTED_UNSUPPORTED_PAGE'>;

/** Pointer capture in JSON-friendly form (px rounded to 0.5, ms to integers, anchors to 0.001, NaN → null). */
export interface SerializedPointer {
  count: number;
  t: number[];
  rootId: number[];
  x: number[];
  y: number[];
  weightMs: number[];
  elementRef: number[];
  anchorX: Array<number | null>;
  anchorY: Array<number | null>;
  coarse: { cellPx: number; cells: Array<{ rootId: number; cx: number; cy: number; weightMs: number }>; droppedWeightMs: number } | null;
  /** Raw samples folded into `coarse` by the session budget (they are no longer in the raw arrays). */
  foldedSamples: number;
  totalWeightMs: number;
}

export interface PageCaptureSegment {
  segmentId: string;
  sessionId: string;
  index: number;
  /** Wall clock. */
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  activeMs: number;
  /** Privacy-safe identity: no query string, no hash, truncated title. */
  page: { origin: string; path: string; title: string };
  viewport: { width: number; height: number };
  layoutVersion: number;
  pointer: SerializedPointer;
  clicks: ClickEvent[];
  clicksDropped: number;
  /** Controls with any activity or exposure (untouched controls are omitted). */
  elements: RecordedElementStats[];
  /** Controls never exposed in this page segment (descriptive fields only; first UNREACHED_MAX). */
  unreached: { count: number; items: ElementBrief[] };
  regions: RecordedRegionStats[];
  scroll: { roots: ScrollRootStats[]; timeline: ScrollTimelinePoint[]; timelineIntervalMs: number };
  limitations: LimitationCode[];
  summary: SessionCaptureSummary;
}

export interface RecordingSessionResult {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  segments: PageCaptureSegment[];
  limitations: SessionLimitationCode[];
}

/** Totals carried into the next page (SESSION_TICK / summary continuity). */
export interface PriorTotals {
  pages: number;
  activeMs: number;
  clicks: number;
  activations: number;
}

/** What a new document needs to continue the tab's recording (SW → content, RESUME_RECORDING). */
export interface ResumePayload {
  sessionId: string;
  /** Wall-clock start of the whole recording. */
  startedAt: number;
  segmentIndex: number;
  prior: PriorTotals;
  continuity: 'continuous' | 'interrupted';
}

/** Content-side channel to the service worker's recording store (used only at page boundaries). */
export interface ContinuityChannel {
  begin(sessionId: string, startedAt: number): void;
  /** Fire-and-forget at pagehide: hands one finalized page segment to the service worker. */
  segment(seg: PageCaptureSegment): void;
  /** Stop: every earlier segment of the session (and the SW's temporary storage is removed). */
  collect(sessionId: string): Promise<{ segments: PageCaptureSegment[]; limitations: SessionLimitationCode[] } | null>;
  clear(sessionId: string): void;
}

export const NO_PRIOR: PriorTotals = { pages: 0, activeMs: 0, clicks: 0, activations: 0 };

/** Summary of a whole recording: per-page facts summed; scroll depth only for single-page recordings. */
export function sessionSummary(r: RecordingSessionResult): SessionCaptureSummary {
  const segs = r.segments;
  if (segs.length === 1 && r.limitations.length === 0) return segs[0]!.summary;
  const sum = (f: (s: SessionCaptureSummary) => number): number => segs.reduce((a, s) => a + f(s.summary), 0);
  const limitations = [...new Set<LimitationCode>([...segs.flatMap((s) => s.summary.limitations), ...r.limitations])];
  return {
    kind: 'capture',
    elapsedMs: Math.max(0, r.endedAt - r.startedAt),
    activeMs: sum((s) => s.activeMs),
    pointerSamples: sum((s) => s.pointerSamples),
    clicks: sum((s) => s.clicks),
    activations: sum((s) => s.activations),
    pages: segs.length,
    deepestScroll: segs.length === 1 ? segs[0]!.summary.deepestScroll : null,
    controlsReached: sum((s) => s.controlsReached),
    controlsInteracted: sum((s) => s.controlsInteracted),
    regionsInteracted: sum((s) => s.regionsInteracted),
    limitations,
  };
}

const r1 = (v: number): number => Math.round(v * 2) / 2;
const r3 = (v: number): number | null => (Number.isNaN(v) ? null : Math.round(v * 1000) / 1000);

export function pageIdentity(url: string, title: string): PageCaptureSegment['page'] {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: u.pathname, title: title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) };
  } catch {
    return { origin: '', path: '', title: title.slice(0, TITLE_MAX) };
  }
}

export function toSegment(c: SessionCapture, s: { sessionId: string; index: number; title: string }): PageCaptureSegment {
  const p = c.pointer;
  return {
    segmentId: `${s.sessionId}#${s.index}`,
    sessionId: s.sessionId,
    index: s.index,
    startedAt: c.meta.startedAt,
    endedAt: c.meta.endedAt,
    elapsedMs: Math.round(c.meta.elapsedMs),
    activeMs: Math.round(c.meta.activeMs),
    page: pageIdentity(c.meta.url, s.title),
    viewport: { width: c.meta.viewportWidth, height: c.meta.viewportHeight },
    layoutVersion: c.meta.layoutVersion,
    pointer: {
      count: p.count,
      t: Array.from(p.t, Math.round),
      rootId: Array.from(p.rootId),
      x: Array.from(p.x, r1),
      y: Array.from(p.y, r1),
      weightMs: Array.from(p.weightMs, Math.round),
      elementRef: Array.from(p.elementRef),
      anchorX: Array.from(p.anchorX, r3),
      anchorY: Array.from(p.anchorY, r3),
      coarse: p.coarse ? { cellPx: p.coarse.cellPx, cells: p.coarse.cells.map((x) => ({ ...x })), droppedWeightMs: p.coarse.droppedWeightMs } : null,
      foldedSamples: 0,
      totalWeightMs: Math.round(p.totalWeightMs),
    },
    clicks: c.clicks,
    clicksDropped: c.clicksDropped,
    elements: c.elements.filter((e) => e.hasActiveInteraction || e.pointerMs > 0 || e.exposure.reached),
    unreached: unreachedOf(c.elements),
    regions: c.regions,
    scroll: c.scroll,
    limitations: [...c.limitations],
    summary: summarizeCapture(c),
  };
}

function unreachedOf(elements: SessionCapture['elements']): PageCaptureSegment['unreached'] {
  const never = elements.filter((e) => !e.exposure.reached && !e.hasActiveInteraction && e.pointerMs <= 0);
  return {
    count: never.length,
    items: never.slice(0, UNREACHED_MAX).map((e) => ({ elementRef: e.elementRef, tagName: e.tagName, ...(e.role ? { role: e.role } : {}), ...(e.label ? { label: e.label } : {}), ...(e.docTop !== undefined ? { docTop: e.docTop } : {}) })),
  };
}

export function segmentBytes(s: PageCaptureSegment): number {
  return JSON.stringify(s).length;
}

/** Folds a segment's raw pointer samples into 16 px coarse cells (dwell preserved). Pure. */
export function coarsenSegment(s: PageCaptureSegment): PageCaptureSegment {
  const p = s.pointer;
  if (p.count === 0) return s;
  const cells = new Map<string, { rootId: number; cx: number; cy: number; weightMs: number }>();
  for (const c of p.coarse?.cells ?? []) cells.set(`${c.rootId}:${c.cx}:${c.cy}`, { ...c });
  for (let i = 0; i < p.count; i++) {
    const w = p.weightMs[i]!;
    if (w <= 0) continue;
    const cx = Math.floor(p.x[i]! / COARSE_CELL_PX);
    const cy = Math.floor(p.y[i]! / COARSE_CELL_PX);
    const key = `${p.rootId[i]}:${cx}:${cy}`;
    const cell = cells.get(key);
    if (cell) cell.weightMs += w;
    else cells.set(key, { rootId: p.rootId[i]!, cx, cy, weightMs: w });
  }
  return {
    ...s,
    pointer: {
      count: 0,
      t: [],
      rootId: [],
      x: [],
      y: [],
      weightMs: [],
      elementRef: [],
      anchorX: [],
      anchorY: [],
      coarse: { cellPx: COARSE_CELL_PX, cells: [...cells.values()], droppedWeightMs: p.coarse?.droppedWeightMs ?? 0 },
      foldedSamples: p.foldedSamples + p.count,
      totalWeightMs: p.totalWeightMs,
    },
  };
}

/**
 * Keeps the serialized total ≤ budget by coarsening the oldest segments first (the newest page
 * keeps raw samples longest). Returns whether anything was coarsened. Never drops a segment.
 */
export function enforceBudget(segments: readonly PageCaptureSegment[], budget = SESSION_BUDGET_BYTES): { segments: PageCaptureSegment[]; coarsened: boolean; bytes: number } {
  const out = [...segments].sort((a, b) => a.index - b.index);
  const sizes = out.map(segmentBytes);
  let total = sizes.reduce((a, b) => a + b, 0);
  let coarsened = false;
  for (let i = 0; i < out.length && total > budget; i++) {
    if (out[i]!.pointer.count === 0) continue;
    out[i] = coarsenSegment(out[i]!);
    const size = segmentBytes(out[i]!);
    total += size - sizes[i]!;
    sizes[i] = size;
    coarsened = true;
  }
  return { segments: out, coarsened, bytes: total };
}

export function priorTotals(segments: readonly Pick<PageCaptureSegment, 'summary'>[]): PriorTotals {
  return segments.reduce<PriorTotals>(
    (t, s) => ({ pages: t.pages + 1, activeMs: t.activeMs + s.summary.activeMs, clicks: t.clicks + s.summary.clicks, activations: t.activations + s.summary.activations }),
    NO_PRIOR,
  );
}
