/**
 * Real-browser validation harness (test/dev-only; not part of the build or unit tests).
 *
 * Loads dist/ as an unpacked extension into Chrome for Testing via Playwright, serves
 * tests/browser/fixtures over http://127.0.0.1, grants activeTab through the REAL toolbar action
 * (CDP Extensions.triggerAction — which opens the side panel), and drives it through a CDP
 * target tunnel with trusted Input events.
 *
 * Requirements (not project dependencies):
 *   PLAYWRIGHT_DIR  directory containing the `playwright` package (e.g. an npx cache)
 *   CHROME_PATH     Chrome for Testing / Chromium binary (branded Chrome ignores --load-extension)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const DIST = path.join(ROOT, 'dist');
const FIXTURES = path.join(here, 'fixtures');

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(process.env.PLAYWRIGHT_DIR ?? '', 'playwright'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function serveFixtures() {
  const types = { '.html': 'text/html', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(FIXTURES, path.normalize(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** Tunnel to a target (side panel) using the browser-level CDP session. */
class TargetTunnel {
  constructor(bs, sessionId) {
    this.bs = bs;
    this.sessionId = sessionId;
    this.nextId = 1;
    this.pending = new Map();
    bs.on('Target.receivedMessageFromTarget', (e) => {
      if (e.sessionId !== sessionId) return;
      const msg = JSON.parse(e.message);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    void this.bs.send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) });
    return done;
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  /** Trusted click (real user gesture) on the first element matching `selector`. */
  async click(selector) {
    const box = await this.eval(`(() => { const b = [...document.querySelectorAll('button')].find(e => e.matches(${JSON.stringify(selector)}) || e.textContent.trim() === ${JSON.stringify(selector)});
      if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled }; })()`);
    if (!box) throw new Error(`no button ${selector}`);
    if (box.disabled) throw new Error(`button ${selector} is disabled`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }
  text() {
    return this.eval('document.body.innerText');
  }
}

/** `extraArgs`: extra Chrome flags; `contextOptions`: Playwright context overrides (e.g. viewport, deviceScaleFactor). */
export async function launch({ extraArgs = [], contextOptions = {} } = {}) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-validate-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true,
    executablePath: process.env.CHROME_PATH,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--enable-unsafe-extension-debugging', ...extraArgs],
    ...contextOptions,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const bs = await ctx.browser().newBrowserCDPSession();
  await bs.send('Target.setDiscoverTargets', { discover: true });
  const network = [];
  ctx.on('request', (r) => network.push(r.url()));

  const h = {
    ctx,
    bs,
    extId,
    network,
    get sw() {
      return ctx.serviceWorkers().find((w) => w.url().includes(extId)) ?? sw;
    },
    async targets() {
      return (await bs.send('Target.getTargets', { filter: [{}] })).targetInfos;
    },
    async attach(urlPart, type = 'page', timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const t = (await h.targets()).find((x) => x.type === type && x.url.includes(urlPart));
        if (t) {
          const { sessionId } = await bs.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
          const tunnel = new TargetTunnel(bs, sessionId);
          await tunnel.eval('new Promise(r => document.readyState === "complete" ? r() : addEventListener("load", r))');
          return tunnel;
        }
        await sleep(100);
      }
      throw new Error(`target ${urlPart} not found`);
    },
    /** Presses the real toolbar icon for `page`: grants activeTab and opens the side panel (returned). */
    async triggerAction(page) {
      const url = page.url();
      const tab = (await h.targets()).find((t) => t.type === 'tab' && t.url === url);
      if (!tab) throw new Error(`no tab target for ${url}`);
      // A click in the first moments after install can be dropped (observed only right after
      // launch); a real user would click again — so does the harness, up to 3 times.
      let panel = null;
      for (let attempt = 0; attempt < 3 && !panel; attempt++) {
        await bs.send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });
        panel = await h.attach('/sidepanel/index.html', 'page', 2000).catch(() => null);
      }
      if (!panel) throw new Error('side panel did not open from the toolbar icon');
      await panel.eval(`new Promise((r) => { const t = () => (document.querySelector('[data-key="nav-overview"]') ? r() : setTimeout(t, 50)); t(); })`);
      return panel;
    },
    async tabIdOf(page) {
      const url = page.url();
      return h.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
    },
    /** Sends a protocol request to a tab's content runtime from the service worker (extension context). */
    async request(tabId, type, payload, kind = 'cmd') {
      return h.sw.evaluate(
        async ([tabId, type, payload, kind]) => {
          const t0 = performance.now();
          const res = await chrome.tabs.sendMessage(tabId, { v: 3, kind, type, requestId: `val-${Math.random()}`, payload }, { frameId: 0 });
          return { res, roundTripMs: performance.now() - t0, bytes: JSON.stringify(res).length };
        },
        [tabId, type, payload, kind],
      );
    },
    async inject(tabId) {
      return h.sw.evaluate(async (tabId) => {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content/runtime.js'] });
          return 'ok';
        } catch (e) {
          return `err: ${e.message}`;
        }
      }, tabId);
    },
    async close() {
      await ctx.close();
    },
  };
  return h;
}

/** Page-side (main world) snapshot used for the read-only check. */
export const PAGE_SNAPSHOT = () => {
  const els = [...document.querySelectorAll('*')];
  const rects = els.map((e) => {
    const r = e.getBoundingClientRect();
    return `${r.x},${r.y},${r.width},${r.height}`;
  });
  const values = [...document.querySelectorAll('input, textarea, select')].map((e) => e.value);
  return {
    html: document.documentElement.outerHTML,
    nodeCount: els.length,
    classes: els.map((e) => e.className && typeof e.className === 'string' ? e.className : '').join('|'),
    styles: els.map((e) => e.getAttribute('style') ?? '').join('|'),
    scroll: [scrollX, scrollY],
    active: document.activeElement?.id || document.activeElement?.tagName,
    values,
    rects: rects.join(';'),
  };
};
