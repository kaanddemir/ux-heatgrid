// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { contrastValue, extractFeatures, foldDecay, logRatio, median, percentile } from '../../src/content/prediction/features';
import { analyzePage } from '../helpers/predictPage';
import { pages } from '../fixtures/predictionPages';

describe('feature transforms', () => {
  it('logRatio is symmetric, bounded and saturating', () => {
    expect(logRatio(200, 100, 3)).toBeCloseTo(1 / 3);
    expect(logRatio(50, 100, 3)).toBeCloseTo(-1 / 3);
    expect(logRatio(1e9, 1, 3)).toBe(1);
    expect(logRatio(0, 100, 3)).toBe(-1);
  });

  it('fold decay is 1 near the top and decreases smoothly and monotonically', () => {
    expect(foldDecay(0)).toBe(1);
    expect(foldDecay(0.75)).toBe(1);
    let prev = 1;
    for (let v = 0.8; v <= 10; v += 0.4) {
      const d = foldDecay(v);
      expect(d).toBeLessThan(prev);
      expect(d).toBeGreaterThan(0);
      prev = d;
    }
  });

  it('contrast value saturates at 7:1', () => {
    expect(contrastValue(1)).toBe(0);
    expect(contrastValue(7)).toBeCloseTo(1);
    expect(contrastValue(21)).toBe(1);
    expect(contrastValue(4.5)).toBeGreaterThan(contrastValue(3));
  });

  it('percentile and median', () => {
    expect(percentile(5, [1, 5, 9])).toBe(0.5);
    expect(percentile(1, [1, 5, 9])).toBe(0);
    expect(percentile(9, [1, 5, 9])).toBe(1);
    expect(percentile(3, [3])).toBe(0.5);
    expect(percentile(2, [1, 2, 2, 2, 3])).toBe(0.5); // ties take the mid-rank
    expect(percentile(0, [1, 2, 3])).toBe(0);
    expect(percentile(10, [1, 2, 3])).toBe(1);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });
});

describe('extractFeatures (features-v1)', () => {
  const analysis = analyzePage(pages.landing);
  const { features, context } = extractFeatures(analysis);
  const byHint = (id: string) => {
    const e = analysis.elements.find((x) => x.ref.selectorHint?.startsWith(`a#${id}`) || x.ref.selectorHint?.startsWith(`button#${id}`))!;
    return features.find((f) => f.elementId === e.ref.id)!;
  };

  it('extracts one bounded vector per assessable control', () => {
    expect(features).toHaveLength(analysis.elements.filter((e) => e.interactive && e.render.rendered).length);
    expect(context.candidateCount).toBe(features.length);
    const bounded: Array<[keyof (typeof features)[number], number, number]> = [
      ['areaPercentile', 0, 1], ['relSizePage', -1, 1], ['relSize', -1, 1], ['firstViewportFraction', 0, 1], ['foldDecay', 0, 1],
      ['contrast', 0, 1], ['fillStrength', 0, 1], ['fontSizeRel', -1, 1], ['fontWeight', -1, 1], ['paddingRel', 0, 1],
      ['peerStrength', -1, 1], ['regionDensityPercentile', 0, 1], ['clearance', 0, 1], ['nearestControlDistance', 0, 1],
    ];
    for (const f of features) {
      for (const [k, lo, hi] of bounded) {
        const v = f[k] as number | null;
        if (v === null) continue;
        expect(v, `${String(k)}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${String(k)}`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('measures the filled CTA as larger, filled and in the first viewport', () => {
    const cta = byHint('cta');
    expect(cta.fillStrength).toBe(1);
    expect(cta.relSizePage).toBeGreaterThan(0);
    expect(cta.firstViewportFraction).toBe(1);
    expect(cta.roleClass).toBe('link');
    expect(cta.landmark).toBe('main');
    expect(cta.headingRelation).toBe(1);
  });

  it('classifies context without page-type rules', () => {
    expect(byHint('nav-f').landmark).toBe('nav');
    expect(byHint('foot-0').landmark).toBe('footer');
    expect(byHint('secondary').roleClass).toBe('button');
    expect(byHint('foot-0').firstViewportFraction).toBe(0);
  });

  it('missing measurements are null, never 0', () => {
    const a = analyzePage(`<div style="background-image: linear-gradient(red, blue)" data-rect="0 0 600 200">
      <button id="g" style="color: rgb(255, 255, 255)" data-rect="10 10 100 40">x</button></div>`);
    const f = extractFeatures(a).features[0]!;
    expect(f.contrast).toBeNull();
    expect(f.peerStrength).toBeNull(); // no peers
    expect(f.styleUniqueness).toBeNull(); // < 3 candidates
    expect(f.relSizeRegion).toBeNull(); // < 3 region peers
  });

  it('uses no label/wording: identical structure with different text gives identical features', () => {
    const a = extractFeatures(analyzePage('<main data-rect="0 0 1280 800"><button style="padding: 8px" data-rect="10 10 120 40">Buy now</button><a href="/" data-rect="10 100 80 20">x</a></main>')).features;
    const b = extractFeatures(analyzePage('<main data-rect="0 0 1280 800"><button style="padding: 8px" data-rect="10 10 120 40">zzzz</button><a href="/" data-rect="10 100 80 20">y</a></main>')).features;
    const strip = (fs: typeof a) => fs.map(({ elementId: _id, ...rest }) => rest);
    expect(strip(a)).toEqual(strip(b));
  });
});
