/**
 * Minimal service worker. Owns ONLY tab-lifecycle bookkeeping:
 *  - mirrors each tab's session state into storage.session, so it can tell the panel a session
 *    ended when navigation destroys the content runtime (the runtime itself cannot)
 *  - marks sessions ended when navigation destroys the content runtime
 *  - recording continuity across full navigations: stores finalized page segments (received
 *    only at page boundaries) and resumes the recording in the next document
 *  - clears the mirror / recording when a tab closes
 * All state is in storage.session (it survives worker suspension). It runs no analysis and never
 * receives live recording data.
 */
import { BUILD_ID, CONTENT_RUNTIME_FILE, RECORDING_PORT, isRestrictedUrl } from '../shared/constants';
import { createRecordingStore } from './recordingStore';
import type { PageCaptureSegment } from '../content/recorder/segment';
import { markEnded, mirrorFromSnapshot, mirrorKey, onRuntimeGone, shouldEndOnNavigation } from '../shared/mirror';
import type { LifecycleMirror } from '../shared/model';
import { isEvent, isResponse, makeEvent, makeRequest, type EventEnvelope } from '../shared/protocol';

async function readMirror(tabId: number): Promise<LifecycleMirror | null> {
  const key = mirrorKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as LifecycleMirror | undefined) ?? null;
}

async function writeMirror(tabId: number, mirror: LifecycleMirror | null): Promise<void> {
  const key = mirrorKey(tabId);
  if (mirror) await chrome.storage.session.set({ [key]: mirror });
  else await chrome.storage.session.remove(key);
}

async function isRuntimeAlive(tabId: number): Promise<boolean> {
  try {
    const res: unknown = await chrome.tabs.sendMessage(tabId, makeRequest('PING', null), { frameId: 0 });
    return isResponse(res) && res.ok;
  } catch {
    return false;
  }
}

const store = createRecordingStore(chrome.storage.session);

async function pingBuild(tabId: number): Promise<string | null> {
  try {
    const res: unknown = await chrome.tabs.sendMessage(tabId, makeRequest('PING', null), { frameId: 0 });
    return isResponse(res) && res.ok ? (res.data as { buildId: string }).buildId : null;
  } catch {
    return null;
  }
}

/**
 * The tab has an active recording and a document finished loading: inject the runtime (using the
 * activeTab grant, which Chrome keeps for same-origin navigations) and continue the recording as
 * the next page segment. Unsupported / not permitted pages interrupt continuity (data is kept).
 */
async function continueRecording(tabId: number): Promise<void> {
  if (!(await store.meta(tabId))) return;
  const interrupt = async (): Promise<void> => {
    await store.interrupt(tabId);
    const mirror = await readMirror(tabId);
    if (mirror && shouldEndOnNavigation(mirror)) await writeMirror(tabId, markEnded(mirror, 'navigation', Date.now()));
  };
  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    return;
  }
  if (isRestrictedUrl(url)) return interrupt();
  if ((await pingBuild(tabId)) !== BUILD_ID) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_RUNTIME_FILE] });
    } catch {
      return interrupt(); // no permission here (e.g. another origin) or not scriptable
    }
  }
  const payload = await store.resumePayload(tabId);
  if (!payload) return;
  try {
    const res: unknown = await chrome.tabs.sendMessage(tabId, makeRequest('RESUME_RECORDING', payload), { frameId: 0 });
    if (!isResponse(res) || !res.ok) await interrupt();
  } catch {
    await interrupt();
  }
}

async function endIfRuntimeGone(tabId: number): Promise<void> {
  // A continuing recording is not "ended" by navigation; continueRecording handles it.
  if (await store.meta(tabId)) return;
  const mirror = await readMirror(tabId);
  if (!mirror || (mirror.state === 'ended' && !mirror.prediction)) return;
  // Same-document (SPA) navigations keep the runtime alive — only act when it's gone.
  if (await isRuntimeAlive(tabId)) return;
  const { next, sessionEnded } = onRuntimeGone(mirror, 'navigation', Date.now());
  await writeMirror(tabId, next);
  if (sessionEnded) chrome.runtime.sendMessage(makeEvent('SESSION_ENDED', { tabId, reason: 'navigation' })).catch(() => {});
}

// Mirror state pushed by content runtimes.
chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !isEvent(msg)) return;
  if (msg.type === 'STATE_CHANGED') {
    const { snapshot } = (msg as EventEnvelope<'STATE_CHANGED'>).payload;
    void writeMirror(tabId, mirrorFromSnapshot(tabId, snapshot, Date.now()));
  } else if (msg.type === 'SESSION_ENDED') {
    void readMirror(tabId).then((mirror) => {
      if (mirror && shouldEndOnNavigation(mirror)) return writeMirror(tabId, markEnded(mirror, 'navigation', Date.now()));
    });
  }
  // Events are never answered.
});

// Recording continuity: content runtimes talk to the store only at page boundaries.
chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name !== RECORDING_PORT || tabId === undefined || port.sender?.frameId !== 0) return;
  port.onMessage.addListener((m: { type?: string; sessionId?: string; startedAt?: number; segment?: PageCaptureSegment }) => {
    switch (m?.type) {
      case 'begin':
        if (typeof m.sessionId === 'string' && typeof m.startedAt === 'number') void store.begin(tabId, m.sessionId, m.startedAt);
        break;
      case 'segment':
        if (m.segment && typeof m.segment.sessionId === 'string') void store.addSegment(tabId, m.segment);
        break;
      case 'clear':
        if (typeof m.sessionId === 'string') void store.clearSession(tabId, m.sessionId);
        break;
      case 'resume-request':
        void continueRecording(tabId);
        break;
      case 'collect':
        if (typeof m.sessionId === 'string') {
          void store.collect(tabId, m.sessionId).then((data) => {
            try {
              port.postMessage({ type: 'collected', data });
            } catch {
              // the requesting document is gone
            }
          });
        }
        break;
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.status === 'complete') {
    void endIfRuntimeGone(tabId);
  }
  if (changeInfo.status === 'complete') void continueRecording(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void writeMirror(tabId, null);
  void store.clear(tabId);
});

// The toolbar icon opens the side panel directly. It goes through action.onClicked (not
// openPanelOnActionClick) because only an action click grants activeTab, which the panel needs to
// inject the runtime; sidePanel.open is called synchronously inside that user gesture.
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId === undefined) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e: unknown) => console.warn('[UX HeatGrid] side panel did not open', e));
});
