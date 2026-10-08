/**
 * Trivial ranking baselines — ENGINEERING CALIBRATION ONLY, never product predictors.
 * Used by tests to check that heuristic-v1 does more than "pick the largest thing near the top".
 */
import type { FullAnalysisResult } from '../analyzer/types';
import { isAssessable } from './features';

export type BaselineId = 'dom-order' | 'size-only' | 'size-first-viewport';

/** Element ids, strongest first. */
export function baselineRanking(analysis: FullAnalysisResult, id: BaselineId): number[] {
  const c = analysis.elements.filter(isAssessable);
  const score = (e: (typeof c)[number]): number => {
    switch (id) {
      case 'dom-order':
        return 0; // ties → document order below
      case 'size-only':
        return e.geometry.area;
      case 'size-first-viewport':
        return e.geometry.area * (0.5 + 0.5 * e.geometry.firstScreenFraction);
    }
  };
  const order = new Map(analysis.elements.map((e, i) => [e.ref.id, i]));
  return [...c].sort((a, b) => score(b) - score(a) || order.get(a.ref.id)! - order.get(b.ref.id)!).map((e) => e.ref.id);
}
