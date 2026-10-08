/**
 * Coach rules (pure). Each rule declares the evidence it requires, the context it may add, its
 * category, the strategies that evidence supports, and its starting confidence. A rule emits
 * nothing unless every required threshold is met — abstention is the default.
 *
 * Rules never look at label wording, page type or language: only measured structure, predicted
 * structure or recorded session facts.
 */
import type { PredControl, PredictionEvidence, RecordedEvidence, RecordedPageEvidence, StructureEvidence } from './evidence';
import type { CoachCaveat, CoachMode, CoachSubject, EvidenceFact, InsightCandidate, InsightCategory, InsightConfidence, StrategyCode, ThresholdMatch } from './types';

/** Thresholds, centralised. Engineering choices, not scientific constants. */
export const T = {
  denseMinControls: 6,
  denseMaxMedianGapPx: 12,
  similarMinControls: 3,
  similarMaxAreaRatio: 1.25,
  smallTargetPx: 24,
  smallTargetGapPx: 8,
  smallTextPx: 12,
  smallTextMinLength: 80,
  longLineChars: 100,
  longLineMinLength: 300,
  predSimilarMinPeers: 3,
  predSimilarMaxStrengthDiff: 0.12,
  predCrowdMinPeers: 5,
  predLateMinScreens: 1.5,
  predLateMinStrongSignals: 2,
  recInViewMs: 5000,
  recCrowdedRegionControls: 5,
  recInteractionRegionControls: 6,
  recHoverMs: 2500,
  recShortSessionMs: 10_000,
  recNeverReachedGroupMin: 3,
} as const;

export interface RuleInput {
  structure: StructureEvidence | null;
  prediction: PredictionEvidence | null;
  recorded: RecordedEvidence | null;
}

export interface Rule {
  id: string;
  mode: CoachMode;
  category: InsightCategory;
  evaluate(input: RuleInput): InsightCandidate[];
}

const f = (key: string, label: string, value: number | string | boolean, display?: string): EvidenceFact => ({ key, label, value, display: display ?? String(value) });
const th = (fact: string, op: ThresholdMatch['op'], threshold: number | string, value: number | string | boolean): ThresholdMatch => ({ fact, op, threshold, value });
const secs = (ms: number): string => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
const px = (v: number): string => `${Math.round(v)} px`;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function candidate(
  rule: Pick<Rule, 'id' | 'mode' | 'category'>,
  subject: CoachSubject,
  o: { obs: EvidenceFact[]; ctx?: EvidenceFact[]; strategies: StrategyCode[]; thresholds: ThresholdMatch[]; strength: number; actionability: number; confidence: InsightConfidence; caveats?: CoachCaveat[] },
): InsightCandidate {
  return {
    ruleId: rule.id,
    mode: rule.mode,
    category: rule.category,
    subject,
    observationFacts: o.obs,
    contextFacts: (o.ctx ?? []).slice(0, 2),
    strategies: o.strategies,
    thresholds: o.thresholds,
    strength: clamp01(o.strength),
    actionability: clamp01(o.actionability),
    baseConfidence: o.confidence,
    caveats: o.caveats ?? [],
  };
}

const TAG_NOUN: Record<string, string> = { a: 'link', button: 'button', input: 'input', select: 'dropdown', textarea: 'text area', summary: 'disclosure' };
const unlabelled = (tagName: string): string => `Unlabelled ${TAG_NOUN[tagName.toLowerCase()] ?? tagName.toLowerCase()}`;
const elementLabel = (label: string | null | undefined, tagName: string): string => label ?? unlabelled(tagName);
/** Subject name for unlabelled text (no raw tag names in copy). */
const textLabel = (tagName: string): string => {
  const t = tagName.toLowerCase();
  return /^h[1-6]$/.test(t) ? 'Heading text' : t === 'p' ? 'Paragraph text' : t === 'li' ? 'List item text' : 'Text';
};

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const denseRegion: Rule = {
  id: 'structure.dense-region',
  mode: 'structure',
  category: 'DENSITY',
  evaluate({ structure: s }) {
    if (!s) return [];
    const byId = new Map(s.controls.map((c) => [c.id, c]));
    return s.regions.flatMap((r) => {
      const cs = r.controlIds.map((id) => byId.get(id)).filter((c) => !!c);
      if (cs.length < T.denseMinControls) return [];
      const gap = median(cs.map((c) => c.nearestGap ?? Infinity));
      if (!(gap <= T.denseMaxMedianGapPx)) return [];
      const nav = r.landmark === 'nav' || r.landmark === 'header' || r.landmark === 'footer';
      return [
        candidate(this, { kind: 'region', regionId: r.id, label: r.label, elementIds: cs.map((c) => c.id), page: null }, {
          obs: [f('regionControls', 'Controls in region', cs.length), f('medianGap', 'Median gap between controls', gap, px(gap))],
          strategies: cs.length >= 10 ? ['GROUP_RELATED_CONTROLS', 'SIMPLIFY_REGION'] : ['GROUP_RELATED_CONTROLS', 'INCREASE_SPACING'],
          thresholds: [th('regionControls', '>=', T.denseMinControls, cs.length), th('medianGap', '<=', T.denseMaxMedianGapPx, gap)],
          strength: 0.4 + (cs.length - T.denseMinControls) * 0.05 + (T.denseMaxMedianGapPx - gap) * 0.02,
          // Navigation bars are expected to be compact: still factual, but less actionable.
          actionability: nav ? 0.35 : 0.7,
          confidence: s.capped ? 'medium' : 'high',
          caveats: s.capped ? ['ANALYSIS_CAPPED'] : [],
        }),
      ];
    });
  },
};

const similarTreatment: Rule = {
  id: 'structure.similar-treatment',
  mode: 'structure',
  category: 'HIERARCHY',
  evaluate({ structure: s }) {
    if (!s) return [];
    const byId = new Map(s.controls.map((c) => [c.id, c]));
    return s.regions.flatMap((r) => {
      const treated = r.controlIds.map((id) => byId.get(id)).filter((c) => !!c && c.treated && c.styleKey) as NonNullable<ReturnType<typeof byId.get>>[];
      if (treated.length < T.similarMinControls) return [];
      const groups = new Map<string, typeof treated>();
      for (const c of treated) groups.set(c.styleKey!, [...(groups.get(c.styleKey!) ?? []), c]);
      // A distinct treated control that is at least as large as the group = a visible primary: no tension.
      const [key, group] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
      if (group.length < T.similarMinControls) return [];
      const areas = group.map((c) => c.area);
      const ratio = Math.max(...areas) / Math.max(1, Math.min(...areas));
      if (ratio > T.similarMaxAreaRatio) return [];
      const largest = Math.max(...areas);
      if (treated.some((c) => c.styleKey !== key && c.area >= largest * 0.9)) return [];
      return [
        candidate(this, { kind: 'region', regionId: r.id, label: r.label, elementIds: group.map((c) => c.id), page: null }, {
          obs: [f('similarControls', 'Actions with the same treatment', group.length), f('sizeRatio', 'Largest / smallest size', Math.round(ratio * 100) / 100, `${ratio.toFixed(2)}×`)],
          strategies: ['DIFFERENTIATE_PRIMARY_ACTION', 'STRENGTHEN_PRIMARY_HIERARCHY'],
          thresholds: [th('similarControls', '>=', T.similarMinControls, group.length), th('sizeRatio', '<=', T.similarMaxAreaRatio, Math.round(ratio * 100) / 100)],
          strength: 0.45 + (group.length - T.similarMinControls) * 0.08,
          actionability: 0.75,
          confidence: 'medium', // structure alone cannot know which action is meant to be primary
        }),
      ];
    });
  },
};

const lowContrast: Rule = {
  id: 'structure.low-contrast',
  mode: 'structure',
  category: 'CONTRAST',
  evaluate({ structure: s }) {
    if (!s) return [];
    return s.texts.flatMap((t) => {
      // Unresolved contrast never produces an insight.
      if (!t.contrast || t.textLength === 0 || t.contrast.ratio >= t.contrast.target) return [];
      const ratio = Math.round(t.contrast.ratio * 100) / 100;
      return [
        candidate(this, { kind: 'element', elementId: t.id, label: t.label ?? (t.isControl ? unlabelled(t.tagName) : textLabel(t.tagName)), regionId: t.regionId, page: null }, {
          obs: [f('contrastRatio', 'Contrast ratio', ratio, `${ratio.toFixed(2)}:1`), f('contrastTarget', 'Guideline for this text size', t.contrast.target, `${t.contrast.target}:1`)],
          strategies: ['INCREASE_CONTRAST'],
          thresholds: [th('contrastRatio', '<', t.contrast.target, ratio)],
          strength: 0.5 + (t.contrast.target - ratio) / t.contrast.target,
          actionability: 0.85,
          confidence: t.contrast.assumedCanvasBase ? 'medium' : 'high',
          caveats: t.contrast.assumedCanvasBase ? ['CANVAS_ASSUMED'] : [],
        }),
      ];
    });
  },
};

const smallCrowdedTarget: Rule = {
  id: 'structure.small-crowded-target',
  mode: 'structure',
  category: 'SPACING',
  evaluate({ structure: s }) {
    if (!s) return [];
    return s.controls.flatMap((c) => {
      if (c.shortSide <= 0 || c.shortSide >= T.smallTargetPx || c.nearestGap === null || c.nearestGap >= T.smallTargetGapPx) return [];
      return [
        candidate(this, { kind: 'element', elementId: c.id, label: elementLabel(c.label, c.tagName), regionId: c.regionId, page: null }, {
          obs: [f('shortSide', 'Short side', c.shortSide, px(c.shortSide)), f('nearestGap', 'Gap to nearest control', c.nearestGap, px(c.nearestGap))],
          strategies: ['INCREASE_TARGET_SIZE', 'INCREASE_SPACING'],
          thresholds: [th('shortSide', '<', T.smallTargetPx, Math.round(c.shortSide)), th('nearestGap', '<', T.smallTargetGapPx, c.nearestGap)],
          strength: 0.4 + (T.smallTargetPx - c.shortSide) / T.smallTargetPx * 0.4,
          actionability: 0.7,
          confidence: c.heuristic ? 'medium' : 'high',
          caveats: c.heuristic ? ['HEURISTIC_CONTROL'] : [],
        }),
      ];
    });
  },
};

const smallText: Rule = {
  id: 'structure.small-text',
  mode: 'structure',
  category: 'TYPOGRAPHY',
  evaluate({ structure: s }) {
    if (!s) return [];
    return s.texts.flatMap((t) => {
      if (t.isControl || t.fontSize === null || t.fontSize >= T.smallTextPx || t.textLength < T.smallTextMinLength) return [];
      return [
        candidate(this, { kind: 'element', elementId: t.id, label: t.label ?? textLabel(t.tagName), regionId: t.regionId, page: null }, {
          obs: [f('fontSize', 'Font size', t.fontSize, px(t.fontSize)), f('textLength', 'Text length', t.textLength, `${t.textLength} characters`)],
          strategies: ['INCREASE_TEXT_LEGIBILITY'],
          thresholds: [th('fontSize', '<', T.smallTextPx, t.fontSize), th('textLength', '>=', T.smallTextMinLength, t.textLength)],
          strength: 0.4 + (T.smallTextPx - t.fontSize) * 0.1,
          actionability: 0.6,
          confidence: 'high',
        }),
      ];
    });
  },
};

const longLines: Rule = {
  id: 'structure.long-lines',
  mode: 'structure',
  category: 'READABILITY',
  evaluate({ structure: s }) {
    if (!s) return [];
    return s.texts.flatMap((t) => {
      if (t.isControl || t.charsPerLine === null || t.charsPerLine <= T.longLineChars || t.textLength < T.longLineMinLength) return [];
      const chars = Math.round(t.charsPerLine);
      return [
        candidate(this, { kind: 'element', elementId: t.id, label: t.label ?? textLabel(t.tagName), regionId: t.regionId, page: null }, {
          obs: [f('charsPerLine', 'Approx. characters per line', chars, `~${chars}`), f('textLength', 'Text length', t.textLength, `${t.textLength} characters`)],
          strategies: ['INCREASE_TEXT_LEGIBILITY'],
          thresholds: [th('charsPerLine', '>', T.longLineChars, chars), th('textLength', '>=', T.longLineMinLength, t.textLength)],
          strength: 0.35 + Math.min(0.3, (chars - T.longLineChars) / 200),
          actionability: 0.5,
          confidence: 'medium', // characters per line is an estimate
        }),
      ];
    });
  },
};

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

const predCaveats = (c: PredControl): CoachCaveat[] => [...(c.confidence === 'low' ? (['PREDICTION_LOW_CONFIDENCE'] as const) : []), ...(c.caveats.includes('HEURISTIC_DETECTION') ? (['HEURISTIC_CONTROL'] as const) : [])];
const predConfidence = (c: PredControl): InsightConfidence => (c.confidence === 'high' ? 'high' : c.confidence === 'medium' ? 'medium' : 'low');
const predSubject = (c: PredControl): CoachSubject => ({ kind: 'element', elementId: c.id, label: elementLabel(c.label, c.tagName), regionId: c.regionId, page: null });

const similarProminence: Rule = {
  id: 'prediction.similar-prominence',
  mode: 'prediction',
  category: 'HIERARCHY',
  evaluate({ prediction: p }) {
    if (!p) return [];
    return p.controls.flatMap((c) => {
      if (c.band !== 'medium' || c.peersNearby === null || c.peerStrength === null) return [];
      if (c.peersNearby < T.predSimilarMinPeers || Math.abs(c.peerStrength) > T.predSimilarMaxStrengthDiff || c.strongestInGroup === 1) return [];
      return [
        candidate(this, predSubject(c), {
          obs: [f('band', 'Predicted', 'Medium'), f('peersNearby', 'Nearby controls', c.peersNearby)],
          ctx: c.regionId !== null && p.regionLabels.has(c.regionId) ? [f('region', 'Region', p.regionLabels.get(c.regionId)!)] : [],
          strategies: ['STRENGTHEN_PRIMARY_HIERARCHY', 'REDUCE_PEER_SIMILARITY'],
          thresholds: [th('band', '=', 'medium', 'medium'), th('peersNearby', '>=', T.predSimilarMinPeers, c.peersNearby), th('peerStrengthDiff', '<=', T.predSimilarMaxStrengthDiff, Math.round(Math.abs(c.peerStrength) * 100) / 100)],
          strength: 0.45 + Math.min(0.3, c.peersNearby * 0.04) + (c.rank !== null ? Math.max(0, 0.15 - c.rank * 0.01) : 0),
          actionability: 0.8,
          confidence: predConfidence(c),
          caveats: predCaveats(c),
        }),
      ];
    });
  },
};

const weakerInCrowd: Rule = {
  id: 'prediction.weaker-in-crowd',
  mode: 'prediction',
  category: 'COMPETING_CONTROLS',
  evaluate({ prediction: p }) {
    if (!p) return [];
    return p.controls.flatMap((c) => {
      if ((c.band !== 'low' && c.band !== 'medium') || c.peersNearby === null || c.peersNearby < T.predCrowdMinPeers) return [];
      if (!c.lowers.includes('MANY_COMPETING_CONTROLS') || !(c.lowers.includes('CROWDED_REGION') || c.lowers.includes('WEAKER_THAN_PEERS'))) return [];
      // Navigation clusters are crowded by design.
      if (c.lowers.includes('NAV_CLUSTER') || c.landmark === 'nav') return [];
      return [
        candidate(this, predSubject(c), {
          obs: [f('band', 'Predicted', c.band === 'low' ? 'Low' : 'Medium'), f('peersNearby', 'Nearby controls', c.peersNearby)],
          ctx: c.lowers.includes('WEAKER_THAN_PEERS') ? [f('weakerThanPeers', 'Relative strength', 'below the strongest peer')] : [f('crowdedRegion', 'Region density', 'High')],
          strategies: ['REDUCE_NEARBY_COMPETITION', 'INCREASE_VISUAL_SEPARATION'],
          thresholds: [th('peersNearby', '>=', T.predCrowdMinPeers, c.peersNearby), th('reasons', 'in', 'MANY_COMPETING_CONTROLS + CROWDED_REGION|WEAKER_THAN_PEERS', [...c.lowers].join(', '))],
          strength: 0.4 + Math.min(0.3, (c.peersNearby - T.predCrowdMinPeers) * 0.05),
          actionability: 0.65,
          confidence: predConfidence(c),
          caveats: predCaveats(c),
        }),
      ];
    });
  },
};

const STRONG_SIGNALS = ['LARGE_RELATIVE_SIZE', 'FILLED_STYLE', 'STRONG_CONTRAST', 'UNIQUE_STYLE', 'STRONGEST_IN_GROUP'] as const;

const strongButLate: Rule = {
  id: 'prediction.strong-but-late',
  mode: 'prediction',
  category: 'PLACEMENT',
  evaluate({ prediction: p }) {
    if (!p) return [];
    return p.controls.flatMap((c) => {
      if ((c.band !== 'high' && c.band !== 'medium') || c.viewportsDown === null || c.viewportsDown < T.predLateMinScreens) return [];
      if (c.landmark === 'footer' || !(c.lowers.includes('BELOW_FOLD') || c.lowers.includes('FAR_DOWN_PAGE'))) return [];
      const strong = c.raises.filter((r) => (STRONG_SIGNALS as readonly string[]).includes(r));
      if (strong.length < T.predLateMinStrongSignals) return [];
      const screens = Math.round(c.viewportsDown * 10) / 10;
      return [
        candidate(this, predSubject(c), {
          obs: [f('screensDown', 'Starts at', screens, `${screens} screens down`), f('strongSignals', 'Strong structural signals', strong.length)],
          strategies: ['MOVE_ACTION_NEAR_RELATED_CONTENT', 'MOVE_ACTION_EARLIER'],
          thresholds: [th('screensDown', '>=', T.predLateMinScreens, screens), th('strongSignals', '>=', T.predLateMinStrongSignals, strong.length)],
          strength: 0.35 + Math.min(0.3, (c.viewportsDown - T.predLateMinScreens) * 0.1) + strong.length * 0.05,
          actionability: 0.55,
          confidence: c.confidence === 'high' ? 'medium' : 'low', // placement intent is unknown to structure
          caveats: predCaveats(c),
        }),
      ];
    });
  },
};

// ---------------------------------------------------------------------------
// Recorded (per page segment; facts never cross pages)
// ---------------------------------------------------------------------------

function recCaveats(r: RecordedEvidence, p: RecordedPageEvidence): CoachCaveat[] {
  const out: CoachCaveat[] = [];
  const l = p.limitations;
  if (l.includes('SHORT_SESSION')) out.push('SHORT_SESSION');
  if (l.includes('FEW_EVENTS')) out.push('FEW_EVENTS');
  if (l.includes('PAGE_CHANGED')) out.push('PAGE_CHANGED');
  if (l.includes('LONG_SESSION_COARSENED') || l.includes('MULTI_PAGE_SESSION_COARSENED')) out.push('COARSENED');
  if (l.includes('REPROJECTION_UNCERTAIN')) out.push('REPROJECTION_UNCERTAIN');
  if (r.interrupted) out.push('INTERRUPTED');
  return out;
}

/** Absence-based evidence ("nothing happened") needs a session long enough to mean something. */
const tooShortForAbsence = (p: RecordedPageEvidence): boolean => p.activeMs < T.recShortSessionMs || p.limitations.includes('SHORT_SESSION');

function perPage(r: RecordedEvidence | null, fn: (p: RecordedPageEvidence, caveats: CoachCaveat[]) => InsightCandidate[]): InsightCandidate[] {
  if (!r) return [];
  return r.pages.flatMap((p) => fn(p, recCaveats(r, p)));
}

const inViewNoInteraction: Rule = {
  id: 'recorded.in-view-no-interaction',
  mode: 'recorded',
  category: 'SEPARATION',
  evaluate({ recorded }) {
    return perPage(recorded, (p, caveats) => {
      if (tooShortForAbsence(p)) return [];
      return p.elements.flatMap((e) => {
        const ms = e.exposure.exposureMs;
        if (ms < T.recInViewMs || e.hoverEntries + e.clicks + e.activations + e.focusEvents > 0) return [];
        const region = e.regionId !== null ? (p.regionControls.get(e.regionId) ?? null) : null;
        const crowded = region !== null && region >= T.recCrowdedRegionControls;
        return [
          candidate({ ...this, category: crowded ? 'SEPARATION' : 'VISIBILITY' }, { kind: 'element', elementId: e.elementRef, label: elementLabel(e.label, e.tagName), regionId: e.regionId, page: p.page }, {
            obs: [f('inViewMs', 'In view', ms, secs(ms)), f('clicks', 'Clicks', 0), f('hoverEntries', 'Hover', 0)],
            ctx: crowded ? [f('regionControls', 'Controls in its region', region)] : [],
            strategies: crowded ? ['INCREASE_VISUAL_SEPARATION', 'REDUCE_NEARBY_COMPETITION'] : ['INCREASE_VISUAL_SEPARATION'],
            thresholds: [th('inViewMs', '>=', T.recInViewMs, Math.round(ms)), th('interactions', '=', 0, 0), ...(crowded ? [th('regionControls', '>=', T.recCrowdedRegionControls, region)] : [])],
            strength: 0.35 + Math.min(0.4, (ms - T.recInViewMs) / 30_000) + (crowded ? 0.1 : 0),
            actionability: crowded ? 0.7 : 0.45,
            confidence: crowded ? 'high' : 'medium',
            caveats,
          }),
        ];
      });
    });
  },
};

const neverReached: Rule = {
  id: 'recorded.never-reached',
  mode: 'recorded',
  category: 'SCROLL_PLACEMENT',
  evaluate({ recorded }) {
    return perPage(recorded, (p, caveats) => {
      if (tooShortForAbsence(p) || p.deepestPx === null) return [];
      // Position must be known and below the deepest recorded scroll point; otherwise abstain.
      const below = p.neverReached.filter((e) => e.docTop !== undefined && e.docTop > p.deepestPx!);
      if (!below.length) return [];
      const deepest = p.deepestPx;
      if (below.length >= T.recNeverReachedGroupMin) {
        return [
          candidate(this, { kind: 'page', label: 'Below the deepest scroll point', page: p.page }, {
            obs: [f('controlsNotReached', 'Controls not reached', below.length)],
            ctx: [f('belowDeepest', 'Position', 'below the deepest recorded scroll point')],
            strategies: ['MOVE_ACTION_EARLIER'],
            thresholds: [th('controlsNotReached', '>=', T.recNeverReachedGroupMin, below.length), th('docTop', '>', Math.round(deepest), 'all below')],
            strength: 0.45,
            actionability: 0.4,
            confidence: 'medium',
            caveats,
          }),
        ];
      }
      return below.map((e) =>
        candidate(this, { kind: 'element', elementId: e.elementRef, label: elementLabel(e.label, e.tagName), regionId: null, page: p.page }, {
          obs: [f('reached', 'Reached', 'no')],
          ctx: [f('belowDeepest', 'Below deepest scroll', e.docTop! - deepest, px(e.docTop! - deepest))],
          strategies: ['MOVE_ACTION_EARLIER'],
          thresholds: [th('reached', '=', 'no', 'no'), th('docTop', '>', Math.round(deepest), e.docTop!)],
          strength: 0.4 + Math.min(0.2, (e.docTop! - deepest) / 5000),
          actionability: 0.5,
          confidence: 'medium',
          caveats,
        }),
      );
    });
  },
};

const crowdedInteraction: Rule = {
  id: 'recorded.crowded-interaction',
  mode: 'recorded',
  category: 'COMPETING_CONTROLS',
  evaluate({ recorded }) {
    return perPage(recorded, (p, caveats) =>
      p.elements.flatMap((e) => {
        const used = e.clicks + e.activations > 0 || e.hoverDwellMs >= 1000;
        const region = e.regionId !== null ? (p.regionControls.get(e.regionId) ?? null) : null;
        if (!used || region === null || region < T.recInteractionRegionControls) return [];
        return [
          candidate(this, { kind: 'element', elementId: e.elementRef, label: elementLabel(e.label, e.tagName), regionId: e.regionId, page: p.page }, {
            obs: [f('clicks', 'Clicks', e.clicks + e.activations), f('hoverMs', 'Hover time', Math.round(e.hoverDwellMs), secs(e.hoverDwellMs))],
            ctx: [f('regionControls', 'Controls in its region', region)],
            strategies: ['GROUP_RELATED_CONTROLS', 'INCREASE_SPACING'],
            thresholds: [th('interaction', '>=', 1, e.clicks + e.activations + (e.hoverDwellMs >= 1000 ? 1 : 0)), th('regionControls', '>=', T.recInteractionRegionControls, region)],
            strength: 0.3 + Math.min(0.2, (region - T.recInteractionRegionControls) * 0.03),
            actionability: 0.45,
            confidence: 'medium',
            caveats,
          }),
        ];
      }),
    );
  },
};

const maybeNotClickable: Rule = {
  id: 'recorded.maybe-not-clickable',
  mode: 'recorded',
  category: 'CLICK_AFFORDANCE',
  evaluate({ recorded }) {
    return perPage(recorded, (p, caveats) =>
      p.maybeNotClickable.map((s) =>
        candidate(this, { kind: 'page', label: 'Unclear click target', page: p.page, point: { rootId: s.rootId, x: s.x, y: s.y } }, {
          obs: [f('clicks', 'Clicks here', s.clicks), f('interactive', 'Target looks interactive', 'no')],
          strategies: ['CLARIFY_INTERACTIVE_AFFORDANCE'],
          thresholds: [th('clicks', '>=', 1, s.clicks), th('interactive', '=', 'maybe-not', 'maybe-not')],
          strength: 0.55 + Math.min(0.25, (s.clicks - 1) * 0.1),
          actionability: 0.75,
          confidence: s.clicks >= 2 ? 'high' : 'medium',
          caveats,
        }),
      ),
    );
  },
};

const hoverNoActivation: Rule = {
  id: 'recorded.hover-no-activation',
  mode: 'recorded',
  category: 'CLICK_AFFORDANCE',
  evaluate({ recorded }) {
    return perPage(recorded, (p, caveats) => {
      if (tooShortForAbsence(p)) return [];
      return p.elements.flatMap((e) => {
        if (e.hoverDwellMs < T.recHoverMs || e.hoverEntries < 1 || e.clicks + e.activations > 0) return [];
        return [
          candidate(this, { kind: 'element', elementId: e.elementRef, label: elementLabel(e.label, e.tagName), regionId: e.regionId, page: p.page }, {
            obs: [f('hoverMs', 'Hover time', Math.round(e.hoverDwellMs), secs(e.hoverDwellMs)), f('clicks', 'Clicks', 0), f('hoverEntries', 'Hover entries', e.hoverEntries)],
            strategies: ['CLARIFY_INTERACTIVE_AFFORDANCE'],
            thresholds: [th('hoverMs', '>=', T.recHoverMs, Math.round(e.hoverDwellMs)), th('clicks', '=', 0, 0)],
            strength: 0.35 + Math.min(0.25, (e.hoverDwellMs - T.recHoverMs) / 20_000),
            actionability: 0.5,
            confidence: 'medium',
            caveats,
          }),
        ];
      });
    });
  },
};

export const RULES: readonly Rule[] = [
  denseRegion,
  similarTreatment,
  lowContrast,
  smallCrowdedTarget,
  smallText,
  longLines,
  similarProminence,
  weakerInCrowd,
  strongButLate,
  inViewNoInteraction,
  neverReached,
  crowdedInteraction,
  maybeNotClickable,
  hoverNoActivation,
];

export function evaluateRules(input: RuleInput, rules: readonly Rule[] = RULES): InsightCandidate[] {
  return rules.flatMap((r) => r.evaluate(input));
}
