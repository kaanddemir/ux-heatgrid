/**
 * Side-panel entry: wires the Chrome APIs into the panel app (see app.ts). Tracks the active tab
 * of its window; refreshes on tab switch and load completion.
 */
import { ensureRuntime, onEvent, request } from '../shared/client';
import { createPanelApp } from './app';

const root = document.getElementById('app')!;
let windowId: number | null = null;

const app = createPanelApp(root, {
  request,
  ensureRuntime,
  activeTab: async () => (windowId !== null ? ((await chrome.tabs.query({ active: true, windowId }))[0] ?? null) : null),
});

async function init(): Promise<void> {
  try {
    windowId = (await chrome.windows.getCurrent()).id ?? null;
  } catch {
    windowId = null;
  }
  onEvent((event, tabId) => app.onEvent(event, tabId));
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) void app.refresh();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === app.inspect().tabId && changeInfo.status === 'complete') void app.refresh();
  });
  await app.refresh();
}

app.render();
void init();
