// @vitest-environment happy-dom
/**
 * Cross-page-type behaviour. Assertions are RELATIVE within each page and conservative;
 * nothing here is page-type specific in the engine.
 */
import { describe, expect, it } from 'vitest';
import { baselineRanking, type BaselineId } from '../../src/content/prediction/baselines';
import type { PredictionResult } from '../../src/content/prediction/types';
import { el, predictPage } from '../helpers/predictPage';
import { pages, type PageName } from '../fixtures/predictionPages';

const run = (name: PageName) => predictPage(pages[name]);
const band = (r: PredictionResult, id: string) => el(r, id).band;
const rank = (r: PredictionResult, id: string) => el(r, id).rank!;
const highs = (r: PredictionResult) => r.elements.filter((e) => e.band === 'high').length;

describe('page types', () => {
  it('landing: the filled primary action ranks first and is High; nav/footer are not High', () => {
    const { result: r } = run('landing');
    expect(rank(r, 'cta')).toBe(1);
    expect(band(r, 'cta')).toBe('high');
    expect(band(r, 'logo')).not.toBe('high');
    for (const id of ['nav-f', 'nav-p', 'foot-0', 'foot-5']) expect(band(r, id)).not.toBe('high');
  });

  it('dashboard: the one filled toolbar action stands out; repeated row actions do not', () => {
    const { result: r } = run('dashboard');
    expect(rank(r, 'new')).toBe(1);
    expect(highs(r)).toBeLessThanOrEqual(2);
    expect(band(r, 'row-10')).not.toBe('high');
  });

  it('docs: no manufactured High; sidebar links are not above the content action', () => {
    const { result: r } = run('docs');
    expect(highs(r)).toBe(0);
    expect(rank(r, 'copy')).toBeLessThan(rank(r, 'side-5'));
  });

  it('dense navigation: the content action outranks every nav link; nav links get NAV_CLUSTER', () => {
    const { result: r } = run('denseNav');
    expect(rank(r, 'filter')).toBe(1);
    expect(el(r, 'n-20').reasons.map((x) => x.code)).toContain('NAV_CLUSTER');
    expect(highs(r)).toBe(1);
  });

  it('article: content links are not High; the only filled action is first despite being far down', () => {
    const { result: r } = run('article');
    expect(rank(r, 'subscribe')).toBe(1);
    expect(el(r, 'subscribe').reasons.map((x) => x.code)).toContain('FAR_DOWN_PAGE');
    for (let i = 0; i < 12; i++) expect(band(r, `a-${i}`)).not.toBe('high');
  });

  it('form: the submit action outranks every field; fields are not High', () => {
    const { result: r } = run('form');
    expect(rank(r, 'submit')).toBe(1);
    for (let i = 0; i < 10; i++) expect(band(r, `f-${i}`)).not.toBe('high');
  });

  it('product: the primary filled action outranks secondary, size options and related cards', () => {
    const { result: r } = run('product');
    expect(rank(r, 'add')).toBe(1);
    expect(rank(r, 'add')).toBeLessThan(rank(r, 'wish'));
    expect(rank(r, 'add')).toBeLessThan(rank(r, 'rel-0'));
  });

  it('equal-weight controls: all Medium, no High, no Low', () => {
    const { result: r } = run('equal');
    expect(new Set(r.elements.map((e) => e.band))).toEqual(new Set(['medium']));
  });

  it('below-fold important control still ranks first, with a fold reason', () => {
    const { result: r } = run('belowFold');
    expect(rank(r, 'deep-cta')).toBe(1);
    expect(el(r, 'deep-cta').reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['BELOW_FOLD']));
  });

  it('footer-heavy page: no High manufactured from footer links', () => {
    const { result: r } = run('footerHeavy');
    expect(highs(r)).toBe(0);
    expect(rank(r, 'main-link')).toBe(1);
    expect(el(r, 'ft-10').reasons.map((x) => x.code)).toContain('FOOTER_CONTEXT');
  });

  it('icon toolbar: tiny icon buttons carry TINY_TARGET and are not High', () => {
    const { result: r } = run('toolbar');
    expect(rank(r, 'share')).toBe(1);
    expect(el(r, 'icon-3').reasons.map((x) => x.code)).toContain('TINY_TARGET');
    for (let i = 0; i < 14; i++) expect(band(r, `icon-${i}`)).not.toBe('high');
  });

  it('heuristic cursor:pointer tiles: assessed with lower confidence, below the real button', () => {
    const { result: r } = run('heuristic');
    expect(rank(r, 'real')).toBe(1);
    expect(el(r, 'h-0').confidence).not.toBe('high');
    expect(el(r, 'h-0').reasons.map((x) => x.code)).toContain('HEURISTIC_CONTROL');
  });

  it('every page: deterministic, bounded High count, contributions traceable', () => {
    for (const name of Object.keys(pages) as PageName[]) {
      const a = run(name).result;
      const b = run(name).result;
      expect(b.elements.map((e) => [e.elementRef.selectorHint, e.band, e.score])).toEqual(a.elements.map((e) => [e.elementRef.selectorHint, e.band, e.score]));
      expect(highs(a)).toBeLessThanOrEqual(5);
    }
  });
});

describe('trivial baselines (engineering calibration only)', () => {
  /** The structurally strongest control by construction of each fixture. */
  const expected: Partial<Record<PageName, string>> = {
    landing: 'cta', dashboard: 'new', denseNav: 'filter', article: 'subscribe', form: 'submit',
    product: 'add', belowFold: 'deep-cta', toolbar: 'share', heuristic: 'real',
  };
  const baselines: BaselineId[] = ['dom-order', 'size-only', 'size-first-viewport'];

  it('heuristic-v1 does more than "the largest thing near the top"', () => {
    const hits: Record<string, number> = { 'heuristic-v1': 0, 'dom-order': 0, 'size-only': 0, 'size-first-viewport': 0 };
    const table: string[] = [];
    for (const [name, id] of Object.entries(expected) as Array<[PageName, string]>) {
      const { analysis, result } = run(name);
      const target = el(result, id).elementRef.id;
      const ranks = [`heuristic=${el(result, id).rank}`];
      if (result.elements[0]!.elementRef.id === target) hits['heuristic-v1']!++;
      for (const b of baselines) {
        const order = baselineRanking(analysis, b);
        if (order[0] === target) hits[b]!++;
        ranks.push(`${b}=${order.indexOf(target) + 1}`);
      }
      table.push(`${name}: ${ranks.join(' ')}`);
    }
    const n = Object.keys(expected).length;
    expect(hits['heuristic-v1']).toBe(n);
    for (const b of baselines) expect(hits['heuristic-v1']!).toBeGreaterThan(hits[b]!);
    // Recorded in the report.
    console.info(`[baseline] top-1 hits of ${n}: ${JSON.stringify(hits)}\n  ${table.join('\n  ')}`);
  });
});
