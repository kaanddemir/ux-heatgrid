/**
 * Coach presentation copy — INACTIVE (see ./README.md). Kept beside the engine so the composition
 * lint keeps covering every user-facing Coach string; nothing in the shipped extension imports it.
 */
import type { CoachCaveat, CoachMode, InsightCategory } from './types';

export const COACH_TITLE = 'Coach';
export const COACH_EMPTY = 'No issues in the current evidence.';
export const COACH_NO_EVIDENCE = 'Findings from page evidence.';
export const COACH_INTRO = 'Each suggestion lists the measured facts it is based on.';

/**
 * "Why": one short line, only for rules where it adds something the observation and evidence do
 * not already say. Rules without an entry show no Why.
 */
export const WHY_COPY: Record<string, string> = {
  'structure.similar-treatment': 'None of them is clearly larger or styled differently.',
  'structure.low-contrast': 'Measured against the guideline for this text size.',
  'prediction.similar-prominence': 'No nearby action is clearly the strongest.',
};

/**
 * Evidence in product terms (1–3 short facts per finding). Values stay truthful — only the
 * wording changes; numbers appear where they help. `null` hides a fact that adds nothing.
 */
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const EVIDENCE: Record<string, (value: number | string | boolean, display: string) => string | null> = {
  band: (v) => `${v} prominence`,
  peersNearby: (v) => (Number(v) >= 4 ? 'Crowded area' : 'Similar actions nearby'),
  regionControls: (v) => `Crowded area (${plural(Number(v), 'action')})`,
  crowdedRegion: () => 'Crowded area',
  weakerThanPeers: () => 'Less prominent than nearby actions',
  medianGap: (_v, d) => `Tight spacing (${d})`,
  similarControls: (v) => plural(Number(v), 'similar action'),
  sizeRatio: () => null,
  contrastRatio: (_v, d) => `Contrast ${d}`,
  contrastTarget: (_v, d) => `Needs ${d}`,
  shortSide: (_v, d) => `Small target (${d})`,
  nearestGap: (v, d) => (Number(v) > 0 ? `Close to another action (${d})` : 'Touching another action'),
  fontSize: (_v, d) => `Small text (${d})`,
  textLength: () => null,
  charsPerLine: (_v, d) => `Long lines (${d} characters)`,
  screensDown: () => 'Appears late on the page',
  strongSignals: () => 'Visually prominent',
  inViewMs: (_v, d) => `In view ${d}`,
  clicks: (v) => (Number(v) ? plural(Number(v), 'click') : 'No clicks'),
  hoverEntries: (v) => (Number(v) ? null : 'No hover'),
  hoverMs: (_v, d) => `Hovered ${d}`,
  controlsNotReached: (v) => `${plural(Number(v), 'action')} not reached`,
  reached: () => 'Not reached',
  belowDeepest: () => 'Below the deepest scroll',
  interactive: () => 'Doesn’t look clickable',
  region: () => null, // region names are layout, not evidence
};

export function evidenceText(e: { key: string; label: string; value: number | string | boolean; display: string }): string | null {
  const f = EVIDENCE[e.key];
  return f ? f(e.value, e.display) : `${e.label}: ${e.display}`;
}

export interface EvidenceMetric { label: string; value: string }

/** The same evidence, shaped for the compact inspector grid. No values are inferred here. */
export function evidenceMetric(e: { key: string; label: string; value: number | string | boolean; display: string }): EvidenceMetric | null {
  const n = Number(e.value);
  switch (e.key) {
    case 'band': return { label: 'Prominence', value: String(e.value) };
    case 'peersNearby': return { label: 'Surroundings', value: n >= 4 ? 'Crowded area' : `${e.display} nearby` };
    case 'regionControls': return { label: 'Surroundings', value: `Crowded area · ${plural(n, 'action')}` };
    case 'crowdedRegion': return { label: 'Surroundings', value: 'Crowded area' };
    case 'weakerThanPeers': return { label: 'Prominence', value: 'Below nearby actions' };
    case 'medianGap': return { label: 'Spacing', value: e.display };
    case 'similarControls': return { label: 'Same treatment', value: plural(n, 'action') };
    case 'sizeRatio': return null;
    case 'contrastRatio': return { label: 'Contrast ratio', value: e.display };
    case 'contrastTarget': return { label: 'Guideline', value: e.display };
    case 'shortSide': return { label: 'Target size', value: e.display };
    case 'nearestGap': return { label: 'Nearest gap', value: e.display };
    case 'fontSize': return { label: 'Font size', value: e.display };
    case 'textLength': return null;
    case 'charsPerLine': return { label: 'Line length', value: `${e.display} characters` };
    case 'screensDown': return { label: 'Position', value: e.display };
    case 'strongSignals': return { label: 'Prominence', value: 'High' };
    case 'inViewMs': return { label: 'In view', value: e.display };
    case 'clicks': return { label: 'Clicks', value: e.display };
    case 'hoverEntries': return { label: 'Hover entries', value: e.display };
    case 'hoverMs': return { label: 'Hover', value: e.display };
    case 'controlsNotReached': return { label: 'Not reached', value: plural(n, 'action') };
    case 'reached': return { label: 'Reached', value: 'No' };
    case 'belowDeepest': return { label: 'Position', value: n > 0 ? `${e.display} below deepest scroll` : 'Below deepest scroll' };
    case 'interactive': return { label: 'Appearance', value: 'Unclear' };
    case 'region': return null;
    default: return { label: e.label, value: e.display };
  }
}

export const CATEGORY_COPY: Record<InsightCategory, string> = {
  HIERARCHY: 'Hierarchy',
  SEPARATION: 'Separation',
  PLACEMENT: 'Placement',
  COMPETING_CONTROLS: 'Competing controls',
  DENSITY: 'Density',
  VISIBILITY: 'Visibility',
  SCROLL_PLACEMENT: 'Scroll placement',
  SPACING: 'Spacing',
  READABILITY: 'Readability',
  CONTRAST: 'Contrast',
  TYPOGRAPHY: 'Typography',
  CLICK_AFFORDANCE: 'Click affordance',
};

export const MODE_COPY: Record<CoachMode, { filter: string; source: string }> = {
  structure: { filter: 'Structure', source: 'Structure evidence' },
  prediction: { filter: 'Prediction', source: 'Prediction evidence' },
  recorded: { filter: 'Recorded', source: 'Recorded evidence · this session' },
};

export const CAVEAT_COPY: Record<CoachCaveat, string> = {
  SHORT_SESSION: 'Short recording.',
  FEW_EVENTS: 'Few recorded events.',
  PAGE_CHANGED: 'The page changed during recording.',
  COARSENED: 'Part of the recording was kept at lower resolution.',
  REPROJECTION_UNCERTAIN: 'Some recorded positions are approximate.',
  INTERRUPTED: 'The recording was interrupted on an unsupported page.',
  PREDICTION_LOW_CONFIDENCE: 'The prediction for this control has low confidence.',
  ANALYSIS_CAPPED: 'Only part of the page was analysed.',
  CANVAS_ASSUMED: 'Background colour partly assumed.',
  HEURISTIC_CONTROL: 'Detected as interactive by styling only.',
};

export const FOCUS_COPY = {
  'not-open': 'Its recorded page is not open.',
  unavailable: 'Not on the current page.',
} as const;
