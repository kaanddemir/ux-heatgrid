/**
 * Factual per-page lists (pure). Orderings are explicit lexicographic keys — never a hidden
 * weighted "engagement" score. Copy elsewhere keeps them session-specific.
 */
import { HOVER_MEANINGFUL_MS, IN_VIEW_MEANINGFUL_MS, LIST_MAX } from './config';
import type { ElementBrief, RecordedElementStats, RecordedRegionStats } from '../recorder/types';

export interface RecordedListItem extends ElementBrief {
  region: string | null;
  clicks: number;
  activations: number;
  hoverEntries: number;
  hoverDwellMs: number;
  focusEvents: number;
  exposureMs: number;
  reached: boolean;
}

export interface RecordedLists {
  mostInteracted: RecordedListItem[];
  clicked: RecordedListItem[];
  mostHovered: RecordedListItem[];
  inViewNoInteraction: RecordedListItem[];
  neverReached: { count: number; items: RecordedListItem[] };
}

/** 1. clicks + activations, 2. hover entries, 3. hover dwell, 4. focus — all descending; ties by id. */
export function compareInteracted(a: RecordedElementStats, b: RecordedElementStats): number {
  return (
    b.clicks + b.activations - (a.clicks + a.activations) ||
    b.hoverEntries - a.hoverEntries ||
    b.hoverDwellMs - a.hoverDwellMs ||
    b.focusEvents - a.focusEvents ||
    a.elementRef - b.elementRef
  );
}

export function buildLists(
  elements: readonly RecordedElementStats[],
  regions: readonly RecordedRegionStats[],
  unreached: { count: number; items: readonly ElementBrief[] },
): RecordedLists {
  const regionLabel = new Map(regions.map((r) => [r.regionId, r.label]));
  const item = (e: RecordedElementStats): RecordedListItem => ({
    elementRef: e.elementRef,
    tagName: e.tagName,
    ...(e.role ? { role: e.role } : {}),
    ...(e.label ? { label: e.label } : {}),
    region: e.regionId === null ? null : (regionLabel.get(e.regionId) ?? null),
    clicks: e.clicks,
    activations: e.activations,
    hoverEntries: e.hoverEntries,
    hoverDwellMs: Math.round(e.hoverDwellMs),
    focusEvents: e.focusEvents,
    exposureMs: Math.round(e.exposure.exposureMs),
    reached: e.exposure.reached,
  });
  const top = (xs: RecordedElementStats[]): RecordedListItem[] => xs.slice(0, LIST_MAX).map(item);
  return {
    mostInteracted: top(elements.filter((e) => e.hasActiveInteraction).sort(compareInteracted)),
    clicked: top(elements.filter((e) => e.clicks + e.activations > 0).sort(compareInteracted)),
    mostHovered: top(elements.filter((e) => e.hoverDwellMs >= HOVER_MEANINGFUL_MS).sort((a, b) => b.hoverDwellMs - a.hoverDwellMs || a.elementRef - b.elementRef)),
    inViewNoInteraction: top(
      elements
        .filter((e) => !e.hasActiveInteraction && e.exposure.exposureMs >= IN_VIEW_MEANINGFUL_MS)
        .sort((a, b) => b.exposure.exposureMs - a.exposure.exposureMs || a.elementRef - b.elementRef),
    ),
    neverReached: {
      count: unreached.count,
      items: unreached.items.slice(0, LIST_MAX).map((b) => ({
        ...b,
        region: null,
        clicks: 0,
        activations: 0,
        hoverEntries: 0,
        hoverDwellMs: 0,
        focusEvents: 0,
        exposureMs: 0,
        reached: false,
      })),
    },
  };
}
