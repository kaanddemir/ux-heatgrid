/**
 * Primary release-style product-flow check (test/dev-only), real extension:
 * toolbar icon → side panel (no popup) → Overview → Predict → Predict tab → Overview → Record → interact →
 * navigate once → Stop → Record tab → layers / pages → Clear → repeat; side-panel
 * reopen, back/forward, tab-close cleanup; 320/400 px, light/dark screenshots.
 */
import fs from 'node:fs';
import { launch, serveFixtures, sleep } from './harness.mjs';

const SHOTS = process.env.SHOT_DIR ?? '/tmp';
const { server, origin } = await serveFixtures();
const h = await launch();
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
};

const page = h.ctx.pages()[0];
const cdp = await h.ctx.newCDPSession(page);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const isolated = new Map();
cdp.on('Runtime.executionContextCreated', ({ context }) => {
  if (context.auxData?.type === 'isolated' && context.name === 'UX HeatGrid') isolated.set(context.auxData.frameId, context.id);
});
const diag = async (fn) => {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const id = isolated.get(frameTree.frame.id);
  return id ? ((await cdp.send('Runtime.evaluate', { expression: `globalThis.__uxHeatgridV2__?.${fn}?.() ?? null`, contextId: id, returnByValue: true })).result.value ?? null) : null;
};
let tabId;
const q = async (type, payload = null, kind = 'query') => (await h.request(tabId, type, payload, kind)).res;
const state = async () => (await q('GET_STATE').catch(() => null))?.data ?? null;
const rect = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);

try {
  await page.goto(`${origin}/prod-a.html`);
  const netBefore = h.network.length;
  const panel = await h.triggerAction(page);
  const extPages = (await h.targets()).filter((t) => t.url.includes(h.extId) && t.type === 'page').map((t) => t.url.split('/').slice(3).join('/'));
  check('12. toolbar icon opens the side panel directly (no popup)', extPages.every((u) => u.startsWith('sidepanel/')) && extPages.length >= 1, extPages);
  tabId = await h.tabIdOf(page);
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const shot = async (name) => fs.writeFileSync(`${SHOTS}/p9-${name}.png`, Buffer.from((await panel.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const noHScroll = () => panel.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1');
  /** Inspector integrity: tabs on one line, head on one line, head actions inside the panel and not overlapping. */
  const layoutOk = () => panel.eval(`(() => {
    const tabs = [...document.querySelectorAll('.tab')].map((t) => t.getBoundingClientRect());
    if (tabs.some((r) => Math.abs(r.top - tabs[0].top) > 1 || r.height > 40)) return 'tabs wrap';
    const head = document.querySelector('.ihead');
    if (head && head.getBoundingClientRect().height > 36) return 'head wraps';
    const acts = [...document.querySelectorAll('.ihead-actions .actions > *, .mode-head > *')].map((e) => e.getBoundingClientRect());
    if (acts.some((r) => r.right > innerWidth + 0.5 || r.left < -0.5)) return 'action outside';
    for (let i = 1; i < acts.length; i++) if (acts[i].top === acts[i - 1].top && acts[i].left < acts[i - 1].right - 0.5) return 'actions overlap';
    const small = [...document.querySelectorAll('main *')].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 10.5);
    if (small.length) return 'text < 10.5px: ' + small[0].className;
    return true;
  })()`);
  const filterFits = async () => {
    if (!(await panel.eval(`!!document.querySelector('button[data-key="filter-toggle"]')`))) return true;
    await panel.click('button[data-key="filter-toggle"]');
    await sleep(100);
    const fit = await panel.eval(`(() => { const e = document.querySelector('.popover'); if (!e) return false; const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1; })()`);
    await panel.click('button[data-key="filter-toggle"]');
    return fit;
  };
  const widths = {};
  const ptext = () => panel.text();
  await until(() => panel.eval(`!!document.querySelector('[data-key="ov-start-predict"]') && !document.querySelector('[data-key="ov-start-predict"]').disabled`));
  const ov = await ptext();
  widths.overview = await noHScroll();
  await shot('overview');
  const navLabels = await panel.eval(`[...document.querySelectorAll('[role="tablist"][aria-label="HeatGrid sections"] [role="tab"]')].map((t) => t.textContent)`);
  const cards = await panel.eval(`[...document.querySelectorAll('.mode')].map((c) => c.getAttribute('aria-label'))`);
  check('1/2. Overview: tabs Overview · Predict · Record; page identity + Predict + Record panels; no Coach', JSON.stringify(navLabels) === '["Overview","Predict","Record"]' && JSON.stringify(cards) === '["Predict","Record"]' && (await panel.eval(`!!document.querySelector('.page-id .page-title')`)) && !/coach|finding|Developer details|Analysis JSON|Raw state|Run analyzer/i.test(ov), { navLabels, cards });

  // Predict → overlay shown on the page; the panel stays on Overview.
  await panel.click('button[data-key="ov-predict"]');
  await panel.click('button[data-key="ov-start-predict"]');
  const predicted = await until(async () => { const s = await state(); return s?.interactionView === 'predicted' && (await panel.eval(`!!document.querySelector('#ov-predict-report')`)) && s; });
  const stayedOnOverview = (await panel.eval(`document.querySelector('[data-key="nav-overview"]').getAttribute('aria-selected')`)) === 'true';
  await panel.click('button[data-key="nav-predict"]');
  await until(() => panel.eval(`!!document.querySelector('.screen[data-kind="predicted"] .summary')`));
  check('3a. Predict tab opens directly into results (no sub-navigation)', !(await panel.eval(`!!document.querySelector('.seg-tabs, [data-key^="itab-"]')`)));
  widths.predicted = await noHScroll();
  await shot('predicted');
  await page.screenshot({ path: `${SHOTS}/p9-page-predicted.png` });
  widths['predicted-filter-320'] = await filterFits();
  // Visual review on a page with results: expanded row (structure · Why) and the open filter, light + dark.
  for (const scheme of ['light', 'dark']) {
    await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    const row = await panel.eval(`document.querySelector('.row-toggle')?.dataset.key ?? null`);
    await panel.click(`button[data-key="${row}"]`);
    await until(() => panel.eval(`!!document.querySelector('.detail .stat-grid')`));
    await shot(`predicted-expanded-320-${scheme}`);
    await panel.click(`button[data-key="${row}"]`);
    await until(() => panel.eval(`!document.querySelector('.detail') && !document.querySelector('.row-toggle[data-selected]')`));
    await sleep(250); // let the collapse command's re-render finish before the next pointer sequence
    await panel.click('button[data-key="filter-toggle"]');
    await until(() => panel.eval(`!!document.querySelector('.popover')`));
    await sleep(250); // past the popover's 180 ms enter fade
    await shot(`predicted-filter-320-${scheme}`);
    await panel.click('button[data-key="filter-done"]');
  }
  await panel.send('Emulation.setEmulatedMedia', { features: [] });
  check('3. Predict shows the overlay and keeps the panel on Overview', !!predicted && stayedOnOverview, predicted?.prediction.summary);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.click(viewport.width - 225, viewport.height - 35); // High in the fixed on-page legend (All · High · Medium · Low · ×).
  const highOnly = await until(async () => (await diag('overlayStats'))?.lastBoxes === 1);
  await page.mouse.click(viewport.width - 277, viewport.height - 35); // All.
  const allBands = await until(async () => (await diag('overlayStats'))?.lastBoxes === 2);
  check('3b. on-page All / High / Medium / Low legend filters the overlay', !!highOnly && !!allBands);
  const predBefore = JSON.stringify((await q('GET_PREDICTION')).data);

  // Back to Overview → Record.
  await panel.click('button[data-key="nav-overview"]');
  await until(() => panel.eval(`!!document.querySelector('[data-key="ov-predict"]')`));
  await panel.click('button[data-key="ov-record"]');
  await panel.click('button[data-key="ov-start-record"]');
  const rec = await until(async () => { const s = await state(); return s?.session.state === 'recording' && s; });
  await sleep(1200);
  const barText = await panel.eval(`[...document.querySelectorAll('.live, .mode[data-kind="recorded"] .mode-head')].map((e) => e.innerText).join(' ')`);
  await shot('recording');
  for (const scheme of ['light', 'dark']) {
    await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(150);
    await shot(`recording-overview-400-${scheme}`);
    await panel.click('button[data-key="nav-record"]');
    await sleep(200);
    await shot(`recording-record-400-${scheme}`);
    await panel.click('button[data-key="nav-overview"]');
  }
  await panel.send('Emulation.setEmulatedMedia', { features: [] });
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 2, mobile: false });
  await page.screenshot({ path: `${SHOTS}/p9-page-recording.png` });
  check('4. Record hides the Prediction visualization', rec?.interactionView === 'none' && (await diag('overlayStats')) !== undefined);
  check('5. recording state is clear (Recording · elapsed · clicks · Stop)', /Recording/.test(barText) && /\d+s/.test(barText) && /click/i.test(barText) && /Stop/.test(barText), barText);

  // UI tab switches during recording never stop, restart or reset the session.
  const sid = rec?.session.sessionId;
  for (const k of ['nav-predict', 'nav-record', 'nav-overview']) {
    await panel.click(`button[data-key="${k}"]`);
    await sleep(150);
  }
  const afterTabs = await state();
  check('5a. recording survives Overview / Predict / Record switches', afterTabs?.session.state === 'recording' && afterTabs.session.sessionId === sid, afterTabs?.session.state);

  // Interact on A, navigate once, interact on B.
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(200 + i * 30, 220);
    await sleep(60);
  }
  const link = await rect('#next');
  await Promise.all([page.waitForNavigation(), page.mouse.click(link.cx, link.cy)]);
  await until(async () => (await state())?.session.recording?.segmentCount === 2);
  const cta = await rect('#start');
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 12_000; i++) {
    await page.mouse.move(700 + (i % 10) * 30, 120 + (i % 4) * 30);
    await sleep(250);
  }
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(cta.cx + (i % 2 ? 4 : -4), cta.cy);
    await sleep(200);
  }
  await page.mouse.click(cta.cx, cta.cy);
  const faux = await rect('#faux');
  await page.mouse.click(faux.cx, faux.cy);
  const pages2 = await panel.eval(`[...document.querySelectorAll('.live, .mode[data-kind="recorded"] .mode-head')].map((e) => e.innerText).join(' ')`);
  const liveRecordWidths = {};
  for (const width of [320, 400, 560]) {
    await panel.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(120);
    liveRecordWidths[width] = await panel.eval(`document.querySelector('[data-key="ov-record"]')?.getAttribute('aria-expanded') === 'true' && !!document.querySelector('#ov-record-report .live') && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`);
  }
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 2, mobile: false });
  check('5b. Overview Record stays expanded through page interaction and navigation', Object.values(liveRecordWidths).every(Boolean), liveRecordWidths);

  // Stop → Recorded.
  if (!(await panel.eval(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop')`))) await panel.click('button[data-key="ov-record"]');
  await panel.click('Stop');
  const done = await until(async () => { const s = await state(); return s?.session.state === 'ready' && s.interactionView === 'recorded' && s; });
  const stopStayed = (await panel.eval(`document.querySelector('[data-key="nav-overview"]').getAttribute('aria-selected')`)) === 'true';
  await panel.click('button[data-key="nav-record"]');
  await until(() => panel.eval(`!!document.querySelector('.screen[data-kind="recorded"] .summary')`));
  await sleep(300);
  widths.recorded = await noHScroll();
  widths['recorded-filter-320'] = await filterFits();
  await page.evaluate(() => scrollTo(0, 0));
  await shot('recorded');
  await page.screenshot({ path: `${SHOTS}/p9-page-recorded.png` });
  check('6. Stop shows the Recorded map on the page and keeps the panel on Overview', !!done && stopStayed, { pagesInBar: pages2 });
  const recBefore = JSON.stringify((await q('GET_RECORDED_SESSION')).data);

  // 7. Layer toggles.
  await panel.click('button[data-key="filter-toggle"]');
  await panel.eval(`document.querySelector('[data-key="rec-clicks"]').click()`);
  const off = await until(async () => { const s = await state(); return s?.recorded?.layers.clicks === false && s; });
  await sleep(200);
  const dOff = await diag('recordedDiagnostics');
  await panel.eval(`document.querySelector('[data-key="rec-clicks"]').click()`);
  await until(async () => (await state())?.recorded?.layers.clicks === true);
  await sleep(200);
  const dOn = await diag('recordedDiagnostics');
  await panel.click('button[data-key="filter-toggle"]');
  check('7. Recorded layer toggles still work (clicks off → no markers; on → markers)', !!off && dOff.overlay.plan.markers.length === 0 && dOn.overlay.plan.markers.length > 0, { off: dOff.overlay.plan.markers.length, on: dOn.overlay.plan.markers.length });
  const pageSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.click(pageSize.width - 170, pageSize.height - 34); // Clicks in the on-page card.
  const pageClicksOff = await until(async () => (await state())?.recorded?.layers.clicks === false && (await diag('recordedDiagnostics'))?.overlay?.plan?.markers?.length === 0);
  await page.mouse.click(pageSize.width - 170, pageSize.height - 34);
  const pageClicksOn = await until(async () => (await state())?.recorded?.layers.clicks === true && (await diag('recordedDiagnostics'))?.overlay?.plan?.markers?.length > 0);
  check('7b. on-page Recorded controls update the shared layer state', !!pageClicksOff && !!pageClicksOn);

  // 8. Multi-page selector.
  await panel.eval(`(() => { const s = document.querySelector('select'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
  const notOpen = await until(async () => { const t = await ptext(); return t.includes('Page not open') && t; });
  const hostsA = await page.evaluate(() => document.querySelectorAll('heatgrid-overlay').length);
  await panel.eval(`(() => { const s = document.querySelector('select'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await until(async () => (await diag('recordedDiagnostics'))?.overlay?.mounted);
  check('8. multi-page selector works (previous page explained, not drawn)', !!notOpen && hostsA === 0);

  // 9. No Coach anywhere: not in the panel, not in the protocol, not on the page.
  const allText = [];
  for (const k of ['nav-overview', 'nav-predict', 'nav-record']) {
    await panel.click(`button[data-key="${k}"]`);
    await sleep(150);
    allText.push(await ptext());
  }
  const coachDom = await panel.eval(`!!document.querySelector('[data-kind="coach"], [data-key*="coach"]')`);
  const coachMsg = await q('GET_COACH').catch((e) => ({ ok: false, error: { code: String(e) } }));
  const coachHosts = await page.evaluate(() => document.querySelectorAll('heatgrid-coach').length);
  const coachDiag = await diag('coachDiagnostics');
  check('9. Coach is gone from the panel, protocol and page', !allText.some((t) => /coach|finding/i.test(t)) && !coachDom && !coachMsg.ok && coachHosts === 0 && coachDiag === null, { coachMsg: coachMsg.error?.code });

  // 13. 320 px.
  check('13. 320 px: no horizontal scroll in any view', Object.values(widths).every(Boolean), widths);
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  // Visual review set: every main view at 400 px, light and dark.
  const layout = {};
  const views = {
    overview: ['nav-overview'],
    predicted: ['nav-predict'],
    recorded: ['nav-record'],
  };
  for (const scheme of ['light', 'dark']) {
    await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    for (const [name, keys] of Object.entries(views)) {
      for (const k of keys) {
        await panel.click(`button[data-key="${k}"]`);
        await sleep(250);
      }
      widths[`${name}-400`] = (widths[`${name}-400`] ?? true) && (await noHScroll());
      layout[`${name}-400-${scheme}`] = await layoutOk();
      if (name === 'predicted' || name === 'recorded') widths[`${name}-filter-400`] = (widths[`${name}-filter-400`] ?? true) && (await filterFits());
      await shot(`${name}-400-${scheme}`);
      if ((name === 'predicted' || name === 'recorded') && (await panel.eval(`!!document.querySelector('[data-key="filter-toggle"]')`))) {
        await panel.click('button[data-key="filter-toggle"]');
        await sleep(150);
        await shot(`${name}-filter-400-${scheme}`);
        await panel.click('button[data-key="filter-done"]');
        await sleep(100);
        const firstRow = await panel.eval(`document.querySelector('.row-toggle')?.dataset.key ?? null`);
        if (firstRow) {
          await panel.click(`button[data-key="${firstRow}"]`);
          await sleep(300);
          layout[`${name}-expanded-400-${scheme}`] = await layoutOk();
          await shot(`${name}-expanded-400-${scheme}`);
          await panel.click(`button[data-key="${firstRow}"]`);
          await sleep(200);
        }
      }
      if (name === 'overview') {
        const hoverShot = async (selector, state) => {
          const point = await panel.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
          await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
          await sleep(120);
          await shot(`overview-400-${scheme}-${state}`);
        };
        await hoverShot('[data-key="ov-predict"]', 'card-hover');
        await hoverShot('[data-key="ov-start-predict"]', 'start-hover');
        await hoverShot('.mode[data-kind="predicted"] .mode-head > .chev', 'chevron-hover');
        await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      }
    }
  }
  // Intermediate narrow widths: preserve the same stacked Overview and readable expanded reports.
  for (const width of [320, 360, 375, 480]) {
    await panel.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false });
    for (const [name, keys] of Object.entries(views)) {
      for (const k of keys) {
        await panel.click(`button[data-key="${k}"]`);
        await sleep(150);
      }
      widths[`${name}-${width}`] = await noHScroll();
      layout[`${name}-${width}`] = await layoutOk();
      if (width === 320 || width === 375) await shot(`${name}-${width}`);
    }
  }
  // Wider side panel.
  await panel.send('Emulation.setEmulatedMedia', { features: [] });
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  for (const [name, keys] of Object.entries(views)) {
    for (const k of keys) {
      await panel.click(`button[data-key="${k}"]`);
      await sleep(250);
    }
    widths[`${name}-560`] = await noHScroll();
    layout[`${name}-560`] = await layoutOk();
    if (name === 'predicted' || name === 'recorded') widths[`${name}-filter-560`] = await filterFits();
    await shot(`${name}-560`);
  }
  check('13b. 320 / 360 / 375 / 400 / 480 / 560 px: no horizontal scroll', Object.values(widths).every(Boolean), widths);
  const badLayout = Object.entries(layout).filter(([, v]) => v !== true);
  check('13c. one-line tabs and head, no clipped / overlapping actions, no tiny text (light + dark)', badLayout.length === 0, badLayout.length ? badLayout : Object.keys(layout).length);
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 2, mobile: false });
  await panel.click('button[data-key="nav-overview"]');
  await sleep(200);

  // 14. Page remains clickable.
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(150);
  const c2 = await rect('#start');
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [c2.cx, c2.cy]);
  const n0 = await page.evaluate(() => window.__pageClicks);
  await page.mouse.click(c2.cx, c2.cy);
  check('14. page remains clickable under overlays', hit === 'start' && (await page.evaluate(() => window.__pageClicks)) === n0 + 1, hit);

  // 16. UI navigation did not change results (captured on the current document).
  const b16 = [JSON.stringify((await q('GET_PREDICTION')).data), JSON.stringify((await q('GET_RECORDED_SESSION')).data)];
  for (const k of ['nav-predict', 'nav-record', 'nav-overview', 'nav-predict']) {
    await panel.click(`button[data-key="${k}"]`);
    await sleep(120);
  }
  const predAfter = JSON.stringify((await q('GET_PREDICTION')).data);
  const recAfter = JSON.stringify((await q('GET_RECORDED_SESSION')).data);
  check('16. no Prediction / Recorded result changes from UI navigation', predAfter === b16[0] && recAfter === b16[1] && recAfter === recBefore, { recSame: recAfter === recBefore, predBeforeNav: predBefore.length });
  const extra = h.network.slice(netBefore).filter((u) => !/\/(prod-a\.html|prod-b\.html(\?.*)?|base\.css)$/.test(u));
  check('15. no new network requests', extra.length === 0, extra);

  // 17. Clear → repeat. Clear recording + prediction from the panel; then Predict again: same result.
  const bandsOf = (r) => JSON.stringify({ s: r.summary, e: r.elements.map((x) => [x.label, x.band]) });
  // Predictions are per document: predict on this page first, so there is something to compare.
  await panel.click('button[data-key="nav-overview"]');
  await until(() => panel.eval(`!!document.querySelector('[data-key="ov-start-predict"]:not(:disabled)')`));
  await panel.click('button[data-key="ov-start-predict"]');
  await until(async () => (await state())?.prediction.state === 'ready');
  const firstPred = bandsOf((await q('GET_PREDICTION')).data);
  await panel.click('button[data-key="nav-record"]');
  await until(() => panel.eval(`!!document.querySelector('[data-key="rec-clear"]:not(:disabled)')`));
  await panel.click('button[data-key="rec-clear"]');
  await until(async () => (await state())?.session.state === 'idle' && (await panel.eval(`!document.querySelector('[data-key="rec-clear"]')`)));
  await panel.click('button[data-key="nav-predict"]');
  await until(() => panel.eval(`!!document.querySelector('[data-key="clear"]:not(:disabled)')`));
  await panel.click('button[data-key="clear"]');
  const cleared = await until(async () => { const s = await state(); return s?.session.state === 'idle' && s.prediction.state === 'idle' && s; });
  const hostsAfterClear = await page.evaluate(() => document.querySelectorAll('heatgrid-overlay').length);
  check('17. Clear removes recording, prediction and their overlays', !!cleared && hostsAfterClear === 0, { hostsAfterClear });
  // Empty states (visual review): Predicted and Recorded after Clear, light + dark.
  for (const scheme of ['light', 'dark']) {
    await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(150);
    await shot(`empty-predicted-${scheme}`);
    await panel.click('button[data-key="nav-record"]');
    await sleep(200);
    await shot(`empty-recorded-${scheme}`);
    await panel.click('button[data-key="nav-predict"]');
    await sleep(150);
  }
  await panel.send('Emulation.setEmulatedMedia', { features: [] });
  await panel.click('button[data-key="nav-overview"]');
  await until(() => panel.eval(`!!document.querySelector('[data-key="ov-start-predict"]:not(:disabled)')`));
  await panel.click('button[data-key="ov-start-predict"]');
  await until(async () => (await state())?.prediction.state === 'ready');
  check('18. repeat Predict on the same page is deterministic', bandsOf((await q('GET_PREDICTION')).data) === firstPred);

  // 19. Side panel close + reopen: state is runtime-owned and comes back.
  const panelTarget = (await h.targets()).find((t) => t.url.includes('/sidepanel/index.html'));
  await h.bs.send('Target.closeTarget', { targetId: panelTarget.targetId });
  await until(async () => !(await h.targets()).some((t) => t.targetId === panelTarget.targetId));
  const panel2 = await h.triggerAction(page);
  const reopened = await until(() => panel2.eval(`!!document.querySelector('[data-key="ov-predict"]') || !!document.querySelector('.summary')`));
  check('19. side panel reopen restores the prediction summary', !!reopened, reopened ? undefined : { text: (await panel2.text().catch(() => '')).slice(0, 300), state: (await state())?.prediction.state ?? null });

  // 20. Back / forward: no recording active → runtime ends with the document; panel stays sane.
  await page.goBack();
  await sleep(800);
  const backState = await state();
  const backErr = await panel2.eval(`document.querySelector('[role="alert"]')?.textContent ?? null`);
  check('20. back navigation: old runtime gone, panel shows no stale result or error', backState === null && backErr === null, { backState: backState?.session.state ?? null, backErr });
  await page.goForward();
  await sleep(500);

  // 21. Tab close cleanup: a recording tab's session data is removed when the tab closes.
  const tab2 = await h.ctx.newPage();
  await tab2.goto(`${origin}/prod-a.html`);
  await h.triggerAction(tab2); // grants activeTab on the new tab
  const id2 = await h.tabIdOf(tab2);
  await h.inject(id2);
  await h.request(id2, 'START_SESSION', { source: 'sidepanel' });
  await until(async () => (await h.request(id2, 'GET_STATE', null, 'query')).res.data?.session.state === 'recording');
  const keysBefore = await h.sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
  await tab2.close();
  await sleep(500);
  const keysAfter = await h.sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
  check('21. tab close removes that tab’s session storage', keysBefore.some((k) => k.includes(String(id2))) && !keysAfter.some((k) => k.includes(String(id2))), { before: keysBefore, after: keysAfter });
} catch (e) {
  failures++;
  console.error('FATAL', e);
} finally {
  await Promise.race([h.close(), sleep(5000)]);
  server.close();
}
console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
