/**
 * Feature extraction (features-v1). Pure: reads only a FullAnalysisResult — no DOM access,
 * no second page scan. Converts measured facts into bounded, page-/region-relative features.
 *
 * Normalization rules:
 *  - relative before absolute (size, font size, density are compared with page/region peers)
 *  - log scaling for ratios, then clamping → bounded values
 *  - missing measurements are null, never silently 0 (e.g. unresolved contrast)
 *  - no text analysis: labels/wording are not used
 */
import { composite, contrastRatio, parseColor } from '../analyzer/color';
import { SpatialIndex } from '../analyzer/spatial';
import type { ElementFacts, FullAnalysisResult, Rect, Region } from '../analyzer/types';
import type { LandmarkContext, PagePredictionContext, PredictionFeatures, RoleClass } from './types';
import { W } from './weights';

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number): number => Math.round(v * 10_000) / 10_000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** First index whose value is ≥ v (strict = false) or > v (strict = true). */
function bound(sorted: readonly number[], v: number, strict: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const x = sorted[mid]!;
    if (x < v || (strict && x === v)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Mid-rank percentile of v in an ascending array (0..1): values below plus half the other ties. */
export function percentile(v: number, sorted: readonly number[]): number {
  if (sorted.length <= 1) return 0.5;
  const below = bound(sorted, v, false);
  const equal = bound(sorted, v, true) - below;
  return clamp((below + Math.max(0, equal - 1) / 2) / (sorted.length - 1), 0, 1);
}

/** log2(value / reference), clamped to [-limit, limit] and scaled to [-1, 1]. */
export function logRatio(value: number, reference: number, limit: number): number {
  if (!(value > 0) || !(reference > 0)) return -1;
  return clamp(Math.log2(value / reference), -limit, limit) / limit;
}

/** Smooth monotonic decay: 1 until `grace`, then exp(-rate · (x - grace)). */
export function foldDecay(viewportsDown: number): number {
  return Math.exp(-W.FOLD_DECAY_RATE * Math.max(0, viewportsDown - W.FOLD_GRACE_VIEWPORTS));
}

/** Saturating contrast value: log(ratio) / log(7) in [0, 1]. */
export function contrastValue(ratio: number): number {
  return clamp(Math.log(Math.max(1, ratio)) / Math.log(7), 0, 1);
}

function roleClass(e: ElementFacts): RoleClass {
  const role = e.ref.role;
  const tag = e.ref.tagName;
  if (role === 'tab' || role?.startsWith('menuitem')) return 'tab-menu';
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'option') return 'choice';
  if (e.interactive?.basis === 'contenteditable') return 'editable';
  if (tag === 'button' || role === 'button' || tag === 'summary') return 'button';
  if (tag === 'a' || tag === 'area' || role === 'link') return 'link';
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || role === 'textbox' || role === 'combobox' || role === 'searchbox') {
    return 'field';
  }
  return 'other';
}

/** Eligible for scoring: rendered with usable geometry. (Suppressions are decided by the predictor.) */
export function isAssessable(e: ElementFacts): boolean {
  return e.interactive !== null && e.render.rendered && e.geometry.area > 0;
}

/** Visual strength proxy used only for peer comparison (bounded, built from size + fill + weight). */
function visualStrength(f: Pick<PredictionFeatures, 'relSizePage' | 'fillStrength' | 'fontWeight'>): number {
  return 0.5 * (f.relSizePage ?? 0) + 0.35 * (f.fillStrength ?? 0) + 0.15 * (f.fontWeight ?? 0);
}

function fillStrength(e: ElementFacts): number | null {
  const s = e.style;
  if (!s) return null;
  if (s.backgroundImage && s.backgroundImage !== 'none') return 0.6; // gradient/image fill: filled, strength not measurable
  const own = parseColor(s.backgroundColor);
  if (!own || own.a < 0.5) return 0;
  if (!e.backdrop || !e.backdrop.resolved) return 0.5; // filled, backdrop unknown
  const fill = composite(own, e.backdrop.color);
  return clamp(Math.log(contrastRatio(fill, e.backdrop.color)) / Math.log(4), 0, 1);
}

function styleSignature(e: ElementFacts): string | null {
  const s = e.style;
  if (!s) return null;
  const bg = parseColor(s.backgroundColor);
  const filled = (bg && bg.a >= 0.5) || (s.backgroundImage && s.backgroundImage !== 'none');
  const bordered = s.borderStyle !== 'none' && s.borderWidth.some((w) => w > 0);
  if (!filled && !bordered) return null;
  const q = (n: number): number => Math.round(n / 16);
  const bgKey = s.backgroundImage !== 'none' ? 'img' : bg ? `${q(bg.r)},${q(bg.g)},${q(bg.b)}` : 'none';
  return `${bgKey}|${bordered ? 1 : 0}|${s.fontWeight >= 600 ? 1 : 0}`;
}

const landmarkOf = (region: Region | undefined): LandmarkContext => {
  if (!region) return 'none';
  if (region.landmark && region.landmark !== 'article' && region.landmark !== 'section') return region.landmark;
  return region.kind === 'heading-section' || region.landmark === 'article' || region.landmark === 'section' ? 'main' : 'none';
};

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export interface ExtractedFeatures {
  features: PredictionFeatures[];
  context: PagePredictionContext;
}

export function extractFeatures(analysis: FullAnalysisResult): ExtractedFeatures {
  const vh = Math.max(1, analysis.meta.viewportHeight);
  const candidates = analysis.elements.filter(isAssessable);
  const regionsById = new Map(analysis.regions.map((r) => [r.id, r]));

  const areas = candidates.map((e) => e.geometry.area).sort((a, b) => a - b);
  const ys = candidates.map((e) => e.geometry.document.y).sort((a, b) => a - b);
  const pageMedianArea = median(areas) ?? 1;
  const fontSizes = candidates.map((e) => e.style?.fontSize).filter((v): v is number => typeof v === 'number' && v > 0);
  const medianFont = median(fontSizes);

  const byRegion = new Map<number, ElementFacts[]>();
  for (const e of candidates) {
    if (e.regionId === null) continue;
    const list = byRegion.get(e.regionId) ?? [];
    list.push(e);
    byRegion.set(e.regionId, list);
  }
  const regionMedian = new Map<number, number>();
  for (const [id, list] of byRegion) {
    if (list.length >= W.REGION_MIN_PEERS) regionMedian.set(id, median(list.map((e) => e.geometry.area))!);
  }
  const densities = analysis.regions.filter((r) => r.stats.interactiveCount > 0).map((r) => r.stats.interactivePer100k).sort((a, b) => a - b);

  const signatures = new Map<number, string | null>();
  const signatureCounts = new Map<string, number>();
  for (const e of candidates) {
    const sig = styleSignature(e);
    signatures.set(e.ref.id, sig);
    if (sig) signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
  }

  const candidateIndex = SpatialIndex.build(candidates.map((e) => ({ id: e.ref.id, rect: e.geometry.document })));
  const others = analysis.elements.filter((e) => e.render.rendered && !e.landmark && e.ref.kind !== 'scroll-container');
  const othersIndex = SpatialIndex.build(others.map((e) => ({ id: e.ref.id, rect: e.geometry.document })));
  const rectById = new Map(analysis.elements.map((e) => [e.ref.id, e.geometry.document]));
  // Headings grouped by region (feature lookup is per region, not over every heading).
  const headingsByRegion = new Map<number | null, ElementFacts[]>();
  for (const h of analysis.elements) {
    if (h.ref.kind !== 'heading' || !h.render.rendered) continue;
    const list = headingsByRegion.get(h.regionId) ?? [];
    list.push(h);
    headingsByRegion.set(h.regionId, list);
  }

  // Pass 1: per-element features that do not depend on peers.
  const base = candidates.map((e): PredictionFeatures => {
    const g = e.geometry;
    const rect = g.document;
    const shortSide = Math.min(rect.width, rect.height);
    const regionRef = e.regionId !== null ? regionMedian.get(e.regionId) : undefined;
    const viewportsDown = clamp(g.topInViewportHeights, 0, 10);
    const s = e.style;
    const pad = s ? (s.padding[0] + s.padding[1] + s.padding[2] + s.padding[3]) / 4 : null;
    const region = e.regionId !== null ? regionsById.get(e.regionId) : undefined;
    const sig = signatures.get(e.ref.id);
    const fill = fillStrength(e);
    const heading = (headingsByRegion.get(e.regionId) ?? [])
      .filter((h) => h.geometry.document.y + h.geometry.document.height <= rect.y + 4)
      .map((h) => ({ h, gap: rect.y - (h.geometry.document.y + h.geometry.document.height) }))
      .filter((x) => x.gap <= W.HEADING_GAP_PX)
      .sort((a, b) => a.gap - b.gap)[0];
    const level = heading?.h.text?.headingLevel ?? null;
    return {
      elementId: e.ref.id,
      areaPercentile: round(percentile(g.area, areas)),
      relSizePage: round(logRatio(g.area, pageMedianArea, 3)),
      relSizeRegion: regionRef !== undefined ? round(logRatio(g.area, regionRef, 3)) : null,
      relSize:
        regionRef !== undefined
          ? round((logRatio(g.area, pageMedianArea, 3) + logRatio(g.area, regionRef, 3)) / 2)
          : round(logRatio(g.area, pageMedianArea, 3)),
      shortSide: round(shortSide),
      tinyTarget: shortSide < W.TINY_SHORT_SIDE ? 1 : 0,
      firstViewportFraction: g.firstScreenFraction,
      viewportsDown: round(viewportsDown),
      docYPercentile: round(percentile(rect.y, ys)),
      foldDecay: round(e.positioning.inFixed ? 1 : foldDecay(viewportsDown)),
      contrast: e.contrast?.resolved ? round(contrastValue(e.contrast.ratio)) : null,
      fillStrength: fill === null ? null : round(fill),
      bordered: s ? (s.borderStyle !== 'none' && s.borderWidth.some((w) => w > 0) ? 1 : 0) : null,
      fontSizeRel: s && medianFont ? round(logRatio(s.fontSize, medianFont, 1)) : null,
      fontWeight: s ? round(clamp((s.fontWeight - 400) / 300, -1, 1)) : null,
      paddingRel: s && pad !== null ? round(clamp(pad / Math.max(1, s.fontSize), 0, 2) / 2) : null,
      styleUniqueness: sig && candidates.length >= 3 ? round(1 / signatureCounts.get(sig)!) : null,
      peersNearby: null,
      semanticPeersNearby: null,
      peerStrength: null,
      strongestInGroup: null,
      nearestControlDistance: null,
      regionDensityPercentile: region && region.stats.interactiveCount > 0 ? round(percentile(region.stats.interactivePer100k, densities)) : null,
      clearance: null,
      clipVisibleFraction: e.render.clipVisibleFraction,
      opacity: e.render.opacity,
      disabled: e.render.disabled || e.render.ariaDisabled ? 1 : 0,
      roleClass: roleClass(e),
      landmark: landmarkOf(region),
      headingRelation: heading ? (level !== null && level <= 3 ? 1 : 0.5) : 0,
      fixed: e.positioning.inFixed ? 1 : 0,
      sticky: e.positioning.inSticky && !e.positioning.inFixed ? 1 : 0,
      heuristicDetection: e.interactive?.semantic ? 0 : 1,
    };
  });

  // Pass 2: peer-relative features (competition, isolation).
  const strength = new Map(base.map((f) => [f.elementId, visualStrength(f)]));
  const semantic = new Map(candidates.map((e) => [e.ref.id, e.interactive?.semantic === true]));
  base.forEach((f, i) => {
    const e = candidates[i]!;
    const rect = e.geometry.document;
    const diag = Math.hypot(rect.width, rect.height);
    const radius = clamp(W.PEER_RADIUS_DIAGONALS * diag, W.PEER_RADIUS_MIN, W.PEER_RADIUS_MAX);
    const peers = candidateIndex.queryWithin(rect, radius).filter((id) => id !== f.elementId);
    f.peersNearby = peers.length;
    f.semanticPeersNearby = peers.filter((id) => semantic.get(id)).length;
    const own = strength.get(f.elementId)!;
    if (peers.length > 0) {
      const strongest = Math.max(...peers.map((id) => strength.get(id)!));
      f.peerStrength = round(clamp(own - strongest, -1, 1));
      f.strongestInGroup = peers.length >= 2 && own > strongest + W.STRONGEST_MARGIN ? 1 : 0;
    }
    const nearest = candidateIndex.nearest(rect, (id) => id !== f.elementId);
    f.nearestControlDistance = nearest && diag > 0 ? round(clamp(nearest.distance / diag, 0, 4) / 4) : null;
    // Clearance: nearest rendered element that neither contains nor is contained by the control.
    const near = othersIndex.nearest(rect, (id) => {
      if (id === f.elementId) return false;
      const r = rectById.get(id)!;
      return !contains(r, rect) && !contains(rect, r);
    });
    f.clearance = rect.height > 0 ? round(clamp((near?.distance ?? 3 * rect.height) / rect.height, 0, 3) / 3) : null;
  });

  return {
    features: base,
    context: {
      viewportWidth: analysis.meta.viewportWidth,
      viewportHeight: vh,
      documentHeight: analysis.meta.documentHeight,
      candidateCount: candidates.length,
      analysisCapped: analysis.coverage.elementsCapped || analysis.warnings.includes('TRAVERSAL_CAPPED'),
    },
  };
}
