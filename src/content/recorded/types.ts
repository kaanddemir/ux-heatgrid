/**
 * Recorded Interaction result model. A Recorded map shows WHAT HAPPENED IN THIS ONE SESSION:
 * time-weighted pointer presence (density), clicks and scroll depth as separate factual layers.
 * Never attention, gaze, intent, engagement or behaviour of users in general; no scores.
 *
 * The heavy part (packed density per root) stays in the content runtime. The side panel only
 * receives the lightweight views at the end of this file.
 */
import type { LimitationCode, RecordedElementStats, RecordedRegionStats } from '../recorder/types';
import type { SessionLimitationCode } from '../recorder/segment';
import type { RecordedLists } from './lists';
import type { ClickMarker, MaybeNotClickableSpot } from './markers';
import type { PackedDensity } from './normalize';
import type { ReprojectionStats } from './reproject';

export type RecordedLimitationCode = LimitationCode | 'REPROJECTION_UNCERTAIN';

export interface PageIdentity {
  origin: string;
  path: string;
  title: string;
}

export interface RecordedScrollMetrics {
  /** Document root (null if none was tracked). */
  document: { deepestPx: number; deepestFraction: number; scrollHeight: number; clientHeight: number } | null;
  nested: Array<{ rootId: number; elementRef?: number; deepestPx: number; deepestFraction: number; scrollHeight: number }>;
}

export interface RecordedPageFacts {
  elapsedMs: number;
  activeMs: number;
  /** Pointer clicks (incl. ones beyond the click cap) and keyboard / assistive activations. */
  clicks: number;
  activations: number;
  pointerSamples: number;
  controlsReached: number;
  controlsInteracted: number;
  maybeNotClickable: number;
}

export interface RecordedPageResult {
  segmentId: string;
  /** Segment index within the recording (0-based). */
  index: number;
  pageIdentity: PageIdentity;
  /** Recorded in the document that is still open in this runtime (live element lookup possible). */
  local: boolean;
  startedAt: number;
  endedAt: number;
  dimensions: { viewport: { width: number; height: number }; documentWidth: number; documentHeight: number; cellPx: number };
  density: {
    roots: PackedDensity[];
    /** Visual upper bound (smoothed dwell ms per cell) — internal, never displayed. */
    upper: number;
    /** Dwell placed on the grid (raw + coarse). */
    placedMs: number;
    /** Phase 5 coarse-grid overflow dwell that has no position. */
    unplacedMs: number;
    bytes: number;
  };
  clickMarkers: ClickMarker[];
  scrollMetrics: RecordedScrollMetrics;
  elementStats: RecordedElementStats[];
  regionStats: RecordedRegionStats[];
  lists: RecordedLists;
  maybeNotClickable: MaybeNotClickableSpot[];
  facts: RecordedPageFacts;
  reprojection: ReprojectionStats;
  limitations: RecordedLimitationCode[];
  timings: { processMs: number };
}

export interface RecordedSessionResult {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  activeMs: number;
  totals: { clicks: number; activations: number; pages: number; controlsInteracted: number };
  segments: RecordedPageResult[];
  limitations: SessionLimitationCode[];
  timings: { processMs: number; perPageMs: number[] };
}

// ---------------------------------------------------------------------------
// Lightweight views (protocol)
// ---------------------------------------------------------------------------

export interface RecordedLayers {
  heatmap: boolean;
  clicks: boolean;
  scroll: boolean;
}

export const DEFAULT_LAYERS: RecordedLayers = { heatmap: true, clicks: true, scroll: true };

/** TabSnapshot.recorded: which Recorded page is selected and how it is shown. */
export interface RecordedSnapshot {
  /** Position of the selected page in the recording (0-based). */
  page: number;
  pageCount: number;
  layers: RecordedLayers;
  focusedElementId: number | null;
  /** The live page is the selected page segment's page (its map can be drawn). */
  pageOpen: boolean;
}

export interface RecordedPageRef {
  position: number;
  path: string;
  title: string;
  clicks: number;
  activeMs: number;
}

/** GET_RECORDED_SESSION */
export interface RecordedSessionView {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  activeMs: number;
  totals: RecordedSessionResult['totals'];
  /** Single-page recordings only (no fake global depth across pages). */
  deepestScroll: number | null;
  pages: RecordedPageRef[];
  selectedPage: number;
  limitations: SessionLimitationCode[];
  timings: RecordedSessionResult['timings'];
}

/** GET_RECORDED_PAGE */
export interface RecordedPageView {
  position: number;
  pageCount: number;
  path: string;
  title: string;
  /** The original page is the live page (map drawable, rows can be shown on the page). */
  pageOpen: boolean;
  /** Elements can be resolved on the live page (same document as the recording). */
  elementsLive: boolean;
  layoutMayHaveChanged: boolean;
  facts: RecordedPageFacts & {
    deepestScroll: number | null;
    nestedScroll: Array<{ rootId: number; label: string | null; deepestFraction: number }>;
  };
  lists: RecordedLists;
  maybeNotClickable: MaybeNotClickableSpot[];
  limitations: RecordedLimitationCode[];
}

/** FOCUS_RECORDED_ELEMENT outcome. */
export interface RecordedFocusResult {
  status: 'focused' | 'cleared' | 'unavailable' | 'not-open';
}
