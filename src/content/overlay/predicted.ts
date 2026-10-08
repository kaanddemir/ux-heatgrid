/**
 * Predicted Interaction visual rules (pure): which predicted elements get an outline, and how.
 *
 * Overlay cap (clutter control) — the side-panel list still contains every assessed control:
 *  - High: always drawn (the engine allows at most 5)
 *  - Medium: the MEDIUM_CAP best-ranked
 *  - Low: the LOW_CAP best-ranked when its presentation filter allows it
 *  - Not assessed: never drawn
 *  - the selected element is always drawn, whatever its band or rank
 */
import type { Band } from '../prediction/types';

export const MEDIUM_CAP = 40;
export const LOW_CAP = 60;

export type PaintedBand = Exclude<Band, 'not-assessed'>;
export type OverlayBandFilter = 'all' | PaintedBand;

export interface OverlayCandidate {
  id: number;
  band: Band;
  rank: number | null;
}

export interface OverlayItem {
  id: number;
  band: PaintedBand;
  selected: boolean;
}

export function selectOverlayItems(
  elements: readonly OverlayCandidate[],
  opts: { showLow: boolean; selectedId: number | null; filter?: OverlayBandFilter },
): OverlayItem[] {
  const ranked = elements
    .filter((e): e is OverlayCandidate & { band: PaintedBand } => e.band !== 'not-assessed')
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id - b.id);
  const out: OverlayItem[] = [];
  let medium = 0;
  let low = 0;
  for (const e of ranked) {
    const selected = e.id === opts.selectedId;
    const allowed = !opts.filter || opts.filter === 'all' || opts.filter === e.band;
    let keep = selected || (allowed && e.band === 'high');
    if (!keep && allowed && e.band === 'medium') keep = medium++ < MEDIUM_CAP;
    if (!keep && allowed && e.band === 'low' && opts.showLow) keep = low++ < LOW_CAP;
    if (keep) out.push({ id: e.id, band: e.band, selected });
  }
  return out;
}

/** Identity word on the persistent legend. Never implies probability or measured data. */
export function overlayTitle(stale: boolean): string {
  return stale ? 'Predicted · page changed' : 'Predicted';
}
