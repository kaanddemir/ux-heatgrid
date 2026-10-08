/**
 * Insight confidence = how well the available evidence supports THIS insight (high/medium/low).
 * Not a probability. Caveats can only lower the rule's starting confidence.
 */
import type { CoachCaveat, InsightConfidence } from './types';

const ORDER: InsightConfidence[] = ['low', 'medium', 'high'];
const cap = (c: InsightConfidence, max: InsightConfidence): InsightConfidence => (ORDER.indexOf(c) > ORDER.indexOf(max) ? max : c);

/** Caveat → highest confidence still allowed. */
export const CAVEAT_CAP: Record<CoachCaveat, InsightConfidence> = {
  SHORT_SESSION: 'low',
  FEW_EVENTS: 'low',
  PREDICTION_LOW_CONFIDENCE: 'low',
  PAGE_CHANGED: 'medium',
  COARSENED: 'medium',
  REPROJECTION_UNCERTAIN: 'medium',
  INTERRUPTED: 'medium',
  ANALYSIS_CAPPED: 'medium',
  CANVAS_ASSUMED: 'medium',
  HEURISTIC_CONTROL: 'medium',
};

export function insightConfidence(base: InsightConfidence, caveats: readonly CoachCaveat[]): InsightConfidence {
  return caveats.reduce((c, k) => cap(c, CAVEAT_CAP[k]), base);
}

export const confidenceWeight = (c: InsightConfidence): number => (c === 'high' ? 1 : c === 'medium' ? 0.6 : 0.3);
