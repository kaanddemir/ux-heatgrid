/**
 * Prediction engine (pure): PageAnalysisResult → features → predictor → bands, reasons,
 * confidence → PredictionResult. No DOM access, no second page scan, no prose.
 */
import type { ElementFacts, FullAnalysisResult } from '../analyzer/types';
import { extractFeatures, median } from './features';
import { heuristicV1 } from './heuristic';
import type {
  Band,
  CaveatCode,
  Component,
  Confidence,
  ElementPrediction,
  FeatureContribution,
  PredictionFeatures,
  PredictionReason,
  PredictionResult,
  Predictor,
  PredictorOutput,
  ReasonCode,
  RegionPredictionSummary,
  TermId,
} from './types';
import { WEIGHTS_VERSION, W } from './weights';

// ---------------------------------------------------------------------------
// Banding
// ---------------------------------------------------------------------------

export interface BandingOutput {
  bands: Map<number, Band>;
  ranks: Map<number, number>;
  /** Thresholds actually used (for boundary caveats and debugging). */
  thresholds: { highFloor: number; highRelative: number | null; lowFloor: number; lowRelative: number | null; highCap: number; median: number | null };
}

/**
 * Page-relative bands with absolute floors.
 * High: within the top HIGH_TOP_SHARE (max HIGH_MAX), ≥ HIGH_FLOOR, (n ≥ 3) ≥ median + margin, and
 *       visual distinction (size + visual groups) ≥ HIGH_MIN_DISTINCTION, and semantic detection
 *       (heuristic cursor:pointer-only controls are capped at Medium).
 * Low: suppressed, below LOW_FLOOR, or (n ≥ 5) in the bottom share and ≤ median − margin.
 * Medium: everything else. Rank alone never creates High.
 */
export function assignBands(
  outputs: readonly PredictorOutput[],
  tiebreak: (id: number) => number,
  highEligible: (id: number) => boolean = () => true,
): BandingOutput {
  const ordered = [...outputs].sort((a, b) => b.score - a.score || tiebreak(a.elementId) - tiebreak(b.elementId) || a.elementId - b.elementId);
  const n = ordered.length;
  const med = median(ordered.map((o) => o.score));
  const highCap = Math.min(W.HIGH_MAX, Math.max(1, Math.ceil(W.HIGH_TOP_SHARE * n)));
  const highRelative = n >= 3 && med !== null ? med + W.HIGH_MEDIAN_MARGIN : null;
  const lowRelative = n >= W.LOW_RELATIVE_MIN_N && med !== null ? med - W.LOW_MEDIAN_MARGIN : null;
  const bands = new Map<number, Band>();
  const ranks = new Map<number, number>();
  let highCount = 0;
  ordered.forEach((o, i) => {
    ranks.set(o.elementId, i + 1);
    const suppressed = o.suppressions.length > 0;
    const bottom = n > 1 ? i / (n - 1) >= 1 - W.LOW_BOTTOM_SHARE : false;
    let band: Band = 'medium';
    if (suppressed || o.score < W.LOW_FLOOR || (lowRelative !== null && bottom && o.score <= lowRelative)) {
      band = 'low';
    } else if (
      highCount < highCap &&
      o.score >= W.HIGH_FLOOR &&
      (highRelative === null || o.score >= highRelative) &&
      o.prominenceGroups.size + o.prominenceGroups.visual >= W.HIGH_MIN_DISTINCTION &&
      highEligible(o.elementId)
    ) {
      band = 'high';
      highCount++;
    }
    bands.set(o.elementId, band);
  });
  return { bands, ranks, thresholds: { highFloor: W.HIGH_FLOOR, highRelative, lowFloor: W.LOW_FLOOR, lowRelative, highCap, median: med } };
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

function reasonCode(c: FeatureContribution, f: PredictionFeatures): ReasonCode | null {
  const up = c.contribution > 0;
  const map: Record<TermId, () => ReasonCode | null> = {
    relSize: () => (up ? 'LARGE_RELATIVE_SIZE' : 'SMALL_RELATIVE_SIZE'),
    areaPercentile: () => (up ? 'LARGE_RELATIVE_SIZE' : 'SMALL_RELATIVE_SIZE'),
    firstViewport: () => (up ? 'FIRST_VIEWPORT' : null),
    foldDecay: () => (up ? null : (f.viewportsDown ?? 0) > 3 ? 'FAR_DOWN_PAGE' : 'BELOW_FOLD'),
    contrast: () => (up ? 'STRONG_CONTRAST' : 'LOW_CONTRAST'),
    fillStrength: () => (up ? 'FILLED_STYLE' : null),
    bordered: () => null,
    fontSizeRel: () => null,
    fontWeight: () => null,
    paddingRel: () => null,
    styleUniqueness: () => (up ? 'UNIQUE_STYLE' : null),
    peers: () => (up ? 'FEW_COMPETING_CONTROLS' : 'MANY_COMPETING_CONTROLS'),
    peerStrength: () => (up ? null : 'WEAKER_THAN_PEERS'),
    strongestInGroup: () => (up ? 'STRONGEST_IN_GROUP' : null),
    regionDensity: () => (up ? null : 'CROWDED_REGION'),
    clearance: () => (up ? 'VISUALLY_ISOLATED' : null),
    tinyTarget: () => 'TINY_TARGET',
    clipLoss: () => 'PARTLY_CLIPPED',
    opacityLoss: () => 'REDUCED_OPACITY',
    fixed: () => (up ? 'FIXED_POSITION' : null),
    sticky: () => null,
    headingRelation: () => (up ? 'NEAR_HEADING' : null),
    navCluster: () => 'NAV_CLUSTER',
    footer: () => 'FOOTER_CONTEXT',
    heuristicDetection: () => 'HEURISTIC_CONTROL',
  };
  return map[c.feature]();
}

export function buildReasons(o: PredictorOutput, f: PredictionFeatures): PredictionReason[] {
  const out: PredictionReason[] = o.suppressions.map((code) => ({ code, polarity: 'suppresses', component: 'availability', contribution: 0, reliability: 'core' }));
  const merged = new Map<ReasonCode, PredictionReason>();
  for (const c of o.contributions) {
    if (Math.abs(c.contribution) < W.REASON_MIN_CONTRIBUTION) continue;
    const code = reasonCode(c, f);
    if (!code) continue;
    const existing = merged.get(code);
    if (existing) {
      existing.contribution += c.contribution;
      if (c.reliability === 'core') existing.reliability = 'core';
    } else {
      merged.set(code, { code, polarity: c.contribution > 0 ? 'raises' : 'lowers', component: c.component, contribution: c.contribution, reliability: c.reliability });
    }
  }
  const ranked = [...merged.values()]
    .map((r) => ({ ...r, contribution: Math.round(r.contribution * 1e6) / 1e6 }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.code.localeCompare(b.code));
  return [...out, ...ranked];
}

// ---------------------------------------------------------------------------
// Confidence (independent of band)
// ---------------------------------------------------------------------------

export function caveatsFor(o: PredictorOutput, f: PredictionFeatures, e: ElementFacts, banding: BandingOutput, regionWeak: boolean, analysisCapped: boolean): CaveatCode[] {
  const out: CaveatCode[] = [];
  if (f.contrast === null) out.push('CONTRAST_UNRESOLVED');
  if (f.heuristicDetection === 1) out.push('HEURISTIC_DETECTION');
  if (regionWeak) out.push('WEAK_REGION');
  if (f.sticky === 1) out.push('STICKY_AMBIGUOUS');
  if (e.render.clip === 'uncertain') out.push('CLIP_UNCERTAIN');
  if (analysisCapped) out.push('ANALYSIS_CAPPED');
  const t = banding.thresholds;
  const edges = [t.highFloor, t.lowFloor, t.highRelative, t.lowRelative].filter((x): x is number => x !== null);
  if (o.suppressions.length === 0 && edges.some((edge) => Math.abs(o.score - edge) < W.BOUNDARY_EPSILON)) out.push('NEAR_BAND_BOUNDARY');
  if (o.components.prominence >= W.CONTRADICTION_PROMINENCE && o.components.competition <= W.CONTRADICTION_COMPETITION) out.push('CONTRADICTORY_EVIDENCE');
  return out;
}

export function confidenceFrom(caveats: readonly CaveatCode[]): Confidence {
  if (caveats.length >= W.CONFIDENCE_LOW_AT) return 'low';
  if (caveats.length >= W.CONFIDENCE_MEDIUM_AT) return 'medium';
  return 'high';
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface PredictOptions {
  predictor?: Predictor;
  predictionId?: string;
  createdAt?: number;
  analysisMs?: number;
  now?: () => number;
}

let predictionCounter = 0;

export function predict(analysis: FullAnalysisResult, options: PredictOptions = {}): PredictionResult {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const predictor = options.predictor ?? heuristicV1;
  const t0 = now();
  const { features, context } = extractFeatures(analysis);
  const t1 = now();
  const outputs = predictor.predict(features, context);
  const t2 = now();

  const featureById = new Map(features.map((f) => [f.elementId, f]));
  const factsById = new Map(analysis.elements.map((e) => [e.ref.id, e]));
  const regionsById = new Map(analysis.regions.map((r) => [r.id, r]));
  const banding = assignBands(
    outputs,
    (id) => factsById.get(id)!.geometry.document.y,
    (id) => featureById.get(id)!.heuristicDetection !== 1,
  );

  const elements: ElementPrediction[] = [];
  for (const o of outputs) {
    const f = featureById.get(o.elementId)!;
    const e = factsById.get(o.elementId)!;
    const region = e.regionId !== null ? regionsById.get(e.regionId) : undefined;
    const caveats = caveatsFor(o, f, e, banding, !region || region.kind === 'band', context.analysisCapped);
    elements.push({
      elementRef: e.ref,
      band: banding.bands.get(o.elementId)!,
      rank: banding.ranks.get(o.elementId)!,
      score: o.score,
      components: o.components,
      confidence: confidenceFrom(caveats),
      reasons: buildReasons(o, f),
      caveats,
      regionId: e.regionId,
      rect: e.geometry.document,
      contributions: o.contributions,
      features: f,
    });
  }
  // Interactive candidates that could not be assessed (not rendered / no geometry).
  for (const e of analysis.elements) {
    if (!e.interactive || featureById.has(e.ref.id)) continue;
    elements.push({
      elementRef: e.ref,
      band: 'not-assessed',
      rank: null,
      score: null,
      components: null,
      confidence: null,
      reasons: [{ code: e.render.rendered ? 'UNUSABLE_GEOMETRY' : 'NOT_RENDERED', polarity: 'suppresses', component: 'availability', contribution: 0, reliability: 'core' }],
      caveats: [],
      regionId: null,
      rect: e.geometry.document,
      contributions: [],
      features: null,
    });
  }
  elements.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.elementRef.id - b.elementRef.id);
  const t3 = now();

  const regions: RegionPredictionSummary[] = analysis.regions.map((r) => {
    const inRegion = elements.filter((p) => p.regionId === r.id);
    const assessed = inRegion.filter((p) => p.band !== 'not-assessed');
    return {
      regionId: r.id,
      label: r.label,
      candidates: inRegion.length,
      high: inRegion.filter((p) => p.band === 'high').length,
      medium: inRegion.filter((p) => p.band === 'medium').length,
      low: inRegion.filter((p) => p.band === 'low').length,
      notAssessed: inRegion.filter((p) => p.band === 'not-assessed').length,
      strongestElementId: assessed[0]?.elementRef.id ?? null,
      meanScore: assessed.length ? Math.round((assessed.reduce((s, p) => s + p.score!, 0) / assessed.length) * 1e4) / 1e4 : null,
    };
  });

  const count = (b: Band): number => elements.filter((p) => p.band === b).length;
  predictionCounter += 1;
  const analysisMs = options.analysisMs ?? 0;
  const ms = (a: number, b: number): number => Math.round((b - a) * 100) / 100;
  return {
    predictionId: options.predictionId ?? `p${analysis.meta.layoutVersion}.${predictionCounter}`,
    predictorId: predictor.id,
    predictorVersion: predictor.version,
    weightsVersion: WEIGHTS_VERSION,
    featureSchema: predictor.featureSchema,
    analysisId: analysis.meta.analysisId,
    layoutVersion: analysis.meta.layoutVersion,
    createdAt: options.createdAt ?? Date.now(),
    page: {
      url: analysis.meta.url,
      title: analysis.meta.title,
      viewportWidth: analysis.meta.viewportWidth,
      viewportHeight: analysis.meta.viewportHeight,
      documentHeight: analysis.meta.documentHeight,
    },
    elements,
    regions,
    summary: { assessed: outputs.length, notAssessed: count('not-assessed'), high: count('high'), medium: count('medium'), low: count('low') },
    coverage: {
      candidatesInAnalysis: analysis.elements.filter((e) => e.interactive).length,
      interactiveFound: analysis.coverage.interactiveFound,
      analysisCapped: context.analysisCapped,
      framesNotAnalyzed: analysis.coverage.framesNotAnalyzed,
      warnings: analysis.warnings,
    },
    timings: { analysisMs, featuresMs: ms(t0, t1), predictMs: ms(t1, t2), bandingMs: ms(t2, t3), totalMs: Math.round((analysisMs + (t3 - t0)) * 100) / 100 },
  };
}

// ---------------------------------------------------------------------------
// Engineering diagnostics (not user-facing)
// ---------------------------------------------------------------------------

export interface RankExplanation {
  higher: number;
  lower: number;
  scoreDiff: number;
  componentDiffs: Record<Component, number>;
  /** Term-level differences (higher minus lower), largest first. */
  termDiffs: Array<{ feature: TermId; diff: number }>;
  suppressedLower: boolean;
}

/** Why did element A rank above element B (or vice versa)? */
export function explainRanking(result: PredictionResult, aId: number, bId: number): RankExplanation | null {
  const a = result.elements.find((e) => e.elementRef.id === aId);
  const b = result.elements.find((e) => e.elementRef.id === bId);
  if (!a?.components || !b?.components || a.rank === null || b.rank === null) return null;
  const [hi, lo] = a.rank <= b.rank ? [a, b] : [b, a];
  const terms = new Map<TermId, number>();
  for (const c of hi.contributions) terms.set(c.feature, (terms.get(c.feature) ?? 0) + c.contribution);
  for (const c of lo.contributions) terms.set(c.feature, (terms.get(c.feature) ?? 0) - c.contribution);
  const r = (n: number): number => Math.round(n * 1e4) / 1e4;
  return {
    higher: hi.elementRef.id,
    lower: lo.elementRef.id,
    scoreDiff: r(hi.score! - lo.score!),
    componentDiffs: {
      prominence: r(hi.components!.prominence - lo.components!.prominence),
      competition: r(hi.components!.competition - lo.components!.competition),
      availability: r(hi.components!.availability - lo.components!.availability),
      context: r(hi.components!.context - lo.components!.context),
    },
    termDiffs: [...terms.entries()]
      .map(([feature, diff]) => ({ feature, diff: r(diff) }))
      .filter((t) => t.diff !== 0)
      .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff) || x.feature.localeCompare(y.feature)),
    suppressedLower: lo.reasons.some((x) => x.polarity === 'suppresses'),
  };
}
