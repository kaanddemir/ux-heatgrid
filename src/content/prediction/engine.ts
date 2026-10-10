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
  /**
   * Score distance to the nearest band edge that could actually change this element's band
   * (Infinity when none can, e.g. suppressed). Edges that cannot apply — the High floor for a
   * control that fails the High distinction gate — are ignored.
   */
  margins: Map<number, number>;
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
  const margins = new Map<number, number>();
  const highEdge = Math.max(W.HIGH_FLOOR, highRelative ?? -Infinity);
  const lowEdge = Math.max(W.LOW_FLOOR, lowRelative ?? -Infinity);
  let highCount = 0;
  let lastHigh: number | null = null;
  ordered.forEach((o, i) => {
    ranks.set(o.elementId, i + 1);
    const suppressed = o.suppressions.length > 0;
    const bottom = n > 1 ? i / (n - 1) >= 1 - W.LOW_BOTTOM_SHARE : false;
    const canBeHigh = o.prominenceGroups.size + o.prominenceGroups.visual >= W.HIGH_MIN_DISTINCTION && highEligible(o.elementId);
    let band: Band = 'medium';
    if (suppressed || o.score < W.LOW_FLOOR || (lowRelative !== null && bottom && o.score <= lowRelative)) {
      band = 'low';
    } else if (highCount < highCap && o.score >= W.HIGH_FLOOR && (highRelative === null || o.score >= highRelative) && canBeHigh) {
      band = 'high';
      highCount++;
      lastHigh = o.score;
    }
    bands.set(o.elementId, band);
    // Distance to the edges this element could cross. A Medium below a full High cap would have to
    // overtake the last High; a Low only escapes the relative rule while it is in the bottom share.
    let margin = Infinity;
    if (suppressed) {
      // Suppressions are measured facts; no score change can lift the forced Low.
    } else if (band === 'low') margin = (bottom ? lowEdge : W.LOW_FLOOR) - o.score;
    else {
      margin = o.score - lowEdge;
      if (band === 'high') margin = Math.min(margin, o.score - highEdge);
      else if (canBeHigh) margin = Math.min(margin, Math.max(highEdge, highCount >= highCap && lastHigh !== null ? lastHigh : -Infinity) - o.score);
    }
    margins.set(o.elementId, Math.max(0, Math.round(margin * 1e6) / 1e6));
  });
  return { bands, ranks, margins, thresholds: { highFloor: W.HIGH_FLOOR, highRelative, lowFloor: W.LOW_FLOOR, lowRelative, highCap, median: med } };
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Reason for one contribution, or null when the term is explained together with others (size and
 * competition terms, see buildReasons) or has no user-facing meaning in that direction.
 */
function reasonCode(c: FeatureContribution, f: PredictionFeatures): ReasonCode | null {
  const up = c.contribution > 0;
  const map: Record<TermId, () => ReasonCode | null> = {
    relSize: () => null,
    areaPercentile: () => null,
    firstViewport: () => (up ? 'FIRST_VIEWPORT' : null),
    foldDecay: () => {
      if (up) return null;
      const viewports = f.viewportsDown ?? 0;
      return viewports < 1 ? 'LOW_ON_FIRST_SCREEN' : viewports > 3 ? 'FAR_DOWN_PAGE' : 'BELOW_FOLD';
    },
    contrast: () => (up ? 'STRONG_CONTRAST' : 'LOW_CONTRAST'),
    fillStrength: () => (up ? 'FILLED_STYLE' : null),
    bordered: () => (up ? 'BUTTON_SHAPE' : null),
    paddingRel: () => (up ? 'BUTTON_SHAPE' : null),
    fontSizeRel: () => (up ? 'LARGER_TEXT' : 'SMALLER_TEXT'),
    fontWeight: () => (up ? 'BOLD_TEXT' : 'LIGHT_TEXT'),
    styleUniqueness: () => (up ? 'UNIQUE_STYLE' : null),
    peers: () => null,
    peerStrength: () => (up ? null : 'WEAKER_THAN_PEERS'),
    strongestInGroup: () => (up ? 'STRONGEST_IN_GROUP' : null),
    regionDensity: () => null,
    clearance: () => (up ? 'VISUALLY_ISOLATED' : 'TIGHT_SPACING'),
    tinyTarget: () => 'TINY_TARGET',
    clipLoss: () => 'PARTLY_CLIPPED',
    opacityLoss: () => 'REDUCED_OPACITY',
    fixed: () => (up ? 'FIXED_POSITION' : null),
    sticky: () => (up ? 'STICKY_POSITION' : null),
    headingRelation: () => (up ? 'NEAR_HEADING' : null),
    navCluster: () => null,
    footer: () => 'FOOTER_CONTEXT',
    heuristicDetection: () => 'HEURISTIC_CONTROL',
  };
  return map[c.feature]();
}

/**
 * Terms that measure one idea are explained once, so the same reasoning never appears twice in
 * different words:
 *  - size: page/region size and size rank → one size reason with the NET direction (two size terms
 *    of opposite sign never show as "large" and "small" at once)
 *  - competition: nearby-control count, section density and the navigation cluster → one reason
 *    with the NET direction: FEW_COMPETING_CONTROLS, or NAV_CLUSTER / MANY_COMPETING_CONTROLS /
 *    CROWDED_REGION by the strongest crowding fact (never "few" and "many" at once)
 */
const COMPETITION_TERMS: ReadonlySet<TermId> = new Set(['peers', 'regionDensity', 'navCluster']);

function mergedCode(feature: TermId, contribution: number, f: PredictionFeatures, by: (id: TermId) => number): ReasonCode | null {
  if (feature === 'relSize' || feature === 'areaPercentile') {
    const net = by('relSize') + by('areaPercentile');
    return net > 0 ? 'LARGE_RELATIVE_SIZE' : net < 0 ? 'SMALL_RELATIVE_SIZE' : null;
  }
  if (COMPETITION_TERMS.has(feature)) {
    const net = by('peers') + by('regionDensity') + by('navCluster');
    if (net > 0) return 'FEW_COMPETING_CONTROLS';
    if (net === 0) return null;
    if (by('navCluster') < 0) return 'NAV_CLUSTER';
    return by('peers') < 0 ? 'MANY_COMPETING_CONTROLS' : 'CROWDED_REGION';
  }
  return reasonCode({ feature, contribution } as FeatureContribution, f);
}

export function buildReasons(o: PredictorOutput, f: PredictionFeatures): PredictionReason[] {
  const out: PredictionReason[] = o.suppressions.map((code) => ({ code, polarity: 'suppresses', component: 'availability', contribution: 0, reliability: 'core' }));
  const merged = new Map<ReasonCode, PredictionReason & { lead: number }>();
  const byTerm = new Map(o.contributions.map((c) => [c.feature, c.contribution]));
  const by = (id: TermId): number => byTerm.get(id) ?? 0;
  for (const c of o.contributions) {
    const code = mergedCode(c.feature, c.contribution, f, by);
    if (!code) continue;
    const existing = merged.get(code);
    if (existing) {
      existing.contribution += c.contribution;
      if (c.reliability === 'core') existing.reliability = 'core';
      // The reason belongs to the component of its largest member.
      if (Math.abs(c.contribution) > existing.lead) Object.assign(existing, { component: c.component, lead: Math.abs(c.contribution) });
    } else {
      merged.set(code, { code, polarity: c.contribution > 0 ? 'raises' : 'lowers', component: c.component, contribution: c.contribution, reliability: c.reliability, lead: Math.abs(c.contribution) });
    }
  }
  // The threshold applies to the merged reason: two small signals about one idea can add up.
  const ranked = [...merged.values()]
    .filter((r) => Math.abs(r.contribution) >= W.REASON_MIN_CONTRIBUTION)
    .map(({ lead: _lead, ...r }) => ({ ...r, polarity: r.contribution > 0 ? ('raises' as const) : ('lowers' as const), contribution: Math.round(r.contribution * 1e6) / 1e6 }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.code.localeCompare(b.code));
  return [...out, ...ranked];
}

// ---------------------------------------------------------------------------
// Confidence (independent of band)
//
// Confidence says how STABLE the band is — not how prominent the control is. A Low band can have
// High confidence ("clearly does not stand out") and a High band Low confidence. It combines:
//  - margin: the score distance to the nearest band edge this element could actually cross
//  - uncertainty: the largest score change hidden by what could not be measured (caveats)
// High: the band holds even if every unmeasured input went the other way, and the score is not
//       within the weights' own imprecision (BOUNDARY_EPSILON) of an edge.
// Medium: near an edge, or detected only through cursor:pointer (it may not be a control at all).
// Low: the unmeasured inputs alone could move it into another band.
// ---------------------------------------------------------------------------

export function caveatsFor(o: PredictorOutput, f: PredictionFeatures, e: ElementFacts, margin: number, regionWeak: boolean, analysisCapped: boolean): CaveatCode[] {
  const out: CaveatCode[] = [];
  if (f.contrast === null) out.push('CONTRAST_UNRESOLVED');
  if (f.heuristicDetection === 1) out.push('HEURISTIC_DETECTION');
  if (regionWeak) out.push('WEAK_REGION');
  if (f.sticky === 1) out.push('STICKY_AMBIGUOUS');
  if (e.render.clip === 'uncertain') out.push('CLIP_UNCERTAIN');
  if (analysisCapped) out.push('ANALYSIS_CAPPED');
  if (o.suppressions.length === 0 && margin < W.BOUNDARY_EPSILON) out.push('NEAR_BAND_BOUNDARY');
  if (o.components.prominence >= W.CONTRADICTION_PROMINENCE && o.components.competition <= W.CONTRADICTION_COMPETITION) out.push('CONTRADICTORY_EVIDENCE');
  return out;
}

/** Largest score change each caveat could hide for this element (0 when it cannot move the score). */
export function uncertaintyOf(caveats: readonly CaveatCode[], o: PredictorOutput, f: PredictionFeatures): number {
  const contribution = (id: TermId): number => o.contributions.find((c) => c.feature === id)?.contribution ?? 0;
  let u = 0;
  for (const c of caveats) {
    switch (c) {
      case 'CONTRAST_UNRESOLVED':
        u += W.contrast; // the missing term could have gone either way
        break;
      case 'WEAK_REGION':
        // Section density, plus the region half of the size comparison (when one was made).
        u += W.regionDensity + (f.relSizeRegion !== null && f.relSizePage !== null ? (W.relSize * Math.abs(f.relSizeRegion - f.relSizePage)) / 2 : 0);
        break;
      case 'STICKY_AMBIGUOUS':
        // If it is stuck it behaves like fixed: the fixed bonus and no scroll-distance penalty.
        u += W.fixed - W.sticky + Math.abs(Math.min(0, contribution('foldDecay')));
        break;
      case 'CLIP_UNCERTAIN':
        u += W.clipLoss;
        break;
      case 'ANALYSIS_CAPPED':
        u += W.peers; // unseen neighbours could only add competition
        break;
      case 'CONTRADICTORY_EVIDENCE':
        u += W.CONTRADICTION_SWING;
        break;
      default:
        break; // HEURISTIC_DETECTION is about identity, NEAR_BAND_BOUNDARY is the margin itself
    }
  }
  return Math.round(u * 1e6) / 1e6;
}

export function confidenceFor(margin: number, uncertainty: number, caveats: readonly CaveatCode[]): Confidence {
  if (uncertainty > 0 && margin < uncertainty) return 'low';
  if (margin < W.BOUNDARY_EPSILON || caveats.includes('HEURISTIC_DETECTION')) return 'medium';
  return 'high';
}

/**
 * Document y from which neighbour counts may be incomplete because the analyzer's interactive cap
 * dropped controls, or null when no rendered control was dropped. The analyzer keeps rendered
 * before hidden, semantic before cursor-only, then earlier screens first — so a dropped rendered
 * control lies at or after the last included screen of the last included tier. Cursor-only controls
 * dropped behind a full semantic tier are not tracked (weak evidence of a control either way).
 */
export function capBoundaryY(analysis: FullAnalysisResult): number | null {
  if (analysis.warnings.includes('TRAVERSAL_CAPPED')) return 0; // nodes were never visited: anywhere
  if (analysis.coverage.interactiveFound <= analysis.coverage.interactiveIncluded) return null;
  const included = analysis.elements.filter((e) => e.interactive);
  if (included.some((e) => !e.render.rendered)) return null; // every rendered control made it in
  const tier = included.some((e) => !e.interactive!.semantic) ? included.filter((e) => !e.interactive!.semantic) : included;
  const vh = Math.max(1, analysis.meta.viewportHeight);
  const lastScreen = Math.max(0, ...tier.map((e) => Math.floor(Math.max(0, e.geometry.document.y) / vh)));
  return Math.max(0, lastScreen * vh - W.PEER_RADIUS_MAX);
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
  const capFrom = capBoundaryY(analysis);

  const elements: ElementPrediction[] = [];
  for (const o of outputs) {
    const f = featureById.get(o.elementId)!;
    const e = factsById.get(o.elementId)!;
    const region = e.regionId !== null ? regionsById.get(e.regionId) : undefined;
    const margin = banding.margins.get(o.elementId)!;
    const r = e.geometry.document;
    const caveats = caveatsFor(o, f, e, margin, !region || region.kind === 'band', capFrom !== null && r.y + r.height >= capFrom);
    elements.push({
      elementRef: e.ref,
      band: banding.bands.get(o.elementId)!,
      rank: banding.ranks.get(o.elementId)!,
      score: o.score,
      components: o.components,
      confidence: confidenceFor(margin, uncertaintyOf(caveats, o, f), caveats),
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

