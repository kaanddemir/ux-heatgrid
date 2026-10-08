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
    facts: {
      peersNearby: f?.peersNearby ?? null,
      viewportsDown: f?.viewportsDown ?? null,
      heuristicDetection: f?.heuristicDetection === 1,
    },
    components: e.components
      ? (Object.fromEntries(COMPONENTS.map((c) => [c, directionOf(e.components![c])])) as Record<Component, ComponentDirection>)
      : null,
  };
}
