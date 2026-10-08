// @vitest-environment happy-dom
/**
 * Counterfactual / monotonic invariants. Each test changes ONE property and checks the direction
 * of the affected contribution — at the feature-vector level (sweeps) and end-to-end through the
 * analyzer on DOM fixtures.
 */
import { describe, expect, it } from 'vitest';
import { scoreOne } from '../../src/content/prediction/heuristic';
import type { PredictionFeatures, TermId } from '../../src/content/prediction/types';
import { W } from '../../src/content/prediction/weights';
import { el, predictPage } from '../helpers/predictPage';
import { neutral } from './prediction.engine.test';

const term = (f: PredictionFeatures, id: TermId): number => scoreOne(f).contributions.find((c) => c.feature === id)?.contribution ?? 0;
const sweep = (values: number[], make: (v: number) => PredictionFeatures, read: (f: PredictionFeatures) => number): number[] => values.map((v) => read(make(v)));
const nonDecreasing = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x >= xs[i - 1]! - 1e-12);
const nonIncreasing = (xs: number[]): boolean => xs.every((x, i) => i === 0 || x <= xs[i - 1]! + 1e-12);

describe('feature-level monotonicity', () => {
  it('size: larger relative size never lowers the size group or the score', () => {
    const vals = [-1, -0.5, 0, 0.3, 0.6, 1];
    expect(nonDecreasing(sweep(vals, (v) => neutral({ relSize: v }), (f) => scoreOne(f).prominenceGroups.size))).toBe(true);
    expect(nonDecreasing(sweep(vals, (v) => neutral({ relSize: v }), (f) => scoreOne(f).score))).toBe(true);
  });

  it('fold: further down never improves the position group', () => {
    const decay = [1, 0.8, 0.5, 0.2, 0.05];
    expect(nonIncreasing(sweep(decay, (d) => neutral({ foldDecay: d }), (f) => scoreOne(f).prominenceGroups.position))).toBe(true);
    const fv = [1, 0.6, 0.2, 0];
    expect(nonIncreasing(sweep(fv, (v) => neutral({ firstViewportFraction: v }), (f) => scoreOne(f).prominenceGroups.position))).toBe(true);
  });

  it('competition: more nearby peers never improves competition', () => {
    expect(nonIncreasing(sweep([0, 1, 2, 4, 8, 16, 40], (n) => neutral({ peersNearby: n }), (f) => scoreOne(f).components.competition))).toBe(true);
    // Saturating: the 30th peer matters less than the 1st.
    const d1 = term(neutral({ peersNearby: 0 }), 'peers') - term(neutral({ peersNearby: 1 }), 'peers');
    const d30 = term(neutral({ peersNearby: 29 }), 'peers') - term(neutral({ peersNearby: 30 }), 'peers');
    expect(d30).toBeLessThan(d1);
  });

  it('isolation: more clearance never worsens the clearance contribution', () => {
    expect(nonDecreasing(sweep([0, 0.1, 0.3, 0.6, 1], (c) => neutral({ clearance: c }), (f) => term(f, 'clearance')))).toBe(true);
  });

  it('peer strength: stronger peers never improve the candidate', () => {
    expect(nonDecreasing(sweep([-1, -0.5, 0, 0.5, 1], (p) => neutral({ peerStrength: p }), (f) => term(f, 'peerStrength')))).toBe(true);
  });

  it('competition never improves when going from no peers to some peers (regression)', () => {
    const alone = scoreOne(neutral({ peersNearby: 0, peerStrength: null, strongestInGroup: null })).components.competition;
    for (const ps of [-1, -0.2, 0, 0.5, 1]) {
      expect(scoreOne(neutral({ peersNearby: 1, peerStrength: ps, strongestInGroup: 0 })).components.competition).toBeLessThanOrEqual(alone);
    }
  });

  it('contrast saturates and unknown contrast is never negative', () => {
    const vals = [0.2, 0.5, 0.7, 0.9, 1];
    const contribs = sweep(vals, (c) => neutral({ contrast: c }), (f) => term(f, 'contrast'));
    expect(nonDecreasing(contribs)).toBe(true);
    expect(term(neutral({ contrast: null }), 'contrast')).toBe(0);
    expect(scoreOne(neutral({ contrast: null })).score).toBeGreaterThan(scoreOne(neutral({ contrast: 0.2 })).score);
  });

  it('disabled never stays High', () => {
    const strong = neutral({ relSize: 1, areaPercentile: 1, fillStrength: 1, firstViewportFraction: 1, foldDecay: 1, peerStrength: 1, peersNearby: 0, contrast: 1, styleUniqueness: 1 });
    expect(scoreOne({ ...strong, disabled: 1 }).score).toBeLessThan(W.HIGH_FLOOR);
  });
});

describe('end-to-end counterfactuals (analyzer → features → predictor)', () => {
  const page = (cta: string, extra = '') => `<main data-rect="0 0 1280 3000">
    <h1 data-rect="100 40 600 50">T</h1>
    <a id="cta" href="/" style="background-color: rgb(29, 78, 216); color: rgb(255, 255, 255); padding: 12px" ${cta}>Go</a>
    <a id="p1" href="/1" style="color: rgb(29, 78, 216)" data-rect="900 600 90 20">a</a>
    <a id="p2" href="/2" style="color: rgb(29, 78, 216)" data-rect="900 640 90 20">b</a>
    <a id="p3" href="/3" style="color: rgb(29, 78, 216)" data-rect="900 680 90 20">c</a>${extra}</main>`;
  const cta = (html: string) => el(predictPage(html).result, 'cta');

  it('size: a relatively larger CTA gets at least as much size prominence', () => {
    const small = cta(page('data-rect="100 200 120 40"'));
    const large = cta(page('data-rect="100 200 300 60"'));
    expect(large.contributions.filter((c) => c.feature === 'relSize' || c.feature === 'areaPercentile').reduce((s, c) => s + c.contribution, 0))
      .toBeGreaterThanOrEqual(small.contributions.filter((c) => c.feature === 'relSize' || c.feature === 'areaPercentile').reduce((s, c) => s + c.contribution, 0));
  });

  it('fold: moving the same CTA down never improves its position', () => {
    const pos = (y: number) => {
      const p = cta(page(`data-rect="100 ${y} 200 50"`));
      return p.contributions.filter((c) => c.feature === 'firstViewport' || c.feature === 'foldDecay').reduce((s, c) => s + c.contribution, 0);
    };
    expect(nonIncreasing([200, 700, 1200, 2000, 2900].map(pos))).toBe(true);
  });

  it('competition: adding nearby controls never improves competition', () => {
    const near = (n: number) =>
      Array.from({ length: n }, (_, i) => `<a href="/n${i}" style="color: rgb(29, 78, 216)" data-rect="${330 + i * 70} 210 60 20">n</a>`).join('');
    const comp = [0, 1, 3, 6].map((n) => cta(page('data-rect="100 200 200 50"', near(n))).components!.competition);
    expect(nonIncreasing(comp)).toBe(true);
  });

  it('isolation: moving a neighbour away never worsens clearance', () => {
    const at = (x: number) => term(cta(page('data-rect="100 200 200 50"', `<span data-rect="${x} 210 40 20"></span><p data-rect="${x} 205 80 30">t</p>`)).features!, 'clearance');
    expect(nonDecreasing([305, 330, 380, 500].map(at))).toBe(true);
  });

  it('disabled: the same strong CTA is not High once disabled', () => {
    const on = cta(page('data-rect="100 200 300 60"'));
    const off = cta(page('disabled aria-disabled="true" data-rect="100 200 300 60"'));
    expect(on.band).toBe('high');
    expect(off.band).toBe('low');
  });

  it('peer strength: making neighbours prominent never improves the candidate', () => {
    const peers = (style: string) =>
      [0, 1].map((i) => `<button style="${style}" data-rect="${330 + i * 230} 200 220 60">p</button>`).join('');
    const weak = cta(page('data-rect="100 200 200 50"', peers('color: rgb(17, 17, 17)')));
    const strong = cta(page('data-rect="100 200 200 50"', peers('background-color: rgb(220, 38, 38); color: rgb(255, 255, 255); font-weight: 700')));
    expect(term(strong.features!, 'peerStrength')).toBeLessThanOrEqual(term(weak.features!, 'peerStrength'));
  });

  it('uniform scaling: relative-size ordering is stable', () => {
    const controls = (k: number) => `<main data-rect="0 0 ${1280} ${3000}">${[[120, 40], [200, 50], [60, 20], [300, 80]]
      .map(([w, h], i) => `<button id="s${i}" data-rect="${100 + i * 50 * k} ${100 + i * 120 * k} ${w! * k} ${h! * k}">x</button>`).join('')}</main>`;
    const order = (k: number) => {
      const r = predictPage(controls(k)).result;
      return [0, 1, 2, 3].map((i) => el(r, `s${i}`)).sort((a, b) => b.features!.relSizePage! - a.features!.relSizePage!).map((e) => e.elementRef.selectorHint);
    };
    expect(order(1)).toEqual(order(2));
  });
});
