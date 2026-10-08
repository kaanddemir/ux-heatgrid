/**
 * Recorder types. A capture describes WHAT HAPPENED IN THIS ONE SESSION on this page:
 * pointer positions over time, clicks, hover, focus, exposure and scrolling. It does not model
 * users, visitors, attention, gaze, intent or frustration, and it carries no scores.
 */

export type LimitationCode =
  | 'SHORT_SESSION'
  | 'LITTLE_SCROLL'
  | 'FEW_EVENTS'
  | 'PAGE_CHANGED'
  | 'FRAMES_UNSUPPORTED'
  | 'NESTED_SCROLL_UNTRACKED'
  | 'LONG_SESSION_COARSENED'
  | 'CANDIDATES_CAPPED'
  // Multi-page recordings (Phase 5.1):
  | 'MULTI_PAGE_SESSION_COARSENED'
  | 'RECORDING_INTERRUPTED_UNSUPPORTED_PAGE';

export interface ClickEvent {
  id: number;
  /** ms since session start (monotonic). */
  t: number;
  /** pointer: a pointing-device click; activation: keyboard / assistive activation (no coordinates). */
  kind: 'pointer' | 'activation';
  rootId?: number;
  /** Root-content coordinates (document space for the document root). */
  x?: number;
  y?: number;
  viewportX?: number;
  viewportY?: number;
  button?: number;
  pointerType?: string;
  elementRef?: number;
  /** 'maybe-not': nothing at or above the target looks clickable (future copy: "May not be clickable"). */
  interactive: 'yes' | 'maybe-not';
}

export interface ExposureStats {
  elementRef: number;
  /** Any part became visible at some point during the session. */
  reached: boolean;
  /** Active time while ≥ 50% visible. Opportunity, not interaction. */
  exposureMs: number;
  maxVisibleRatio: number;
  firstReachedAt?: number;
}

/** Descriptive fields of a control (accessible-name-like label ≤ 60 chars; never an input value). */
export interface ElementBrief {
  elementRef: number;
  tagName: string;
  role?: string;
  label?: string;
  /** Document top (px) at recording start; absent for fixed-position controls. */
  docTop?: number;
}

export interface RecordedElementStats extends ElementBrief {
  regionId: number | null;
  hoverEntries: number;
  hoverDwellMs: number;
  /** Pointer dwell (time-weighted samples anchored to this control). */
  pointerMs: number;
  clicks: number;
  activations: number;
  focusEvents: number;
  firstFocusAt?: number;
  exposure: ExposureStats;
  /** Hover, click, activation or focus happened. Exposure alone never counts. */
  hasActiveInteraction: boolean;
}

export interface RecordedRegionStats {
  regionId: number;
  label: string;
  /** Interactive controls in the region (structure at recording start). */
  controls?: number;
  pointerWeightMs: number;
  clicks: number;
  /** At least one control in the region was reached (became visible). */
  reached: boolean;
  interactedElements: number;
}

export interface ScrollTimelinePoint {
  t: number;
  rootId: number;
  scrollTop: number;
}

export interface ScrollRootStats {
  rootId: number;
  kind: 'document' | 'container';
  elementRef?: number;
  /** Discovered during recording (not in the start snapshot). */
  lazy: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Deepest visible content edge (px from the root's content top). */
  deepestPx: number;
  /** deepestPx / scrollHeight, 0–1. */
  deepestFraction: number;
}

/** Pointer samples, column-oriented (typed arrays). Raw up to the cap; coarse afterwards. */
export interface PointerCapture {
  count: number;
  capacity: number;
  t: Float64Array;
  rootId: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  /** Dwell weight (ms) of each sample; time until the next retained sample, ≤ 1000. */
  weightMs: Float32Array;
  /** 0 = unanchored. */
  elementRef: Int32Array;
  /** 0–1 within the element; NaN when unanchored. */
  anchorX: Float32Array;
  anchorY: Float32Array;
  /** After the raw cap: dwell aggregated into coarse cells (see buffer.ts). */
  coarse: { cellPx: number; cells: Array<{ rootId: number; cx: number; cy: number; weightMs: number }>; droppedWeightMs: number } | null;
  /** Total dwell, raw + coarse + dropped. */
  totalWeightMs: number;
}

/** Internal capture (stays in the content runtime). Phase 6 turns it into the Recorded map. */
export interface SessionCapture {
  meta: {
    startedAt: number;
    endedAt: number;
    elapsedMs: number;
    activeMs: number;
    layoutVersion: number;
    viewportWidth: number;
    viewportHeight: number;
    url: string;
  };
  pointer: PointerCapture;
  clicks: ClickEvent[];
  clicksDropped: number;
  elements: RecordedElementStats[];
  regions: RecordedRegionStats[];
  scroll: { roots: ScrollRootStats[]; timeline: ScrollTimelinePoint[]; timelineIntervalMs: number };
  limitations: LimitationCode[];
}

/** Lightweight, UI-safe summary of a finished capture (no samples, no arrays of events). */
export interface SessionCaptureSummary {
  kind: 'capture';
  elapsedMs: number;
  activeMs: number;
  pointerSamples: number;
  clicks: number;
  activations: number;
  /** Page segments in the recording (1 unless the recording continued across navigations). */
  pages: number;
  /** Deepest document scroll, 0–1 — single-page recordings only (null across pages: no fake global depth). */
  deepestScroll: number | null;
  controlsReached: number;
  controlsInteracted: number;
  regionsInteracted: number;
  limitations: LimitationCode[];
}

/** Live values for SESSION_TICK while recording. */
export interface LiveCaptureStats {
  activeMs: number;
  clicks: number;
  deepestScroll: number;
}

/** GET_SESSION_CAPTURE_SUMMARY: aggregated capture facts — never pointer samples or event lists. */
export interface SessionCaptureDetails {
  summary: SessionCaptureSummary;
  pointer: { samples: number; capacity: number; totalWeightMs: number; coarseCells: number };
  clickCounts: { pointer: number; activation: number; maybeNotClickable: number; dropped: number };
  /** Controls with any recorded activity or exposure. */
  elements: RecordedElementStats[];
  regions: RecordedRegionStats[];
  scrollRoots: ScrollRootStats[];
  timelinePoints: number;
}
