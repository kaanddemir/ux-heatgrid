// Renders icon PNGs from the SVG masters with Playwright's Chromium.
// Usage: PLAYWRIGHT_DIR=… CHROME_PATH=… node assets/brand/render-icons.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../icons');
const { chromium } = createRequire(import.meta.url)(path.join(process.env.PLAYWRIGHT_DIR ?? '', 'playwright'));
const main = fs.readFileSync(path.join(here, 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(here, 'icon-16.svg'), 'utf8');
// 32/48: the main mark without Chrome's 128-canvas padding (toolbar sizes need every pixel).
const bleed = main.replace('viewBox="0 0 128 128"', 'viewBox="16 16 96 96"');
const jobs = [[16, small], [32, bleed], [48, bleed], [128, main], [512, main]];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [size, svg] of jobs) {
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
  const file = size === 512 ? path.join(here, 'icon-512.png') : path.join(out, `icon${size}.png`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log('icons rendered');
