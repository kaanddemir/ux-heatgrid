/**
 * V2 shared data model: runtime state that crosses the extension boundary.
 * Session (Record) and Prediction (Predict) are independent capabilities with independent state.
 */

export const SESSION_STATES = ['idle', 'preparing', 'recording', 'processing', 'ready', 'error'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** States in which a session (or its result) exists in the content runtime. */
export const ACTIVE_STATES: readonly SessionState[] = ['preparing', 'recording', 'processing', 'ready'];

export const ERROR_CODES = [
  'NOT_INJECTED',
  'RESTRICTED_PAGE',
  'NO_PERMISSION',
  'INVALID_STATE',
  'INVALID_MESSAGE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface HeatGridError {
  code: ErrorCode;
  /** Developer-facing detail; UI maps `code` to user copy. */
  message: string;
  recoverable: boolean;
}

export interface SessionSummary {
  startedAt: number;
  endedAt: number | null;
  elapsedMs: number;
  activeMs: number;
  clicks: number;
  /** 0–1 */
  scrollDepth: number;
}

import type { SessionCaptureSummary } from '../content/recorder/types';
import type { RecordedSnapshot } from '../content/recorded/types';

/** Phase 1 placeholder result (only when no recorder is attached, e.g. lifecycle unit tests). */
export interface PlaceholderResult {
  kind: 'placeholder';
  note: string;
}

export interface SessionSnapshot {
  buildId: string;
  state: SessionState;
  sessionId: string | null;
  summary: SessionSummary | null;
  /** Lightweight summary of the finished capture (Phase 5); the capture itself stays in the runtime. */
  result: SessionCaptureSummary | PlaceholderResult | null;
  error: HeatGridError | null;
  /** Tab-level recording continuity (null without a recording). */
  recording: RecordingContinuity | null;
}

export interface RecordingContinuity {
  /** Page segments so far, including the current one. */
  segmentCount: number;
  currentSegmentIndex: number;
  continuity: 'continuous' | 'interrupted';
}

export const PREDICTION_STATES = ['idle', 'analyzing', 'ready', 'stale', 'error'] as const;
export type PredictionState = (typeof PREDICTION_STATES)[number];

export type StaleReason = 'dom-change' | 'resize' | 'same-document-navigation';

export interface PredictionCounts {
  assessed: number;
  notAssessed: number;
  high: number;
  medium: number;
  low: number;
}

/** Lightweight prediction state. The list is fetched with GET_PREDICTION, one element's breakdown with GET_PREDICTION_DETAILS. */
export interface PredictionSnapshot {
  state: PredictionState;
  predictionId: string | null;
  predictorId: string | null;
  createdAt: number | null;
  summary: PredictionCounts | null;
  staleReason: StaleReason | null;
  error: HeatGridError | null;
}

/**
 * Which interaction layer the page overlay shows (only one at a time): 'predicted' (Phase 4) or
 * 'recorded' (Phase 6 — available once a recording is ready).
 */
export type InteractionView = 'none' | 'predicted' | 'recorded';
export const INTERACTION_VIEWS: readonly InteractionView[] = ['none', 'predicted', 'recorded'];

/** Page overlay options (runtime memory only). */
export interface OverlaySnapshot {
  /** Low-band outlines are hidden by default. */
  showLow: boolean;
  /** Element highlighted with "Show on page", or null. */
  focusedElementId: number | null;
}

/** Combined per-tab runtime state (protocol v3). */
export interface TabSnapshot {
  buildId: string;
  session: SessionSnapshot;
  prediction: PredictionSnapshot;
  interactionView: InteractionView;
  overlay: OverlaySnapshot;
  /** Recorded Interaction selection (null until a recording has been processed). */
  recorded: RecordedSnapshot | null;
}

/**
 * FOCUS_ELEMENT outcome.
 * - focused: the live element was resolved, highlighted (and scrolled to when asked)
 * - cleared: highlight removed
 * - unavailable: the element is no longer on the page (nothing is painted for it)
 * `moved`: its live position differs materially from where it was when the prediction ran.
 */
export interface FocusResult {
  status: 'focused' | 'cleared' | 'unavailable';
  moved: boolean;
  snapshot: TabSnapshot;
}

export type EndedReason = 'navigation' | 'runtime-lost';

/** Lightweight per-tab mirror kept by the service worker in storage.session. */
export interface LifecycleMirror {
  tabId: number;
  /** Session state ('idle' when only a prediction exists). */
  state: SessionState | 'ended';
  endedReason: EndedReason | null;
  sessionId: string | null;
  startedAt: number | null;
  summary: SessionSummary | null;
  /** Prediction state only (never the result); null when there is no prediction. */
  prediction: { state: PredictionState; predictionId: string | null } | null;
  updatedAt: number;
}

export function makeError(code: ErrorCode, message: string, recoverable = true): HeatGridError {
  return { code, message, recoverable };
}
