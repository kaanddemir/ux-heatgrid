// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SUMMARY_REASONS, directionOf, toElementDetails, toSummaryResult } from '../../src/content/prediction/summary';
import { pages } from '../fixtures/predictionPages';
import { el, predictPage } from '../helpers/predictPage';

/** ~400 assessed controls (the analyzer's interactive cap): a dense worst case for payload size. */
const dense = `<main data-rect="0 0 1280 4000">${Array.from(
  { length: 400 },
  (_, i) => `<a href="/p${i}" style="color: rgb(29, 78, 216)" data-rect="${8 + (i % 10) * 126} ${8 + Math.floor(i / 10) * 40} 118 28">Product link number ${i}</a>`,
).join('')}</main>`;

describe('lightweight prediction payload', () => {
  it('summary carries no features, contributions, components or raw scores', () => {
    const { result } = predictPage(pages.landing);
    const s = toSummaryResult(result);
    const json = JSON.stringify(s);
    for (const key of ['"contributions"', '"features"', '"components"', '"score"', '"meanScore"', '"selectorHint"', '"rect"', '"url"']) {
      expect(json).not.toContain(key);
    }
    expect(s.elements).toHaveLength(result.elements.length);
    expect(s.summary).toEqual(result.summary);
    for (const e of s.elements) expect(e.topReasons.length).toBeLessThanOrEqual(SUMMARY_REASONS);
  });

  it('summary keeps order, bands, ranks, confidence, caveats and labels', () => {
    const { result } = predictPage(pages.landing);
    const s = toSummaryResult(result);
    s.elements.forEach((e, i) => {
      const full = result.elements[i]!;
      expect(e).toMatchObject({ id: full.elementRef.id, band: full.band, rank: full.rank, confidence: full.confidence, caveats: full.caveats, regionId: full.regionId });
      expect(e.label).toBe(full.elementRef.label);
      expect(e.topReasons).toEqual(full.reasons.slice(0, SUMMARY_REASONS).map((r) => ({ code: r.code, polarity: r.polarity })));
    });
    const cta = s.elements.find((e) => e.id === el(result, 'cta').elementRef.id)!;
    expect(cta.controlType).toBe('link');
  });

  it('details return the selected element only, with the full breakdown', () => {
    const { result } = predictPage(pages.landing);
    const cta = el(result, 'cta');
    const d = toElementDetails(result, cta.elementRef.id)!;
    expect(d.element.id).toBe(cta.elementRef.id);
    expect(d.reasons).toEqual(cta.reasons);
    expect(d).not.toHaveProperty('debug'); // no raw scores / contributions leave the runtime
    expect(d.components).toEqual({
      prominence: directionOf(cta.components!.prominence),
      competition: directionOf(cta.components!.competition),
      availability: directionOf(cta.components!.availability),
      context: directionOf(cta.components!.context),
    });
    // No other element's data leaks into the response.
    const other = el(result, 'secondary');
    expect(JSON.stringify(d)).not.toContain(`"id":${other.elementRef.id},`);
    expect(toElementDetails(result, 999_999)).toBeNull();
  });

  it('details expose facts for specific copy', () => {
    const { result } = predictPage(pages.denseNav);
    const d = toElementDetails(result, el(result, 'n-20').elementRef.id)!;
    expect(d.facts.peersNearby).toBeGreaterThan(3);
    expect(d.facts.heuristicDetection).toBe(false);
    expect(d.regionLabel).not.toBeNull();
  });

  it('dense result: summary is a small fraction of the full result; one detail is small', () => {
    const { result } = predictPage(dense);
    expect(result.summary.assessed).toBeGreaterThanOrEqual(350);
    const full = JSON.stringify(result).length;
    const summary = JSON.stringify(toSummaryResult(result)).length;
    const detail = JSON.stringify(toElementDetails(result, result.elements[0]!.elementRef.id)).length;
    console.log(`payload: full ${(full / 1024).toFixed(0)} KB · summary ${(summary / 1024).toFixed(0)} KB · one detail ${(detail / 1024).toFixed(1)} KB`);
    expect(summary).toBeLessThan(full * 0.2);
    expect(detail).toBeLessThan(8 * 1024);
  });

  it('directionOf is qualitative with a neutral band', () => {
    expect(directionOf(0.1)).toBe('raises');
    expect(directionOf(-0.1)).toBe('lowers');
    expect(directionOf(0.01)).toBe('neutral');
    expect(directionOf(-0.01)).toBe('neutral');
  });
});
