// Renders the Chrome Web Store small promo tile (440×280 PNG) in the screenshots' visual language.
// Renders at 2× and downsamples to the exact store size.
// Usage: PLAYWRIGHT_DIR=… CHROME_PATH=… node assets/store/promo.mjs [outDir]  (default: assets/store/final)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(here, 'final'));
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = createRequire(import.meta.url)(path.join(process.env.PLAYWRIGHT_DIR ?? '', 'playwright'));
const mark = `data:image/png;base64,${fs.readFileSync(path.join(here, '../brand/icon-512.png')).toString('base64')}`;
const BLUE = '#397BFA', CORAL = '#FF6B57';

// Heat grid motif along the bottom: a few cells warmed in blue and coral.
let s = 11; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
let cells = '';
for (let r = 0; r < 3; r++) for (let c = 0; c < 23; c++) {
  const v = rnd(), fill = v > 0.93 ? CORAL : v > 0.8 ? BLUE : '#FFFFFF', op = v > 0.93 ? 0.6 : v > 0.8 ? 0.42 : 0.05;
  cells += `<rect x="${4 + c * 19}" y="${218 + r * 19}" width="14" height="14" rx="3.5" fill="${fill}" fill-opacity="${op}"/>`;
}

const html = `<!doctype html><html><head><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 440px; height: 280px; overflow: hidden; }
  body { position: relative; isolation: isolate; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
    background: radial-gradient(120% 110% at 10% 0%, #1A2333 0%, #11151D 50%, #0B0D12 100%); }
  .glow { position: absolute; border-radius: 50%; filter: blur(60px); z-index: -1; }
  .dots { position: absolute; inset: 0; z-index: -1; background-image: radial-gradient(rgba(255,255,255,.08) 1px, transparent 1.1px); background-size: 16px 16px;
    -webkit-mask-image: radial-gradient(80% 70% at 25% 30%, #000 0%, transparent 75%); }
  svg { position: absolute; inset: 0; z-index: -1; -webkit-mask-image: linear-gradient(180deg, transparent 74%, #000 90%); }
  .brand { position: absolute; left: 36px; top: 40px; display: flex; align-items: center; gap: 14px; }
  .brand img { width: 60px; height: 60px; margin: -4px; }
  .name { font-size: 34px; font-weight: 800; letter-spacing: -.025em; }
  .tag { position: absolute; left: 36px; top: 122px; font-size: 22px; line-height: 1.25; font-weight: 700; letter-spacing: -.015em; }
</style></head><body>
  <div class="glow" style="left:-80px;top:-120px;width:300px;height:300px;background:${BLUE};opacity:.45"></div>
  <div class="glow" style="right:-90px;bottom:-130px;width:280px;height:280px;background:${CORAL};opacity:.28"></div>
  <div class="dots"></div>
  <svg viewBox="0 0 440 280" width="440" height="280">${cells}</svg>
  <div class="brand"><img src="${mark}" alt=""><span class="name">UX HeatGrid</span></div>
  <div class="tag"><span style="color:${BLUE}">See what stands out.</span><br><span style="color:${CORAL}">Record how it is used.</span></div>
</body></html>`;

if (/[-–—]/.test(html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]*>/g, '').replace(/data:[^"]*/g, ''))) throw new Error('copy contains a dash');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const big = path.join(os.tmpdir(), `ux-heatgrid-promo-${process.pid}.png`);
await page.screenshot({ path: big });
await browser.close();
const out = path.join(OUT, 'ux-heatgrid-promo-440x280.png');
execFileSync('sips', ['-z', '280', '440', big, '--out', out], { stdio: 'ignore' });
fs.rmSync(big, { force: true });
console.log('promo tile →', out);
