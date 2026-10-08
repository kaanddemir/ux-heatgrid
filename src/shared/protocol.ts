/**
 * Typed message protocol between extension UI, service worker and content runtime.
 *
 * - Requests (commands + queries): UI → content via chrome.tabs.sendMessage.
 *   Always answered with a Response: { ok: true, data } | { ok: false, error }.
 * - Events: pushed with chrome.runtime.sendMessage (content → extension pages / SW,
 *   or SW → extension pages). Never answered.
 */
import {
  ERROR_CODES,
  INTERACTION_VIEWS,
  PREDICTION_STATES,
  SESSION_STATES,
  makeError,
  type EndedReason,
  type FocusResult,
  type HeatGridError,
  type InteractionView,
  type PredictionCounts,
  type SessionSummary,
  type StaleReason,
  type TabSnapshot,
} from './model';
import type { PredictionElementDetails, PredictionSummaryResult } from '../content/prediction/types';
import type { SessionCaptureDetails } from '../content/recorder/types';
import type { ResumePayload } from '../content/recorder/segment';
import type { RecordedFocusResult, RecordedLayers, RecordedPageView, RecordedSessionView } from '../content/recorded/types';

/**
 * v2 (Phase 3): state is a combined TabSnapshot { session, prediction, interactionView };
 * adds RUN_PREDICTION / CLEAR_PREDICTION / GET_PREDICTION and PREDICTION_READY / PREDICTION_STALE.
 * v3 (Phase 4): GET_PREDICTION returns the lightweight PredictionSummaryResult (breaking change);
 * adds GET_PREDICTION_DETAILS, SET_INTERACTION_VIEW, FOCUS_ELEMENT and TabSnapshot.overlay.
 * Phase 5 (additive, still v3): GET_SESSION_CAPTURE_SUMMARY; session.result is a capture summary.
 * Phase 5.1 (additive, still v3): RESUME_RECORDING (service worker → new document) and
 * session.recording { segmentCount, currentSegmentIndex, continuity }.
 * Phase 6 (additive, still v3): SET_INTERACTION_VIEW accepts 'recorded' once a recording is ready;
 * GET_RECORDED_SESSION / GET_RECORDED_PAGE / SET_RECORDED_PAGE / SET_RECORDED_LAYERS /
 * FOCUS_RECORDED_ELEMENT and TabSnapshot.recorded. Density and tiles never cross the protocol.
 * Phases 7–8 added Coach messages (GET_COACH / RUN_COACH / FOCUS_COACH_SUBJECT / GET_PAGE_COVERAGE);
 * they were removed with the Coach UI (V2 ships Predict + Record only) and are now rejected as unknown.
 */
export const PROTOCOL_VERSION = 3;

export type StartSource = 'sidepanel';
export type Source = StartSource;

export interface PingData {
  buildId: string;
}

/** Request type → payload and response data. */
export interface RequestMap {
  PING: { kind: 'cmd'; payload: null; data: PingData };
  START_SESSION: { kind: 'cmd'; payload: { source: StartSource }; data: TabSnapshot };
  STOP_SESSION: { kind: 'cmd'; payload: null; data: TabSnapshot };
  CLEAR_SESSION: { kind: 'cmd'; payload: null; data: TabSnapshot };
  GET_STATE: { kind: 'query'; payload: null; data: TabSnapshot };
  RUN_PREDICTION: { kind: 'cmd'; payload: { source: Source }; data: TabSnapshot };
  CLEAR_PREDICTION: { kind: 'cmd'; payload: null; data: TabSnapshot };
  /** Lightweight result of the current prediction (no features/contributions), or null. Never persisted. */
  GET_PREDICTION: { kind: 'query'; payload: null; data: PredictionSummaryResult | null };
  /** Full breakdown of ONE element of the current prediction; null when it is not in the result. */
  GET_PREDICTION_DETAILS: { kind: 'query'; payload: { elementId: number }; data: PredictionElementDetails | null };
  /** Shows/hides the page overlay ('recorded' needs a ready recording). */
  SET_INTERACTION_VIEW: { kind: 'cmd'; payload: { view: InteractionView; showLow?: boolean }; data: TabSnapshot };
  /** Highlights one predicted element ("Show on page"), or clears the highlight with null. */
  FOCUS_ELEMENT: { kind: 'cmd'; payload: { elementId: number | null; scroll: boolean }; data: FocusResult };
  /** Service worker → new document: continue the tab's recording as the next page segment. */
  RESUME_RECORDING: { kind: 'cmd'; payload: ResumePayload; data: TabSnapshot };
  /** Aggregated facts of the finished capture (no samples / event lists), or null. */
  GET_SESSION_CAPTURE_SUMMARY: { kind: 'query'; payload: null; data: SessionCaptureDetails | null };
  /** Recorded Interaction: session summary + page list (no density), or null. */
  GET_RECORDED_SESSION: { kind: 'query'; payload: null; data: RecordedSessionView | null };
  /** Facts and lists of one recorded page (position in the recording), or null. */
  GET_RECORDED_PAGE: { kind: 'query'; payload: { page: number }; data: RecordedPageView | null };
  /** Selects the recorded page to inspect (its map is drawn only when that page is open). */
  SET_RECORDED_PAGE: { kind: 'cmd'; payload: { page: number }; data: TabSnapshot };
  SET_RECORDED_LAYERS: { kind: 'cmd'; payload: RecordedLayers; data: TabSnapshot };
  /** Selects a recorded control on a page (outline + scroll on the live page when possible), or clears with null. */
  FOCUS_RECORDED_ELEMENT: { kind: 'cmd'; payload: { page: number; elementId: number | null; scroll: boolean }; data: RecordedFocusResult & { snapshot: TabSnapshot } };
}
export type RequestType = keyof RequestMap;

/** Event type → payload. `tabId` is set by the SW; content events use sender.tab.id. */
export interface EventMap {
  STATE_CHANGED: { snapshot: TabSnapshot };
  SESSION_TICK: { sessionId: string; summary: SessionSummary };
  SESSION_ENDED: { tabId?: number; reason: EndedReason };
  PREDICTION_READY: { predictionId: string; summary: PredictionCounts };
  PREDICTION_STALE: { predictionId: string | null; reason: StaleReason };
}
export type EventType = keyof EventMap;

export interface RequestEnvelope<T extends RequestType = RequestType> {
  v: typeof PROTOCOL_VERSION;
  kind: RequestMap[T]['kind'];
  type: T;
  requestId: string;
  payload: RequestMap[T]['payload'];
}

export interface EventEnvelope<T extends EventType = EventType> {
  v: typeof PROTOCOL_VERSION;
  kind: 'event';
  type: T;
  payload: EventMap[T];
}

export type Response<D> = { ok: true; data: D } | { ok: false; error: HeatGridError };

const REQUEST_KINDS: { [K in RequestType]: RequestMap[K]['kind'] } = {
  PING: 'cmd',
  START_SESSION: 'cmd',
  STOP_SESSION: 'cmd',
  CLEAR_SESSION: 'cmd',
  GET_STATE: 'query',
  RUN_PREDICTION: 'cmd',
  CLEAR_PREDICTION: 'cmd',
  GET_PREDICTION: 'query',
  GET_PREDICTION_DETAILS: 'query',
  SET_INTERACTION_VIEW: 'cmd',
  FOCUS_ELEMENT: 'cmd',
  GET_SESSION_CAPTURE_SUMMARY: 'query',
  RESUME_RECORDING: 'cmd',
  GET_RECORDED_SESSION: 'query',
  GET_RECORDED_PAGE: 'query',
  SET_RECORDED_PAGE: 'cmd',
  SET_RECORDED_LAYERS: 'cmd',
  FOCUS_RECORDED_ELEMENT: 'cmd',
};
const EVENT_TYPES: readonly EventType[] = ['STATE_CHANGED', 'SESSION_TICK', 'SESSION_ENDED', 'PREDICTION_READY', 'PREDICTION_STALE'];
const STALE_REASONS: readonly StaleReason[] = ['dom-change', 'resize', 'same-document-navigation'];

let requestCounter = 0;

export function makeRequest<T extends RequestType>(type: T, payload: RequestMap[T]['payload']): RequestEnvelope<T> {
  requestCounter += 1;
  return {
    v: PROTOCOL_VERSION,
    kind: REQUEST_KINDS[type],
    type,
    requestId: `${Date.now().toString(36)}-${requestCounter}`,
    payload,
  };
}

export function makeEvent<T extends EventType>(type: T, payload: EventMap[T]): EventEnvelope<T> {
  return { v: PROTOCOL_VERSION, kind: 'event', type, payload };
}

export function ok<D>(data: D): Response<D> {
  return { ok: true, data };
}

export function fail<D = never>(error: HeatGridError): Response<D> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function isRequestType(x: unknown): x is RequestType {
  return typeof x === 'string' && hasOwn(REQUEST_KINDS as Record<string, unknown>, x);
}

const isElementId = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const isPage = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x < 10_000;

function isValidRequestPayload(type: RequestType, payload: unknown): boolean {
  switch (type) {
    case 'START_SESSION':
    case 'RUN_PREDICTION':
      return isObject(payload) && payload.source === 'sidepanel';
    case 'GET_PREDICTION_DETAILS':
      return isObject(payload) && isElementId(payload.elementId);
    case 'SET_INTERACTION_VIEW':
      return (
        isObject(payload) &&
        typeof payload.view === 'string' &&
        (INTERACTION_VIEWS as readonly string[]).includes(payload.view) &&
        (!hasOwn(payload, 'showLow') || typeof payload.showLow === 'boolean')
      );
    case 'RESUME_RECORDING': {
      const p = payload as Record<string, unknown> | null;
      const prior = isObject(p) ? p.prior : null;
      return (
        isObject(p) &&
        typeof p.sessionId === 'string' &&
        p.sessionId.length > 0 &&
        typeof p.startedAt === 'number' &&
        Number.isSafeInteger(p.segmentIndex) &&
        (p.segmentIndex as number) >= 0 &&
        (p.continuity === 'continuous' || p.continuity === 'interrupted') &&
        isObject(prior) &&
        ['pages', 'activeMs', 'clicks', 'activations'].every((k) => typeof prior[k] === 'number')
      );
    }
    case 'GET_RECORDED_PAGE':
    case 'SET_RECORDED_PAGE':
      return isObject(payload) && isPage(payload.page);
    case 'SET_RECORDED_LAYERS':
      return isObject(payload) && ['heatmap', 'clicks', 'scroll'].every((k) => typeof payload[k] === 'boolean');
    case 'FOCUS_RECORDED_ELEMENT':
      return isObject(payload) && isPage(payload.page) && (payload.elementId === null || isElementId(payload.elementId)) && typeof payload.scroll === 'boolean';
    case 'FOCUS_ELEMENT':
      return isObject(payload) && (payload.elementId === null || isElementId(payload.elementId)) && typeof payload.scroll === 'boolean';
    case 'PING':
    case 'STOP_SESSION':
    case 'CLEAR_SESSION':
    case 'GET_STATE':
    case 'CLEAR_PREDICTION':
    case 'GET_PREDICTION':
    case 'GET_SESSION_CAPTURE_SUMMARY':
    case 'GET_RECORDED_SESSION':
      return payload === null;
  }
}

/** Validates a request envelope. Returns null if valid, otherwise a typed error. */
export function validateRequest(x: unknown): HeatGridError | null {
  if (!isObject(x)) return makeError('INVALID_MESSAGE', 'Message is not an object');
  if (x.v !== PROTOCOL_VERSION) return makeError('INVALID_MESSAGE', `Unsupported protocol version: ${String(x.v)}`);
  if (!isRequestType(x.type)) return makeError('INVALID_MESSAGE', `Unknown request type: ${String(x.type)}`);
  if (x.kind !== REQUEST_KINDS[x.type]) return makeError('INVALID_MESSAGE', `Wrong kind for ${x.type}`);
  if (typeof x.requestId !== 'string' || x.requestId.length === 0) {
    return makeError('INVALID_MESSAGE', 'Missing requestId');
  }
  if (!hasOwn(x, 'payload') || !isValidRequestPayload(x.type, x.payload)) {
    return makeError('INVALID_MESSAGE', `Invalid payload for ${x.type}`);
  }
  return null;
}

export function isRequest(x: unknown): x is RequestEnvelope {
  return validateRequest(x) === null;
}

/** True for anything that claims to be a V2 envelope (used to ignore foreign messages). */
export function isEnvelope(x: unknown): boolean {
  return isObject(x) && x.v === PROTOCOL_VERSION && (x.kind === 'cmd' || x.kind === 'query' || x.kind === 'event');
}

function isSessionSnapshot(x: unknown): boolean {
  return isObject(x) && typeof x.state === 'string' && (SESSION_STATES as readonly string[]).includes(x.state);
}

function isPredictionSnapshot(x: unknown): boolean {
  return isObject(x) && typeof x.state === 'string' && (PREDICTION_STATES as readonly string[]).includes(x.state);
}

export function isTabSnapshot(x: unknown): x is TabSnapshot {
  return (
    isObject(x) &&
    typeof x.buildId === 'string' &&
    isSessionSnapshot(x.session) &&
    isPredictionSnapshot(x.prediction) &&
    typeof x.interactionView === 'string' &&
    (INTERACTION_VIEWS as readonly string[]).includes(x.interactionView) &&
    isObject(x.overlay) &&
    typeof x.overlay.showLow === 'boolean' &&
    (x.overlay.focusedElementId === null || typeof x.overlay.focusedElementId === 'number')
  );
}

export function isEvent(x: unknown): x is EventEnvelope {
  if (!isObject(x) || x.v !== PROTOCOL_VERSION || x.kind !== 'event') return false;
  if (typeof x.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(x.type)) return false;
  const p = x.payload;
  if (!isObject(p)) return false;
  switch (x.type as EventType) {
    case 'STATE_CHANGED':
      return isTabSnapshot(p.snapshot);
    case 'SESSION_TICK':
      return typeof p.sessionId === 'string' && isObject(p.summary);
    case 'SESSION_ENDED':
      return p.reason === 'navigation' || p.reason === 'runtime-lost';
    case 'PREDICTION_READY':
      return typeof p.predictionId === 'string' && isObject(p.summary);
    case 'PREDICTION_STALE':
      return (p.predictionId === null || typeof p.predictionId === 'string') && (STALE_REASONS as readonly string[]).includes(p.reason as string);
  }
}

export function isHeatGridError(x: unknown): x is HeatGridError {
  return (
    isObject(x) &&
    typeof x.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(x.code) &&
    typeof x.message === 'string' &&
    typeof x.recoverable === 'boolean'
  );
}

/** Validates the shape of a response (data contents are trusted per request type). */
export function isResponse(x: unknown): x is Response<unknown> {
  if (!isObject(x) || typeof x.ok !== 'boolean') return false;
  if (x.ok) return hasOwn(x, 'data');
  return isHeatGridError(x.error);
}
