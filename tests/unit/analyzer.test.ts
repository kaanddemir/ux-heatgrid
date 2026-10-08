// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createPageAnalyzer, MAX_INTERACTIVE } from '../../src/content/analyzer';
import type { ElementFacts, FullAnalysisResult } from '../../src/content/analyzer/types';
import { fixtureReader, mount, type FixtureOptions } from '../helpers/fixtureReader';
import { denseNav, formPage, gradientBackground, landing, longPage, many, nestedScroll, transparentBackgrounds, unsemantic } from '../fixtures/pages';

function setup(html: string, opts: FixtureOptions = {}) {
  mount(html);
  const reader = fixtureReader(opts);
  const analyzer = createPageAnalyzer({ reader, clock: () => 1_700_000_000_000 });
  return { analyzer, reader };
}

const byLabel = (r: FullAnalysisResult, label: string): ElementFacts => {
  const hit = r.elements.find((e) => e.ref.label === label);
  if (!hit) throw new Error(`no element labelled ${label}`);
  return hit;
};

describe('PageAnalyzer — full mode (landing fixture)', () => {
  const { analyzer } = setup(landing, { docHeight: 1800 });
  const r = analyzer.analyze();

  it('returns meta with origin+path url, viewport and timings', () => {
    expect(r.mode).toBe('full');
    expect(r.meta).toMatchObject({ layoutVersion: 1, mode: 'full', viewportWidth: 1280, viewportHeight: 800, devicePixelRatio: 2, documentHeight: 1800 });
    expect(r.meta.url).not.toContain('?');
    for (const k of ['discoveryMs', 'measurementMs', 'contrastMs', 'regionsMs', 'spatialMs', 'totalMs'] as const) {
      expect(typeof r.meta.timings[k]).toBe('number');
    }
  });

  it('collects interactive candidates with facts', () => {
    const cta = byLabel(r, 'Get started');
    expect(cta.interactive).toEqual({ basis: 'native', semantic: true });
    expect(cta.render.rendered).toBe(true);
    expect(cta.geometry.document).toEqual({ x: 100, y: 300, width: 220, height: 56 });
    expect(cta.geometry.firstScreenFraction).toBe(1);
    expect(cta.style?.fontSize).toBeGreaterThan(0);
    expect(cta.text?.textLength).toBe('Get started'.length);
    expect(cta.ref.selectorHint).toBe('a.btn.primary');
    expect(r.elements.filter((e) => e.interactive)).toHaveLength(7);
  });

  it('builds landmark + heading regions and assigns membership', () => {
    // Header (1280×80) and nav (680×80) overlap with IoU ≈ .53, below the .85 duplicate threshold: both stay.
    expect(r.regions.map((x) => x.label)).toEqual(['Header', 'Primary', 'Ship faster', 'Features', 'Pricing', 'Footer']);
    const pricing = r.regions.find((x) => x.label === 'Pricing')!;
    expect(byLabel(r, 'Choose plan').regionId).toBe(pricing.id);
    expect(pricing.stats.interactiveCount).toBe(1);
  });

  it('records first-screen counts and coverage', () => {
    expect(r.firstScreen.interactiveCount).toBeGreaterThanOrEqual(5);
    expect(r.coverage).toMatchObject({ elementsCapped: false, regionsCapped: false, framesNotAnalyzed: 0, closedShadowRoots: 'not-inspected' });
    expect(r.warnings).toEqual([]);
  });

  it('builds a spatial index over rendered elements', () => {
    const idx = analyzer.getSpatialIndex()!;
    const cta = byLabel(r, 'Get started');
    const near = idx.queryRadius(cta.geometry.center.x, cta.geometry.center.y, 200);
    expect(near).toContain(byLabel(r, 'Watch demo').ref.id);
  });

  it('is deterministic for the same layout', () => {
    const again = analyzer.analyze({ force: true });
    const strip = (x: FullAnalysisResult) => ({ ...x, meta: { ...x.meta, analysisId: '', timings: null } });
    expect(strip(again)).toEqual(strip(r));
  });
});

describe('registry mode', () => {
  it('skips expensive facts but keeps candidates, regions and scroll roots', () => {
    const { analyzer, reader } = setup(landing, { docHeight: 1800 });
    const reg = analyzer.analyze({ mode: 'registry' });
    const regReads = reader.styleReads;
    expect(reg.mode).toBe('registry');
    expect(reg.meta.timings.contrastMs).toBe(0);
    expect(reg.elements.length).toBeGreaterThan(0);
    expect(reg.regions.length).toBeGreaterThan(0);
    expect(reg.scrollRoots[0]!.kind).toBe('document');
    for (const e of reg.elements) {
      expect(e).not.toHaveProperty('style');
      expect(e).not.toHaveProperty('contrast');
      expect(e).not.toHaveProperty('text');
    }
    const full = analyzer.analyze({ mode: 'full' });
    expect(reader.styleReads - regReads).toBeGreaterThan(regReads * 0.5); // full mode does materially more style work
    // Same logical elements in both modes.
    expect(reg.elements.map((e) => e.ref.id)).toEqual(full.elements.map((e) => e.ref.id));
  });
});

describe('cache and layoutVersion', () => {
  it('caches per layout version and mode; full satisfies registry', () => {
    const { analyzer } = setup(landing);
    const a = analyzer.analyze();
    expect(analyzer.analyze()).toBe(a);
    const reg = analyzer.getRegistrySnapshot();
    expect(reg.meta.analysisId).toBe(a.meta.analysisId); // projected from the cached full result
    expect(reg.elements[0]).not.toHaveProperty('style');
    expect(analyzer.peek()).toBe(a);
  });

  it('registry-only cache does not satisfy full mode', () => {
    const { analyzer } = setup(landing);
    const reg = analyzer.analyze({ mode: 'registry' });
    const full = analyzer.analyze();
    expect(full.meta.analysisId).not.toBe(reg.meta.analysisId);
  });

  it('invalidate bumps the version and breaks the cache, but keeps element ids', () => {
    const { analyzer } = setup(landing);
    const a = analyzer.analyze();
    analyzer.invalidate('manual');
    expect(analyzer.layoutVersion).toBe(2);
    expect(analyzer.peek()).toBeNull();
    expect(analyzer.getSpatialIndex()).toBeNull();
    const b = analyzer.analyze();
    expect(b).not.toBe(a);
    expect(b.meta.layoutVersion).toBe(2);
    expect(b.elements.map((e) => e.ref.id)).toEqual(a.elements.map((e) => e.ref.id));
  });

  it('dispose clears state and blocks further analysis', () => {
    const { analyzer } = setup(landing);
    analyzer.analyze();
    analyzer.dispose();
    expect(analyzer.registry.size).toBe(0);
    expect(() => analyzer.analyze()).toThrow();
  });
});

describe('caps', () => {
  it('caps interactive candidates and reports coverage', () => {
    const { analyzer } = setup(many(450), { docHeight: 450 * 30 });
    const r = analyzer.analyze({ mode: 'registry' });
    expect(r.elements.filter((e) => e.interactive)).toHaveLength(MAX_INTERACTIVE);
    expect(r.coverage).toMatchObject({ interactiveFound: 450, interactiveIncluded: 400, elementsCapped: true });
    expect(r.warnings).toContain('INTERACTIVE_CAPPED');
    // Priority keeps the earliest screens.
    const maxTop = Math.max(...r.elements.filter((e) => e.interactive).map((e) => e.geometry.document.y));
    expect(maxTop).toBeLessThan(400 * 30);
  });

  it('prefers rendered and semantic candidates', () => {
    const html = `<main data-rect="0 0 1280 800">
      ${Array.from({ length: 405 }, (_, i) => `<span style="cursor: pointer" data-rect="0 ${i} 50 1">s</span>`).join('')}
      <button data-rect="0 0 10 10" hidden>hidden</button>
      <button data-rect="0 700 100 40">late but semantic</button></main>`;
    const { analyzer } = setup(html);
    const r = analyzer.analyze({ mode: 'registry' });
    const labels = r.elements.map((e) => e.ref.label);
    expect(labels).toContain('late but semantic');
    expect(labels).not.toContain('hidden');
  });
});

describe('fixtures', () => {
  it('dense navigation: all links captured, one nav region', () => {
    const { analyzer } = setup(denseNav(60));
    const r = analyzer.analyze();
    const nav = r.regions.find((x) => x.landmark === 'nav')!;
    expect(nav.stats.interactiveCount).toBe(60);
    expect(nav.stats.interactivePer100k).toBeGreaterThan(40);
  });

  it('long page: heading sections and below-fold positions', () => {
    const { analyzer } = setup(longPage, { docHeight: 12000 });
    const r = analyzer.analyze();
    expect(r.regions.filter((x) => x.kind === 'heading-section')).toHaveLength(10);
    const last = byLabel(r, 'Action 9');
    expect(last.geometry.topInViewportHeights).toBeGreaterThan(13);
    expect(last.geometry.firstScreenFraction).toBe(0);
  });

  it('form page: no form values anywhere in the result', () => {
    const { analyzer } = setup(formPage);
    const json = JSON.stringify(analyzer.analyze());
    for (const secret of ['private@example.com', 'hunter2', 'secret-token', 'my secret note', '$99']) {
      expect(json).not.toContain(secret);
    }
    const r = analyzer.analyze();
    expect(r.regions.some((x) => x.landmark === 'form' && x.label === 'Checkout')).toBe(true);
    expect(r.elements.filter((e) => e.ref.tagName === 'textarea').every((e) => e.text?.textLength === 0)).toBe(true);
  });

  it('nested scroll containers: document root + ranked containers; overflow hidden and tiny ignored', () => {
    const { analyzer } = setup(nestedScroll);
    const r = analyzer.analyze({ mode: 'registry' });
    expect(r.scrollRoots.map((s) => s.kind)).toEqual(['document', 'container', 'container']);
    const feedRef = analyzer.registry.get(document.getElementById('feed')!)!.id;
    const sideRef = analyzer.registry.get(document.getElementById('sidebar')!)!.id;
    expect(r.scrollRoots.slice(1).map((s) => s.elementRef)).toEqual([feedRef, sideRef]);
    expect(r.scrollRoots[1]!.scrollHeight).toBe(9000);
    expect(analyzer.registry.get(document.getElementById('clipped')!)).toBeUndefined();
  });

  it('transparent backgrounds composite through ancestors', () => {
    const { analyzer } = setup(transparentBackgrounds);
    const r = analyzer.analyze();
    const ghost = byLabel(r, 'Ghost');
    // 50% white over blue → (127.5, 127.5, 255); white text on it.
    expect(ghost.contrast?.resolved).toBe(true);
    if (ghost.contrast?.resolved) {
      expect(ghost.contrast.backgroundColor).toMatchObject({ r: 127.5, g: 127.5, b: 255, a: 1 });
      expect(ghost.contrast.assumedCanvasBase).toBe(false);
      expect(ghost.contrast.ratio).toBeGreaterThan(1);
    }
    expect(ghost.backdrop).toMatchObject({ resolved: true });
    const p = r.elements.find((e) => e.ref.kind === 'text')!;
    expect(p.contrast?.resolved && p.contrast.textColor.a).toBe(1); // translucent text composited
  });

  it('gradient, image and opacity backgrounds are unknown, not guessed', () => {
    const { analyzer } = setup(gradientBackground, { docHeight: 1000 });
    const r = analyzer.analyze();
    expect(byLabel(r, 'Hero title').contrast).toEqual({ resolved: false, reasonIfUnknown: 'background-image' });
    expect(byLabel(r, 'Go').contrast).toEqual({ resolved: false, reasonIfUnknown: 'background-image' });
    const texts = r.elements.filter((e) => e.ref.kind === 'text');
    expect(texts.map((t) => t.contrast)).toEqual([
      { resolved: false, reasonIfUnknown: 'background-image' },
      { resolved: false, reasonIfUnknown: 'opacity' },
    ]);
  });

  it('open shadow root content is analyzed', () => {
    mount('<main data-rect="0 0 1280 800"><div id="host" data-rect="0 0 400 100"></div></main>');
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button data-rect="10 10 120 40">Shadow action</button>';
    const analyzer = createPageAnalyzer({ reader: fixtureReader() });
    const r = analyzer.analyze();
    expect(r.coverage.openShadowRoots).toBe(1);
    expect(byLabel(r, 'Shadow action').interactive?.basis).toBe('native');
  });

  it('unsemantic page falls back to layout blocks', () => {
    const { analyzer } = setup(unsemantic, { docHeight: 2000 });
    const r = analyzer.analyze();
    expect(r.regions.map((x) => x.kind)).toEqual(['block', 'block', 'block']);
    expect(byLabel(r, 'Fake button').interactive).toEqual({ basis: 'cursor', semantic: false });
  });

  it('frames are reported as not analyzed', () => {
    const { analyzer } = setup('<iframe data-rect="0 0 300 300"></iframe><button data-rect="0 400 50 20">x</button>');
    const r = analyzer.analyze();
    expect(r.coverage.framesNotAnalyzed).toBe(1);
    expect(r.warnings).toContain('FRAMES_NOT_ANALYZED');
  });

  it('elements that throw are skipped, not fatal', () => {
    const { analyzer, reader } = setup(landing);
    const original = reader.rect.bind(reader);
    reader.rect = (el) => {
      if (el.tagName === 'BUTTON') throw new Error('boom');
      return original(el);
    };
    const r = analyzer.analyze();
    expect(r.coverage.elementErrors).toBeGreaterThan(0);
    expect(r.warnings).toContain('ELEMENT_ERRORS');
    expect(r.elements.some((e) => e.ref.label === 'Get started')).toBe(true);
  });

  it('analysis never mutates the page', () => {
    const { analyzer } = setup(landing);
    const before = document.documentElement.outerHTML;
    analyzer.analyze();
    analyzer.analyze({ mode: 'registry', force: true });
    expect(document.documentElement.outerHTML).toBe(before);
  });
});
