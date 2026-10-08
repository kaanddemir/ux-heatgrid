/**
 * heuristic-v1 — deterministic, explainable structural predictor.
 *
 * Three stages per control:
 *  1. eligibility (decided upstream: rendered, non-zero geometry; others are "not assessed")
 *  2. suppressions: disabled / near-invisible / unusable geometry → capped score, forced Low
 *  3. structural scoring: Σ weighted, bounded terms grouped into four components, each clamped
 *     to its budget (weights.ts). Contributions are scaled with their component's budget so the
 *     score stays exactly traceable: score = base + Σ contributions + clampAdjustment.
 *
 * Missing features contribute 0 — they never act as a negative signal.
 */
import { clamp, contrastValue } from './features';
import type {
  Component,
  ComponentTotals,
  FeatureContribution,
  PagePredictionContext,
  PredictionFeatures,
  Predictor,
  PredictorOutput,
  Reliability,
  SuppressionCode,
  TermId,
} from './types';
import { FEATURE_SCHEMA } from './types';
import { W } from './weights';

interface Term {
  id: TermId;
  component: Component;
  /** Sub-budget group inside prominence (size / position / visual); undefined = component budget only. */
  group?: 'size' | 'position' | 'visual';
  reliability: Reliability;
  weight: number;
  /** Bounded transformed value, or null when the feature is missing (→ no contribution). */
  value(f: PredictionFeatures): number | null;
}

export const TERMS: readonly Term[] = [
  // Prominence — size
  { id: 'relSize', component: 'prominence', group: 'size', reliability: 'core', weight: W.relSize, value: (f) => f.relSize },
  { id: 'areaPercentile', component: 'prominence', group: 'size', reliability: 'core', weight: W.areaPercentile, value: (f) => (f.areaPercentile === null ? null : (f.areaPercentile - 0.5) * 2) },
  // Prominence — position
  { id: 'firstViewport', component: 'prominence', group: 'position', reliability: 'core', weight: W.firstViewport, value: (f) => f.firstViewportFraction },
  { id: 'foldDecay', component: 'prominence', group: 'position', reliability: 'core', weight: W.foldDecay, value: (f) => (f.foldDecay === null ? null : f.foldDecay - 1) },
  // Prominence — visual treatment
  { id: 'contrast', component: 'prominence', group: 'visual', reliability: 'core', weight: W.contrast, value: (f) => (f.contrast === null ? null : clamp((f.contrast - W.CONTRAST_NEUTRAL) / (1 - W.CONTRAST_NEUTRAL), -1, 1)) },
  { id: 'fillStrength', component: 'prominence', group: 'visual', reliability: 'core', weight: W.fillStrength, value: (f) => f.fillStrength },
  { id: 'bordered', component: 'prominence', group: 'visual', reliability: 'core', weight: W.bordered, value: (f) => f.bordered },
  { id: 'fontSizeRel', component: 'prominence', group: 'visual', reliability: 'core', weight: W.fontSizeRel, value: (f) => f.fontSizeRel },
  { id: 'fontWeight', component: 'prominence', group: 'visual', reliability: 'core', weight: W.fontWeight, value: (f) => f.fontWeight },
  { id: 'paddingRel', component: 'prominence', group: 'visual', reliability: 'heuristic', weight: W.paddingRel, value: (f) => f.paddingRel },
  { id: 'styleUniqueness', component: 'prominence', group: 'visual', reliability: 'heuristic', weight: W.styleUniqueness, value: (f) => f.styleUniqueness },
  { id: 'strongestInGroup', component: 'prominence', group: 'visual', reliability: 'heuristic', weight: W.strongestInGroup, value: (f) => f.strongestInGroup },
  // Competition
  { id: 'peers', component: 'competition', reliability: 'core', weight: W.peers, value: (f) => (f.peersNearby === null ? null : 1 - 2 * (1 - Math.exp(-f.peersNearby / W.PEER_SATURATION))) },
  { id: 'peerStrength', component: 'competition', reliability: 'core', weight: W.peerStrength, value: (f) => (f.peerStrength === null ? null : Math.min(0, f.peerStrength)) },
  { id: 'regionDensity', component: 'competition', reliability: 'core', weight: W.regionDensity, value: (f) => (f.regionDensityPercentile === null ? null : -(f.regionDensityPercentile - 0.5) * 2) },
  { id: 'clearance', component: 'competition', reliability: 'heuristic', weight: W.clearance, value: (f) => (f.clearance === null ? null : clamp((f.clearance - W.CLEARANCE_NEUTRAL) / (1 - W.CLEARANCE_NEUTRAL), -1, 1)) },
  // Availability (penalties)
  { id: 'tinyTarget', component: 'availability', reliability: 'core', weight: W.tinyTarget, value: (f) => (f.tinyTarget === null ? null : -f.tinyTarget) },
  { id: 'clipLoss', component: 'availability', reliability: 'core', weight: W.clipLoss, value: (f) => (f.clipVisibleFraction === null ? null : f.clipVisibleFraction - 1) },
  { id: 'opacityLoss', component: 'availability', reliability: 'core', weight: W.opacityLoss, value: (f) => (f.opacity === null ? null : clamp(f.opacity, 0, 1) - 1) },
  // Context (small)
  { id: 'fixed', component: 'context', reliability: 'core', weight: W.fixed, value: (f) => f.fixed },
  { id: 'sticky', component: 'context', reliability: 'heuristic', weight: W.sticky, value: (f) => f.sticky },
  { id: 'headingRelation', component: 'context', reliability: 'heuristic', weight: W.headingRelation, value: (f) => f.headingRelation },
  { id: 'navCluster', component: 'context', reliability: 'heuristic', weight: W.navCluster, value: (f) => (f.landmark === 'nav' && (f.peersNearby ?? 0) >= W.NAV_CLUSTER_PEERS ? -1 : 0) },
  { id: 'footer', component: 'context', reliability: 'heuristic', weight: W.footer, value: (f) => (f.landmark === 'footer' ? -1 : 0) },
  { id: 'heuristicDetection', component: 'context', reliability: 'core', weight: W.heuristicDetection, value: (f) => (f.heuristicDetection === null ? null : -f.heuristicDetection) },
];

const GROUP_BUDGET = { size: W.SIZE_BUDGET, position: W.POSITION_BUDGET, visual: W.VISUAL_BUDGET } as const;
const COMPONENT_BUDGET: Record<Component, { min: number; max: number }> = {
  prominence: W.PROMINENCE_BUDGET,
  competition: W.COMPETITION_BUDGET,
  availability: W.AVAILABILITY_BUDGET,
  context: W.CONTEXT_BUDGET,
};

/** Clamps a group's sum to its budget and scales its members proportionally (keeps sums exact). */
function applyBudget(items: FeatureContribution[], budget: { min: number; max: number }): number {
  const raw = items.reduce((s, c) => s + c.contribution, 0);
  const capped = clamp(raw, budget.min, budget.max);
  if (raw !== capped && raw !== 0) {
    const k = capped / raw;
    for (const c of items) c.contribution *= k;
  }
  return capped;
}

export function suppressionsFor(f: PredictionFeatures): SuppressionCode[] {
  const out: SuppressionCode[] = [];
  if (f.disabled === 1) out.push('DISABLED');
  const nearInvisibleText = f.contrast !== null && f.contrast < contrastValue(W.NEAR_INVISIBLE_CONTRAST) && (f.fillStrength ?? 0) === 0 && (f.bordered ?? 0) === 0;
  if ((f.opacity !== null && f.opacity < W.NEAR_INVISIBLE_OPACITY) || nearInvisibleText) out.push('NEAR_INVISIBLE');
  if (f.shortSide !== null && f.shortSide < W.UNUSABLE_SHORT_SIDE) out.push('UNUSABLE_GEOMETRY');
  return out;
}

export function scoreOne(f: PredictionFeatures): PredictorOutput {
  const contributions: FeatureContribution[] = [];
  for (const t of TERMS) {
    const value = t.value(f);
    if (value === null) continue;
    contributions.push({ feature: t.id, transformedValue: Math.round(value * 10_000) / 10_000, contribution: value * t.weight, component: t.component, reliability: t.reliability });
  }
  const groupOf = new Map(TERMS.map((t) => [t.id, t.group]));
  // Sub-budgets inside prominence, then component budgets.
  const groupTotals = { size: 0, position: 0, visual: 0 };
  for (const group of ['size', 'position', 'visual'] as const) {
    groupTotals[group] = applyBudget(contributions.filter((c) => groupOf.get(c.feature) === group), GROUP_BUDGET[group]);
  }
  const components = {} as ComponentTotals;
  for (const component of ['prominence', 'competition', 'availability', 'context'] as const) {
    const before = component === 'prominence' ? groupTotals.size + groupTotals.position + groupTotals.visual : 0;
    components[component] = applyBudget(contributions.filter((c) => c.component === component), COMPONENT_BUDGET[component]);
    // Keep group totals consistent if the prominence budget scaled them.
    if (component === 'prominence' && before !== 0 && before !== components.prominence) {
      const k = components.prominence / before;
      groupTotals.size *= k;
      groupTotals.position *= k;
      groupTotals.visual *= k;
    }
  }

  const suppressions = suppressionsFor(f);
  const unclamped = W.BASE + components.prominence + components.competition + components.availability + components.context;
  let score = clamp(unclamped, 0, 1);
  if (suppressions.length > 0) score = Math.min(score, W.SUPPRESSED_SCORE_CAP);
  for (const c of contributions) c.contribution = Math.round(c.contribution * 1e6) / 1e6;
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.feature.localeCompare(b.feature));
  const roundedSum = contributions.reduce((s, c) => s + c.contribution, 0);
  return {
    elementId: f.elementId,
    eligible: true,
    suppressions,
    score: Math.round(score * 1e6) / 1e6,
    prominenceGroups: {
      size: Math.round(groupTotals.size * 1e6) / 1e6,
      position: Math.round(groupTotals.position * 1e6) / 1e6,
      visual: Math.round(groupTotals.visual * 1e6) / 1e6,
    },
    base: W.BASE,
    clampAdjustment: Math.round((score - (W.BASE + roundedSum)) * 1e6) / 1e6,
    components: {
      prominence: Math.round(components.prominence * 1e6) / 1e6,
      competition: Math.round(components.competition * 1e6) / 1e6,
      availability: Math.round(components.availability * 1e6) / 1e6,
      context: Math.round(components.context * 1e6) / 1e6,
    },
    contributions,
  };
}

export const heuristicV1: Predictor = {
  id: 'heuristic-v1',
  version: '1.0.0',
  featureSchema: FEATURE_SCHEMA,
  predict(features: PredictionFeatures[], _context: PagePredictionContext): PredictorOutput[] {
    return features.map(scoreOne);
  },
};
