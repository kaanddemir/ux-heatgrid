import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  isEnvelope,
  isEvent,
  isRequest,
  isResponse,
  makeEvent,
  makeRequest,
  validateRequest,
} from '../../src/shared/protocol';
import type { TabSnapshot } from '../../src/shared/model';

const snapshot: TabSnapshot = {
  buildId: 'b',
  session: { buildId: 'b', state: 'idle', sessionId: null, summary: null, result: null, error: null, recording: null },
  prediction: { state: 'idle', predictionId: null, predictorId: null, createdAt: null, summary: null, staleReason: null, error: null },
  interactionView: 'none',
  recorded: null,
  overlay: { showLow: false, focusedElementId: null },
};

describe('request envelopes', () => {
  it('accepts valid requests built by makeRequest', () => {
    expect(isRequest(makeRequest('PING', null))).toBe(true);
    expect(isRequest(makeRequest('GET_STATE', null))).toBe(true);
    expect(isRequest(makeRequest('START_SESSION', { source: 'sidepanel' }))).toBe(true);
    expect(isRequest(makeRequest('STOP_SESSION', null))).toBe(true);
    expect(isRequest(makeRequest('CLEAR_SESSION', null))).toBe(true);
  });

  it('assigns the right kind', () => {
    expect(makeRequest('GET_STATE', null).kind).toBe('query');
    expect(makeRequest('START_SESSION', { source: 'sidepanel' }).kind).toBe('cmd');
  });

  it('rejects unknown types', () => {
    const err = validateRequest({ v: PROTOCOL_VERSION, kind: 'cmd', type: 'startTracking', requestId: '1', payload: null });
    expect(err?.code).toBe('INVALID_MESSAGE');
  });

  it('rejects wrong version and wrong kind', () => {
    expect(isRequest({ ...makeRequest('PING', null), v: 0 })).toBe(false);
    expect(isRequest({ ...makeRequest('GET_STATE', null), kind: 'cmd' })).toBe(false);
  });

  it('rejects missing or invalid payloads', () => {
    const base = makeRequest('START_SESSION', { source: 'sidepanel' });
    const { payload: _omit, ...missing } = base;
    expect(isRequest(missing)).toBe(false);
    expect(isRequest({ ...base, payload: null })).toBe(false);
    expect(isRequest({ ...base, payload: { source: 'elsewhere' } })).toBe(false);
    expect(isRequest({ ...makeRequest('PING', null), payload: {} })).toBe(false);
  });

  it('rejects missing requestId and non-objects', () => {
    expect(isRequest({ ...makeRequest('PING', null), requestId: '' })).toBe(false);
    expect(isRequest(null)).toBe(false);
    expect(isRequest('PING')).toBe(false);
  });

  it('the removed analyzer debug endpoints are not accepted', () => {
    const base = makeRequest('PING', null);
    expect(isRequest({ ...base, kind: 'cmd', type: 'RUN_ANALYSIS', payload: { mode: 'full', force: false } })).toBe(false);
    expect(isRequest({ ...base, kind: 'query', type: 'GET_ANALYSIS_DEBUG', payload: null })).toBe(false);
  });

  it('accepts v2 prediction requests with the right kinds', () => {
    expect(isRequest(makeRequest('RUN_PREDICTION', { source: 'sidepanel' }))).toBe(true);
    expect(isRequest(makeRequest('CLEAR_PREDICTION', null))).toBe(true);
    expect(isRequest(makeRequest('GET_PREDICTION', null))).toBe(true);
    expect(makeRequest('RUN_PREDICTION', { source: 'sidepanel' }).kind).toBe('cmd');
    expect(makeRequest('GET_PREDICTION', null).kind).toBe('query');
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it('accepts v3 overlay / details requests with the right kinds', () => {
    expect(isRequest(makeRequest('GET_PREDICTION_DETAILS', { elementId: 4 }))).toBe(true);
    expect(isRequest(makeRequest('SET_INTERACTION_VIEW', { view: 'predicted' }))).toBe(true);
    expect(isRequest(makeRequest('SET_INTERACTION_VIEW', { view: 'none', showLow: true }))).toBe(true);
    expect(isRequest(makeRequest('FOCUS_ELEMENT', { elementId: 4, scroll: true }))).toBe(true);
    expect(isRequest(makeRequest('FOCUS_ELEMENT', { elementId: null, scroll: false }))).toBe(true);
    expect(makeRequest('GET_PREDICTION_DETAILS', { elementId: 1 }).kind).toBe('query');
    expect(makeRequest('SET_INTERACTION_VIEW', { view: 'none' }).kind).toBe('cmd');
    expect(makeRequest('FOCUS_ELEMENT', { elementId: null, scroll: false }).kind).toBe('cmd');
  });

  it('rejects malformed v3 overlay / details requests', () => {
    const details = makeRequest('GET_PREDICTION_DETAILS', { elementId: 1 });
    for (const payload of [null, {}, { elementId: '1' }, { elementId: 0 }, { elementId: -2 }, { elementId: 1.5 }, { elementId: Number.NaN }]) {
      expect(isRequest({ ...details, payload })).toBe(false);
    }
    const view = makeRequest('SET_INTERACTION_VIEW', { view: 'none' });
    for (const payload of [null, {}, { view: 'heatmap' }, { view: 'predicted', showLow: 'yes' }, { view: 3 }]) {
      expect(isRequest({ ...view, payload })).toBe(false);
    }
    const focus = makeRequest('FOCUS_ELEMENT', { elementId: 1, scroll: true });
    for (const payload of [null, { elementId: 1 }, { elementId: 'a', scroll: true }, { elementId: 0, scroll: false }, { scroll: true }]) {
      expect(isRequest({ ...focus, payload })).toBe(false);
    }
    expect(isRequest({ ...details, kind: 'cmd' })).toBe(false);
    expect(isRequest({ ...focus, v: 2 })).toBe(false);
  });

  it('rejects malformed prediction requests and v1 envelopes', () => {
    const base = makeRequest('RUN_PREDICTION', { source: 'sidepanel' });
    expect(isRequest({ ...base, payload: null })).toBe(false);
    expect(isRequest({ ...base, payload: { source: 'elsewhere' } })).toBe(false);
    expect(isRequest({ ...makeRequest('GET_PREDICTION', null), payload: {} })).toBe(false);
    expect(isRequest({ ...makeRequest('GET_STATE', null), v: 1 })).toBe(false);
    expect(validateRequest({ v: 2, kind: 'query', type: 'GET_COMPARISON', requestId: '1', payload: null })?.code).toBe('INVALID_MESSAGE');
  });

  it('legacy string-action messages are not V2 envelopes', () => {
    expect(isEnvelope({ action: 'getStatus' })).toBe(false);
  });
});

describe('events', () => {
  it('accepts valid events', () => {
    expect(isEvent(makeEvent('STATE_CHANGED', { snapshot }))).toBe(true);
    expect(isEvent(makeEvent('SESSION_ENDED', { tabId: 3, reason: 'navigation' }))).toBe(true);
    expect(
      isEvent(
        makeEvent('SESSION_TICK', {
          sessionId: 's1',
          summary: { startedAt: 0, endedAt: null, elapsedMs: 0, activeMs: 0, clicks: 0, scrollDepth: 0 },
        }),
      ),
    ).toBe(true);
  });

  it('accepts prediction events', () => {
    expect(isEvent(makeEvent('PREDICTION_READY', { predictionId: 'p1', summary: { assessed: 1, notAssessed: 0, high: 0, medium: 1, low: 0 } }))).toBe(true);
    expect(isEvent(makeEvent('PREDICTION_STALE', { predictionId: 'p1', reason: 'resize' }))).toBe(true);
    expect(isEvent(makeEvent('PREDICTION_STALE', { predictionId: null, reason: 'dom-change' }))).toBe(true);
    expect(isEvent({ ...makeEvent('PREDICTION_STALE', { predictionId: 'p', reason: 'resize' }), payload: { predictionId: 'p', reason: 'weather' } })).toBe(false);
    expect(isEvent({ ...makeEvent('PREDICTION_READY', { predictionId: 'p', summary: { assessed: 0, notAssessed: 0, high: 0, medium: 0, low: 0 } }), payload: { predictionId: 3 } })).toBe(false);
  });

  it('rejects malformed events', () => {
    expect(isEvent({ v: PROTOCOL_VERSION, kind: 'event', type: 'NOPE', payload: {} })).toBe(false);
    expect(isEvent(makeEvent('STATE_CHANGED', { snapshot: { ...snapshot, session: { ...snapshot.session, state: 'paused' as never } } }))).toBe(false);
    expect(isEvent(makeEvent('STATE_CHANGED', { snapshot: { ...snapshot, prediction: { ...snapshot.prediction, state: 'guessing' as never } } }))).toBe(false);
    // A v2-shaped snapshot (no overlay) is rejected by v3.
    const { overlay: _overlay, ...v2Snapshot } = snapshot;
    expect(isEvent({ ...makeEvent('STATE_CHANGED', { snapshot }), payload: { snapshot: v2Snapshot } })).toBe(false);
    expect(isEvent(makeEvent('STATE_CHANGED', { snapshot: { ...snapshot, overlay: { showLow: 'no' as never, focusedElementId: null } } }))).toBe(false);
    // A v1-shaped (session-only) snapshot is rejected too.
    expect(isEvent({ ...makeEvent('STATE_CHANGED', { snapshot }), payload: { snapshot: snapshot.session } })).toBe(false);
    expect(isEvent({ ...makeEvent('SESSION_ENDED', { reason: 'navigation' }), payload: { reason: 'boom' } })).toBe(false);
  });
});

describe('responses', () => {
  it('accepts success and typed failure', () => {
    expect(isResponse({ ok: true, data: null })).toBe(true);
    expect(isResponse({ ok: false, error: { code: 'INVALID_STATE', message: 'x', recoverable: true } })).toBe(true);
  });

  it('rejects malformed responses', () => {
    expect(isResponse(undefined)).toBe(false);
    expect(isResponse({ ok: true })).toBe(false);
    expect(isResponse({ ok: false, error: 'bad' })).toBe(false);
    expect(isResponse({ ok: false, error: { code: 'WHATEVER', message: 'x', recoverable: true } })).toBe(false);
    expect(isResponse({ success: true })).toBe(false);
  });
});
