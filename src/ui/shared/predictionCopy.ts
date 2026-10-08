/**
 * User-facing copy for Predicted Interaction. Explanations only — never advice, never numbers
 * that look like probabilities or measured behaviour.
 */
import type {
  Band,
  CaveatCode,
  Confidence,
  PredictionElementDetails,
  ReasonCode,
  RoleClass,
} from '../../content/prediction/types';

export const STALE_COPY = 'Page changed';
export const PREDICTED_EMPTY = { title: 'No prediction yet', body: 'Estimated from page structure.', action: 'Start prediction' } as const;

export const BAND_COPY: Record<Band, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  'not-assessed': 'Not assessed',
};

export const CONTROL_TYPE_COPY: Record<RoleClass, string> = {
  button: 'Button',
  link: 'Link',
  field: 'Field',
  choice: 'Choice',
  'tab-menu': 'Tab or menu item',
  editable: 'Editable area',
  other: 'Control',
};

const REASON_COPY: Record<ReasonCode, string> = {
  FIRST_VIEWPORT: 'Visible without scrolling',
  LARGE_RELATIVE_SIZE: 'Larger than other controls on the page',
  STRONG_CONTRAST: 'High text contrast',
  FILLED_STYLE: 'Filled visual style',
  VISUALLY_ISOLATED: 'Has space around it',
  FEW_COMPETING_CONTROLS: 'Few controls nearby',
  STRONGEST_IN_GROUP: 'Stands out among the controls around it',
  UNIQUE_STYLE: 'Styled unlike other controls',
  NEAR_HEADING: 'Directly below a heading',
  FIXED_POSITION: 'Stays on screen while scrolling',
  BELOW_FOLD: 'Below the first viewport',
  FAR_DOWN_PAGE: 'Far down the page',
  SMALL_RELATIVE_SIZE: 'Smaller than other controls on the page',
  LOW_CONTRAST: 'Low text contrast',
  MANY_COMPETING_CONTROLS: 'Many controls nearby',
  CROWDED_REGION: 'Inside a dense region',
  WEAKER_THAN_PEERS: 'A nearby control stands out more',
  NAV_CLUSTER: 'One of a group of navigation links',
  FOOTER_CONTEXT: 'In the page footer',
  TINY_TARGET: 'Small target size',
  PARTLY_CLIPPED: 'Partly cut off',
  REDUCED_OPACITY: 'Faded (reduced opacity)',
  HEURISTIC_CONTROL: 'Only the pointer cursor suggests it is clickable',
  DISABLED: 'Disabled',
  NOT_RENDERED: 'Not rendered on the page',
  NEAR_INVISIBLE: 'Nearly invisible',
  UNUSABLE_GEOMETRY: 'Too small to use',
};

/** Reason text; details facts make some reasons specific ("Competes with 6 nearby controls"). */
export function reasonText(code: ReasonCode, facts?: PredictionElementDetails['facts']): string {
  if (code === 'MANY_COMPETING_CONTROLS' && facts?.peersNearby) {
    return `Competes with ${facts.peersNearby} nearby control${facts.peersNearby === 1 ? '' : 's'}`;
  }
  if (code === 'FAR_DOWN_PAGE' && facts?.viewportsDown) return `About ${Math.round(facts.viewportsDown)} screens down the page`;
  return REASON_COPY[code];
}

export const CAVEAT_COPY: Record<CaveatCode, string> = {
  CONTRAST_UNRESOLVED: 'Contrast could not be measured reliably',
  HEURISTIC_DETECTION: 'Recognised as a control only from its pointer cursor',
  WEAK_REGION: 'The page region around it is uncertain',
  STICKY_AMBIGUOUS: 'Sticky positioning — it may or may not stay on screen',
  CLIP_UNCERTAIN: 'It may be partly hidden by a mask or clip-path',
  ANALYSIS_CAPPED: 'The page has more controls than were analysed',
  NEAR_BAND_BOUNDARY: 'Close to the line between two bands',
  CONTRADICTORY_EVIDENCE: 'Strong styling, but heavy competition nearby',
};

/** Qualifier shown next to the band; nothing for high confidence (no percentages). */
export function confidenceQualifier(c: Confidence | null): string | null {
  if (c === 'medium') return 'Lower confidence';
  if (c === 'low') return 'Low confidence';
  return null;
}
