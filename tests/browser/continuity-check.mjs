/**
 * Recording continuity check (test/dev-only). One recording across full navigations:
 * Record once on nav-a → link to nav-b (auto-resume) → reload nav-b → link to nav-c → Stop.
 */
import { launch, serveFixtures, sleep } from './harness.mjs';

const { server, origin } = await serveFixtures();
const h = await launch();
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const until = async (fn, ms = 6000) => {
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
const diag = async () => {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const id = isolated.get(frameTree.frame.id);
  if (!id) return null;
  return (await cdp.send('Runtime.evaluate', { expression: 'globalThis.__uxHeatgridV2__?.recorderDiagnostics?.() ?? null', contextId: id, returnByValue: true })).result.value ?? null;
};

let tabId;
const state = async () => (await h.request(tabId, 'GET_STATE', null, 'query').catch(() => null))?.res?.data ?? null;
const recHost = () => page.evaluate(() => document.querySelectorAll('heatgrid-rec').length);
async function interact(clicks) {
  await page.evaluate(() => scrollTo(0, 0)); // reload restores scroll; keep the action button on screen
  await sleep(100);
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(200 + i * 20, 300 + (i % 3) * 15);
    await sleep(45);
  }
  const b = await page.evaluate(() => { const r = document.getElementById('act').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  for (let i = 0; i < clicks; i++) await page.mouse.click(b.x, b.y);
}
async function followLink() {
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(100);
  const a = await page.evaluate(() => { const r = document.getElementById('next').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await Promise.all([page.waitForNavigation(), page.mouse.click(a.x, a.y)]);
}
const resumedAs = (n) => until(async () => { const s = await state(); return s?.session.state === 'recording' && s.session.recording?.segmentCount === n && s; });

try {
  await page.goto(`${origin}/nav-a.html`);
  const netBefore = h.network.length;
  const panel = await h.triggerAction(page);
  await until(() => panel.eval(`!!document.querySelector('[data-key="ov-start-record"]:not(:disabled)')`));
  tabId = await h.tabIdOf(page);
  await panel.click('button[data-key="ov-start-record"]'); // the ONLY Record press
  await until(async () => (await state())?.session.state === 'recording');
  const sessionId = (await state()).session.sessionId;
  await interact(1);

  // A → B (full navigation by link click).
  await followLink();
  const sB = await resumedAs(2);
  check('A → B: recording resumed automatically (same session, segment 2, REC shown)', !!sB && sB.session.sessionId === sessionId && (await recHost()) === 1, sB?.session.recording);
  await interact(2);
  await page.mouse.wheel(0, 600);
  await sleep(300);

  // Reload B → new document, same recording.
  await page.reload();
  const sR = await resumedAs(3);
  check('reload B: recording resumed (segment 3)', !!sR && sR.session.sessionId === sessionId, sR?.session.recording);
  await interact(1);
  const d1 = await diag();

  // B → C.
  await followLink();
  const sC = await resumedAs(4);
  check('B → C: recording resumed (segment 4); one set of listeners', !!sC && sC.session.sessionId === sessionId && (await diag())?.listeners === d1?.listeners, { recording: sC?.session.recording, listeners: (await diag())?.listeners });
  await interact(3);
  // Following a link is itself a real click: A = 1 + link, B = 2 (left by reload), B' = 1 + link, C = 3.
  check('live totals continue across pages', (await state()).session.summary.clicks === 9, (await state()).session.summary);

  // Stop.
  const t0 = Date.now();
  await h.request(tabId, 'STOP_SESSION', null);
  const done = await until(async () => { const s = await state(); return s?.session.state === 'ready' && s; });
  const stopMs = Date.now() - t0;
  const res = done?.session.result;
  check('Stop → one recording with 4 page segments; click total 9; no global scroll depth', res?.pages === 4 && res?.clicks === 9 && res?.deepestScroll === null, res);
  const d = await diag();
  const segs = d?.segments ?? [];
  console.log('    segments:', JSON.stringify(segs));
  check('every page segment survived with its own data (samples + clicks per page)', segs.length === 4 && segs.every((s) => s.samples > 0) && segs.map((s) => s.clicks).join(',') === '2,2,2,3', segs.map((s) => `${s.index}:${s.path}:${s.samples}s/${s.clicks}c`));
  check('page identity is origin + path only (no query/hash); paths per page', segs.map((s) => s.path).join(',') === '/nav-a.html,/nav-b.html,/nav-b.html,/nav-c.html');
  check('coordinates stay per page (each segment in its own document space)', segs.every((s) => s.yMin !== null && s.yMax < 2400), segs.map((s) => [s.yMin, s.yMax]));
  const total = segs.reduce((a, s) => a + s.bytes, 0);
  console.log(`    sizes: ${segs.map((s) => `${(s.bytes / 1024).toFixed(1)} KB`).join(' + ')} = ${(total / 1024).toFixed(1)} KB · Stop (collect + finalize) round trip ${stopMs} ms`);
  const store = await h.sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
  check('temporary recording storage removed after Stop', !store.some((k) => k.startsWith('rec:') || k.startsWith('seg:')), store);
  check('Prediction never ran', done.prediction.state === 'idle');
  // The test's own page navigations load HTML + CSS; nothing else may appear (no extension traffic).
  const extra = h.network.slice(netBefore).filter((u) => !/\/(nav-[abc]\.html|base\.css)$/.test(u));
  check('no network requests besides the navigations themselves', extra.length === 0, extra);
} catch (e) {
  failures++;
  console.error('FATAL', e);
} finally {
  await Promise.race([h.close(), sleep(5000)]);
  server.close();
}
console.log(`\nfailures: ${failures}`);
process.exit(failures ? 1 : 0);
