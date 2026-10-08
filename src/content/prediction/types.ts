/**
 * Structural prediction types.
 *
 * Target: STRUCTURAL INTERACTION POTENTIAL — how strongly an interactive control stands out
 * structurally relative to the other controls on the same page. It is not a click, gaze,
 * attention or conversion probability and is not a model of real-user behaviour.
 * Raw scores are internal (ranking, calibration, debugging); users see bands only.
 */
import type { ElementRef, Rect } from '../analyzer/types';

export const FEATURE_SCHEMA = 'features-v1';

export type Component = 'prominence' | 'competition' | 'availability' | 'context';
export const COMPONENTS: readonly Component[] = ['prominence', 'competition', 'availability', 'context'];

/** core: measured and directionally reliable; heuristic: weak structural assumption. */
export type Reliability = 'core' | 'heuristic';

export type RoleClass = 'button' | 'link' | 'field' | 'choice' | 'tab-menu' | 'editable' | 'other';
export type LandmarkContext = 'header' | 'nav' | 'main' | 'footer' | 'aside' | 'form' | 'none';

/** A feature value: a bounded number, or null when it could not be measured. Never silently 0. */
export type FeatureValue = number | null;

/** features-v1. All numeric values are bounded; see features.ts for exact definitions. */
export interface PredictionFeatures {
  elementId: number;
  // Size
  areaPercentile: FeatureValue; // 0..1
  relSizePage: FeatureValue; // log2(area / page median), clamped to [-3, 3], scaled to [-1, 1]
  relSizeRegion: FeatureValue; // same vs region median; null with < 3 region peers
  relSize: FeatureValue; // scored size: mean of page and region scales when the region scale exists, else page
  shortSide: FeatureValue; // px
  tinyTarget: FeatureValue; // 1 when short side < 24px (WCAG 2.2 target-size minimum), else 0
  // Position
  firstViewportFraction: FeatureValue; // 0..1
  viewportsDown: FeatureValue; // top / viewport height, clamped to [0, 10]
  docYPercentile: FeatureValue; // 0..1 among candidates
  foldDecay: FeatureValue; // 1 near the top, smooth exponential decay further down (0..1]
  // Visual treatment
  contrast: FeatureValue; // log(ratio)/log(7), 0..1; null when contrast is unresolved
  fillStrength: FeatureValue; // 0..1 contrast of the control's own fill vs its backdrop; 0 = no fill
  bordered: FeatureValue; // 1 / 0
  fontSizeRel: FeatureValue; // log2(font size / median control font size), clamped to [-1, 1]
  fontWeight: FeatureValue; // (weight - 400) / 300, clamped to [-1, 1]
  paddingRel: FeatureValue; // mean padding / font size, clamped to [0, 2], scaled to [0, 1]
  styleUniqueness: FeatureValue; // 0..1 for filled/bordered controls; null otherwise or with < 3 candidates
  // Competition
  peersNearby: FeatureValue; // count of other assessed controls within the competition radius
  semanticPeersNearby: FeatureValue;
  peerStrength: FeatureValue; // [-1, 1]: own visual strength minus the strongest nearby peer; null without peers
  strongestInGroup: FeatureValue; // 1 when clearly stronger than every nearby peer (≥ 2 peers)
  nearestControlDistance: FeatureValue; // edge distance / own diagonal, clamped to [0, 4], scaled to [0, 1]
  // Density / isolation
  regionDensityPercentile: FeatureValue; // 0..1 among regions with controls; null without region
  clearance: FeatureValue; // distance to nearest unrelated element / own height, [0, 3] → [0, 1]
  // Availability
  clipVisibleFraction: FeatureValue;
  opacity: FeatureValue;
  disabled: FeatureValue; // 1 when disabled or aria-disabled
  // Context
  roleClass: RoleClass;
  landmark: LandmarkContext;
  headingRelation: FeatureValue; // 1 near an h1–h3 above in the same region, 0.5 near h4–h6, 0 none
  fixed: FeatureValue; // 1 / 0
  sticky: FeatureValue; // 1 / 0 (style fact; not necessarily stuck)
  heuristicDetection: FeatureValue; // 1 when detected only through cursor:pointer
}

export interface PagePredictionContext {
  viewportWidth: number;
  viewportHeight: number;
  documentHeight: number;
  candidateCount: number;
  analysisCapped: boolean;
}

/** Scoring terms of heuristic-v1 (one per weight in weights.ts). */
export type TermId =
  | 'relSize'
  | 'areaPercentile'
  | 'firstViewport'
  | 'foldDecay'
  | 'contrast'
  | 'fillStrength'
  | 'bordered'
  | 'fontSizeRel'
  | 'fontWeight'
  | 'paddingRel'
  | 'styleUniqueness'
  | 'strongestInGroup'
  | 'peers'
  | 'peerStrength'
  | 'regionDensity'
  | 'clearance'
  | 'tinyTarget'
  | 'clipLoss'
  | 'opacityLoss'
  | 'fixed'
  | 'sticky'
  | 'headingRelation'
  | 'navCluster'
  | 'footer'
  | 'heuristicDetection';

export interface FeatureContribution {
  /** The scoring term (named after its weight in weights.ts). */
  feature: TermId;
  /** The bounded value fed to the weight (after transforms). */
  transformedValue: number;
  /** Signed share of the raw score after component budgets are applied. */
  contribution: number;
  component: Component;
  reliability: Reliability;
}

export type ComponentTotals = Record<Component, number>;

export type SuppressionCode = 'DISABLED' | 'NOT_RENDERED' | 'NEAR_INVISIBLE' | 'UNUSABLE_GEOMETRY';

export interface PredictorOutput {
  elementId: number;
  eligible: boolean;
  suppressions: SuppressionCode[];
  /** base + Σ contributions + clampAdjustment. Internal only. */
  score: number;
  /** Prominence split into its budgeted groups (debugging and the High distinction gate). */
  prominenceGroups: { size: number; position: number; visual: number };
  base: number;
  clampAdjustment: number;
  components: ComponentTotals;
  contributions: FeatureContribution[];
}

export interface Predictor {
  id: string;
  version: string;
  featureSchema: string;
  predict(features: PredictionFeatures[], context: PagePredictionContext): PredictorOutput[];
}

export type Band = 'high' | 'medium' | 'low' | 'not-assessed';
export type Confidence = 'high' | 'medium' | 'low';

export type RaiseReason =
  | 'FIRST_VIEWPORT'
  | 'LARGE_RELATIVE_SIZE'
  | 'STRONG_CONTRAST'
  | 'FILLED_STYLE'
  | 'VISUALLY_ISOLATED'
  | 'FEW_COMPETING_CONTROLS'
  | 'STRONGEST_IN_GROUP'
  | 'UNIQUE_STYLE'
  | 'NEAR_HEADING'
  | 'FIXED_POSITION';
export type LowerReason =
  | 'BELOW_FOLD'
  | 'FAR_DOWN_PAGE'
  | 'SMALL_RELATIVE_SIZE'
  | 'LOW_CONTRAST'
  | 'MANY_COMPETING_CONTROLS'
  | 'CROWDED_REGION'
  | 'WEAKER_THAN_PEERS'
  | 'NAV_CLUSTER'
  | 'FOOTER_CONTEXT'
  | 'TINY_TARGET'
  | 'PARTLY_CLIPPED'
  | 'REDUCED_OPACITY'
  | 'HEURISTIC_CONTROL';
export type ReasonCode = RaiseReason | LowerReason | SuppressionCode;

export interface PredictionReason {
  code: ReasonCode;
  polarity: 'raises' | 'lowers' | 'suppresses';
  component: Component;
  /** Signed contribution backing this reason (0 for suppressions). */
  contribution: number;
  reliability: Reliability;
}

export type CaveatCode =
  | 'CONTRAST_UNRESOLVED'
  | 'HEURISTIC_DETECTION'
  | 'WEAK_REGION'
  | 'STICKY_AMBIGUOUS'
  | 'CLIP_UNCERTAIN'
  | 'ANALYSIS_CAPPED'
  | 'NEAR_BAND_BOUNDARY'
  | 'CONTRADICTORY_EVIDENCE';

export interface ElementPrediction {
  elementRef: ElementRef;
  band: Band;
  /** 1-based rank among assessed elements; null when not assessed. */
  rank: number | null;
  /** Internal/debug only — never shown to users as a number. */
  score: number | null;
  components: ComponentTotals | null;
  confidence: Confidence | null;
  reasons: PredictionReason[];
  caveats: CaveatCode[];
  regionId: number | null;
  /** Document rect (for later visualization). */
  rect: Rect;
  /** Debug: every contribution, ordered by magnitude. */
  contributions: FeatureContribution[];
  /** Debug: the extracted features. */
  features: PredictionFeatures | null;
}

export interface RegionPredictionSummary {
  regionId: number;
  label: string;
  candidates: number;
  high: number;
  medium: number;
  low: number;
  notAssessed: number;
  strongestElementId: number | null;
  /** Internal/debug: mean structural score of assessed candidates. */
  meanScore: number | null;
}

export interface PredictionTimings {
  analysisMs: number;
  featuresMs: number;
  predictMs: number;
  bandingMs: number;
  totalMs: number;
}

export interface PredictionResult {
  predictionId: string;
  predictorId: string;
  predictorVersion: string;
  weightsVersion: string;
  featureSchema: string;
  analysisId: string;
  layoutVersion: number;
  createdAt: number;
  page: {
    url: string;
    title: string;
    viewportWidth: number;
    viewportHeight: number;
    documentHeight: number;
  };
  elements: ElementPrediction[];
  regions: RegionPredictionSummary[];
  summary: { assessed: number; notAssessed: number; high: number; medium: number; low: number };
  coverage: {
    candidatesInAnalysis: number;
    interactiveFound: number;
    analysisCapped: boolean;
    framesNotAnalyzed: number;
    warnings: string[];
  };
  timings: PredictionTimings;
}

// ---------------------------------------------------------------------------
// UI-facing payloads (Phase 4). The full PredictionResult stays in the content runtime.
// ---------------------------------------------------------------------------

/** One assessed or not-assessed control, without features, contributions or raw scores. */
export interface PredictionSummaryElement {
  id: number;
  tagName: string;
  /** Approved truncated label (≤ 60 chars), when the registry has one. */
  label?: string;
  /** Structural control type (from features-v1 roleClass); null when not assessed. */
  controlType: RoleClass | null;
  regionId: number | null;
  band: Band;
  rank: number | null;
  confidence: Confidence | null;
  /** Up to SUMMARY_REASONS strongest reasons, codes only. */
  topReasons: Array<{ code: ReasonCode; polarity: PredictionReason['polarity'] }>;
  caveats: CaveatCode[];
}

export interface PredictionSummaryRegion {
  regionId: number;
  label: string;
  high: number;
  medium: number;
  low: number;
  notAssessed: number;
}

/** Lightweight result returned by GET_PREDICTION. */
export interface PredictionSummaryResult {
  predictionId: string;
  predictorId: string;
  predictorVersion: string;
  weightsVersion: string;
  featureSchema: string;
  layoutVersion: number;
  createdAt: number;
  summary: PredictionResult['summary'];
  coverage: { candidatesInAnalysis: number; interactiveFound: number; analysisCapped: boolean };
  timings: PredictionTimings;
  regions: PredictionSummaryRegion[];
  /** Ordered by rank (not-assessed last). */
  elements: PredictionSummaryElement[];
}

/** Qualitative direction of a component, for normal (non-developer) UI. */
export type ComponentDirection = 'raises' | 'neutral' | 'lowers';

/** Everything known about one element, returned by GET_PREDICTION_DETAILS. */
export interface PredictionElementDetails {
  predictionId: string;
  element: PredictionSummaryElement;
  regionLabel: string | null;
  reasons: PredictionReason[];
  /** Selected feature values the UI uses to phrase reasons (e.g. "6 nearby controls"). */
  facts: { peersNearby: number | null; viewportsDown: number | null; heuristicDetection: boolean };
  components: Record<Component, ComponentDirection> | null;
}
