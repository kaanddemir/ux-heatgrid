/**
 * Projections of the full PredictionResult for the UI (pure).
 * - toSummaryResult: everything the list / overlay needs, nothing per-feature (GET_PREDICTION).
 * - toElementDetails: the full breakdown for ONE element (GET_PREDICTION_DETAILS).
 */
import type {
  Component,
  ComponentDirection,
  ElementPrediction,
  PredictionElementDetails,
  PredictionResult,
  PredictionSummaryElement,
  PredictionSummaryResult,
  PredictionFeatures,
  ReasonFacts,
} from './types';
import { COMPONENTS } from './types';

/** Reasons carried per element in the summary payload. */
export const SUMMARY_REASONS = 3;
/** |component subtotal| below this is described as neutral. */
export const COMPONENT_NEUTRAL = 0.02;

function summarizeElement(e: ElementPrediction): PredictionSummaryElement {
  return {
    id: e.elementRef.id,
    tagName: e.elementRef.tagName,
    ...(e.elementRef.label ? { label: e.elementRef.label } : {}),
    controlType: e.features?.roleClass ?? null,
    regionId: e.regionId,
    band: e.band,
    rank: e.rank,
    confidence: e.confidence,
    topReasons: e.reasons.slice(0, SUMMARY_REASONS).map((r) => ({ code: r.code, polarity: r.polarity })),
    caveats: [...e.caveats],
  };
}

export function toSummaryResult(r: PredictionResult): PredictionSummaryResult {
  return {
    predictionId: r.predictionId,
    predictorId: r.predictorId,
    predictorVersion: r.predictorVersion,
    weightsVersion: r.weightsVersion,
    featureSchema: r.featureSchema,
    layoutVersion: r.layoutVersion,
    createdAt: r.createdAt,
    summary: { ...r.summary },
    coverage: {
      candidatesInAnalysis: r.coverage.candidatesInAnalysis,
      interactiveFound: r.coverage.interactiveFound,
      analysisCapped: r.coverage.analysisCapped,
    },
    timings: { ...r.timings },
    regions: r.regions
      .filter((g) => g.candidates > 0)
      .map((g) => ({ regionId: g.regionId, label: g.label, high: g.high, medium: g.medium, low: g.low, notAssessed: g.notAssessed })),
    elements: r.elements.map(summarizeElement),
  };
}

export function directionOf(value: number): ComponentDirection {
  if (value >= COMPONENT_NEUTRAL) return 'raises';
  if (value <= -COMPONENT_NEUTRAL) return 'lowers';
  return 'neutral';
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Display facts behind the reasons — inverted from the bounded features, never new measurements. */
export function reasonFacts(f: PredictionFeatures | null): ReasonFacts {
  return {
    peersNearby: f?.peersNearby ?? null,
    viewportsDown: f?.viewportsDown ?? null,
    heuristicDetection: f?.heuristicDetection === 1,
    // relSizePage = log2(area / median) / 3, so the ratio is recoverable up to the ±3 clamp.
    sizeRatio: f?.relSizePage != null ? round1(2 ** (f.relSizePage * 3)) : null,
    // contrast = log(ratio) / log(7), saturating at 7:1.
    contrastRatio: f?.contrast != null ? round1(7 ** f.contrast) : null,
    shortSide: f?.shortSide != null ? Math.round(f.shortSide) : null,
    styleShared: f?.styleUniqueness ? Math.round(1 / f.styleUniqueness) : null,
    bordered: f?.bordered === 1,
    padded: (f?.paddingRel ?? 0) > 0,
  };
}

export function toElementDetails(r: PredictionResult, elementId: number): PredictionElementDetails | null {
  const e = r.elements.find((x) => x.elementRef.id === elementId);
  if (!e) return null;
  const region = e.regionId !== null ? r.regions.find((g) => g.regionId === e.regionId) : undefined;
  const f = e.features;
  return {
    predictionId: r.predictionId,
    element: summarizeElement(e),
    regionLabel: region?.label ?? null,
    reasons: e.reasons.map((x) => ({ ...x })),
    facts: reasonFacts(f),
    components: e.components
      ? (Object.fromEntries(COMPONENTS.map((c) => [c, directionOf(e.components![c])])) as Record<Component, ComponentDirection>)
      : null,
  };
}
