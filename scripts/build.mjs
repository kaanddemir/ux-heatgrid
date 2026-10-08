// UX HeatGrid V2 build: src/ → dist/ (load dist/ as an unpacked extension).
// Usage: node scripts/build.mjs [--watch]
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const buildId = `${pkg.version}+${Date.now().toString(36)}`;

const common = {
  bundle: true,
  target: 'chrome116',
  // Release builds contain only executable assets. Watch builds keep maps for local debugging.
  sourcemap: watch ? 'linked' : false,
  minify: false,
  logLevel: 'info',
  legalComments: 'none',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
};

const entries = [
  // Content runtime is injected with chrome.scripting.executeScript → must be a classic script.
  { entryPoints: [join(src, 'content/index.ts')], outfile: join(dist, 'content/runtime.js'), format: 'iife' },
  { entryPoints: [join(src, 'background/sw.ts')], outfile: join(dist, 'background/sw.js'), format: 'esm' },
  { entryPoints: [join(src, 'ui/sidepanel/panel.ts')], outfile: join(dist, 'sidepanel/panel.js'), format: 'esm' },
];

const staticFiles = [
  ['manifest.json', 'manifest.json'],
  ['ui/sidepanel/index.html', 'sidepanel/index.html'],
  ['ui/shared/tokens.css', 'shared/tokens.css'],
];

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    const target = join(dist, to);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(src, from), target);
  }
  // Icons are plain assets shared with the legacy build; no legacy code is pulled in.
  await cp(join(root, 'icons'), join(dist, 'icons'), { recursive: true });
  await writeFile(join(dist, 'BUILD_ID'), `${buildId}\n`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(entries.map((e) => context({ ...common, ...e })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log(`[build] watching (build ${buildId}). Static files are copied at start — restart after editing HTML/CSS/manifest.`);
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
  console.log(`[build] done → dist/ (build ${buildId})`);
}
