// Composes the four Chrome Web Store screenshots from the REAL captures in assets/store/captures/
// (run capture.mjs first). Layout and copy only; the UI itself is never redrawn.
// Renders at 2× into <out>/2560x1600/ and a downsampled store upload into <out>/1280x800/.
// Usage: PLAYWRIGHT_DIR=… CHROME_PATH=… node assets/store/compose.mjs [outDir]  (default: assets/store/final)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const CAP = path.join(here, 'captures');
const OUT = path.resolve(process.argv[2] ?? path.join(here, 'final'));
const BIG = path.join(OUT, '2560x1600'), STORE = path.join(OUT, '1280x800');
for (const d of [BIG, STORE]) fs.mkdirSync(d, { recursive: true });
const { chromium } = createRequire(import.meta.url)(path.join(process.env.PLAYWRIGHT_DIR ?? '', 'playwright'));
const img = (name) => `data:image/png;base64,${fs.readFileSync(path.join(CAP, name)).toString('base64')}`;
const mark = `data:image/png;base64,${fs.readFileSync(path.join(here, '../brand/icon-512.png')).toString('base64')}`;

const BLUE = '#397BFA', CORAL = '#FF6B57';
const css = `
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1280px; height: 800px; overflow: hidden; }
  body { position: relative; isolation: isolate; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    background: radial-gradient(120% 95% at 15% 0%, #1A2333 0%, #11151D 45%, #0B0D12 100%); }
  .bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; }
  .glow { position: absolute; border-radius: 50%; filter: blur(110px); }
  .dots { position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.08) 1.2px, transparent 1.3px); background-size: 24px 24px;
    -webkit-mask-image: radial-gradient(85% 75% at 25% 35%, #000 0%, transparent 75%); }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 25px; letter-spacing: -.01em; }
  .brand img { width: 48px; height: 48px; margin: -2px; }
  h1 { font-size: 54px; line-height: 1.06; font-weight: 800; letter-spacing: -.03em; }
  h1 em { font-style: normal; }
  p.sub { font-size: 21px; line-height: 1.45; color: rgba(255,255,255,.72); margin-top: 20px; }
  .shot { position: absolute; border-radius: 16px; overflow: hidden; background-repeat: no-repeat; background-position: top left;
    box-shadow: 0 40px 90px -20px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.12); }
  .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 28px; }
  .chips span { display: inline-flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.04); border-radius: 999px; padding: 8px 16px; font-size: 16px; font-weight: 600; }
  .chips i { width: 9px; height: 9px; border-radius: 3px; }
  .feat { list-style: none; padding: 0; margin-top: 34px; display: flex; flex-direction: column; gap: 20px; }
  .feat li { position: relative; padding-left: 28px; }
  .feat li::before { content: ""; position: absolute; left: 0; top: 7px; width: 11px; height: 11px; border-radius: 3px; background: var(--c); }
  .feat b { display: block; font-size: 21px; }
  .feat span { display: block; font-size: 17px; color: rgba(255,255,255,.68); margin-top: 3px; }
`;

/** Brand motif: a faint heat grid along the bottom edge, a few cells warmed in blue and coral. */
function heatStrip(seed) {
  let s = seed; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  let cells = '';
  for (let r = 0; r < 4; r++) for (let c = 0; c < 46; c++) {
    const x = 8 + c * 28, y = 690 + r * 28, v = rnd();
    const fill = v > 0.94 ? CORAL : v > 0.82 ? BLUE : '#FFFFFF';
    const op = v > 0.94 ? 0.55 : v > 0.82 ? 0.38 : 0.05;
    cells += `<rect x="${x}" y="${y}" width="20" height="20" rx="5" fill="${fill}" fill-opacity="${op}"/>`;
  }
  return `<svg viewBox="0 0 1280 800" style="position:absolute;inset:0;width:100%;height:100%;-webkit-mask-image:linear-gradient(180deg,transparent 82%,#000 92%)">${cells}</svg>`;
}
const bg = (seed, glows) => `<div class="bg">${glows.map(([c, x, y, s, o]) => `<div class="glow" style="left:${x}px;top:${y}px;width:${s}px;height:${s}px;background:${c};opacity:${o}"></div>`).join('')}<div class="dots"></div>${heatStrip(seed)}</div>`;
const brand = `<div class="brand"><img src="${mark}" alt="">UX HeatGrid</div>`;
const shot = (file, x, y, w, h, extra = '') => `<div class="shot" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background-image:url(${img(file)});background-size:${w}px auto;${extra}"></div>`;
const chip = (c, t) => `<span><i style="background:${c}"></i>${t}</span>`;

const slides = [
  ['ux-heatgrid-store-1-overview.png', `
    ${bg(7, [[BLUE, -180, -240, 640, .42], [CORAL, 980, 520, 520, .22]])}
    <div style="position:absolute;left:64px;top:64px;width:440px">
      ${brand}
      <h1 style="margin-top:118px">Your page, <em style="color:${BLUE}">seen</em> <em style="color:${CORAL}">two ways.</em></h1>
      <p class="sub">Predict what stands out by structure. Record what you actually do. Both live in your Chrome side panel.</p>
      <div class="chips">${chip(BLUE, 'Predict')}${chip(CORAL, 'Record')}${chip('#C9CED8', 'Side panel')}</div>
    </div>
    ${shot('overview-page.png', 548, 88, 560, 365)}
    ${shot('overview-panel.png', 896, 236, 320, 520)}`],
  ['ux-heatgrid-store-2-predict.png', `
    ${bg(13, [[BLUE, -160, -260, 680, .5], [BLUE, 900, 480, 520, .2]])}
    <div style="position:absolute;left:64px;top:64px;width:430px">
      ${brand}
      <h1 style="margin-top:118px">See what stands out, <em style="color:${BLUE}">no recording needed.</em></h1>
      <p class="sub">Every button and link ranked High, Medium or Low from size, position, contrast and nearby competition.</p>
      <p class="sub" style="font-size:16px;margin-top:14px;color:rgba(255,255,255,.5)">A structural estimate, not a click forecast.</p>
    </div>
    ${shot('predict-page.png', 540, 88, 600, 391)}
    ${shot('predict-detail-panel.png', 880, 220, 336, 540)}`],
  ['ux-heatgrid-store-3-record.png', `
    ${bg(29, [[CORAL, -200, -260, 660, .32], [CORAL, 940, 500, 520, .2]])}
    <div style="position:absolute;left:64px;top:64px;width:430px">
      ${brand}
      <h1 style="margin-top:118px">Your session, <em style="color:${CORAL}">painted on the page.</em></h1>
      <p class="sub">Record yourself using a page, then see clicks, pointer heat and scroll depth exactly where they happened.</p>
      <div class="chips">${chip(CORAL, 'Heatmap')}${chip(CORAL, 'Clicks')}${chip(CORAL, 'Scroll depth')}</div>
    </div>
    ${shot('record-page.png', 540, 88, 600, 391)}
    ${shot('record-panel.png', 880, 220, 336, 540)}`],
  ['ux-heatgrid-store-4-inspector.png', `
    ${bg(41, [[BLUE, -200, 300, 560, .3], [CORAL, 420, -260, 560, .22]])}
    ${shot('predict-detail-panel.png', 64, 64, 330, 672)}
    ${shot('record-detail-panel.png', 414, 112, 330, 640)}
    <div style="position:absolute;left:800px;top:64px;width:416px">
      ${brand}
      <h1 style="margin-top:64px;font-size:46px">Every result <em style="color:${CORAL}">shows its reasons.</em></h1>
      <ul class="feat">
        <li style="--c:${BLUE}"><b>Why it ranks</b><span>The structural evidence behind each band.</span></li>
        <li style="--c:${CORAL}"><b>Measured, not guessed</b><span>Clicks, hover, focus and time in view.</span></li>
        <li style="--c:#C9CED8"><b>Show on page</b><span>Highlight any element right on the live page.</span></li>
        <li style="--c:#C9CED8"><b>Filter what matters</b><span>Narrow results by band, type or map layer.</span></li>
      </ul>
    </div>`],
];

for (const [, body] of slides) if (/[-–—]/.test(body.replace(/<[^>]*>/g, '').replace(/data:[^)"]*/g, ''))) throw new Error('copy contains a dash');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
for (const [name, body] of slides) {
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const big = path.join(BIG, name);
  await page.screenshot({ path: big });
  execFileSync('sips', ['-z', '800', '1280', big, '--out', path.join(STORE, name)], { stdio: 'ignore' });
}
await browser.close();
console.log('composed →', OUT);
