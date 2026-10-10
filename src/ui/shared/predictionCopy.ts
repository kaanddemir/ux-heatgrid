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

/** Help (?) next to the Predict heading. */
export const PREDICT_HELP = 'Predicts which page elements stand out visually, not actual user behavior.';

export const STALE_COPY = 'Page changed since this prediction.';
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

/** Short reason labels (row previews, where space is one line). */
const REASON_COPY: Record<ReasonCode, string> = {
  FIRST_VIEWPORT: 'Visible without scrolling',
  LARGE_RELATIVE_SIZE: 'Relatively large control',
  STRONG_CONTRAST: 'Clear text contrast',
  FILLED_STYLE: 'Filled visual style',
  VISUALLY_ISOLATED: 'Has space around it',
  FEW_COMPETING_CONTROLS: 'Few controls nearby',
  STRONGEST_IN_GROUP: 'Stands out among the controls around it',
  UNIQUE_STYLE: 'Uses a less common control style',
  NEAR_HEADING: 'Below a nearby heading',
  FIXED_POSITION: 'Stays on screen while scrolling',
  STICKY_POSITION: 'Sticky positioning',
  LARGER_TEXT: 'Larger text',
  BOLD_TEXT: 'Bold text',
  BUTTON_SHAPE: 'Button-like shape',
  LOW_ON_FIRST_SCREEN: 'Low on the first screen',
  BELOW_FOLD: 'Below the first viewport',
  FAR_DOWN_PAGE: 'Far down the page',
  SMALL_RELATIVE_SIZE: 'Relatively small control',
  LOW_CONTRAST: 'Low text contrast',
  SMALLER_TEXT: 'Smaller text',
  LIGHT_TEXT: 'Light text weight',
  TIGHT_SPACING: 'Little space around it',
  MANY_COMPETING_CONTROLS: 'Many controls nearby',
  CROWDED_REGION: 'Inside a dense region',
  WEAKER_THAN_PEERS: 'A nearby control stands out more',
  NAV_CLUSTER: 'Part of a dense navigation group',
  FOOTER_CONTEXT: 'In the page footer',
  TINY_TARGET: 'Small target size',
  PARTLY_CLIPPED: 'Partly cut off',
  REDUCED_OPACITY: 'Reduced opacity',
  HEURISTIC_CONTROL: 'Only the pointer cursor suggests it is clickable',
  DISABLED: 'Disabled',
  NOT_RENDERED: 'Not rendered on the page',
  NEAR_INVISIBLE: 'Nearly invisible',
  UNUSABLE_GEOMETRY: 'Geometry is too small to assess',
};

/** Short reason label for one-line contexts. */
export function reasonText(code: ReasonCode): string {
  return REASON_COPY[code];
}

type Facts = PredictionElementDetails['facts'];
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** "about 3×" / "about half" — only ever from a measured ratio. */
function times(ratio: number): string {
  if (ratio >= 8) return '8 or more times';
  if (ratio >= 1.5) return `about ${Math.round(ratio * 2) / 2}×`;
  if (ratio <= 0.125) return 'an eighth or less of';
  if (ratio <= 0.3) return 'about a quarter of';
  return 'about half';
}
const ratioText = (r: number): string => (r >= 7 ? '7:1 or more' : `about ${r.toFixed(1)}:1`);

/**
 * Full reason sentence for the Positive / Negative columns: what was measured and how it affects
 * visual prominence. Uses only the measured facts behind the score; falls back to a generic but
 * still explanatory sentence when a fact is missing.
 */
export function reasonDetail(code: ReasonCode, facts?: Facts): string {
  const f = facts;
  switch (code) {
    case 'FIRST_VIEWPORT':
      return 'Visible on the first screen, before any scrolling.';
    case 'LARGE_RELATIVE_SIZE':
      return f?.sizeRatio && f.sizeRatio >= 1.5
        ? `Larger than a typical control on this page (${times(f.sizeRatio)} the area), so it is easier to spot.`
        : 'Larger than most controls on this page, so it is easier to spot.';
    case 'SMALL_RELATIVE_SIZE':
      return f?.sizeRatio && f.sizeRatio <= 0.6
        ? `Smaller than a typical control on this page (${times(f.sizeRatio)} the area), so it stands out less.`
        : 'Smaller than most controls on this page, so it stands out less.';
    case 'STRONG_CONTRAST':
      return f?.contrastRatio ? `Strong text contrast (${ratioText(f.contrastRatio)}) makes it stand out from its background.` : 'Strong text contrast makes it stand out from its background.';
    case 'LOW_CONTRAST':
      return f?.contrastRatio ? `Low text contrast (${ratioText(f.contrastRatio)}) lets it blend into its background.` : 'Low text contrast lets it blend into its background.';
    case 'FILLED_STYLE':
      return 'A solid background fill sets it apart from the surrounding page.';
    case 'BUTTON_SHAPE':
      return f?.bordered && f.padded
        ? 'A border and generous padding give it a distinct button shape.'
        : f?.bordered
          ? 'A visible border separates it from the surrounding content.'
          : 'Generous padding gives it a larger, button-like shape.';
    case 'LARGER_TEXT':
      return 'Its text is larger than on most other controls, which adds visual weight.';
    case 'SMALLER_TEXT':
      return 'Its text is smaller than on most other controls, which makes it easier to overlook.';
    case 'BOLD_TEXT':
      return 'Bold text adds visual weight.';
    case 'LIGHT_TEXT':
      return 'Light, thin text carries little visual weight.';
    case 'UNIQUE_STYLE':
      return f?.styleShared && f.styleShared > 1
        ? `Only ${plural(f.styleShared - 1, 'other control')} on the page ${f.styleShared === 2 ? 'shares' : 'share'} its style, so it stands apart.`
        : 'No other control on the page shares its style, so it stands apart.';
    case 'STRONGEST_IN_GROUP':
      return f?.peersNearby ? `The most prominent of the ${f.peersNearby + 1} controls in this area.` : 'The most prominent control in this area.';
    case 'WEAKER_THAN_PEERS':
      return 'A larger or more strongly styled control nearby stands out more.';
    case 'FEW_COMPETING_CONTROLS':
      return f?.peersNearby === 0 ? 'No other controls nearby compete for attention.' : f?.peersNearby ? `Only ${plural(f.peersNearby, 'other control')} nearby, so little competes with it.` : 'Few other controls nearby compete for attention.';
    case 'MANY_COMPETING_CONTROLS':
      return f?.peersNearby ? `${plural(f.peersNearby, 'other control')} nearby ${f.peersNearby === 1 ? 'competes' : 'compete'} for attention.` : 'Nearby controls compete for attention.';
    case 'CROWDED_REGION':
      return 'Sits in one of the busiest sections of the page, where controls compete for attention.';
    case 'NAV_CLUSTER':
      return f?.peersNearby ? `One of ${f.peersNearby + 1} similar navigation items close together, so no single one stands out.` : 'One of many similar navigation items close together, so no single one stands out.';
    case 'VISUALLY_ISOLATED':
      return 'Whitespace around it separates it from other content.';
    case 'TIGHT_SPACING':
      return 'Little whitespace separates it from the content around it.';
    case 'NEAR_HEADING':
      return 'Placed just below a heading, so it reads as part of that section’s main content.';
    case 'FIXED_POSITION':
      return 'Fixed in place, so it stays on screen while the page scrolls.';
    case 'STICKY_POSITION':
      return 'Sticky positioning can keep it on screen while the page scrolls.';
    case 'LOW_ON_FIRST_SCREEN':
      return 'Near the bottom edge of the first screen, where it is easy to miss.';
    case 'BELOW_FOLD':
      return 'Below the first screen, so it is only seen after scrolling.';
    case 'FAR_DOWN_PAGE':
      return f?.viewportsDown ? `About ${plural(Math.round(f.viewportsDown), 'screen')} down the page, so it takes a lot of scrolling to reach.` : 'Far down the page, so it takes a lot of scrolling to reach.';
    case 'FOOTER_CONTEXT':
      return 'In the footer, where links are usually secondary.';
    case 'TINY_TARGET':
      return f?.shortSide ? `Only ${f.shortSide} px tall or wide, a small target that is easy to overlook.` : 'A small target that is easy to overlook.';
    case 'PARTLY_CLIPPED':
      return 'Partly cut off by its container, so less of it is visible.';
    case 'REDUCED_OPACITY':
      return 'Faded with reduced opacity, which reads as de-emphasised.';
    case 'HEURISTIC_CONTROL':
      return 'Only its pointer cursor suggests it is clickable; it has no button or link semantics.';
    case 'DISABLED':
      return 'Disabled, so it cannot be used right now.';
    case 'NEAR_INVISIBLE':
      return 'Nearly invisible on the page.';
    case 'NOT_RENDERED':
      return 'Not rendered on the page.';
    case 'UNUSABLE_GEOMETRY':
      return 'Too small to assess.';
  }
}

export const CAVEAT_COPY: Record<CaveatCode, string> = {
  CONTRAST_UNRESOLVED: 'Contrast could not be measured reliably',
  HEURISTIC_DETECTION: 'Recognised as a control only from its pointer cursor',
  WEAK_REGION: 'The page region around it is uncertain',
  STICKY_AMBIGUOUS: 'Sticky, so it may not always stay on screen',
  CLIP_UNCERTAIN: 'It may be partly hidden by a mask or clip-path',
  ANALYSIS_CAPPED: 'Some controls further down the page were not analysed, so nearby competition may be undercounted',
  NEAR_BAND_BOUNDARY: 'Close to the line between two bands, so a small change could move it',
  CONTRADICTORY_EVIDENCE: 'Strong styling, but heavy competition nearby',
};

/** What Confidence means — it is about the band's stability, not the element's prominence. */
export const CONFIDENCE_HELP = 'How settled this band is: whether anything that could not be measured, or a nearby band threshold, could change it. Not how prominent the element is.';

/** Qualifier shown next to the band; nothing for high confidence (no percentages). */
export function confidenceQualifier(c: Confidence | null): string | null {
  if (c === 'medium') return 'Lower confidence';
  if (c === 'low') return 'Low confidence';
  return null;
}
