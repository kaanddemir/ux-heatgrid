// @vitest-environment happy-dom
/**
 * Regression tests for defects found during Phase 2 real-browser validation.
 * Each block names the defect it protects against.
 */
import { describe, expect, it } from 'vitest';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { createBackgroundResolver } from '../../src/content/analyzer/contrast';
import { ancestorModel, deriveGeometry } from '../../src/content/analyzer/measure';
import type { ElementFacts, FullAnalysisResult } from '../../src/content/analyzer/types';
import { fixtureReader, mount, type FixtureOptions } from '../helpers/fixtureReader';

const analyze = (html: string, opts: FixtureOptions = {}): FullAnalysisResult => {
  mount(html);
  return createPageAnalyzer({ reader: fixtureReader(opts) }).analyze();
};
const byHint = (r: FullAnalysisResult, id: string): ElementFacts => {
  const hit = r.elements.find((e) => e.ref.selectorHint?.includes(`#${id}`));
  if (!hit) throw new Error(`missing #${id}`);
  return hit;
};

describe('defect: cursor:pointer heuristics crowded semantic controls out of the cap', () => {
  it('semantic controls are kept before heuristic ones, even when heuristics are higher on the page', () => {
    const fakes = Array.from({ length: 450 }, (_, i) => `<div style="cursor: pointer" data-rect="0 ${i * 4} 100 4">t</div>`).join('');
    const real = Array.from({ length: 300 }, (_, i) => `<button data-rect="200 ${2000 + i * 30} 100 24">B${i}</button>`).join('');
    const r = analyze(`<main data-rect="0 0 1280 12000">${fakes}${real}</main>`, { docHeight: 12000 });
    const inter = r.elements.filter((e) => e.interactive);
    expect(inter).toHaveLength(400);
    expect(inter.filter((e) => e.interactive!.semantic)).toHaveLength(300);
    // Remaining slots go to the top-most heuristic candidates.
    const ys = inter.filter((e) => !e.interactive!.semantic).map((e) => e.geometry.document.y);
    expect(Math.max(...ys)).toBe(99 * 4);
  });
});

describe('defect: elements clipped by ancestor overflow were reported as fully rendered/visible', () => {
  const html = `
    <div id="clip" style="overflow: hidden" data-rect="0 0 300 40">
      <button id="out" data-rect="0 100 100 30">out</button>
      <button id="half" data-rect="0 20 100 40">half</button>
      <button id="in" data-rect="0 0 100 30">in</button>
      <button id="abs-escape" style="position: absolute" data-rect="0 200 100 30">abs</button>
      <button id="fixed-escape" style="position: fixed" data-rect="0 300 100 30">fixed</button>
    </div>
    <div style="overflow: hidden; position: relative" data-rect="400 0 300 40">
      <button id="abs-cb" style="position: absolute" data-rect="400 200 100 30">abs in positioned clipper</button>
    </div>
    <div style="overflow: hidden; transform: translateX(0px)" data-rect="800 0 300 40">
      <button id="fixed-cb" style="position: fixed" data-rect="800 200 100 30">fixed in transformed clipper</button>
    </div>
    <div style="clip-path: inset(0px)" data-rect="0 500 300 40"><button id="clip-path" data-rect="0 600 100 30">cp</button></div>
    <div style="height: 0px; overflow: hidden" data-rect="0 700 300 0"><a id="accordion" href="/x" data-rect="0 700 100 20">hidden link</a></div>`;
  const r = analyze(html, { docHeight: 1000 });

  it.each([
    ['out', 'full', false, 0],
    ['half', 'partial', true, 0.5],
    ['in', 'none', true, 1],
    ['abs-escape', 'none', true, 1],
    ['fixed-escape', 'none', true, 1],
    ['abs-cb', 'full', false, 0],
    ['fixed-cb', 'full', false, 0],
    ['clip-path', 'uncertain', true, 1],
    ['accordion', 'full', false, 0],
  ] as const)('%s → clip %s', (id, clip, rendered, fraction) => {
    const e = byHint(r, id);
    expect(e.render.clip).toBe(clip);
    expect(e.render.rendered).toBe(rendered);
    expect(e.render.clipVisibleFraction).toBeCloseTo(fraction, 3);
  });

  it('visible fractions account for the clip', () => {
    expect(byHint(r, 'half').geometry.viewportVisibleFraction).toBeCloseTo(0.5, 3);
    expect(byHint(r, 'half').geometry.firstScreenFraction).toBeCloseTo(0.5, 3);
    expect(byHint(r, 'out').geometry.viewportVisibleFraction).toBe(0);
  });

  it('clip-aware geometry helper keeps the unclipped box', () => {
    const vp = { width: 1000, height: 800, scrollX: 0, scrollY: 100, dpr: 1 };
    const g = deriveGeometry({ x: 0, y: 0, width: 100, height: 100 }, vp, false, { x: 0, y: 0, width: 100, height: 25 });
    expect(g.viewport.height).toBe(100);
    expect(g.viewportVisibleFraction).toBe(0.25);
    expect(g.firstScreenFraction).toBe(0.25);
  });

  it('ancestor model memoizes (style reads bounded)', () => {
    mount(`<div style="overflow:hidden" data-rect="0 0 10 10">${'<span><b>x</b></span>'.repeat(50)}</div>`);
    const reader = fixtureReader();
    const model = ancestorModel(reader);
    for (const b of document.querySelectorAll('b')) model.clip(b, 'static', { x: 0, y: 0, width: 1, height: 1 });
    // 50 <span> parents + 1 shared <div>, each read once.
    expect(reader.styleReads).toBe(51);
  });
});

describe('defect: dark default canvas was assumed white', () => {
  it('color-scheme: dark canvas → unknown, light canvas → white base', () => {
    mount('<p id="p" style="color: rgb(221, 221, 221)" data-rect="0 0 100 20">t</p>');
    const p = document.getElementById('p')!;
    expect(createBackgroundResolver(fixtureReader({ canvas: 'dark' })).resolve(p)).toEqual({ resolved: false, reason: 'dark-canvas' });
    expect(createBackgroundResolver(fixtureReader({ canvas: 'light' })).resolve(p)).toMatchObject({ resolved: true, assumedCanvasBase: true });
  });

  it('an opaque page background still resolves on a dark canvas', () => {
    mount('<div style="background-color: rgb(255, 255, 255)" data-rect="0 0 100 100"><p id="p" data-rect="0 0 100 20">t</p></div>');
    expect(createBackgroundResolver(fixtureReader({ canvas: 'dark' })).resolve(document.getElementById('p')!)).toMatchObject({ resolved: true, assumedCanvasBase: false });
  });
});

describe('defect: covering ::before backgrounds and text-shadow produced confident ratios', () => {
  const cover = JSON.stringify({ content: '""', 'background-color': 'rgb(0, 0, 0)', width: '300px', height: '60px' });
  const icon = JSON.stringify({ content: '""', 'background-color': 'rgb(0, 0, 0)', width: '8px', height: '8px' });
  const r = analyze(`
    <div data-rect="0 0 300 60" data-before='${cover}' style="background-color: rgb(255, 255, 255)"><p id="covered" style="color: rgb(255, 255, 255)" data-rect="0 0 300 20">a</p></div>
    <div data-rect="0 100 300 60" data-before='${icon}' style="background-color: rgb(255, 255, 255)"><p id="icon" style="color: rgb(0, 0, 0)" data-rect="0 100 300 20">b</p></div>
    <p id="shadow" style="color: rgb(255, 255, 255); text-shadow: rgb(0, 0, 0) 0px 0px 4px" data-rect="0 200 300 20">c</p>`);

  it('a covering pseudo-element background makes contrast unknown', () => {
    expect(byHint(r, 'covered').contrast).toEqual({ resolved: false, reasonIfUnknown: 'pseudo-element' });
  });

  it('a small decorative pseudo-element (icon/bullet) does not', () => {
    expect(byHint(r, 'icon').contrast).toMatchObject({ resolved: true, ratio: 21 });
  });

  it('text-shadow makes contrast unknown', () => {
    expect(byHint(r, 'shadow').contrast).toEqual({ resolved: false, reasonIfUnknown: 'text-shadow' });
  });
});

describe('defect: hidden elements inflated region counts', () => {
  it('display:none controls get no region and are not counted', () => {
    const hidden = Array.from({ length: 30 }, (_, i) => `<a href="/m${i}" style="display: none">m${i}</a>`).join('');
    const r = analyze(`<header data-rect="0 0 1280 200"><a id="vis" href="/" data-rect="0 0 100 30">v</a>${hidden}</header>`, { docHeight: 800 });
    const header = r.regions.find((x) => x.landmark === 'header')!;
    expect(header.stats.interactiveCount).toBe(1);
    expect(r.elements.filter((e) => !e.render.rendered).every((e) => e.regionId === null)).toBe(true);
  });
});

describe('defect: nested scroll content was outside the document / unassigned', () => {
  const html = `
    <div id="app" data-rect="0 0 1280 800">
      <aside id="side" data-rect="0 0 300 800"><a href="/s" data-rect="0 0 300 30">side</a></aside>
      <div id="feed" style="overflow-y: auto" data-rect="300 0 980 800" data-scroll="980 800 980 5000">
        <h1 data-rect="320 10 400 40">Feed</h1>
        <button id="top" data-rect="320 100 100 30">top</button>
        <button id="deep" data-rect="320 3000 100 30">deep</button>
      </div>
    </div>`;
  const r = analyze(html, { docHeight: 800 });

  it('content scrolled out of a nested scroller stays rendered (reachable), with 0 visible fraction', () => {
    const deep = byHint(r, 'deep');
    expect(deep.render).toMatchObject({ rendered: true, outsideDocument: false, clip: 'none' });
    expect(deep.geometry.viewportVisibleFraction).toBe(0);
  });

  it('low landmark coverage adds the main content block as a region; scrolled content assigned by ancestry', () => {
    expect(r.regions.map((x) => [x.kind, x.label])).toEqual([
      ['landmark', 'Sidebar'],
      ['block', 'Section'],
    ]);
    const feed = r.regions.find((x) => x.kind === 'block')!;
    expect(byHint(r, 'top').regionId).toBe(feed.id);
    expect(byHint(r, 'deep').regionId).toBe(feed.id);
    expect(feed.stats.interactiveCount).toBe(2);
  });

  it('scroll roots carry a selector hint for debugging', () => {
    expect(r.scrollRoots[1]).toMatchObject({ kind: 'container', selectorHint: 'div#feed', scrollHeight: 5000 });
  });
});

describe('defect: context cap dropped later section headings (h2) in favour of earlier card headings (h3)', () => {
  it('keeps every h2 boundary even with 300 card h3s', () => {
    let html = '<main data-rect="0 0 1280 30000">';
    for (let g = 0; g < 10; g++) {
      html += `<h2 data-rect="0 ${g * 3000} 600 40">Group ${g}</h2>`;
      for (let c = 0; c < 30; c++) html += `<h3 data-rect="0 ${g * 3000 + 60 + c * 90} 300 30">Card ${g}.${c}</h3>`;
    }
    const r = analyze(`${html}</main>`, { docHeight: 30000 });
    expect(r.coverage.contextFound).toBe(311);
    expect(r.regions.filter((x) => x.kind === 'heading-section').map((x) => x.label)).toEqual(Array.from({ length: 10 }, (_, g) => `Group ${g}`));
  });
});
