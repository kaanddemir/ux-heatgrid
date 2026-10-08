/**
 * Extension-page client for the content runtime: tab resolution, injection, typed requests,
 * and event subscription for the side panel; owns no state.
 */
import { BUILD_ID, CONTENT_RUNTIME_FILE, PANEL_PORT, isRestrictedUrl } from '../../shared/constants';
import { makeError, type HeatGridError } from '../../shared/model';
import {
  isEvent,
  isResponse,
  makeRequest,
  type EventEnvelope,
  type RequestMap,
  type RequestType,
  type Response,
} from '../../shared/protocol';

/** Sends a typed request to the tab's top-frame content runtime. Never throws. */
export async function request<T extends RequestType>(
  tabId: number,
  type: T,
  payload: RequestMap[T]['payload'],
): Promise<Response<RequestMap[T]['data']>> {
  let raw: unknown;
  try {
    raw = await chrome.tabs.sendMessage(tabId, makeRequest(type, payload), { frameId: 0 });
  } catch (e) {
    return { ok: false, error: makeError('NOT_INJECTED', errMessage(e)) };
  }
  if (!isResponse(raw)) {
    return { ok: false, error: makeError('INTERNAL', `Malformed response to ${type}`) };
  }
  return raw as Response<RequestMap[T]['data']>;
}

/** Maps chrome.scripting injection failures to typed errors. */
export function classifyInjectionError(message: string): HeatGridError {
  const m = message.toLowerCase();
  if (
    m.includes('chrome://') ||
    m.includes('extensions gallery') ||
    m.includes('cannot be scripted') ||
    m.includes('chrome-extension://') ||
    m.includes('cannot access a chrome')
  ) {
    return makeError('RESTRICTED_PAGE', message, false);
  }
  if (m.includes('cannot access contents') || m.includes('permission') || m.includes('host')) {
    return makeError('NO_PERMISSION', message);
  }
  return makeError('INTERNAL', message);
}

/**
 * Ensures the current V2 build is running in the tab. Must be called from a user action
 * (it relies on the activeTab grant). Idempotent: PING first, inject only if missing or stale.
 */
const panelPorts = new Map<number, chrome.runtime.Port>();

/**
 * Keeps one port open to the tab's runtime while this panel is open. Closing the panel closes the
 * port, which tells the runtime to hide its page visualization. Idempotent; reconnects after the
 * runtime was replaced (navigation, reinjection).
 */
export function attachPanel(tabId: number): void {
  if (panelPorts.has(tabId)) return;
  try {
    const port = chrome.tabs.connect(tabId, { name: PANEL_PORT, frameId: 0 });
    panelPorts.set(tabId, port);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // runtime gone: expected
      if (panelPorts.get(tabId) === port) panelPorts.delete(tabId);
    });
  } catch {
    // no runtime in this tab
  }
}

export async function ensureRuntime(tab: chrome.tabs.Tab): Promise<Response<{ injected: boolean }>> {
  if (tab.id === undefined) return { ok: false, error: makeError('INTERNAL', 'Tab has no id') };
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, error: makeError('RESTRICTED_PAGE', `Restricted URL: ${tab.url}`, false) };
  }

  const ping = await request(tab.id, 'PING', null);
  if (ping.ok && ping.data.buildId === BUILD_ID) return { ok: true, data: { injected: false } };

  try {
    // The runtime's guard disposes a different build before booting this one.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_RUNTIME_FILE] });
  } catch (e) {
    return { ok: false, error: classifyInjectionError(errMessage(e)) };
  }

  // executeScript resolves after the script ran, so the listener is registered — no delay needed.
  const confirm = await request(tab.id, 'PING', null);
  if (!confirm.ok) return { ok: false, error: confirm.error };
  if (confirm.data.buildId !== BUILD_ID) {
    return { ok: false, error: makeError('INTERNAL', `Runtime build mismatch: ${confirm.data.buildId}`) };
  }
  return { ok: true, data: { injected: true } };
}

/** Resolves which tab an event belongs to (content events: sender; SW events: payload). */
export function eventTabId(event: EventEnvelope, sender: chrome.runtime.MessageSender): number | null {
  if (sender.tab?.id !== undefined) return sender.tab.id;
  const p = event.payload as { tabId?: number };
  return typeof p.tabId === 'number' ? p.tabId : null;
}

/** Subscribes to protocol events; returns an unsubscribe function. */
export function onEvent(handler: (event: EventEnvelope, tabId: number | null) => void): () => void {
  const listener = (msg: unknown, sender: chrome.runtime.MessageSender): void => {
    if (!isEvent(msg)) return;
    handler(msg, eventTabId(msg, sender));
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
