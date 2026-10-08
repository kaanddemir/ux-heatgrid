/**
 * Recorded Interaction copy. Session-specific, factual language only: what happened in THIS
 * recording. Never users/visitors, attention, gaze, intent, engagement, frustration or scores.
 */
import type { RecordedLimitationCode } from '../../content/recorded/types';
import type { RecordedListItem } from '../../content/recorded/lists';

export const NOT_OPEN_COPY = 'Page not open · map not drawn';
export const NOT_LIVE_COPY = 'Page reloaded since · controls can’t be outlined';
export const LAYOUT_COPY = 'Layout may have changed since recording';

export const LIST_COPY = {
  mostInteracted: { title: 'Interacted Elements' },
  inViewNoInteraction: { title: 'No Interaction' },
} as const;

export const RECORDED_LIMITATION_COPY: Record<RecordedLimitationCode, string> = {
  SHORT_SESSION: 'Short session (under 10 seconds active).',
  LITTLE_SCROLL: 'Little scrolling happened in this session.',
  FEW_EVENTS: 'Few pointer events were recorded.',
  PAGE_CHANGED: 'The page changed substantially while recording.',
  FRAMES_UNSUPPORTED: 'Embedded frames were not recorded.',
  NESTED_SCROLL_UNTRACKED: 'Some scroll areas were not tracked.',
  LONG_SESSION_COARSENED: 'Long session: later pointer data was kept at lower resolution.',
  CANDIDATES_CAPPED: 'Very many controls: only some were tracked.',
  MULTI_PAGE_SESSION_COARSENED: 'Earlier pages were kept at lower resolution to stay within the storage budget.',
  RECORDING_INTERRUPTED_UNSUPPORTED_PAGE: 'Recording was interrupted on a page HeatGrid cannot access.',
  REPROJECTION_UNCERTAIN: 'Some controls moved a lot during recording; their pointer time is shown where it was recorded.',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function percent(fraction: number | null): string {
  return fraction === null ? '—' : `${Math.round(fraction * 100)}%`;
}

export function itemLabel(i: Pick<RecordedListItem, 'label' | 'tagName'>): string {
  return i.label ?? `Unlabelled ${i.tagName}`;
}

const clickText = (n: number): string => plural(n, 'click');
/** Compact duration: "0.3s", "1.6s", "14s". */
const secs = (ms: number): string => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
const hoverText = (ms: number): string => `${secs(ms)} hover`;

/**
 * Row meta: the one or two facts that matter for this list (raw counts only, never a score).
 * Everything else lives in the expanded row.
 */
export function shortMeta(i: RecordedListItem, kind: keyof typeof LIST_COPY): string {
  const clicks = i.clicks + i.activations;
  const hover = i.hoverDwellMs >= 100 ? hoverText(i.hoverDwellMs) : null;
  switch (kind) {
    case 'inViewNoInteraction':
      return `${secs(i.exposureMs)} in view`;
    default:
      return [clicks ? clickText(clicks) : null, hover].filter(Boolean).join(' · ') || (i.focusEvents ? plural(i.focusEvents, 'focus', 'focuses') : plural(i.hoverEntries, 'hover'));
  }
}

/**
 * Expanded-row Activity: recorded interaction only (type / region live in the row and the page).
 * Short values, zero counts left out; "In view" always shows (Never is itself a finding).
 */
export function detailFacts(i: RecordedListItem): Array<[string, string]> {
  const clicks = i.clicks + i.activations;
  const rows: Array<[string, string] | null> = [
    clicks ? ['Clicks', String(clicks)] : null,
    i.hoverEntries && i.hoverDwellMs >= 100 ? ['Hover', secs(i.hoverDwellMs)] : null,
    i.focusEvents ? ['Focus', String(i.focusEvents)] : null,
    ['In view', i.reached ? secs(i.exposureMs) : 'Never'],
  ];
  return rows.filter((r): r is [string, string] => !!r);
}
