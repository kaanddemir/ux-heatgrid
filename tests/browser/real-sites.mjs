/**
 * Real-site calibration sweep (test/dev-only; needs network for the page loads only — the
 * extension itself makes no requests). Grants activeTab through the real toolbar action, then
 * runs Prediction and page facts and prints a compact report per site.
 * Usage: SITES=url1,url2 node tests/browser/real-sites.mjs   (defaults to a diverse set)
 */
import fs from 'node:fs';
import { launch, sleep } from './harness.mjs';

const SHOTS = process.env.SHOT_DIR ?? '/tmp';
const DEFAULT = [
  ['saas', 'https://linear.app/'],
  ['docs', 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/button'],
  ['app', 'https://github.com/microsoft/vscode'],
  ['shop', 'https://books.toscrape.com/'],
  ['article', 'https://en.wikipedia.org/wiki/Heat_map'],
  ['form', 'https://httpbin.org/forms/post'],
  ['content', 'https://paulgraham.com/articles.html'],
  ['densenav', 'https://news.ycombinator.com/'],
  ['landing', 'https://www.apple.com/'],
  ['news', 'https://www.bbc.com/news'],
];
const sites = process.env.SITES ? process.env.SITES.split(',').map((u, i) => [`site${i}`, u]) : DEFAULT;

const h = await launch();
const page = h.ctx.pages()[0];
const out = [];
for (const [kind, url] of sites) {
  const row = { kind, url };
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await sleep(1500);
    await h.triggerAction(page); // grants activeTab (opens the side panel)
    const tabId = await h.tabIdOf(page);
    row.inject = await h.inject(tabId);
    const t0 = Date.now();
    const run = await h.request(tabId, 'RUN_PREDICTION', { source: 'sidepanel' });
    row.predictWallMs = Date.now() - t0;
    if (!run.res.ok) throw new Error(`predict: ${run.res.error?.code} ${run.res.error?.message}`);
    const sum = await h.request(tabId, 'GET_PREDICTION', null, 'query');
    const r = sum.res.data;
    row.summaryKB = +(sum.bytes / 1024).toFixed(1);
    row.dist = r.summary;
    row.timings = r.timings;
    const label = (e) => `${e.label ?? e.tagName}`.slice(0, 40);
    row.high = r.elements.filter((e) => e.band === 'high').slice(0, 10).map(label);
    row.mediumN = r.elements.filter((e) => e.band === 'medium').length;
    await page.screenshot({ path: `${SHOTS}/site-${kind}.png` });
    await h.request(tabId, 'CLEAR_PREDICTION', null);
  } catch (e) {
    row.error = String(e.message ?? e).slice(0, 200);
  }
  out.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(`${SHOTS}/real-sites.json`, JSON.stringify(out, null, 1));
await h.close();
