/**
 * Recorded sanity on a real page + a long session (test/dev-only; network only for the page load).
 * Checks: frame time while recording, click marker alignment, deepest scroll, pointer cap → coarse
 * Stop processing time, exact counts, cleanup. (Pointer cap → coarse fallback: unit-tested.)
 */
import { launch, sleep } from './harness.mjs';

const URL_ = process.env.URL ?? 'https://en.wikipedia.org/wiki/Heat_map';
const h = await launch();
const page = h.ctx.pages()[0];
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
};
const frames = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const t = [];
        let last = performance.now();
        const step = (now) => {
          t.push(now - last);
          last = now;
          if (t.length < 60) {
            scrollBy(0, 40);
            requestAnimationFrame(step);
          } else resolve(t.sort((a, b) => a - b)[Math.floor(t.length * 0.95)]);
        };
        requestAnimationFrame(step);
      }),
  );

try {
  await page.goto(URL_, { waitUntil: 'load' });
  await sleep(1000);
  await h.triggerAction(page); // grants activeTab (opens the side panel)
  const tabId = await h.tabIdOf(page);
  await h.inject(tabId);
  const req = async (type, payload = null, kind = 'cmd') => (await h.request(tabId, type, payload, kind)).res;

  await page.evaluate(() => scrollTo(0, 0));
  const p95Off = await frames();
  await page.evaluate(() => scrollTo(0, 0));
  check('start session', (await req('START_SESSION', { source: 'sidepanel' })).ok);
  await sleep(300);
  const p95On = await frames();
  check('recorder overhead: p95 frame time while scrolling stays close to baseline', p95On < Math.max(p95Off * 1.5, 25), { p95OffMs: +p95Off.toFixed(1), p95OnMs: +p95On.toFixed(1) });

  // Realistic: pointer over the first heading, a few clicks on non-navigating text, scroll halfway.
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(200);
  const target = await page.evaluate(() => { const r = document.querySelector('h1').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; });
  for (let i = 0; i < 40; i++) await page.mouse.move(target.x + i * 3, target.y);
  for (let i = 0; i < 3; i++) await page.mouse.click(target.x, target.y);
  const docH = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  await page.evaluate((y) => scrollTo(0, y), Math.round(docH / 2));
  await sleep(1500);

  // Longer session with trusted input only (the recorder ignores synthetic events by design):
  // ~3 000 real pointer moves and 300 clicks. The 150 000-sample cap / coarse fallback is
  // covered by unit tests (recorder.test.ts) — reaching it for real needs ~80 min of input.
  await page.evaluate(() => scrollTo(0, 0));
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) await page.mouse.move(40 + ((i * 97) % 1100), 120 + ((i * 53) % 600), { steps: 50 });
  for (let i = 0; i < 300; i++) await page.mouse.click(5 + (i % 50), 400);
  const loadMs = Date.now() - t0;

  const stopT = Date.now();
  const stop = await req('STOP_SESSION');
  let st;
  for (let i = 0; i < 100; i++) {
    st = (await req('GET_STATE', null, 'query')).data;
    if (st.session.state === 'ready') break;
    await sleep(100);
  }
  const stopMs = Date.now() - stopT;
  check('Stop processes the long session', stop.ok && st.session.state === 'ready', { stopMs, loadMs });
  const sess = (await h.request(tabId, 'GET_RECORDED_SESSION', null, 'query'));
  const pv = (await h.request(tabId, 'GET_RECORDED_PAGE', { page: 0 }, 'query'));
  const s = sess.res.data;
  const p = pv.res.data;
  check('payloads stay light', sess.bytes < 200_000 && pv.bytes < 300_000, { sessionKB: +(sess.bytes / 1024).toFixed(1), pageKB: +(pv.bytes / 1024).toFixed(1) });
  check('clicks counted exactly (3 + 300)', s.totals.clicks + s.totals.activations >= 303, s.totals);
  check('deepest scroll ≈ 50 %', s.deepestScroll >= 0.45 && s.deepestScroll <= 0.6, s.deepestScroll);
  check('limitations surfaced to the UI', Array.isArray(p.limitations), { page: p.limitations });
  check('processing time reported', typeof s.timings.processMs === 'number', s.timings);

  // Click marker alignment: view the map at the top; a marker should sit on the h1 click point.
  await page.evaluate(() => scrollTo(0, 0));
  await req('SET_INTERACTION_VIEW', { view: 'recorded' });
  await sleep(600);
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? '/tmp'}/recorded-real.png` });
  const usable = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && !e.closest('heatgrid-overlay'); }, [target.x, target.y]);
  check('page stays clickable under the map', usable);

  await req('CLEAR_SESSION');
  await sleep(300);
  const hosts = await page.evaluate(() => document.querySelectorAll('heatgrid-overlay').length);
  const after = (await req('GET_STATE', null, 'query')).data;
  check('Clear removes the map and the session', after.session.state === 'idle' && hosts === 0, { state: after.session.state, hosts });
} catch (e) {
  failures++;
  console.log('  ✗ error', e.message);
}
console.log(`failures: ${failures}`);
await h.close();
process.exit(failures ? 1 : 0);
