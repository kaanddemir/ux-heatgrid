/**
 * Strategy library: reusable design actions as short imperative phrases (3 variants each). A strategy is
 * only used when a rule's evidence lists it. Phrases describe a design consideration, never an
 * outcome. Rule-specific overrides keep one strategy code meaningful in different contexts.
 */
import type { StrategyCode } from './types';

export const STRATEGY_PHRASES: Record<StrategyCode, readonly string[]> = {
  STRENGTHEN_PRIMARY_HIERARCHY: ['Strengthen the primary action', 'Make the main action more distinct', 'Strengthen the hierarchy of this group'],
  REDUCE_PEER_SIMILARITY: ['Tone down nearby actions', 'Make secondary actions quieter', 'Vary the style of secondary actions'],
  INCREASE_VISUAL_SEPARATION: ['Give it more space or contrast', 'Separate it from nearby actions', 'Set it apart from its neighbours'],
  REDUCE_NEARBY_COMPETITION: ['Reduce competing actions nearby', 'Move less related actions away', 'Simplify the actions around it'],
  GROUP_RELATED_CONTROLS: ['Group related actions', 'Organise these actions into clearer groups', 'Create clearer groups'],
  MOVE_ACTION_EARLIER: ['Move it higher on the page', 'Surface it earlier', 'Place it closer to the top'],
  MOVE_ACTION_NEAR_RELATED_CONTENT: ['Move it closer to the related content', 'Place it next to the content it supports', 'Keep it near the content that introduces it'],
  INCREASE_TARGET_SIZE: ['Enlarge the target', 'Make it at least 24 px', 'Give it a larger hit area'],
  INCREASE_CONTRAST: ['Increase the text contrast', 'Use a stronger colour pair', 'Strengthen the text/background contrast'],
  INCREASE_TEXT_LEGIBILITY: ['Make the text easier to read', 'Improve the legibility of this text', 'Revisit the type settings'],
  CLARIFY_INTERACTIVE_AFFORDANCE: ['Make it look clearly interactive', 'Clarify its interactive styling', 'Strengthen its affordance'],
  SIMPLIFY_REGION: ['Simplify this area', 'Reduce the number of actions here', 'Split this area into smaller groups'],
  INCREASE_SPACING: ['Add space between actions', 'Loosen the spacing', 'Increase the spacing in this group'],
  DIFFERENTIATE_PRIMARY_ACTION: ['Give the main action a distinct style', 'Make one action visibly primary', 'Differentiate the primary action'],
};

/** Rule-specific phrasing for a strategy (key: `${ruleId}:${strategy}`). */
export const STRATEGY_OVERRIDES: Record<string, readonly string[]> = {
  'structure.small-text:INCREASE_TEXT_LEGIBILITY': ['Increase the font size', 'Use a larger text size', 'Set this text larger'],
  'structure.long-lines:INCREASE_TEXT_LEGIBILITY': ['Shorten the line length', 'Narrow the text column', 'Limit the line length'],
  'recorded.hover-no-activation:CLARIFY_INTERACTIVE_AFFORDANCE': ['Check that its label explains the action', 'Clarify its label or styling', 'Make the action clearer'],
  'recorded.maybe-not-clickable:CLARIFY_INTERACTIVE_AFFORDANCE': ['Add a clear clickable style', 'Give it a visible button or link style', 'Strengthen its interactive styling'],
  // The condition already names the main action, so these talk about the element itself.
  'prediction.similar-prominence:STRENGTHEN_PRIMARY_HIERARCHY': ['Give it more emphasis', 'Make it more distinct', 'Strengthen its visual weight'],
  'prediction.similar-prominence:REDUCE_PEER_SIMILARITY': ['Tone down nearby actions', 'Make nearby actions quieter', 'Vary the style of nearby actions'],
};

export function phrasesFor(ruleId: string, s: StrategyCode): readonly string[] {
  return STRATEGY_OVERRIDES[`${ruleId}:${s}`] ?? STRATEGY_PHRASES[s];
}
