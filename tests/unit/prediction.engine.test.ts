// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { assignBands, confidenceFrom, explainRanking, predict } from '../../src/content/prediction/engine';
import { TERMS, scoreOne, suppressionsFor } from '../../src/content/prediction/heuristic';
import type { PredictionFeatures, PredictorOutput } from '../../src/content/prediction/types';
import { W } from '../../src/content/prediction/weights';
import { analyzePage, el, predictPage } from '../helpers/predictPage';
import { pages } from '../fixtures/predictionPages';

/** A neutral, fully-measured feature vector to build counterfactuals from. */
export function neutral(over: Partial<PredictionFeatures> = {}): PredictionFeatures {
  return {
    elementId: 1, areaPercentile: 0.5, relSizePage: 0, relSizeRegion: 0, relSize: 0, shortSide: 40, tinyTarget: 0,
    firstViewportFraction: 0, viewportsDown: 2, docYPercentile: 0.5, foldDecay: 0.6, contrast: 0.7, fillStrength: 0,
    bordered: 0, fontSizeRel: 0, fontWeight: 0, paddingRel: 0.3, styleUniqueness: null, peersNearby: 2, semanticPeersNearby: 2,
    peerStrength: 0, strongestInGroup: 0, nearestControlDistance: 0.3, regionDensityPercentile: 0.5, clearance: 0.3,
    clipVisibleFraction: 1, opacity: 1, disabled: 0, roleClass: 'button', landmark: 'main', headingRelation: 0, fixed: 0,
    sticky: 0, heuristicDetection: 0, ...over,
  };
}
const out = (id: number, score: number, over: Partial<PredictorOutput> = {}): PredictorOutput => ({
  elementId: id, eligible: true, suppressions: [], score, base: W.BASE, clampAdjustment: 0,
  components: { prominence: 0, competition: 0, availability: 0, context: 0 },
  prominenceGroups: { size: 0.1, position: 0, visual: 0.1 }, contributions: [], ...over,
});

describe('scoring', () => {
  it('score = base + Σ contributions + clampAdjustment (exact traceability)', () => {
    for (const f of [neutral(), neutral({ relSize: 1, fillStrength: 1, firstViewportFraction: 1, foldDecay: 1, contrast: 1, styleUniqueness: 1, peersNearby: 0, peerStrength: 1, clearance: 1, fixed: 1, headingRelation: 1 }), neutral({ tinyTarget: 1, opacity: 0.5, clipVisibleFraction: 0.5, peersNearby: 30, peerStrength: -1, regionDensityPercentile: 1 })]) {
      const o = scoreOne(f);
      const sum = o.contributions.reduce((s, c) => s + c.contribution, 0);
      expect(o.base + sum + o.clampAdjustment).toBeCloseTo(o.score, 5);
      const compSum = Object.values(o.components).reduce((s, c) => s + c, 0);
      expect(compSum).toBeCloseTo(sum, 5);
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(1);
    }
  });

  it('component subtotals respect their budgets', () => {
    const maxed = scoreOne(neutral({ relSize: 1, areaPercentile: 1, fillStrength: 1, bordered: 1, fontSizeRel: 1, fontWeight: 1, paddingRel: 1, styleUniqueness: 1, contrast: 1, firstViewportFraction: 1, foldDecay: 1, peersNearby: 0, peerStrength: 1, regionDensityPercentile: 0, clearance: 1, fixed: 1, sticky: 1, headingRelation: 1 }));
    expect(maxed.components.prominence).toBeLessThanOrEqual(W.PROMINENCE_BUDGET.max + 1e-9);
    expect(maxed.components.competition).toBeLessThanOrEqual(W.COMPETITION_BUDGET.max + 1e-9);
    expect(maxed.components.context).toBeLessThanOrEqual(W.CONTEXT_BUDGET.max + 1e-9);
    expect(maxed.components.availability).toBe(0);
    const worst = scoreOne(neutral({ tinyTarget: 1, opacity: 0.25, clipVisibleFraction: 0 }));
    expect(worst.components.availability).toBeGreaterThanOrEqual(W.AVAILABILITY_BUDGET.min - 1e-9);
  });

  it('contribution limits: no single signal family can reach High on its own', () => {
    const gap = W.HIGH_FLOOR - W.BASE;
    expect(W.SIZE_BUDGET.max).toBeLessThan(gap);
    expect(W.POSITION_BUDGET.max).toBeLessThan(gap);
    expect(W.VISUAL_BUDGET.max).toBeLessThan(gap);
    expect(W.contrast).toBeLessThan(gap);
    // Weak heuristic signals together stay below the gap.
    const heuristicMax = TERMS.filter((t) => t.reliability === 'heuristic' && t.weight > 0).reduce((s, t) => s + t.weight, 0);
    expect(heuristicMax).toBeLessThan(gap);
    // A size-only control: huge but nothing else.
    expect(scoreOne(neutral({ relSize: 1, areaPercentile: 1 })).score).toBeLessThan(W.HIGH_FLOOR);
    expect(scoreOne(neutral({ firstViewportFraction: 1, foldDecay: 1 })).score).toBeLessThan(W.HIGH_FLOOR);
    expect(scoreOne(neutral({ contrast: 1 })).score).toBeLessThan(W.HIGH_FLOOR);
    expect(scoreOne(neutral({ roleClass: 'button' })).score).toBeLessThan(W.HIGH_FLOOR);
  });

  it('every weight in the term table is a named entry in weights-v1', () => {
    const weightValues = new Set<number>();
    for (const v of Object.values(W) as unknown[]) if (typeof v === 'number') weightValues.add(v);
    for (const t of TERMS) expect(weightValues.has(t.weight)).toBe(true);
  });
});

describe('suppressions and eligibility', () => {
  it('disabled, near-invisible and unusable geometry are suppressed', () => {
    expect(suppressionsFor(neutral({ disabled: 1 }))).toEqual(['DISABLED']);
    expect(suppressionsFor(neutral({ opacity: 0.1 }))).toEqual(['NEAR_INVISIBLE']);
    expect(suppressionsFor(neutral({ contrast: 0.05, fillStrength: 0, bordered: 0 }))).toEqual(['NEAR_INVISIBLE']);
    expect(suppressionsFor(neutral({ contrast: 0.05, fillStrength: 1 }))).toEqual([]); // filled control: text contrast alone is not invisibility
    expect(suppressionsFor(neutral({ shortSide: 3 }))).toEqual(['UNUSABLE_GEOMETRY']);
  });

  it('a suppressed control cannot compensate its way up', () => {
    const strong = neutral({ relSize: 1, areaPercentile: 1, fillStrength: 1, firstViewportFraction: 1, foldDecay: 1, peerStrength: 1, peersNearby: 0, styleUniqueness: 1, contrast: 1 });
    expect(scoreOne(strong).score).toBeGreaterThan(W.HIGH_FLOOR);
    expect(scoreOne({ ...strong, disabled: 1 }).score).toBeLessThanOrEqual(W.SUPPRESSED_SCORE_CAP);
  });

  it('hidden controls are "not assessed" (never Low) with NOT_RENDERED', () => {
    const { result } = predictPage('<main data-rect="0 0 1280 800"><button id="v" data-rect="10 10 100 40">a</button><button id="h" style="display: none">b</button></main>');
    expect(el(result, 'h')).toMatchObject({ band: 'not-assessed', rank: null, score: null, confidence: null });
    expect(el(result, 'h').reasons[0]).toMatchObject({ code: 'NOT_RENDERED', polarity: 'suppresses' });
    expect(result.summary).toMatchObject({ assessed: 1, notAssessed: 1 });
  });

  it('disabled controls are Low with a DISABLED reason', () => {
    const { result } = predictPage(`<main data-rect="0 0 1280 800"><button id="d" disabled style="background-color: rgb(29, 78, 216); color: rgb(255, 255, 255); padding: 20px" data-rect="100 100 400 80">x</button><a href="/" data-rect="100 300 60 20">y</a></main>`);
    expect(el(result, 'd').band).toBe('low');
    expect(el(result, 'd').reasons[0]!.code).toBe('DISABLED');
  });
});

describe('banding', () => {
  const tie = () => 0;
  it('1 control: High only with enough absolute score and distinction', () => {
    expect(assignBands([out(1, 0.7)], tie).bands.get(1)).toBe('high');
    expect(assignBands([out(1, 0.5)], tie).bands.get(1)).toBe('medium');
    expect(assignBands([out(1, 0.7, { prominenceGroups: { size: 0, position: 0.2, visual: 0.05 } })], tie).bands.get(1)).toBe('medium');
  });

  it('2 and 3 controls', () => {
    const two = assignBands([out(1, 0.7), out(2, 0.68)], tie);
    expect([two.bands.get(1), two.bands.get(2)]).toEqual(['high', 'medium']); // cap 1 for small n
    const three = assignBands([out(1, 0.7), out(2, 0.66), out(3, 0.64)], tie);
    expect([...three.bands.values()]).toEqual(['medium', 'medium', 'medium']); // nobody beats median + margin
  });

  it('100+ controls: at most 5 High, bottom share Low', () => {
    const many = Array.from({ length: 120 }, (_, i) => out(i + 1, 0.95 - i * 0.006));
    const b = assignBands(many, tie);
    const bands = [...b.bands.values()];
    expect(bands.filter((x) => x === 'high')).toHaveLength(W.HIGH_MAX);
    expect(bands.filter((x) => x === 'low').length).toBeGreaterThan(30);
    expect(b.ranks.get(1)).toBe(1);
  });

  it('all-weak pages produce no High (rank 1 is not enough)', () => {
    const weak = Array.from({ length: 20 }, (_, i) => out(i + 1, 0.45 - i * 0.001));
    expect([...assignBands(weak, tie).bands.values()].includes('high')).toBe(false);
  });

  it('equal-weight controls are all Medium', () => {
    const eq = Array.from({ length: 8 }, (_, i) => out(i + 1, 0.5));
    expect(new Set(assignBands(eq, tie).bands.values())).toEqual(new Set(['medium']));
  });

  it('heuristic-only controls are capped at Medium (regression: real-Chrome divsoup wrapper was High)', () => {
    expect(assignBands([out(1, 0.9)], tie, () => false).bands.get(1)).toBe('medium');
    const { result } = predictPage(`<div data-rect="0 0 1280 800">
      <div id="wrap" style="cursor: pointer; background-color: rgb(29, 78, 216); color: rgb(255, 255, 255); padding: 24px" data-rect="0 0 1280 400"><div data-rect="20 20 400 40">Deep text</div></div>
      <a href="/" data-rect="20 600 60 18">a</a><a href="/b" data-rect="120 600 60 18">b</a><a href="/c" data-rect="220 600 60 18">c</a></div>`);
    expect(el(result, 'wrap').rank).toBe(1);
    expect(el(result, 'wrap').band).toBe('medium');
  });

  it('suppressed outputs are Low regardless of score', () => {
    expect(assignBands([out(1, 0.9, { suppressions: ['DISABLED'] })], tie).bands.get(1)).toBe('low');
  });
});

describe('confidence', () => {
  it('maps caveat count to high / medium / low', () => {
    expect(confidenceFrom([])).toBe('high');
    expect(confidenceFrom(['CONTRAST_UNRESOLVED'])).toBe('medium');
    expect(confidenceFrom(['CONTRAST_UNRESOLVED', 'HEURISTIC_DETECTION', 'WEAK_REGION'])).toBe('low');
  });

  it('heuristic-only controls carry HEURISTIC_DETECTION and lower confidence', () => {
    const { result } = predictPage(pages.heuristic);
    expect(el(result, 'h-0').caveats).toContain('HEURISTIC_DETECTION');
    expect(el(result, 'real').caveats).not.toContain('HEURISTIC_DETECTION');
  });

  it('unknown contrast lowers confidence but is not scored as poor contrast', () => {
    const html = (bg: string) => `<main data-rect="0 0 1280 800"><div style="${bg}" data-rect="0 0 1280 400">
      <a id="b" href="/" style="color: rgb(17, 17, 17); padding: 12px" data-rect="100 100 200 50">x</a></div>
      <a href="/" data-rect="100 600 80 20">y</a><a href="/" data-rect="300 600 80 20">z</a></main>`;
    const known = el(predictPage(html('background-color: rgb(255, 255, 255)')).result, 'b');
    const unknown = el(predictPage(html('background-image: linear-gradient(red, blue)')).result, 'b');
    expect(unknown.features!.contrast).toBeNull();
    expect(unknown.caveats).toContain('CONTRAST_UNRESOLVED');
    expect(unknown.contributions.find((c) => c.feature === 'contrast')).toBeUndefined();
    expect(unknown.reasons.map((r) => r.code)).not.toContain('LOW_CONTRAST');
    expect(['high', 'medium', 'low'].indexOf(unknown.confidence!)).toBeGreaterThanOrEqual(['high', 'medium', 'low'].indexOf(known.confidence!));
  });
});

describe('reasons and explainability', () => {
  const { result } = predictPage(pages.landing);

  it('reasons are structured codes ordered by contribution, backed by contributions', () => {
    const cta = el(result, 'cta');
    expect(cta.reasons.length).toBeGreaterThan(0);
    const mags = cta.reasons.map((r) => Math.abs(r.contribution));
    expect(mags).toEqual([...mags].sort((a, b) => b - a));
    for (const r of cta.reasons) expect(Math.abs(r.contribution)).toBeGreaterThanOrEqual(W.REASON_MIN_CONTRIBUTION);
    expect(cta.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['FIRST_VIEWPORT', 'FILLED_STYLE']));
    expect(JSON.stringify(cta.reasons)).not.toMatch(/[a-z]{4,} [a-z]{4,}/); // codes, not prose
  });

  it('nav and footer controls carry context reasons when they apply', () => {
    expect(el(result, 'foot-0').reasons.map((r) => r.code)).toContain('FOOTER_CONTEXT');
    expect(el(result, 'foot-0').reasons.map((r) => r.code)).toContain('BELOW_FOLD');
  });

  it('explainRanking answers "why A above B" with component and term differences', () => {
    const cta = el(result, 'cta');
    const foot = el(result, 'foot-0');
    const x = explainRanking(result, foot.elementRef.id, cta.elementRef.id)!;
    expect(x.higher).toBe(cta.elementRef.id);
    expect(x.scoreDiff).toBeGreaterThan(0);
    const compSum = Object.values(x.componentDiffs).reduce((s, v) => s + v, 0);
    expect(compSum).toBeCloseTo(x.scoreDiff - (cta.score! - foot.score! - x.scoreDiff) * 0, 1);
    expect(x.termDiffs[0]!.diff).not.toBe(0);
    expect(explainRanking(result, cta.elementRef.id, 999_999)).toBeNull();
  });
});

describe('result', () => {
  it('is versioned, deterministic and contains region summaries', () => {
    const a = analyzePage(pages.landing);
    const r1 = predict(a, { createdAt: 1, predictionId: 'x', now: () => 0 });
    const r2 = predict(a, { createdAt: 1, predictionId: 'x', now: () => 0 });
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ predictorId: 'heuristic-v1', weightsVersion: 'weights-v1', featureSchema: 'features-v1', analysisId: a.meta.analysisId, layoutVersion: 1 });
    const s = r1.summary;
    expect(s.high + s.medium + s.low).toBe(s.assessed);
    expect(r1.elements).toHaveLength(s.assessed + s.notAssessed);
    const cta = el(r1, 'cta');
    const region = r1.regions.find((r) => r.regionId === cta.regionId)!;
    expect(region.strongestElementId).toBe(cta.elementRef.id);
    expect(region.high).toBeGreaterThan(0);
    expect(region.candidates).toBe(region.high + region.medium + region.low + region.notAssessed);
    expect(JSON.stringify(r1.regions)).not.toMatch(/probab|percent/i);
  });

  it('timings separate feature extraction and prediction', () => {
    const r = predict(analyzePage(pages.dashboard), { analysisMs: 12 });
    expect(r.timings.analysisMs).toBe(12);
    for (const k of ['featuresMs', 'predictMs', 'bandingMs', 'totalMs'] as const) expect(r.timings[k]).toBeGreaterThanOrEqual(0);
  });

  it('contains no page text beyond short labels', () => {
    const { result } = predictPage(`<main data-rect="0 0 1280 800"><p data-rect="0 0 600 200">${'secret body text '.repeat(50)}</p><input id="i" value="SECRET-VALUE" data-rect="0 300 200 30"></main>`);
    const json = JSON.stringify(result);
    expect(json).not.toContain('SECRET-VALUE');
    expect(json).not.toContain('secret body text secret');
  });
});
