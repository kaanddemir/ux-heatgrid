import { describe, expect, it } from 'vitest';
import { isRestrictedUrl } from '../../src/shared/constants';
import { markEnded, mirrorFromSnapshot, mirrorKey, onRuntimeGone, shouldEndOnNavigation } from '../../src/shared/mirror';
import type { PredictionSnapshot, SessionSnapshot, TabSnapshot } from '../../src/shared/model';
import { classifyInjectionError } from '../../src/ui/shared/client';

const recordingSession: SessionSnapshot = {
  buildId: 'b',
  state: 'recording',
  sessionId: 's1',
  summary: { startedAt: 100, endedAt: null, elapsedMs: 0, activeMs: 0, clicks: 0, scrollDepth: 0 },
  result: null,
  error: null,
  recording: null,
};
const idlePrediction: PredictionSnapshot = { state: 'idle', predictionId: null, predictorId: null, createdAt: null, summary: null, staleReason: null, error: null };
const tab = (session: Partial<SessionSnapshot>, prediction: Partial<PredictionSnapshot> = {}): TabSnapshot => ({
  buildId: 'b',
  session: { ...recordingSession, ...session },
  prediction: { ...idlePrediction, ...prediction },
  interactionView: 'none',
  recorded: null,
  overlay: { showLow: false, focusedElementId: null },
});
const recording = tab({});

describe('lifecycle mirror', () => {
  it('mirrors active snapshots with lightweight fields only', () => {
    const m = mirrorFromSnapshot(7, recording, 500);
    expect(m).toEqual({
      tabId: 7,
      state: 'recording',
      endedReason: null,
      sessionId: 's1',
      startedAt: 100,
      summary: recordingSession.summary,
      prediction: null,
      updatedAt: 500,
    });
  });

  it('does not mirror idle (no session, no prediction)', () => {
    expect(mirrorFromSnapshot(7, tab({ state: 'idle', summary: null }), 1)).toBeNull();
  });

  it('mirrors prediction state only (never the result) when the session is idle', () => {
    const m = mirrorFromSnapshot(7, tab({ state: 'idle', summary: null, sessionId: null }, { state: 'ready', predictionId: 'p1.1', summary: { assessed: 3, notAssessed: 0, high: 1, medium: 1, low: 1 } }), 1)!;
    expect(m.state).toBe('idle');
    expect(m.prediction).toEqual({ state: 'ready', predictionId: 'p1.1' });
    expect(JSON.stringify(m)).not.toContain('assessed');
  });

  it('runtime gone: active session ends and prediction is dropped; prediction-only entry is removed', () => {
    const both = mirrorFromSnapshot(7, tab({}, { state: 'ready', predictionId: 'p' }), 1)!;
    const gone = onRuntimeGone(both, 'navigation', 5);
    expect(gone.sessionEnded).toBe(true);
    expect(gone.next).toMatchObject({ state: 'ended', endedReason: 'navigation', prediction: null });
    const predOnly = mirrorFromSnapshot(7, tab({ state: 'idle', summary: null }, { state: 'stale', predictionId: 'p' }), 1)!;
    expect(onRuntimeGone(predOnly, 'navigation', 5)).toEqual({ next: null, sessionEnded: false });
    expect(onRuntimeGone(null, 'navigation', 5)).toEqual({ next: null, sessionEnded: false });
  });

  it('ends active sessions on navigation, not idle/ended/error ones', () => {
    const m = mirrorFromSnapshot(7, recording, 1)!;
    expect(shouldEndOnNavigation(m)).toBe(true);
    expect(shouldEndOnNavigation({ ...m, state: 'ready' })).toBe(true);
    expect(shouldEndOnNavigation({ ...m, state: 'error' })).toBe(false);
    expect(shouldEndOnNavigation(markEnded(m, 'navigation', 2))).toBe(false);
    expect(shouldEndOnNavigation(null)).toBe(false);
  });

  it('markEnded records the reason', () => {
    const ended = markEnded(mirrorFromSnapshot(7, recording, 1)!, 'navigation', 9);
    expect(ended).toMatchObject({ state: 'ended', endedReason: 'navigation', updatedAt: 9, sessionId: 's1' });
  });

  it('uses a per-tab key', () => {
    expect(mirrorKey(42)).toBe('tab:42');
  });
});

describe('restricted pages', () => {
  it.each([
    'chrome://settings',
    'chrome-extension://abc/popup.html',
    'view-source:https://example.com',
    'about:blank',
    'edge://extensions',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/category/extensions',
    'devtools://devtools/bundled/inspector.html',
  ])('%s is restricted', (url) => {
    expect(isRestrictedUrl(url)).toBe(true);
  });

  it.each(['https://example.com', 'http://localhost:3000', 'file:///tmp/a.html'])('%s is not restricted', (url) => {
    expect(isRestrictedUrl(url)).toBe(false);
  });

  it('unknown URL is not assumed restricted', () => {
    expect(isRestrictedUrl(undefined)).toBe(false);
  });

  it('classifies injection errors', () => {
    expect(classifyInjectionError('Cannot access a chrome:// URL').code).toBe('RESTRICTED_PAGE');
    expect(classifyInjectionError('The extensions gallery cannot be scripted.').code).toBe('RESTRICTED_PAGE');
    expect(
      classifyInjectionError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.').code,
    ).toBe('NO_PERMISSION');
    expect(classifyInjectionError('Frame with ID 0 was removed.').code).toBe('INTERNAL');
  });
});
