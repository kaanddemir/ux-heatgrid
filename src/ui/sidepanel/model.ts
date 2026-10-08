/**
 * Side-panel navigation + Overview view-model (pure; no DOM, no chrome APIs).
 *
 * Information architecture:  Overview · Predict · Record.
 * Navigation only changes presentation; it never asks an engine to run.
 */
import type { TabSnapshot } from '../../shared/model';

export type Section = 'overview' | 'predict' | 'record';
export const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'predict', label: 'Predict' },
  { id: 'record', label: 'Record' },
];

export interface NavState {
  section: Section;
}

export const INITIAL_NAV: NavState = { section: 'overview' };

export function goSection(n: NavState, section: Section): NavState {
  return n.section === section ? n : { section };
}

/** What the user just asked for, so the panel can route when the result arrives. */
export type Intent = 'predict' | 'stop' | null;

/**
 * Routing on a new snapshot: Predict → the Predict tab once the prediction is ready;
 * Stop → the Record tab once processing has produced a Recorded result.
 * Returns the (possibly unchanged) nav and the remaining intent.
 */
export function route(n: NavState, intent: Intent, next: TabSnapshot): { nav: NavState; intent: Intent } {
  if (intent === 'predict') {
    const st = next.prediction.state;
    if (st === 'ready' || st === 'stale') return { nav: goSection(n, 'predict'), intent: null };
    if (st === 'error' || st === 'idle') return { nav: n, intent: null };
  }
  if (intent === 'stop') {
    const st = next.session.state;
    if (st === 'ready' && next.recorded) return { nav: goSection(n, 'record'), intent: null };
    if (st !== 'processing' && st !== 'recording') return { nav: n, intent: null };
  }
  return { nav: n, intent };
}

/** "1m 42s" / "42s" / "1h 03m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

