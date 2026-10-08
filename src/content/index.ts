/**
 * Content runtime entry. Bundled as an IIFE and injected on demand via chrome.scripting.
 *
 * Injection guard:
 *  - same build already running → no-op (no duplicate listeners)
 *  - different build running     → dispose it, then boot this one
 */
import { BUILD_ID, RECORDING_PORT, RUNTIME_GLOBAL_KEY } from '../shared/constants';
import type { ContinuityChannel } from './recorder/segment';
import { fail, isEnvelope, makeEvent, validateRequest, type EventEnvelope, type RequestEnvelope, type Response } from '../shared/protocol';
import { createStaleWatcher } from './prediction/stale';
import { createTabRuntime } from './tabRuntime';

interface RuntimeHandle {
  buildId: string;
  /** False once the extension that injected this runtime was reloaded/updated. */
  isContextValid: () => boolean;
  dispose: () => void;
  /** Diagnostics for automated checks (lives in the extension's isolated world only). */
  overlayStats: () => unknown;
  recorderDiagnostics: () => unknown;
  recordedDiagnostics: () => unknown;
}

function contextValid(): boolean {
  try {
    return typeof chrome.runtime?.id === 'string';
  } catch {
    return false;
  }
}

type GuardedGlobal = typeof globalThis & { [RUNTIME_GLOBAL_KEY]?: RuntimeHandle };

function emit(event: EventEnvelope): void {
  try {
    // Rejects when no extension page is listening — that's expected and safe to ignore.
    chrome.runtime.sendMessage(event).catch(() => {});
  } catch {
    // Extension context invalidated (extension reloaded); nothing to notify.
  }
}

/**
 * Continuity channel to the service worker. A short-lived runtime.connect port per message: only
 * the service worker listens for it (the side panel never receives segment data). Used only at
 * page boundaries (begin, pagehide, Stop, Clear) — never while recording.
 */
const continuity: ContinuityChannel = {
  begin: (sessionId, startedAt) => post({ type: 'begin', sessionId, startedAt }),
  segment: (segment) => post({ type: 'segment', segment }),
  clear: (sessionId) => post({ type: 'clear', sessionId }),
  collect: (sessionId) =>
    new Promise((resolve) => {
      try {
        const port = chrome.runtime.connect({ name: RECORDING_PORT });
        const timer = setTimeout(() => (port.disconnect(), resolve(null)), 5000);
        port.onMessage.addListener((m: { type?: string; data?: unknown }) => {
          if (m?.type !== 'collected') return;
          clearTimeout(timer);
          port.disconnect();
          resolve(m.data as Awaited<ReturnType<ContinuityChannel['collect']>>);
        });
        port.postMessage({ type: 'collect', sessionId });
      } catch {
        resolve(null);
      }
    }),
};

function post(msg: unknown): void {
  try {
    const port = chrome.runtime.connect({ name: RECORDING_PORT });
    port.postMessage(msg);
    port.disconnect();
  } catch {
    // Extension context invalidated: nothing to hand over.
  }
}

function boot(): RuntimeHandle {
  const tab = createTabRuntime({ buildId: BUILD_ID, emit, continuity, createWatcher: (onStale) => createStaleWatcher(onStale) });

  const onMessage = (
    msg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: Response<unknown>) => void,
  ): void => {
    if (!isEnvelope(msg)) return; // not ours — let other listeners handle it
    const invalid = validateRequest(msg);
    if (invalid) {
      sendResponse(fail(invalid));
      return;
    }
    try {
      sendResponse(tab.handle(msg as RequestEnvelope));
    } catch (e) {
      sendResponse(fail({ code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), recoverable: true }));
    }
    // All handlers are synchronous: no `return true`.
  };

  const onPageHide = (e: PageTransitionEvent): void => {
    // Recording: this page segment ends here (exactly once); the tab's recording continues on the
    // next document (the service worker resumes it). Same for bfcache: the page's segment ends.
    const handedOff = tab.handoffRecording() !== null;
    if (e.persisted) return; // bfcache — the document may come back (see onPageShow)
    if (!handedOff && tab.hasActiveSession()) emit(makeEvent('SESSION_ENDED', { reason: 'navigation' }));
    dispose();
  };
  // Back/forward cache restore: ask the service worker whether this tab's recording continues.
  const onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) post({ type: 'resume-request' });
  };

  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    tab.dispose();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // context invalidated
    }
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    const g = globalThis as GuardedGlobal;
    if (g[RUNTIME_GLOBAL_KEY] === runtime) delete g[RUNTIME_GLOBAL_KEY];
  }

  const runtime: RuntimeHandle = { buildId: BUILD_ID, isContextValid: contextValid, dispose, overlayStats: () => tab.overlayStats(), recorderDiagnostics: () => tab.recorderDiagnostics(), recordedDiagnostics: () => tab.recordedDiagnostics() };
  return runtime;
}

function safeValid(handle: RuntimeHandle): boolean {
  try {
    return handle.isContextValid();
  } catch {
    return false;
  }
}

(() => {
  const g = globalThis as GuardedGlobal;
  const existing = g[RUNTIME_GLOBAL_KEY];
  if (existing && existing.buildId === BUILD_ID && safeValid(existing)) return;
  if (existing) {
    try {
      existing.dispose();
    } catch {
      // previous runtime belonged to an invalidated context
    }
  }
  g[RUNTIME_GLOBAL_KEY] = boot();
})();
