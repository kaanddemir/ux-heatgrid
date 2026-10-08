/**
 * Guidance planning + deterministic natural-language composition.
 *
 * plan(): category, ≤ 2 strategies (primary + optional supporting), observation slots, ≤ 2
 * context clauses, hedge and constraints. compose(): picks wording variants with a stable hash of
 * (insight id, category, subject) — never random — so the same evidence always reads the same,
 * and different subjects naturally vary. Copy is built only from the plan's slots.
 */
import { bannedIn, wordCount } from './lint';
import { phrasesFor } from './strategies';
import type { CoachSubject, GuidancePlan, InsightCandidate } from './types';

export const MAX_WORDS = 30;

/** FNV-1a 32-bit. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function subjectKey(s: CoachSubject): string {
  const page = s.page === null ? '' : `p${s.page}-`;
  if (s.kind === 'element') return `${page}e${s.elementId}`;
  if (s.kind === 'region') return `${page}r${s.regionId}`;
  return `${page}page${s.point ? `@${s.point.rootId}:${s.point.x},${s.point.y}` : ''}`;
}

/**
 * Observation templates per rule (no trailing period; `{name}` slots come from facts). Product
 * language: what is on the page, not how the engine scored it. Recorded copy stays session-scoped.
 */
export const OBSERVATIONS: Record<string, readonly string[]> = {
  'structure.dense-region': [
    '{regionControls} actions packed closely together',
    'Many actions sit tightly together here',
    'This area is crowded with {regionControls} actions',
  ],
  'structure.similar-treatment': [
    '{similarControls} actions look the same',
    'Several actions share the same style and size',
    'No action stands out among {similarControls} similar ones',
  ],
  'structure.low-contrast': [
    'Text contrast is below the guideline ({contrastRatio})',
    'Low text contrast ({contrastRatio}, needs {contrastTarget})',
    'This text has low contrast against its background ({contrastRatio})',
  ],
  'structure.small-crowded-target': [
    'Small target ({shortSide}) close to another action',
    'This target is small and tightly spaced',
    'Small {shortSide} target right next to another action',
  ],
  'structure.small-text': [
    'Text is set small ({fontSize})',
    'This text uses a small size ({fontSize})',
    'Small text size here ({fontSize})',
  ],
  'structure.long-lines': [
    'Long lines (about {charsPerLine} characters)',
    'Lines run to about {charsPerLine} characters',
    'This text uses long lines ({charsPerLine} characters)',
  ],
  'prediction.similar-prominence': [
    'Several nearby actions compete for emphasis',
    'Doesn’t stand out from nearby actions',
    'Similar emphasis to {peersNearby} nearby actions',
  ],
  'prediction.weaker-in-crowd': [
    'Less prominent than the actions around it',
    'Sits in a crowded area and stands out less',
    'Nearby actions carry more emphasis',
  ],
  'prediction.strong-but-late': [
    'Prominent but appears late on the page',
    'This action is prominent but sits far down the page',
    'A prominent action placed late on the page',
  ],
  'recorded.in-view-no-interaction': [
    'In view for {inViewMs} this session, not used',
    'Seen for {inViewMs} this session without a hover or click',
    'Visible for {inViewMs} during this recording, no interaction',
  ],
  'recorded.never-reached': [
    'Not reached this session',
    'Scrolling didn’t reach this in this session',
    'Stayed out of view during this recording',
  ],
  'recorded.never-reached:page': [
    '{controlsNotReached} actions not reached this session',
    'In this session, {controlsNotReached} actions stayed out of view',
    '{controlsNotReached} actions stayed out of view during this recording',
  ],
  'recorded.crowded-interaction': [
    'Used this session in a crowded area',
    'Used in a dense group of {regionControls} actions this session',
    'Used during this recording among many actions',
  ],
  'recorded.maybe-not-clickable': [
    'Clicked this session, but doesn’t look clickable',
    'Clicked {clicks}× this session, but doesn’t look clickable',
    'Clicked during this recording; nothing here looks clickable',
  ],
  'recorded.hover-no-activation': [
    'Hovered {hoverMs} this session without a click',
    'The pointer rested here {hoverMs} this session, no click',
    'Hovered for {hoverMs} during this recording, not clicked',
  ],
};

/**
 * Context clauses by fact key. Kept empty: context stays in Evidence, so observations remain one
 * short sentence. (Keys are still planned, so Evidence keeps them.)
 */
const CONTEXT: Record<string, string> = {};

/** Short conditions that keep a suggestion tied to the designer's intent. */
const CONDITIONS: Record<string, string> = {
  'structure.similar-treatment': ' if one should stand out',
  'prediction.similar-prominence': ' if it’s the main action',
  'prediction.strong-but-late': ' if it relates to earlier content',
  'recorded.in-view-no-interaction': ' if it should stand out',
  'recorded.never-reached': ' if it matters to the task',
  'recorded.maybe-not-clickable': ' if it should be clickable',
};

/** Suggestions stay short: a second strategy is added only while the line stays this brief. */
const SUGGESTION_WORDS = 12;

export function plan(c: InsightCandidate): GuidancePlan {
  const slots: Record<string, string> = {};
  for (const x of [...c.observationFacts, ...c.contextFacts]) slots[x.key] = x.display;
  const contextSlots = c.contextFacts.map((x) => x.key).filter((k) => CONTEXT[k]).slice(0, 2);
  return {
    category: c.category,
    strategies: c.strategies.slice(0, 2),
    observationSlots: slots,
    contextSlots,
    hedge: c.mode === 'recorded' ? 'review' : 'consider',
    constraints: { maxWords: MAX_WORDS, sessionScoped: c.mode === 'recorded' },
  };
}

const fill = (t: string, slots: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_, k: string) => slots[k] ?? '');
const sentence = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
};

export interface Composed {
  observation: string;
  suggestion: string;
  /** Strategies actually used in the copy (≤ 2). */
  strategies: GuidancePlan['strategies'];
  variants: { observation: number; suggestion: number };
}

export function compose(c: InsightCandidate, id: string, p: GuidancePlan = plan(c)): Composed {
  const h = stableHash(`${id}|${c.category}|${subjectKey(c.subject)}`);
  const obsKey = c.subject.kind === 'page' && OBSERVATIONS[`${c.ruleId}:page`] ? `${c.ruleId}:page` : c.ruleId;
  const obsVariants = OBSERVATIONS[obsKey] ?? ['This {category} pattern was found'];
  const oi = h % obsVariants.length;
  let observation = fill(obsVariants[oi]!, p.observationSlots);
  for (const k of p.contextSlots) {
    const clause = fill(CONTEXT[k]!, p.observationSlots);
    if (clause && wordCount(observation + ' ' + clause) <= 30) observation += `, ${clause}`;
  }
  observation = sentence(observation);

  const [primary, supporting] = p.strategies;
  const pi = (h >>> 9) % 3;
  const phrase1 = phrasesFor(c.ruleId, primary!)[pi % phrasesFor(c.ruleId, primary!).length]!;
  const cond = CONDITIONS[c.ruleId] ?? '';
  let used = [primary!];
  let suggestion = sentence(`${phrase1}${cond}`);
  if (supporting) {
    const ph2 = phrasesFor(c.ruleId, supporting);
    const second = ph2[(h >>> 13) % ph2.length]!;
    const withSupport = sentence(`${phrase1} or ${second.charAt(0).toLowerCase()}${second.slice(1)}${cond}`);
    if (wordCount(withSupport) <= SUGGESTION_WORDS) {
      suggestion = withSupport;
      used = [primary!, supporting];
    }
  }
  // Group findings (several actions on the page) read in the plural.
  if (obsKey.endsWith(':page')) suggestion = suggestion.replace(/\bit matters\b/g, 'they matter').replace(/\bits\b/g, 'their').replace(/\bit\b/g, 'them');
  const banned = bannedIn(`${observation} ${suggestion}`);
  if (banned.length) throw new Error(`Coach copy failed lint (${banned.join(', ')}): ${observation} ${suggestion}`);
  if (p.constraints.sessionScoped && !/this session|this recording/i.test(observation)) throw new Error(`Recorded copy must be session-scoped: ${observation}`);
  return { observation, suggestion, strategies: used, variants: { observation: oi, suggestion: pi } };
}
