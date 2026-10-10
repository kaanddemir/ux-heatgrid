// @vitest-environment happy-dom
/**
 * Calibration and explanation invariants.
 *  - controlled experiments: one factor changes at a time; assertions are directional, never exact
 *  - explanations: every reason is backed by scoring terms of the same sign, no contradictory pairs
 *  - confidence: describes band stability, not prominence or caveat count
 */
import { describe, expect, it } from 'vitest';
import { toElementDetails } from '../../src/content/prediction/summary';
import type { PredictionResult, ReasonCode, TermId } from '../../src/content/prediction/types';
import { W } from '../../src/content/prediction/weights';
import { el, predictPage } from '../helpers/predictPage';
import { pages } from '../fixtures/predictionPages';
import { realisticPages } from '../fixtures/predictionPagesRealistic';

const LINK = 'color: rgb(29, 78, 216)';
const FILL = (bg = 'rgb(29, 78, 216)', fg = 'rgb(255, 255, 255)') => `background-color: ${bg}; color: ${fg}; font-weight: 600; padding: 12px 20px`;
const OUTLINE = 'color: rgb(17, 17, 17); border: 1px solid rgb(17, 17, 17); padding: 12px 20px';

/** A neutral page with a short nav, intro, body links further down and one target `#t`. */
function page(target: string, around = ''): string {
  return `
  <header data-rect="0 0 1280 64"><nav data-rect="600 0 680 64">${Array.from({ length: 5 }, (_, i) => `<a href="/n${i}" style="${LINK}" data-rect="${620 + i * 120} 22 90 20">n</a>`).join('')}</nav></header>
  <main data-rect="0 64 1280 3000"><h1 data-rect="100 120 800 60">Title</h1><p data-rect="100 200 700 80">Intro</p>
    ${target}${around}
    ${Array.from({ length: 6 }, (_, i) => `<a href="/b${i}" style="${LINK}" data-rect="100 ${1200 + i * 200} 120 20">body</a>`).join('')}
    <button style="${OUTLINE}" data-rect="100 2600 140 44">Other</button>
  </main>`;
}
const button = (style: string, rect = '100 320 180 48', attrs = '') => `<button id="t" style="${style}" data-rect="${rect}" ${attrs}>Go</button>`;
const target = (html: string) => el(predictPage(html).result, 't');
const score = (html: string) => target(html).score!;
const codes = (html: string) => target(html).reasons.map((r) => r.code);

describe('controlled experiments (one factor at a time)', () => {
  it('contrast: a stronger fill and text contrast never lowers the score', () => {
    const low = score(page(button(FILL('rgb(210, 215, 225)', 'rgb(160, 165, 175)'))));
    const mid = score(page(button(FILL('rgb(120, 140, 200)'))));
    const high = score(page(button(FILL())));
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(codes(page(button(FILL('rgb(210, 215, 225)', 'rgb(160, 165, 175)'))))).toContain('LOW_CONTRAST');
  });

  it('size: a larger control never scores lower', () => {
    const s = ['100 320 90 28', '100 320 180 48', '100 320 320 64'].map((r) => score(page(button(FILL(), r))));
    expect(s[0]).toBeLessThan(s[1]!);
    expect(s[1]).toBeLessThan(s[2]!);
  });

  it('crowding: adding nearby controls lowers the score and explains it as competition', () => {
    const crowd = Array.from({ length: 8 }, (_, i) => `<a href="/c${i}" style="${LINK}" data-rect="${300 + (i % 4) * 110} ${310 + Math.floor(i / 4) * 40} 90 20">c</a>`).join('');
    const isolated = target(page(button(FILL())));
    const crowded = target(page(button(FILL()), crowd));
    expect(crowded.score!).toBeLessThan(isolated.score!);
    expect(crowded.components!.competition).toBeLessThan(isolated.components!.competition);
    expect(isolated.reasons.map((r) => r.code)).toContain('FEW_COMPETING_CONTROLS');
    // A quieter section partly offsets the local crowd; whatever is left is never called "few".
    expect(crowded.reasons.map((r) => r.code)).not.toContain('FEW_COMPETING_CONTROLS');
  });

  it('fold: moving the same control down never raises it, and the reason follows the position', () => {
    const rects = ['100 320 180 48', '100 900 180 48', '100 2400 180 48'];
    const s = rects.map((r) => score(page(button(FILL(), r))));
    expect(s[0]).toBeGreaterThan(s[1]!);
    expect(s[1]).toBeGreaterThan(s[2]!);
    expect(codes(page(button(FILL(), rects[0])))).toContain('FIRST_VIEWPORT');
    expect(codes(page(button(FILL(), rects[2])))).toContain('BELOW_FOLD');
    expect(codes(page(button(FILL(), rects[2])))).not.toContain('FIRST_VIEWPORT');
  });

  it('emphasis: filled primary > outlined secondary > text-only, each explained by its own styling', () => {
    const primary = target(page(button(FILL())));
    const secondary = target(page(button(OUTLINE)));
    const text = target(page(button(`${LINK}; padding: 12px 20px`)));
    expect(primary.score!).toBeGreaterThan(secondary.score!);
    expect(secondary.score!).toBeGreaterThan(text.score!);
    expect(primary.reasons.map((r) => r.code)).toContain('FILLED_STYLE');
    expect(secondary.reasons.map((r) => r.code)).toContain('BUTTON_SHAPE');
    expect(text.reasons.map((r) => r.code)).not.toContain('FILLED_STYLE');
  });

  it('visibility: reduced opacity lowers the score; hidden is not assessed', () => {
    expect(score(page(button(`${FILL()}; opacity: 0.5`)))).toBeLessThan(score(page(button(FILL()))));
    expect(codes(page(button(`${FILL()}; opacity: 0.5`)))).toContain('REDUCED_OPACITY');
    expect(target(page(button(FILL(), '100 320 180 48', 'hidden'))).band).toBe('not-assessed');
  });

  it('fixed positioning raises the same control and says so', () => {
    const normal = page(button(FILL(), '1080 700 160 48'));
    const fixed = page(`<div style="position: fixed" data-rect="1060 690 200 70">${button(FILL(), '1080 700 160 48')}</div>`);
    expect(score(fixed)).toBeGreaterThan(score(normal));
    expect(codes(fixed)).toContain('FIXED_POSITION');
  });

  it('navigation density: a link in a denser nav never scores higher', () => {
    const nav = (n: number, step: number) =>
      `<header data-rect="0 0 1280 64"><nav data-rect="0 0 1280 64">${Array.from({ length: n }, (_, i) => `<a id="${i === 1 ? 't' : `x${i}`}" href="/n${i}" style="${LINK}" data-rect="${20 + i * step} 22 76 20">n</a>`).join('')}</nav></header>
       <main data-rect="0 64 1280 1200"><h1 data-rect="100 120 800 60">T</h1><button style="${FILL()}" data-rect="100 320 180 48">Go</button></main>`;
    expect(score(nav(14, 88))).toBeLessThanOrEqual(score(nav(4, 160)));
  });

  it('target size: the penalty ramps, so a 1px change never causes a large jump', () => {
    const tiny = (h: number) => target(page(button(LINK, `100 320 90 ${h}`))).contributions.find((c) => c.feature === 'tinyTarget')?.contribution ?? 0;
    const step = W.tinyTarget / (W.TINY_SHORT_SIDE - W.UNUSABLE_SHORT_SIDE);
    for (const h of [8, 12, 16, 20, 23]) expect(Math.abs(tiny(h + 1) - tiny(h))).toBeLessThanOrEqual(step * 1.01);
    expect(Math.abs(tiny(24))).toBe(0);
    expect(score(page(button(LINK, '100 320 90 24')))).toBeGreaterThan(score(page(button(LINK, '100 320 90 12'))));
    expect(codes(page(button(LINK, '100 320 90 12')))).toContain('TINY_TARGET');
  });
});

// ---------------------------------------------------------------------------
// Explanations
// ---------------------------------------------------------------------------

/** Scoring terms each reason may stand for. A reason must be backed by at least one of them. */
const BACKING: Partial<Record<ReasonCode, TermId[]>> = {
  LARGE_RELATIVE_SIZE: ['relSize', 'areaPercentile'],
  SMALL_RELATIVE_SIZE: ['relSize', 'areaPercentile'],
  // Competition is explained once, from the net of all three crowding terms.
  FEW_COMPETING_CONTROLS: ['peers', 'regionDensity', 'navCluster'],
  MANY_COMPETING_CONTROLS: ['peers', 'regionDensity', 'navCluster'],
  CROWDED_REGION: ['peers', 'regionDensity', 'navCluster'],
  NAV_CLUSTER: ['peers', 'regionDensity', 'navCluster'],
  BUTTON_SHAPE: ['bordered', 'paddingRel'],
  FIRST_VIEWPORT: ['firstViewport'],
  LOW_ON_FIRST_SCREEN: ['foldDecay'],
  BELOW_FOLD: ['foldDecay'],
  FAR_DOWN_PAGE: ['foldDecay'],
  STRONG_CONTRAST: ['contrast'],
  LOW_CONTRAST: ['contrast'],
  FILLED_STYLE: ['fillStrength'],
  LARGER_TEXT: ['fontSizeRel'],
  SMALLER_TEXT: ['fontSizeRel'],
  BOLD_TEXT: ['fontWeight'],
  LIGHT_TEXT: ['fontWeight'],
  UNIQUE_STYLE: ['styleUniqueness'],
  STRONGEST_IN_GROUP: ['strongestInGroup'],
  WEAKER_THAN_PEERS: ['peerStrength'],
  VISUALLY_ISOLATED: ['clearance'],
  TIGHT_SPACING: ['clearance'],
  TINY_TARGET: ['tinyTarget'],
  PARTLY_CLIPPED: ['clipLoss'],
  REDUCED_OPACITY: ['opacityLoss'],
  FIXED_POSITION: ['fixed'],
  STICKY_POSITION: ['sticky'],
  NEAR_HEADING: ['headingRelation'],
  FOOTER_CONTEXT: ['footer'],
  HEURISTIC_CONTROL: ['heuristicDetection'],
};
const CONTRADICTIONS: Array<[ReasonCode, ReasonCode]> = [
  ['LARGE_RELATIVE_SIZE', 'SMALL_RELATIVE_SIZE'],
  ['STRONG_CONTRAST', 'LOW_CONTRAST'],
  ['FEW_COMPETING_CONTROLS', 'MANY_COMPETING_CONTROLS'],
  ['FEW_COMPETING_CONTROLS', 'CROWDED_REGION'],
  ['FEW_COMPETING_CONTROLS', 'NAV_CLUSTER'],
  ['MANY_COMPETING_CONTROLS', 'NAV_CLUSTER'],
  ['MANY_COMPETING_CONTROLS', 'CROWDED_REGION'],
  ['VISUALLY_ISOLATED', 'TIGHT_SPACING'],
  ['STRONGEST_IN_GROUP', 'WEAKER_THAN_PEERS'],
  ['LARGER_TEXT', 'SMALLER_TEXT'],
  ['FIRST_VIEWPORT', 'BELOW_FOLD'],
  ['FIRST_VIEWPORT', 'FAR_DOWN_PAGE'],
];

const allPages: Record<string, string> = { ...pages, ...realisticPages };
const results: Array<[string, PredictionResult]> = Object.entries(allPages).map(([name, html]) => [name, predictPage(html).result]);

describe('explanations reflect the scoring', () => {
  it('every reason is backed by scoring terms of the same sign, and its contribution is their sum', () => {
    for (const [name, r] of results) {
      for (const e of r.elements) {
        for (const reason of e.reasons) {
          if (reason.polarity === 'suppresses') continue;
          const terms = BACKING[reason.code];
          expect(terms, `${name}: ${reason.code} has no backing terms`).toBeDefined();
          const backing = e.contributions.filter((c) => terms!.includes(c.feature) && c.contribution !== 0);
          expect(backing.length, `${name}: ${reason.code}`).toBeGreaterThan(0);
          expect(Math.sign(reason.contribution)).toBe(reason.polarity === 'raises' ? 1 : -1);
          expect(Math.abs(reason.contribution)).toBeGreaterThanOrEqual(W.REASON_MIN_CONTRIBUTION);
          expect(reason.contribution, `${name}: ${reason.code}`).toBeCloseTo(backing.reduce((s, c) => s + c.contribution, 0), 4);
        }
      }
    }
  });

  it('no element is explained with contradictory or duplicated reasons', () => {
    for (const [name, r] of results) {
      for (const e of r.elements) {
        const set = e.reasons.map((x) => x.code);
        expect(new Set(set).size, `${name}: duplicate reason`).toBe(set.length);
        for (const [a, b] of CONTRADICTIONS) expect(set.includes(a) && set.includes(b), `${name}: ${a} with ${b}`).toBe(false);
        // At most one competition reason per element.
        expect(set.filter((c) => ['FEW_COMPETING_CONTROLS', 'MANY_COMPETING_CONTROLS', 'CROWDED_REGION', 'NAV_CLUSTER'].includes(c)).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('similar elements get the same explanation', () => {
    const r = predictPage(pages.equal).result;
    const sets = Array.from({ length: 6 }, (_, i) => el(r, `eq-${i}`).reasons.map((x) => `${x.code}:${x.polarity}`).sort().join());
    // Neighbour counts differ towards the ends; the two middle buttons are interchangeable.
    expect(sets[2]).toBe(sets[3]);
    const shop = predictPage(realisticPages.shopGrid).result;
    // Inner cards of the same row share position, size, style and neighbourhood.
    for (const [a, b] of [[5, 6], [9, 10]]) {
      expect(el(shop, `sg-add-${a}`).reasons.map((x) => x.code)).toEqual(el(shop, `sg-add-${b}`).reasons.map((x) => x.code));
    }
  });

  it('details facts are the measured values behind the copy', () => {
    const r = predictPage(pages.landing).result;
    const cta = el(r, 'cta');
    const d = toElementDetails(r, cta.elementRef.id)!;
    expect(d.facts.peersNearby).toBe(cta.features!.peersNearby);
    expect(d.facts.shortSide).toBe(Math.round(cta.features!.shortSide!));
    expect(d.facts.sizeRatio).toBeCloseTo(2 ** (cta.features!.relSizePage! * 3), 1);
    expect(d.facts.contrastRatio).toBeLessThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

describe('confidence describes band stability', () => {
  it('is independent of the band: Low and High bands can both be confident', () => {
    const r = predictPage(pages.landing).result;
    expect(el(r, 'cta')).toMatchObject({ band: 'high', confidence: 'high' });
    const lowConfident = r.elements.filter((e) => e.band === 'low' && e.confidence === 'high');
    expect(lowConfident.length).toBeGreaterThan(0);
  });

  it('an unmeasured input far from every band edge does not lower confidence', () => {
    const faded = target(page(button(`${FILL()}; opacity: 0.5`)));
    expect(faded.caveats).toContain('CONTRAST_UNRESOLVED');
    expect(faded.band).toBe('high');
    expect(faded.confidence).toBe('high');
  });

  it('is never raised by a caveat and is Low only when the unmeasured inputs could change the band', () => {
    for (const [, r] of results) {
      for (const e of r.elements) {
        if (e.band === 'not-assessed') continue;
        if (e.confidence === 'low') expect(e.caveats.filter((c) => c !== 'NEAR_BAND_BOUNDARY' && c !== 'HEURISTIC_DETECTION').length).toBeGreaterThan(0);
        if (e.caveats.includes('NEAR_BAND_BOUNDARY')) expect(e.confidence).not.toBe('high');
        if (e.caveats.includes('HEURISTIC_DETECTION')) expect(e.confidence).not.toBe('high');
      }
    }
  });

  it('most assessed controls on the fixture pages are confidently banded (no blanket uncertainty)', () => {
    const assessed = results.flatMap(([, r]) => r.elements.filter((e) => e.band !== 'not-assessed'));
    const high = assessed.filter((e) => e.confidence === 'high').length;
    expect(high / assessed.length).toBeGreaterThan(0.5);
  });

  it('is deterministic', () => {
    const a = predictPage(realisticPages.stickyLanding).result;
    const b = predictPage(realisticPages.stickyLanding).result;
    expect(a.elements.map((e) => [e.band, e.confidence, e.reasons.map((x) => x.code).join()])).toEqual(b.elements.map((e) => [e.band, e.confidence, e.reasons.map((x) => x.code).join()]));
  });
});
