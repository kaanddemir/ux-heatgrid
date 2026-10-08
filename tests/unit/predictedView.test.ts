// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { toElementDetails, toSummaryResult } from '../../src/content/prediction/summary';
import type { CaveatCode, ReasonCode } from '../../src/content/prediction/types';
import type { PredictionSnapshot } from '../../src/shared/model';
import { CAVEAT_COPY, confidenceQualifier, reasonText } from '../../src/ui/shared/predictionCopy';
import { groupByBand, predictedViewState, rowModel } from '../../src/ui/sidepanel/viewModel';
import { meaningfulRegion } from '../../src/ui/shared/regionLabel';
import { pages } from '../fixtures/predictionPages';
import { el, predictPage } from '../helpers/predictPage';

const snap = (state: PredictionSnapshot['state']): PredictionSnapshot => ({
  state,
  predictionId: state === 'idle' ? null : 'p1',
  predictorId: null,
  createdAt: null,
  summary: null,
  staleReason: state === 'stale' ? 'dom-change' : null,
  error: null,
});

describe('Predict tab view states', () => {
  it('empty / analyzing / ready / stale / error', () => {
    expect(predictedViewState(null)).toEqual({ kind: 'empty', action: 'Predict' });
    expect(predictedViewState(snap('idle'))).toEqual({ kind: 'empty', action: 'Predict' });
    expect(predictedViewState(snap('analyzing')).kind).toBe('analyzing');
    expect(predictedViewState(snap('ready'))).toEqual({ kind: 'ready', action: 'Re-run prediction' });
    expect(predictedViewState(snap('stale'))).toEqual({ kind: 'stale', action: 'Run again', notice: 'Page changed' });
    const err = predictedViewState(snap('error'));
    expect(err.kind === 'error' && err.action).toBe('Try again');
  });
});

describe('ranked list', () => {
  const { result } = predictPage(pages.landing);
  const s = toSummaryResult(result);

  it('groups High → Medium → Low, rank order within a band, not assessed excluded', () => {
    const groups = groupByBand(s, 'all');
    expect(groups.map((g) => g.band)).toEqual(['high', 'medium', 'low']);
    for (const g of groups) {
      expect(g.items.every((e) => e.band === g.band)).toBe(true);
      const ranks = g.items.map((e) => e.rank!);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
    expect(groups.flatMap((g) => g.items)).toHaveLength(s.summary.assessed);
    expect(groupByBand(s, 'medium').map((g) => g.band)).toEqual(['medium']);
  });

  it('rows: clean label, type · named area, qualifier below high confidence, reason preview — never a score', () => {
    const cta = s.elements.find((e) => e.id === el(result, 'cta').elementRef.id)!;
    const m = rowModel(s, cta);
    expect(m.label).toBe('Go');
    expect(m.type).toBe('Link');
    expect(m.meta).toBe('Link'); // type only — the page area stays in m.area for the expanded detail
    expect(m.qualifier).toBe(confidenceQualifier(cta.confidence));
    expect(m.preview).not.toBeNull();
    expect(JSON.stringify(m)).not.toMatch(/\d\.\d{2}/); // no raw numbers
    expect(confidenceQualifier('high')).toBeNull();
    expect(confidenceQualifier('medium')).toBe('Lower confidence');
    expect(confidenceQualifier('low')).toBe('Low confidence');
    expect(rowModel(s, { ...cta, label: 'X (Twitter), opens in a new tab' }).label).toBe('X (Twitter)');
    expect(rowModel(s, { ...cta, label: 'External link ↗' }).label).toBe('External link');
  });
});

describe('row region names', () => {
  it('keeps semantic and real names, hides generic fallbacks', () => {
    expect(['Header', 'Navigation', 'Main', 'Footer', 'Get in touch', 'Pricing plans', 'Attributes 2'].map(meaningfulRegion)).toEqual(['Header', 'Navigation', 'Main', 'Footer', 'Get in touch', 'Pricing plans', 'Attributes 2']);
    expect(['Article', 'Article 3', 'Article 8', 'Section', 'Section 4', 'Block 2', null, undefined, ''].map(meaningfulRegion)).toEqual([null, null, null, null, null, null, null, null, null]);
    expect(meaningfulRegion('Navigation 2')).toBe('Navigation'); // landmark repeat number dropped
  });
});

describe('copy', () => {
  it('every reason and caveat has plain copy without probability language', () => {
    const reasons: ReasonCode[] = [
      'FIRST_VIEWPORT', 'LARGE_RELATIVE_SIZE', 'STRONG_CONTRAST', 'FILLED_STYLE', 'VISUALLY_ISOLATED', 'FEW_COMPETING_CONTROLS',
      'STRONGEST_IN_GROUP', 'UNIQUE_STYLE', 'NEAR_HEADING', 'FIXED_POSITION', 'LOW_ON_FIRST_SCREEN', 'BELOW_FOLD', 'FAR_DOWN_PAGE', 'SMALL_RELATIVE_SIZE',
      'LOW_CONTRAST', 'MANY_COMPETING_CONTROLS', 'CROWDED_REGION', 'WEAKER_THAN_PEERS', 'NAV_CLUSTER', 'FOOTER_CONTEXT', 'TINY_TARGET',
      'PARTLY_CLIPPED', 'REDUCED_OPACITY', 'HEURISTIC_CONTROL', 'DISABLED', 'NOT_RENDERED', 'NEAR_INVISIBLE', 'UNUSABLE_GEOMETRY',
    ];
    const texts = [...reasons.map((r) => reasonText(r)), ...Object.values(CAVEAT_COPY)];
    expect(new Set(reasons).size).toBe(28);
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(3);
      expect(t).not.toMatch(/probab|attention|gaze|%|\bAI\b|heat|\bshould\b|\bconsider\b|\btry\b/i);
    }
    expect(Object.keys(CAVEAT_COPY).sort()).toEqual(
      (['CONTRAST_UNRESOLVED', 'HEURISTIC_DETECTION', 'WEAK_REGION', 'STICKY_AMBIGUOUS', 'CLIP_UNCERTAIN', 'ANALYSIS_CAPPED', 'NEAR_BAND_BOUNDARY', 'CONTRADICTORY_EVIDENCE'] as CaveatCode[]).sort(),
    );
  });

  it('details facts make copy specific', () => {
    const { result } = predictPage(pages.denseNav);
    const d = toElementDetails(result, el(result, 'n-20').elementRef.id)!;
    expect(reasonText('MANY_COMPETING_CONTROLS', d.facts)).toMatch(/^Competes with \d+ nearby controls$/);
    expect(reasonText('MANY_COMPETING_CONTROLS')).toBe('Many controls nearby');
  });

  it('phrases relative and contextual evidence no more strongly than it was measured', () => {
    expect(reasonText('LARGE_RELATIVE_SIZE')).toBe('Relatively large control');
    expect(reasonText('SMALL_RELATIVE_SIZE')).toBe('Relatively small control');
    expect(reasonText('STRONG_CONTRAST')).toBe('Clear text contrast');
    expect(reasonText('UNIQUE_STYLE')).toBe('Uses a less common control style');
    expect(reasonText('NEAR_HEADING')).toBe('Below a nearby heading');
    expect(reasonText('NAV_CLUSTER')).toBe('Part of a dense navigation group');
    expect(reasonText('LOW_ON_FIRST_SCREEN')).toBe('Low on the first screen');
    expect(reasonText('UNUSABLE_GEOMETRY')).toBe('Geometry is too small to assess');
  });
});
