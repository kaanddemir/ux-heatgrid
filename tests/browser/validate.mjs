/**
 * Real-browser analyzer + lifecycle validation (test/dev-only). See harness.mjs for requirements.
 *
 *   PLAYWRIGHT_DIR=… CHROME_PATH=… node tests/browser/validate.mjs [section …]
 *
 * Analyzer sections run the unchanged analyzer source (src/content/analyzer, bundled with
 * esbuild) in the fixture page's main world against real Chrome layout — the product exposes no
 * raw-analysis endpoint. The shipped extension path (toolbar action → injection → runtime) is
 * covered by `ui` and `phase1` here (toolbar icon → panel, Record/Stop/Clear, reinjection, navigation)
 * and by product-check.mjs.
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { DIST, PAGE_SNAPSHOT, ROOT, launch, serveFixtures, sleep } from './harness.mjs';

const only = new Set(process.argv.slice(2));
const want = (name) => only.size === 0 || only.has(name);
const report = {};
let failures = 0;
const check = (section, name, ok, detail) => {
  (report[section] ??= []).push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} [${section}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const near = (a, b, tol = 0.75) => Math.abs(a - b) <= tol;

const { server, origin } = await serveFixtures();
const h = await launch();

/** The analyzer source, bundled once for in-page runs (same code the runtime ships). */
const ANALYZER_BUNDLE = (
  await esbuild.build({
    stdin: { contents: `export { createPageAnalyzer } from './src/content/analyzer/index.ts';`, resolveDir: ROOT, loader: 'ts' },
    bundle: true, format: 'iife', globalName: '__hgAnalyzer', write: false, target: 'chrome116',
  })
).outputFiles[0].text;

/** Open a fixture and load the analyzer into the page (no DOM change: indirect eval, no tag). */
async function openFixture(file, { scrollY = 0 } = {}) {
  const page = h.ctx.pages()[0] ?? (await h.ctx.newPage());
  await page.goto(`${origin}/${file}`);
  await page.waitForLoadState('load');
  if (scrollY) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  await page.evaluate((code) => (0, eval)(`${code}; window.__hgA = __hgAnalyzer.createPageAnalyzer();`), ANALYZER_BUNDLE);
  const run = async (mode = 'full', force = true) =>
    page.evaluate(([mode, force]) => {
      const t0 = performance.now();
      const r = window.__hgA.analyze({ mode, force });
      const callMs = performance.now() - t0;
      return { ...r, summary: { timings: r.meta.timings, warnings: r.warnings, elementCount: r.elements.length }, callMs, bytes: JSON.stringify(r).length };
    }, [mode, force]);
  return { page, run };
}
const byId = (result, id) => result.elements.find((e) => new RegExp(`#${id}(\\.|$)`).test(e.ref.selectorHint ?? ''));

try {
  // -------------------------------------------------------------------------
  if (want('ui')) {
    console.log('\n== UI path: real toolbar icon → side panel ==');
    const page = h.ctx.pages()[0];
    await page.goto(`${origin}/landing.html`);
    const panel = await h.triggerAction(page);
    const tabId0 = await h.tabIdOf(page);
    const before = await h.request(tabId0, 'PING', null).catch((e) => ({ err: e.message }));
    const noPopup = !(await h.targets()).some((t) => t.url.includes('/popup/'));
    check('ui', 'toolbar icon opens the side panel directly; opening it does not inject', noPopup && !!before.err);
    for (let i = 0; i < 30 && !(await panel.eval(`!!document.querySelector('[data-key="ov-predict"]')`)); i++) await sleep(100);
    const ptext = await panel.text();
    check('ui', 'side panel opens on Overview with no developer/debug UI', ptext.includes('Overview') && !/Developer details|Analysis JSON|Raw state|Run analyzer/.test(ptext));
  }

  // -------------------------------------------------------------------------
  if (want('readonly')) {
    console.log('\n== Read-only check (real layout) ==');
    for (const file of ['landing.html', 'form.html', 'nested-scroll.html', 'shadow.html', 'visibility.html', 'divsoup.html']) {
      const { page, run } = await openFixture(file);
      await page.evaluate(() => {
        window.__muts = 0;
        new MutationObserver((list) => (window.__muts += list.length)).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        const ce = document.querySelector('[contenteditable]');
        if (ce) ce.focus();
        window.__shifts = 0;
        new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__shifts += e.value))).observe({ type: 'layout-shift', buffered: false });
      });
      const before = await page.evaluate(PAGE_SNAPSHOT);
      await run('full', true);
      await run('registry', true);
      await run('full', true);
      await run('full', false);
      await sleep(100);
      const after = await page.evaluate(PAGE_SNAPSHOT);
      const muts = await page.evaluate(() => window.__muts);
      const shifts = await page.evaluate(() => window.__shifts);
      const same = ['html', 'nodeCount', 'classes', 'styles', 'active', 'rects'].every((k) => before[k] === after[k]) &&
        JSON.stringify(before.scroll) === JSON.stringify(after.scroll) && JSON.stringify(before.values) === JSON.stringify(after.values);
      check('readonly', `${file}: DOM/classes/styles/scroll/focus/values/rects unchanged, 0 mutations, 0 layout shift`, same && muts === 0 && shifts === 0, { muts, shifts, nodes: after.nodeCount, focus: after.active });
    }
  }

  // -------------------------------------------------------------------------
  if (want('discovery')) {
    console.log('\n== Candidate discovery ==');
    const summarize = (r) => {
      const inter = r.elements.filter((e) => e.interactive);
      return {
        semantic: inter.filter((e) => e.interactive.semantic).length,
        heuristic: inter.filter((e) => !e.interactive.semantic).length,
        found: r.coverage.interactiveFound,
        warnings: r.warnings,
      };
    };
    {
      const { run } = await openFixture('landing.html');
      const r = await run();
      const ids = ['logo', 'nav-features', 'nav-login', 'cta', 'secondary', 'choose', 'tab-a', 'tab-b', 'tabindex-card', 'editable'];
      const missing = ids.filter((id) => !byId(r, id)?.interactive);
      check('discovery', 'landing: CTA, secondary, nav, tabs, tabindex, contenteditable all found', missing.length === 0, { missing, ...summarize(r) });
      const basis = Object.fromEntries(['tab-a', 'tabindex-card', 'editable', 'cta'].map((id) => [id, byId(r, id)?.interactive?.basis]));
      check('discovery', 'landing: basis classification', basis['tab-a'] === 'native' && basis['tabindex-card'] === 'tabindex' && basis.editable === 'contenteditable', basis);
      const nonControls = r.elements.filter((e) => e.interactive && !['a', 'button', 'div'].includes(e.ref.tagName));
      check('discovery', 'landing: no decorative/plain elements as candidates', summarize(r).heuristic === 0 && nonControls.length === 0, summarize(r));
    }
    {
      const { run } = await openFixture('form.html');
      const r = await run();
      const ids = ['email', 'pw', 'notes', 'country', 'placeholder-only', 'rich', 'terms', 'submit', 'pay'];
      check('discovery', 'form: every field and submit found; hidden input excluded', ids.every((id) => byId(r, id)?.interactive) && !r.elements.some((e) => e.ref.tagName === 'input' && /hidden/i.test(e.ref.label ?? '')), summarize(r));
    }
    {
      const { run } = await openFixture('divsoup.html');
      const r = await run();
      const heur = r.elements.filter((e) => e.interactive && !e.interactive.semantic).map((e) => e.ref.selectorHint);
      check('discovery', 'divsoup: pointer wrapper counted once, inner nodes not re-counted', heur.length <= 5 && !heur.some((s) => s === 'span' || s === 'b'), { heuristic: heur, ...summarize(r) });
      check('discovery', 'divsoup: onclick div and real link found', !!byId(r, 'onclick-div') && r.elements.some((e) => e.ref.label === 'Real link'));
    }
    {
      const { run } = await openFixture('many.html');
      const r = await run();
      const s = summarize(r);
      report.discoveryMany = s;
      check('discovery', 'many: cap at 400, semantic buttons NOT crowded out by 450 cursor:pointer tiles', s.semantic + s.heuristic === 400 && s.semantic === 300, s);
      const ys = r.elements.filter((e) => e.interactive && !e.interactive.semantic).map((e) => e.geometry.document.y);
      check('discovery', 'many: remaining heuristic slots go to the top of the page', ys.length === 0 || Math.max(...ys) <= Math.min(...ys) + 2000, { heuristicKept: ys.length, minY: Math.min(...ys), maxY: Math.max(...ys) });
    }
    {
      const { run } = await openFixture('dense-nav.html');
      const r = await run();
      const nav = r.elements.filter((e) => e.interactive && (e.ref.label ?? '').startsWith('Category'));
      const mega = r.elements.filter((e) => (e.ref.label ?? '').startsWith('Mega'));
      check('discovery', 'dense nav: 80 visible links included; 120 display:none mega links not rendered', nav.length === 80 && mega.every((e) => !e.render.rendered), { visible: nav.length, megaIncluded: mega.length, ...summarize(r) });
      check('discovery', 'dense nav: primary CTA included', !!byId(r, 'cta'));
    }
  }

  // -------------------------------------------------------------------------
  if (want('geometry')) {
    console.log('\n== Geometry vs real layout ==');
    const compare = async (file, ids, scrollY = 0) => {
      const { page, run } = await openFixture(file, { scrollY });
      const r = await run();
      const truth = await page.evaluate((ids) => {
        const out = {};
        for (const id of ids) {
          const el = document.getElementById(id);
          if (!el) continue;
          const b = el.getBoundingClientRect();
          out[id] = { x: b.x, y: b.y, w: b.width, h: b.height, sx: scrollX, sy: scrollY, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, pos: getComputedStyle(el).position };
        }
        return out;
      }, ids);
      for (const id of ids) {
        const e = byId(r, id);
        const t = truth[id];
        if (!e || !t) {
          check('geometry', `${file}#${id} present`, false, { inResult: !!e });
          continue;
        }
        const fixed = e.positioning.inFixed;
        const docY = t.y + (fixed ? 0 : t.sy);
        const vis = (() => {
          const w = Math.max(0, Math.min(t.x + t.w, t.vw) - Math.max(t.x, 0));
          const hh = Math.max(0, Math.min(t.y + t.h, t.vh) - Math.max(t.y, 0));
          return t.w * t.h > 0 ? (w * hh) / (t.w * t.h) : 0;
        })();
        const first = (() => {
          const w = Math.max(0, Math.min(t.x + t.w, t.vw) - Math.max(t.x, 0));
          const hh = Math.max(0, Math.min(docY + t.h, t.vh) - Math.max(docY, 0));
          return t.w * t.h > 0 ? (w * hh) / (t.w * t.h) : 0;
        })();
        const g = e.geometry;
        const ok =
          near(g.viewport.x, t.x) && near(g.viewport.y, t.y) && near(g.viewport.width, t.w) && near(g.viewport.height, t.h) &&
          near(g.document.y, docY) && near(g.area, t.w * t.h, 2) && near(g.center.y, docY + t.h / 2) &&
          near(g.viewportVisibleFraction, vis, 0.01) && near(g.firstScreenFraction, first, 0.01) && near(g.topInViewportHeights, docY / t.vh, 0.01);
        check('geometry', `${file}#${id}`, ok, { docY: Math.round(g.document.y), truthDocY: Math.round(docY), vis: g.viewportVisibleFraction, truthVis: Number(vis.toFixed(3)), first: g.firstScreenFraction, truthFirst: Number(first.toFixed(3)), fixed, sticky: e.positioning.inSticky });
      }
      return r;
    };
    await compare('landing.html', ['cta', 'secondary', 'choose', 'logo']);
    await compare('long.html', ['b1', 'b2', 'b15', 'b30']);
    const fs = await compare('fixed-sticky.html', ['fixed-link', 'fixed-btn', 'sticky-link', 'mid', 'below', 'chat'], 1500);
    check('geometry', 'fixed-sticky: fixed facts', byId(fs, 'fixed-btn')?.positioning.inFixed === true && byId(fs, 'chat')?.positioning.inFixed === true && byId(fs, 'sticky-link')?.positioning.inSticky === true, Object.fromEntries(['fixed-btn', 'chat', 'sticky-link', 'mid'].map((id) => [id, byId(fs, id)?.positioning])));
    await compare('nested-scroll.html', ['inner-top', 'inner-bottom']);
  }

  // -------------------------------------------------------------------------
  if (want('visibility')) {
    console.log('\n== Visibility / rendered facts ==');
    const { run } = await openFixture('visibility.html');
    const r = await run();
    const expectations = {
      'v-visible': { rendered: true },
      'v-display-none': { rendered: false, display: 'none' },
      'v-hidden': { rendered: false, visibility: 'hidden' },
      'v-collapse': { rendered: false, visibility: 'collapse' },
      'v-opacity0': { rendered: false, opacity: 0 },
      'v-opacity-tiny': { rendered: false, opacity: 0.03 },
      'v-opacity-half': { rendered: true, opacity: 0.5 },
      'v-zero': { rendered: false, rectArea: 0 },
      'v-disabled': { rendered: true, disabled: true },
      'v-aria-disabled': { rendered: true, ariaDisabled: true },
      'v-offscreen': { rendered: false, outsideDocument: true },
      'v-sronly': { rendered: false },
    };
    for (const [id, exp] of Object.entries(expectations)) {
      const e = byId(r, id);
      const ok = !!e && Object.entries(exp).every(([k, v]) => e.render[k] === v);
      check('visibility', id, ok, e ? Object.fromEntries(Object.keys(exp).map((k) => [k, e.render[k]])) : 'missing');
    }
    const clipIds = ['v-clipped-out', 'v-slide3', 'v-zero-height-parent', 'v-abs-escape', 'v-slide1'];
    report.clipping = Object.fromEntries(clipIds.map((id) => [id, byId(r, id) && { rendered: byId(r, id).render.rendered, clip: byId(r, id).render.clip, vis: byId(r, id).geometry.viewportVisibleFraction, clippedVisible: byId(r, id).render.clippedVisibleFraction }]));
    console.log('  clipping facts:', JSON.stringify(report.clipping));
  }

  // -------------------------------------------------------------------------
  if (want('contrast')) {
    console.log('\n== Contrast / backgrounds (real computed styles) ==');
    const { run } = await openFixture('backgrounds.html');
    const r = await run();
    const lum = (c) => {
      const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const resolvedCases = {
      't-black': [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }],
      't-grey': [{ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 }],
      't-white-dark': [{ r: 255, g: 255, b: 255 }, { r: 26, g: 26, b: 26 }],
      't-translucent-child': [{ r: 0, g: 0, b: 0 }, { r: 127.5, g: 127.5, b: 255 }],
      't-multi': [{ r: 255, g: 255, b: 255 }, { r: 159.375, g: 63.75, b: 63.75 }],
      't-ghost-btn': [{ r: 255, g: 255, b: 255 }, { r: 20, g: 120, b: 60 }],
      't-translucent-text': [{ r: 102, g: 102, b: 102 }, { r: 255, g: 255, b: 255 }],
    };
    for (const [id, [fg, bg]] of Object.entries(resolvedCases)) {
      const c = byId(r, id)?.contrast;
      const expRatio = Math.round(ratio(fg, bg) * 100) / 100;
      const ok = c?.resolved && near(c.backgroundColor.r, bg.r, 0.6) && near(c.backgroundColor.g, bg.g, 0.6) && near(c.backgroundColor.b, bg.b, 0.6) && near(c.ratio, expRatio, 0.02) &&
        c.meetsNormalTextAA === c.ratio >= 4.5 && c.meetsLargeTextAA === c.ratio >= 3;
      check('contrast', `${id} resolved ${expRatio}:1`, ok, c?.resolved ? { ratio: c.ratio, bg: c.backgroundColor } : c);
    }
    const unknownCases = ['u-gradient', 'u-image', 'u-pseudo', 'u-filter', 'u-blend', 'u-opacity'];
    for (const id of unknownCases) {
      const c = byId(r, id)?.contrast;
      check('contrast', `${id} is unknown (no guideline booleans)`, c && c.resolved === false && !('ratio' in c) && !('meetsNormalTextAA' in c), c);
    }
    const sib = byId(r, 'u-canvas-sibling')?.contrast;
    report.canvasSibling = sib;
    console.log('  non-ancestor canvas sibling (known limitation):', JSON.stringify(sib));
    const shadow = byId(r, 't-shadow')?.contrast;
    console.log('  text-shadow case (white text, dark shadow on white):', JSON.stringify(shadow && { resolved: shadow.resolved, ratio: shadow.ratio }));
    {
      const { run: runDark } = await openFixture('dark-canvas.html');
      const d = await runDark();
      const c = byId(d, 'dark-canvas-text')?.contrast;
      check('contrast', 'color-scheme: dark default canvas is NOT assumed white', c && (c.resolved === false || c.backgroundColor.r < 60), c);
    }
  }

  // -------------------------------------------------------------------------
  if (want('regions')) {
    console.log('\n== Regions ==');
    const show = (r) => r.regions.map((x) => `${x.kind}:${x.label}[${Math.round(x.rect.y)}+${Math.round(x.rect.height)}] i${x.stats.interactiveCount}`);
    for (const file of ['landing.html', 'dense-nav.html', 'long.html', 'form.html', 'headings.html', 'divsoup.html', 'fixed-sticky.html', 'nested-scroll.html', 'generated.html?cards=500']) {
      const { run } = await openFixture(file);
      const r = await run();
      report.regionLists ??= {};
      report.regionLists[file] = show(r);
      console.log(`  ${file}: ${r.regions.length} regions${r.coverage.regionsCapped ? ' (capped)' : ''}\n    ${show(r).join('\n    ')}`);
      const unassigned = r.elements.filter((e) => e.render.rendered && e.interactive && e.regionId === null).length;
      check('regions', `${file}: rendered interactive elements without region`, unassigned === 0, unassigned);
      if (file === 'landing.html') {
        const label = (id) => r.regions.find((x) => x.id === byId(r, id)?.regionId)?.label;
        check('regions', 'landing: CTA in hero section, Choose plan in Pricing, nav link in nav, footer link in footer', label('cta') === 'Ship design reviews faster' && label('choose') === 'Pricing' && ['Primary', 'Header'].includes(label('nav-login')), { cta: label('cta'), choose: label('choose'), nav: label('nav-login') });
      }
      if (file === 'headings.html') check('regions', 'headings: split at h2 (3 sections + intro), not every h3', r.regions.filter((x) => x.kind === 'heading-section').length === 4, show(r));
      if (file === 'long.html') check('regions', 'long: 30 heading sections, no giant main', r.regions.filter((x) => x.kind === 'heading-section').length === 30, r.regions.length);
    }
  }

  // -------------------------------------------------------------------------
  if (want('spatial') || want('registry')) {
    console.log('\n== Spatial index + registry API on browser layout (test bundle in page) ==');
    // Bundles the analyzer (unchanged source) for direct API checks that the debug protocol does not expose
    // (spatial queries, invalidate, resolve). Injected into the page's main world: supplementary to the
    // extension-path checks above, not a replacement for them.
    const bundle = await esbuild.build({
      stdin: { contents: `export { createPageAnalyzer } from './src/content/analyzer/index.ts'; export { SpatialIndex, rectDistance, pointRectDistance } from './src/content/analyzer/spatial.ts';`, resolveDir: ROOT, loader: 'ts' },
      bundle: true, format: 'iife', globalName: '__hgTest', write: false, target: 'chrome116',
    });
    const code = bundle.outputFiles[0].text;
    const page = h.ctx.pages()[0];
    await page.goto(`${origin}/generated.html?cards=300`);
    await page.addScriptTag({ content: code });
    const spatial = await page.evaluate(() => {
      const { createPageAnalyzer, rectDistance, pointRectDistance } = window.__hgTest;
      const a = createPageAnalyzer();
      const r = a.analyze();
      const idx = a.getSpatialIndex();
      const items = r.elements.filter((e) => e.render.rendered).map((e) => ({ id: e.ref.id, rect: e.geometry.document }));
      // Edge items: negative/offscreen, huge, overlapping, zero-size on a cell boundary.
      const extra = [
        { id: 900001, rect: { x: -9999, y: -50, width: 10, height: 10 } },
        { id: 900002, rect: { x: 0, y: 0, width: 5000, height: 4000 } },
        { id: 900003, rect: { x: 128, y: 256, width: 0, height: 0 } },
        { id: 900004, rect: { x: 130, y: 260, width: 50, height: 50 } },
      ];
      for (const e of extra) idx.insert(e);
      const all = [...items, ...extra];
      let mismatches = 0;
      let queries = 0;
      const intersects = (a, b) => (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) || rectDistance(a, b) === 0;
      const probes = [
        ...all.slice(0, 120).map((x) => x.rect),
        { x: -10000, y: -100, width: 50, height: 50 }, { x: 128, y: 256, width: 0, height: 0 }, { x: 99999, y: 99999, width: 1, height: 1 },
        { x: 127.5, y: 255.5, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 0 },
      ];
      for (const p of probes) {
        queries++;
        const got = idx.queryRect(p);
        const exp = all.filter((x) => intersects(x.rect, p)).map((x) => x.id).sort((a, b) => a - b);
        if (JSON.stringify(got) !== JSON.stringify(exp)) mismatches++;
        if (new Set(got).size !== got.length) mismatches++;
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        for (const radius of [0, 40, 300]) {
          queries++;
          const gotR = idx.queryRadius(cx, cy, radius).slice().sort((a, b) => a - b);
          const expR = all.filter((x) => pointRectDistance(cx, cy, x.rect) <= radius).map((x) => x.id).sort((a, b) => a - b);
          if (JSON.stringify(gotR) !== JSON.stringify(expR)) mismatches++;
        }
        queries++;
        const filter = (id) => id < 900000;
        const n = idx.nearest(p, filter);
        const best = all.filter((x) => filter(x.id)).map((x) => ({ id: x.id, d: rectDistance(p, x.rect) })).sort((a, b) => a.d - b.d || a.id - b.id)[0];
        if (!n || n.id !== best.id || Math.abs(n.distance - best.d) > 1e-9) mismatches++;
      }
      const empty = new window.__hgTest.SpatialIndex(64);
      const emptyOk = empty.nearest({ x: 0, y: 0, width: 1, height: 1 }) === null && empty.queryRadius(0, 0, 100).length === 0;
      return { items: all.length, queries, mismatches, emptyOk };
    });
    check('spatial', `queryRect/queryRadius/nearest vs brute force on browser rects (${spatial.items} items, ${spatial.queries} queries incl. negative/huge/boundary/zero-size)`, spatial.mismatches === 0 && spatial.emptyOk, spatial);

    const reg = await page.evaluate(() => {
      const a = window.__hgTest.createPageAnalyzer();
      const full = a.analyze();
      const regi = a.analyze({ mode: 'registry', force: true });
      const forced = a.analyze({ force: true });
      const sameIds = JSON.stringify(full.elements.map((e) => e.ref.id)) === JSON.stringify(regi.elements.map((e) => e.ref.id)) &&
        JSON.stringify(full.elements.map((e) => e.ref.id)) === JSON.stringify(forced.elements.map((e) => e.ref.id));
      const firstBtn = document.querySelector('main button');
      const ref = a.registry.get(firstBtn);
      const resolvesLive = a.registry.resolve(ref.id) === firstBtn;
      a.invalidate('manual');
      const spatialDropped = a.getSpatialIndex() === null && a.peek() === null;
      const v2 = a.analyze();
      const keptId = a.registry.get(firstBtn).id === ref.id;
      firstBtn.closest('.card').remove();
      const removedResolvesNull = a.registry.resolve(ref.id) === null;
      a.invalidate('dom-mutation');
      const v3 = a.analyze();
      const removedAbsent = !v3.elements.some((e) => e.ref.id === ref.id);
      const newBtn = document.createElement('button');
      newBtn.textContent = 'Fresh';
      document.querySelector('main').prepend(newBtn);
      a.invalidate('dom-mutation');
      const v4 = a.analyze();
      const maxBefore = Math.max(...full.elements.map((e) => e.ref.id), ...v3.elements.map((e) => e.ref.id));
      const freshId = v4.elements.find((e) => e.ref.label === 'Fresh')?.ref.id;
      const allIds = v4.elements.map((e) => e.ref.id);
      return {
        sameIds, resolvesLive, spatialDropped, versions: [full.meta.layoutVersion, v2.meta.layoutVersion, v3.meta.layoutVersion, v4.meta.layoutVersion],
        keptId, removedResolvesNull, removedAbsent, freshIdIsNew: freshId > maxBefore, uniqueIds: new Set(allIds).size === allIds.length,
      };
    });
    check('registry', 'same Element → same ref across full/registry/force', reg.sameIds && reg.resolvesLive, reg);
    check('registry', 'invalidate bumps version, drops cache + spatial index, keeps live-element ids', reg.spatialDropped && reg.keptId && JSON.stringify(reg.versions) === '[1,2,3,4]', reg.versions);
    check('registry', 'removed node resolves to null and leaves results; new nodes get never-used ids; no duplicates', reg.removedResolvesNull && reg.removedAbsent && reg.freshIdIsNew && reg.uniqueIds, reg);
  }

  // -------------------------------------------------------------------------
  if (want('scroll')) {
    console.log('\n== Scroll roots ==');
    const { page, run } = await openFixture('nested-scroll.html');
    const r = await run('registry');
    const truth = await page.evaluate(() =>
      Object.fromEntries(['sidebar', 'feed', 'hscroll', 'inner', 'clipped', 'auto-fits', 'tiny'].map((id) => {
        const e = document.getElementById(id);
        return [id, { cw: e.clientWidth, ch: e.clientHeight, sw: e.scrollWidth, sh: e.scrollHeight }];
      })),
    );
    const roots = r.scrollRoots.map((s) => ({ ...s, hint: s.selectorHint }));
    console.log('  roots:', roots.map((s) => `${s.kind}:${s.hint ?? ''} ${s.clientWidth}x${s.clientHeight}/${s.scrollWidth}x${s.scrollHeight} ${s.overflowX}/${s.overflowY}`).join(' | '));
    const hints = roots.map((s) => s.hint);
    check('scroll', 'document root first', r.scrollRoots[0].kind === 'document');
    check('scroll', 'feed (overflow-y:scroll), sidebar (auto), hscroll (x only), inner (nested) detected', ['div#feed', 'aside#sidebar', 'div#hscroll', 'div#inner'].every((x) => hints.includes(x)), hints);
    check('scroll', 'overflow:hidden, non-overflowing auto and tiny scrollbox ignored', !hints.some((x) => /clipped|auto-fits|tiny/.test(x ?? '')), hints);
    const dimsOk = roots.filter((s) => s.hint).every((s) => {
      const t = truth[s.hint.split('#')[1]];
      return t && t.cw === s.clientWidth && t.ch === s.clientHeight && t.sw === s.scrollWidth && t.sh === s.scrollHeight;
    });
    check('scroll', 'dimensions match browser values exactly', dimsOk);
    check('scroll', 'ranked by visible area (feed before sidebar)', hints.indexOf('div#feed') < hints.indexOf('aside#sidebar'), hints);
  }

  // -------------------------------------------------------------------------
  if (want('shadow')) {
    console.log('\n== Shadow DOM / frames ==');
    const { run } = await openFixture('shadow.html');
    const r = await run();
    const labels = r.elements.map((e) => e.ref.label);
    check('shadow', 'open shadow: button, heading and nested open-shadow link found', labels.includes('Shadow action') && labels.includes('Open shadow heading') && labels.includes('Deep nested link'), { openShadowRoots: r.coverage.openShadowRoots });
    check('shadow', 'closed shadow content not pierced; coverage says not-inspected', !labels.includes('Closed shadow action') && r.coverage.closedShadowRoots === 'not-inspected');
    const btn = r.elements.find((e) => e.ref.label === 'Shadow action');
    check('shadow', 'shadow button has real geometry and styles (nested shadow styles applied)', btn?.render.rendered && btn.contrast?.resolved, btn && { rendered: btn.render.rendered, contrast: btn.contrast?.ratio, bg: btn.contrast?.backgroundColor });
    const { run: runF } = await openFixture('iframe.html');
    const f = await runF();
    check('frames', 'iframes counted, not analyzed, warning present', f.coverage.framesNotAnalyzed === 2 && f.warnings.includes('FRAMES_NOT_ANALYZED') && !f.elements.some((e) => e.ref.label === 'Inside srcdoc' || e.ref.label === 'Get started'), { frames: f.coverage.framesNotAnalyzed, warnings: f.warnings });
  }

  // -------------------------------------------------------------------------
  if (want('privacy')) {
    console.log('\n== Privacy ==');
    const { page, run } = await openFixture('form.html?token=SECRET-QUERY#SECRET-FRAGMENT');
    const netBefore = h.network.length;
    const full = await run('full');
    const regi = await run('registry');
    const blob = JSON.stringify([full, regi]);
    const secrets = ['SECRET-EMAIL', 'SECRET-TYPED-EMAIL', 'SECRET-PASSWORD', 'SECRET-HIDDEN-TOKEN', 'SECRET-TEXTAREA', 'SECRET-SELECT-VALUE', 'SECRET-CONTENTEDITABLE', 'SECRET-SUBMIT-VALUE', 'SECRET-QUERY', 'SECRET-FRAGMENT', 'BODYEND', 'never be stored'];
    const leaks = secrets.filter((s) => blob.includes(s));
    check('privacy', 'no form values, query, fragment or body text in results', leaks.length === 0, leaks.length ? leaks : `${(blob.length / 1024).toFixed(1)} KB searched`);
    check('privacy', 'url is origin + path only', full.meta.url === `${origin}/form.html`, full.meta.url);
    const labels = full.elements.map((e) => e.ref.label).filter(Boolean);
    check('privacy', 'labels ≤ 60 chars', labels.every((l) => l.length <= 60), Math.max(...labels.map((l) => l.length)));
    const longStrings = [];
    JSON.stringify({ ...full, summary: undefined }, (k, v) => (typeof v === 'string' && v.length > 130 && longStrings.push(k), v));
    check('privacy', 'no long strings stored anywhere in result', longStrings.length === 0, longStrings);
    const store = await h.sw.evaluate(async () => chrome.storage.session.get(null));
    check('privacy', 'storage.session holds no analysis data', !JSON.stringify(store).includes('elements') && !JSON.stringify(store).includes('analysisId'), Object.keys(store));
    await sleep(200);
    const netDuring = h.network.slice(netBefore);
    check('privacy', 'no network requests during analysis', netDuring.length === 0, netDuring);
    const typed = await page.evaluate(() => document.getElementById('email').value);
    check('privacy', 'form value unchanged by analysis', typed === 'SECRET-TYPED-EMAIL@example.test');
  }

  // -------------------------------------------------------------------------
  if (want('perf')) {
    console.log('\n== Performance (Chrome for Testing, headless, M-series Mac) ==');
    const cases = [
      ['A ~800 nodes', 'generated.html?cards=60'],
      ['B ~6.5k nodes', 'generated.html?cards=520'],
      ['C ~55k nodes (near 60k traversal cap)', 'generated.html?cards=4500'],
      ['D 400+ controls (many)', 'many.html'],
      ['E long page', 'long.html'],
      ['landing', 'landing.html'],
    ];
    report.perf = {};
    for (const [name, file] of cases) {
      const { page, run } = await openFixture(file);
      await page.evaluate(() => {
        window.__long = [];
        new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask' });
      });
      const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
      const cold = await run('full', true);
      const fulls = [];
      const regs = [];
      const cached = [];
      for (let i = 0; i < 7; i++) fulls.push((await run('full', true)).summary.timings);
      for (let i = 0; i < 7; i++) regs.push((await run('registry', true)).summary.timings);
      await run('full', true);
      for (let i = 0; i < 7; i++) cached.push((await run('full', false)).callMs);
      const uncached = [];
      for (let i = 0; i < 5; i++) uncached.push((await run('full', true)).callMs);
      const regOnly = await run('registry', true);
      const long = await page.evaluate(() => window.__long);
      const med = (k, arr) => median(arr.map((t) => t[k]));
      const row = {
        nodes,
        coldFullMs: cold.summary.timings.totalMs,
        fullMedian: { discovery: med('discoveryMs', fulls), measure: med('measurementMs', fulls), contrast: med('contrastMs', fulls), regions: med('regionsMs', fulls), spatial: med('spatialMs', fulls), total: med('totalMs', fulls) },
        fullRange: [Math.min(...fulls.map((t) => t.totalMs)), Math.max(...fulls.map((t) => t.totalMs))],
        registryMedian: med('totalMs', regs),
        registryRange: [Math.min(...regs.map((t) => t.totalMs)), Math.max(...regs.map((t) => t.totalMs))],
        cachedCallMedian: Number(median(cached).toFixed(1)),
        uncachedCallMedian: Number(median(uncached).toFixed(1)),
        fullPayloadKB: Number((cold.bytes / 1024).toFixed(1)),
        registryPayloadKB: Number((regOnly.bytes / 1024).toFixed(1)),
        longTasksMs: long,
        warnings: cold.summary.warnings,
        elements: cold.summary.elementCount,
      };
      report.perf[name] = row;
      console.log(`  ${name}: ${JSON.stringify(row)}`);
    }
  }

  // -------------------------------------------------------------------------
  if (want('phase1')) {
    console.log('\n== Phase 1 regression ==');
    const page = h.ctx.pages()[0];
    await page.goto(`${origin}/landing.html`);
    await h.sw.evaluate(() => {
      globalThis.__events = [];
      chrome.runtime.onMessage.addListener((m, sender) => {
        if (m && m.kind === 'event') globalThis.__events.push({ type: m.type, state: m.payload?.snapshot?.session?.state, tab: sender.tab?.id ?? m.payload?.tabId, t: Date.now() });
      });
    });
    const panel = await h.triggerAction(page);
    // Overview Record is an accordion: expand it (only if collapsed), then Start.
    const startRecord = async () => {
      if ((await panel.eval(`document.querySelector('[data-key="ov-record"]')?.getAttribute('aria-expanded')`)) !== 'true') await panel.click('button[data-key="ov-record"]');
      for (let i = 0; i < 30 && !(await panel.eval(`!!document.querySelector('[data-key="ov-start-record"]:not(:disabled)')`)); i++) await sleep(100);
      await panel.click('button[data-key="ov-start-record"]');
    };
    const liveText = () => panel.eval(`[...document.querySelectorAll('.live')].map((e) => e.innerText).join(' ')`);
    await startRecord();
    await sleep(3200);
    const bar0 = await liveText();
    check('phase1', 'panel Record injects and records; recording bar shows elapsed', /Recording/.test(bar0) && /\b[23]s\b/.test(bar0), bar0.replace(/\n+/g, ' | '));
    let events = await h.sw.evaluate(() => globalThis.__events);
    const states = events.filter((e) => e.type === 'STATE_CHANGED').map((e) => e.state);
    const ticks = events.filter((e) => e.type === 'SESSION_TICK').length;
    check('phase1', 'preparing → recording, ~1 tick/s', JSON.stringify(states) === '["preparing","recording"]' && ticks >= 2 && ticks <= 4, { states, ticks });
    await panel.click('button[data-key="stop"]');
    await sleep(300);
    events = await h.sw.evaluate(() => globalThis.__events);
    // From the panel, Stop also switches the page to the Recorded map (an extra 'ready' snapshot).
    const afterStop = events.filter((e) => e.type === 'STATE_CHANGED').map((e) => e.state).slice(2);
    check('phase1', 'Stop → processing → ready', afterStop[0] === 'processing' && afterStop.slice(1).every((x) => x === 'ready') && afterStop.length >= 2, afterStop);
    await h.request(await h.tabIdOf(page), 'CLEAR_SESSION', null); // Clear lives in the side panel
    await sleep(300);
    events = await h.sw.evaluate(() => globalThis.__events);
    check('phase1', 'Clear → idle', events.filter((e) => e.type === 'STATE_CHANGED').at(-1)?.state === 'idle');

    // Side panel follows runtime
    await panel.click('button[data-key="nav-overview"]');
    await startRecord();
    await sleep(1300);
    const bar = await liveText();
    check('phase1', 'side panel Record + recording bar follows runtime', /Recording/.test(bar) && /\b[12]s\b/.test(bar), bar.replace(/\n+/g, ' | '));

    // Repeated injection must not duplicate listeners/controllers.
    const tabId = await h.tabIdOf(page);
    for (let i = 0; i < 3; i++) await h.inject(tabId);
    await h.sw.evaluate(() => (globalThis.__events = []));
    await sleep(3100);
    events = await h.sw.evaluate(() => globalThis.__events);
    const tickCount = events.filter((e) => e.type === 'SESSION_TICK').length;
    check('phase1', '3× reinjection keeps one runtime (ticks still ~1/s, session preserved)', tickCount >= 2 && tickCount <= 4, { ticksIn3s: tickCount });
    const st = await h.request(tabId, 'GET_STATE', null, 'query');
    check('phase1', 'state survives reinjection of same build', st.res.ok && st.res.data.session.state === 'recording');


    // Same-origin navigation continues the recording (Phase 5 continuity; details in continuity-check).
    await page.goto(`${origin}/headings.html`);
    let cont = null;
    for (let i = 0; i < 30; i++) {
      cont = (await h.request(tabId, 'GET_STATE', null, 'query').catch(() => null))?.res?.data;
      if (cont?.session.state === 'recording' && (cont.session.recording?.segmentCount ?? 1) >= 2) break;
      await sleep(100);
    }
    check('phase1', 'same-origin navigation continues the recording as segment 2', cont?.session.state === 'recording' && cont.session.recording?.segmentCount === 2, cont?.session.recording);
    // Without an active recording, navigation leaves no runtime behind.
    await h.request(tabId, 'STOP_SESSION', null);
    await sleep(300);
    await h.request(tabId, 'CLEAR_SESSION', null);
    await page.goto(`${origin}/landing.html`);
    await sleep(600);
    const afterNav = await h.request(tabId, 'PING', null).catch((e) => ({ err: e.message }));
    check('phase1', 'old runtime is gone after navigation (PING fails)', !!afterNav.err, afterNav.err?.slice(0, 60));

    // Extension reload is not automated: chrome.runtime.reload() tears down the service worker the
    // harness drives Chrome through, which hangs Playwright. Covered by BUILD_ID reinjection
    // (pingBuild) in unit tests; verify manually after reloading the unpacked extension.
  }
} catch (e) {
  failures++;
  console.error('FATAL', e);
} finally {
  await h.close();
  server.close();
}

const summary = Object.fromEntries(Object.entries(report).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, `${v.filter((c) => c.ok).length}/${v.length}`]));
console.log('\nSUMMARY', JSON.stringify(summary), 'failures:', failures);
console.log('REPORT_JSON', JSON.stringify({ perf: report.perf, discoveryMany: report.discoveryMany, clipping: report.clipping }));
process.exit(failures ? 1 : 0);
