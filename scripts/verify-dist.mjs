// Verifies dist/ is a loadable MV3 extension: every file the manifest references exists, the
// permission set is the approved minimal one, and only the expected production files are shipped.
// Usage: node scripts/verify-dist.mjs  (after npm run build)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const problems = [];
const fail = (msg) => problems.push(msg);

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('[verify] dist/manifest.json is missing. Run npm run build first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) fail(`invalid version "${manifest.version}"`);

const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  'content/runtime.js',
].filter(Boolean);
for (const file of referenced) {
  if (!existsSync(join(dist, file))) fail(`referenced file missing: ${file}`);
}

const allowed = ['activeTab', 'scripting', 'sidePanel', 'storage'];
const extra = (manifest.permissions ?? []).filter((p) => !allowed.includes(p));
if (extra.length) fail(`unexpected permissions: ${extra.join(', ')}`);
if (manifest.host_permissions?.length) fail('host_permissions must be empty');
if (manifest.content_scripts?.length) fail('no static content scripts: the runtime is injected on demand');
if (manifest.web_accessible_resources?.length) fail('no web accessible resources: pages must not be able to detect UX HeatGrid');

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(relative(dist, path));
  }
};
walk(dist);
const maps = files.filter((f) => f.endsWith('.map'));
if (maps.length) fail(`source maps in a release build: ${maps.join(', ')}`);

const expected = [
  'BUILD_ID',
  'background/sw.js',
  'content/runtime.js',
  'icons/icon128.png',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'manifest.json',
  'shared/tokens.css',
  'sidepanel/index.html',
  'sidepanel/panel.js',
];
const unexpected = files.filter((file) => !expected.includes(file));
const missing = expected.filter((file) => !files.includes(file));
if (unexpected.length) fail(`unexpected production files: ${unexpected.join(', ')}`);
if (missing.length) fail(`production files missing: ${missing.join(', ')}`);

const pkg = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`manifest ${manifest.version} does not match package ${pkg.version}`);

if (problems.length) {
  console.error(`[verify] dist/ is NOT valid:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`[verify] dist/ OK (${files.length} files, MV3, permissions: ${manifest.permissions.join(', ')})`);
