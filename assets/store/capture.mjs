// Captures REAL HeatGrid UI for the store images: loads dist/ into Chrome for Testing, opens the
// side panel through the real toolbar action, runs Predict and a real Record session on the demo
// page, and saves page + panel screenshots to assets/store/captures/. Nothing is drawn or edited.
// Usage: npm run build && PLAYWRIGHT_DIR=… CHROME_PATH=… node assets/store/capture.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../../tests/browser/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'captures');
fs.mkdirSync(OUT, { recursive: true });
const DEMO = path.join(here, 'demo');
const server = http.createServer((req, res) => {
  const file = path.join(DEMO, 'index.html');
  res.setHeader('content-type', 'text/html');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// Reserved example hostname (RFC 2606) mapped to the local server, so the panel shows a clean domain.
const HOST = 'fieldnote.example';
const origin = `http://${HOST}`;

const PAGE_W = 1080, PAGE_H = 704, PANEL_W = 400, PANEL_H = 820, DSF = 2;
const h = await launch({
  extraArgs: [`--host-resolver-rules=MAP ${HOST}:80 127.0.0.1:${server.address().port}`],
  contextOptions: { viewport: { width: PAGE_W, height: PAGE_H }, deviceScaleFactor: DSF },
});
try {
  const page = h.ctx.pages()[0];
  await page.goto(`${origin}/`);
  const panel = await h.triggerAction(page);
  await panel.send('Emulation.setDeviceMetricsOverride', { width: PANEL_W, height: PANEL_H, deviceScaleFactor: DSF, mobile: false });
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(80); } throw new Error('timeout'); };
  const has = (sel) => panel.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
  const settle = () => sleep(450);
  const shotPanel = async (name) => { await settle(); fs.writeFileSync(path.join(OUT, `${name}-panel.png`), Buffer.from((await panel.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  const shotPage = async (name) => { await settle(); await page.screenshot({ path: path.join(OUT, `${name}-page.png`) }); };
  const expand = async (key) => { if ((await panel.eval(`document.querySelector('[data-key="${key}"]')?.getAttribute('aria-expanded')`)) !== 'true') await panel.click(`button[data-key="${key}"]`); };

  // Predict (structure only — no recording data involved).
  await expand('ov-predict');
  await panel.click('button[data-key="ov-start-predict"]');
  await until(() => panel.eval(`document.querySelector('[data-key="ov-start-predict"]') === null || document.body.innerText.includes('High')`));
  await sleep(600);
  await panel.click('button[data-key="nav-predict"]');
  await until(() => has('.screen[data-kind="predicted"]'));
  await shotPanel('predict');
  await shotPage('predict');
  // Predict, one result expanded ("Why" + evidence) and shown on the page.
  const predRow = await panel.eval(`document.querySelector('.row-toggle')?.dataset.key ?? null`);
  if (predRow) { await panel.click(`button[data-key="${predRow}"]`); await until(() => has('.detail')); await shotPanel('predict-detail'); await shotPage('predict-detail'); await panel.click(`button[data-key="${predRow}"]`); await sleep(300); }

  // Record a real session on the page with trusted input.
  await panel.click('button[data-key="nav-overview"]');
  await expand('ov-record');
  await panel.click('button[data-key="ov-start-record"]');
  await until(() => panel.eval(`document.body.innerText.includes('Recording')`));
  const box = async (sel) => (await page.locator(sel).first().boundingBox());
  const glide = async (sel, dwell = 900, click = false) => {
    const b = await box(sel); if (!b) return;
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x - 40, y + 30, { steps: 12 });
    await page.mouse.move(x, y, { steps: 10 });
    await sleep(dwell);
    if (click) await page.mouse.click(x, y);
    await sleep(250);
  };
  await glide('h1', 1200);
  await glide('#trial', 1600, true);
  await glide('#demo', 700);
  await glide('#trial', 900, true);
  await glide('.nav nav a:nth-child(2)', 800, true);
  await page.mouse.wheel(0, 640); await sleep(900);
  await glide('.features .card:nth-child(2) a', 1000, true);
  await glide('.features .card:nth-child(1) h3', 700);
  await page.mouse.wheel(0, 520); await sleep(900);
  await glide('.pricing .card:nth-child(2) .btn', 1500, true);
  await glide('.pricing .card:nth-child(3) .btn', 700);
  await page.mouse.wheel(0, -1400); await sleep(900);
  await glide('#trial', 1200, true);
  await sleep(1200);
  await shotPanel('recording');
  const tabId = await h.tabIdOf(page);
  const session = async () => (await h.request(tabId, 'GET_STATE', null, 'query')).res.data.session.state;
  await panel.click('Stop');
  await until(async () => (await session()) === 'ready', 15000);
  await sleep(800);
  await page.evaluate(() => scrollTo(0, 0)); await sleep(500);
  await panel.click('button[data-key="nav-record"]');
  await until(() => has('.screen[data-kind="recorded"] .summary'));
  await shotPanel('record');
  await shotPage('record');
  // Record, one interacted element expanded and outlined on the page.
  const recRow = await panel.eval(`document.querySelector('.screen[data-kind="recorded"] .row-toggle')?.dataset.key ?? null`);
  if (recRow) { await panel.click(`button[data-key="${recRow}"]`); await until(() => has('.detail')); await page.evaluate(() => scrollTo(0, 0)); await shotPanel('record-detail'); await shotPage('record-detail'); }

  // Overview with both results, clean page.
  await panel.click('button[data-key="nav-overview"]');
  await sleep(300);
  await expand('ov-predict');
  await expand('ov-record');
  await shotPanel('overview');
  await h.request(tabId, 'SET_INTERACTION_VIEW', { view: 'none' });
  await page.evaluate(() => scrollTo(0, 0));
  await shotPage('overview');
  console.log('captures:', fs.readdirSync(OUT).join(' '));
} finally {
  await h.close();
  server.close();
}
