import { describe, expect, it } from 'vitest';
import { deriveGeometry, deriveRenderFacts, fontWeightNumber, lineHeightPx } from '../../src/content/analyzer/measure';
import { isScrollable, selectScrollRoots } from '../../src/content/analyzer/scrollRoots';

const style = { display: 'block', visibility: 'visible', opacity: 1, position: 'static', cursor: 'auto' };
const renderInput = {
  connected: true,
  style,
  rect: { x: 0, y: 0, width: 100, height: 40 },
  documentWidth: 1280,
  documentHeight: 3000,
  scrollX: 0,
  scrollY: 0,
  disabled: false,
  ariaDisabled: false,
};

describe('render facts', () => {
  it('a normal box is rendered', () => {
    expect(deriveRenderFacts(renderInput)).toMatchObject({ rendered: true, rectArea: 4000, outsideDocument: false });
  });

  it.each([
    ['zero-size', { rect: { x: 0, y: 0, width: 0, height: 40 } }],
    ['display none', { style: { ...style, display: 'none' } }],
    ['visibility hidden', { style: { ...style, visibility: 'hidden' } }],
    ['near-transparent', { style: { ...style, opacity: 0.01 } }],
    ['disconnected', { connected: false }],
    ['off-screen sr-only pattern', { rect: { x: -10000, y: 0, width: 100, height: 40 } }],
  ])('%s is not rendered', (_name, over) => {
    const facts = deriveRenderFacts({ ...renderInput, ...over });
    expect(facts.rendered).toBe(false);
  });

  it('keeps distinct facts instead of one boolean', () => {
    const facts = deriveRenderFacts({ ...renderInput, disabled: true, ariaDisabled: true, style: { ...style, opacity: 0.5 } });
    expect(facts).toMatchObject({ rendered: true, disabled: true, ariaDisabled: true, opacity: 0.5 });
  });
});

describe('geometry', () => {
  const vp = { width: 1000, height: 800, scrollX: 0, scrollY: 400, dpr: 2 };

  it('derives document coordinates and fractions', () => {
    const g = deriveGeometry({ x: 0, y: 300, width: 100, height: 200 }, vp, false);
    expect(g.document.y).toBe(700);
    expect(g.viewportVisibleFraction).toBe(1);
    expect(g.firstScreenFraction).toBe(0.5); // doc 700–900, first screen 0–800
    expect(g.topInViewportHeights).toBeCloseTo(0.875);
    expect(g.center).toEqual({ x: 50, y: 800 });
  });

  it('fixed elements keep viewport coordinates as document coordinates', () => {
    const g = deriveGeometry({ x: 0, y: 0, width: 100, height: 50 }, vp, true);
    expect(g.document.y).toBe(0);
    expect(g.firstScreenFraction).toBe(1);
  });

  it('style normalization', () => {
    expect(fontWeightNumber('bold')).toBe(700);
    expect(fontWeightNumber('600')).toBe(600);
    expect(lineHeightPx('normal', 16)).toBeNull();
    expect(lineHeightPx('24px', 16)).toBe(24);
  });
});

describe('scroll root selection', () => {
  const cand = (order: number, over: Partial<{ overflowY: string; w: number; h: number; sh: number }> = {}) => ({
    order,
    overflowX: 'visible',
    overflowY: over.overflowY ?? 'auto',
    metrics: { clientWidth: over.w ?? 400, clientHeight: over.h ?? 400, scrollWidth: over.w ?? 400, scrollHeight: over.sh ?? 2000 },
    rect: { x: 0, y: 0, width: over.w ?? 400, height: over.h ?? 400 },
  });
  const vp = { width: 1280, height: 800 };

  it('requires a scrollable overflow value', () => {
    expect(isScrollable(cand(0, { overflowY: 'hidden' })).y).toBe(false);
    expect(isScrollable(cand(0)).y).toBe(true);
    expect(selectScrollRoots([cand(0, { overflowY: 'hidden' }), cand(1, { overflowY: 'visible' })], vp).chosen).toEqual([]);
  });

  it('ignores small containers and ranks by visible area', () => {
    const out = selectScrollRoots([cand(0, { w: 100, h: 60 }), cand(1, { w: 400, h: 300 }), cand(2, { w: 900, h: 700 })], vp);
    expect(out.chosen).toEqual([2, 1]);
  });

  it('caps at 8 and reports it', () => {
    const out = selectScrollRoots(Array.from({ length: 12 }, (_, i) => cand(i)), vp);
    expect(out.chosen).toHaveLength(8);
    expect(out).toMatchObject({ found: 12, capped: true });
    expect(out.chosen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // ties → document order
  });
});
