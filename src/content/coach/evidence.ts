/**
 * Evidence adapters (pure). The Coach never reads the DOM: it consumes structured facts derived
 * from existing outputs — a full PageAnalyzer result, a PredictionResult, a Recorded result.
 * Each adapter keeps only what the rules need, so rules stay small and testable.
 */
import { AA_LARGE_TEXT, AA_NORMAL_TEXT, parseColor } from '../analyzer/color';
import { rectDistance } from '../analyzer/spatial';
import type { FullAnalysisResult, LandmarkType, Rect } from '../analyzer/types';
import type { Band, Confidence, PredictionResult, ReasonCode } from '../prediction/types';
import type { RecordedSessionResult } from '../recorded/types';
import type { ElementBrief, RecordedElementStats, LimitationCode } from '../recorder/types';
import type { MaybeNotClickableSpot } from '../recorded/markers';

/** Controls whose edges are within this distance count as "nearby" (structure evidence). */
export const NEARBY_PX = 96;

export interface StructControl {
  id: number;
  label: string | null;
  tagName: string;
  regionId: number | null;
  rect: Rect;
  shortSide: number;
  area: number;
  /** Own fill or border (a "button-like" treatment); null when style was not measured. */
  treated: boolean | null;
  /** Visual treatment key (fill colour, border, font size/weight) for filled/bordered controls. */
  styleKey: string | null;
  peersNearby: number;
  nearestGap: number | null;
  heuristic: boolean;
}

export interface StructText {
  id: number;
  label: string | null;
  tagName: string;
  isControl: boolean;
  regionId: number | null;
  /** Resolved contrast only; null when unresolved (never guessed). */
  contrast: { ratio: number; target: number; assumedCanvasBase: boolean } | null;
  fontSize: number | null;
  textLength: number;
  charsPerLine: number | null;
  lineHeightRatio: number | null;
}

export interface StructRegion {
  id: number;
  label: string;
  landmark: LandmarkType | null;
  rect: Rect;
  controlIds: number[];
}

export interface StructureEvidence {
  analysisId: string;
  viewportHeight: number;
  documentHeight: number;
  controls: StructControl[];
  texts: StructText[];
  regions: StructRegion[];
  capped: boolean;
}

export function structureEvidence(a: FullAnalysisResult): StructureEvidence {
  const rendered = a.elements.filter((e) => e.render.rendered && !e.positioning.inFixed);
  const controlFacts = rendered.filter((e) => e.interactive && e.ref.kind === 'control');
  const controls: StructControl[] = controlFacts.map((e) => {
    const s = e.style;
    const bg = s ? parseColor(s.backgroundColor) : null;
    const filled = !!bg && bg.a > 0.5;
    const bordered = !!s && s.borderStyle !== 'none' && s.borderWidth.some((w) => w >= 1);
    const treated = s ? filled || bordered : null;
    const r = e.geometry.document;
    return {
      id: e.ref.id,
      label: e.ref.label ?? null,
      tagName: e.ref.tagName,
      regionId: e.regionId,
      rect: r,
      shortSide: Math.min(r.width, r.height),
      area: r.width * r.height,
      treated,
      styleKey: s && treated ? `${s.backgroundColor}|${s.borderStyle}|${Math.round(s.fontSize)}|${s.fontWeight}` : null,
      peersNearby: 0,
      nearestGap: null,
      heuristic: e.interactive?.semantic === false,
    };
  });
  for (const c of controls) {
    let n = 0;
    let gap = Infinity;
    for (const o of controls) {
      if (o === c) continue;
      const d = rectDistance(c.rect, o.rect);
      if (d <= NEARBY_PX) n++;
      gap = Math.min(gap, d);
    }
    c.peersNearby = n;
    c.nearestGap = Number.isFinite(gap) ? Math.round(gap) : null;
  }
  const controlIds = new Set(controls.map((c) => c.id));
  const texts: StructText[] = rendered
    .filter((e) => e.contrast || e.text)
    .map((e) => {
      const c = e.contrast;
      return {
        id: e.ref.id,
        label: e.ref.label ?? null,
        tagName: e.ref.tagName,
        isControl: controlIds.has(e.ref.id),
        regionId: e.regionId,
        contrast: c && c.resolved ? { ratio: c.ratio, target: c.largeText ? AA_LARGE_TEXT : AA_NORMAL_TEXT, assumedCanvasBase: c.assumedCanvasBase } : null,
        fontSize: e.text?.fontSize ?? e.style?.fontSize ?? null,
        textLength: e.text?.textLength ?? 0,
        charsPerLine: e.text?.approxCharsPerLine ?? null,
        lineHeightRatio: e.text?.lineHeightRatio ?? null,
      };
    });
  return {
    analysisId: a.meta.analysisId,
    viewportHeight: a.meta.viewportHeight,
    documentHeight: a.meta.documentHeight,
    controls,
    texts,
    regions: a.regions.map((r) => ({ id: r.id, label: r.label, landmark: r.landmark ?? null, rect: r.rect, controlIds: r.elementRefs.filter((id) => controlIds.has(id)) })),
    capped: a.coverage.elementsCapped,
  };
}

export interface PredControl {
  id: number;
  label: string | null;
  tagName: string;
  regionId: number | null;
  band: Band;
  confidence: Confidence | null;
  rank: number | null;
  raises: ReasonCode[];
  lowers: ReasonCode[];
  caveats: string[];
  peersNearby: number | null;
  peerStrength: number | null;
  strongestInGroup: number | null;
  viewportsDown: number | null;
  landmark: string | null;
}

export interface PredictionEvidence {
  predictionId: string;
  controls: PredControl[];
  regionLabels: Map<number, string>;
  capped: boolean;
}

export function predictionEvidence(p: PredictionResult): PredictionEvidence {
  return {
    predictionId: p.predictionId,
    controls: p.elements.map((e) => ({
      id: e.elementRef.id,
      label: e.elementRef.label ?? null,
      tagName: e.elementRef.tagName,
      regionId: e.regionId,
      band: e.band,
      confidence: e.confidence,
      rank: e.rank,
      raises: e.reasons.filter((r) => r.polarity === 'raises').map((r) => r.code),
      lowers: e.reasons.filter((r) => r.polarity === 'lowers').map((r) => r.code),
      caveats: [...e.caveats],
      peersNearby: e.features?.peersNearby ?? null,
      peerStrength: e.features?.peerStrength ?? null,
      strongestInGroup: e.features?.strongestInGroup ?? null,
      viewportsDown: e.features?.viewportsDown ?? null,
      landmark: e.features?.landmark ?? null,
    })),
    regionLabels: new Map(p.regions.map((r) => [r.regionId, r.label])),
    capped: p.coverage.analysisCapped,
  };
}

/** One recorded page segment's facts. Facts never mix across pages. */
export interface RecordedPageEvidence {
  page: number;
  path: string;
  activeMs: number;
  limitations: Array<LimitationCode | 'REPROJECTION_UNCERTAIN'>;
  deepestPx: number | null;
  elements: RecordedElementStats[];
  neverReached: ElementBrief[];
  regionControls: Map<number, number>;
  regionLabels: Map<number, string>;
  maybeNotClickable: MaybeNotClickableSpot[];
}

export interface RecordedEvidence {
  sessionId: string;
  interrupted: boolean;
  pages: RecordedPageEvidence[];
}

export function recordedEvidence(r: RecordedSessionResult): RecordedEvidence {
  return {
    sessionId: r.sessionId,
    interrupted: r.limitations.includes('RECORDING_INTERRUPTED_UNSUPPORTED_PAGE'),
    pages: r.segments.map((p, page) => ({
      page,
      path: p.pageIdentity.path,
      activeMs: p.facts.activeMs,
      limitations: [...p.limitations, ...(r.limitations.includes('MULTI_PAGE_SESSION_COARSENED') ? (['MULTI_PAGE_SESSION_COARSENED'] as const) : [])],
      deepestPx: p.scrollMetrics.document?.deepestPx ?? null,
      elements: p.elementStats,
      neverReached: p.lists.neverReached.items,
      regionControls: new Map(p.regionStats.filter((g) => g.controls !== undefined).map((g) => [g.regionId, g.controls!])),
      regionLabels: new Map(p.regionStats.map((g) => [g.regionId, g.label])),
      maybeNotClickable: p.maybeNotClickable,
    })),
  };
}
