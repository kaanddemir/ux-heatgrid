/**
 * Click markers (pure). Pointer clicks only (keyboard activations have no position). Consecutive
 * clicks within CLICK_CLUSTER_PX and CLICK_CLUSTER_MS on the same root become one marker with a
 * count ("×2"). This is a drawing aid only — it never infers frustration or "rage clicking".
 */
import { CLICK_CLUSTER_MS, CLICK_CLUSTER_PX, MAYBE_NOT_GROUP_PX } from './config';
import type { ClickEvent } from '../recorder/types';

export interface ClickMarker {
  rootId: number;
  x: number;
  y: number;
  count: number;
  /** ms since the page segment started (first click of the marker). */
  t: number;
  elementRef?: number;
  /** At least one click here had no structurally interactive target. */
  maybeNotClickable: boolean;
}

export function clusterClicks(clicks: readonly ClickEvent[]): ClickMarker[] {
  const out: ClickMarker[] = [];
  let last: { m: ClickMarker; t: number } | null = null;
  const sorted = clicks.filter((c) => c.kind === 'pointer' && c.x !== undefined && c.y !== undefined).sort((a, b) => a.t - b.t || a.id - b.id);
  for (const c of sorted) {
    const rootId = c.rootId ?? 0;
    if (last && last.m.rootId === rootId && c.t - last.t <= CLICK_CLUSTER_MS && Math.hypot(c.x! - last.m.x, c.y! - last.m.y) <= CLICK_CLUSTER_PX) {
      last.m.count++;
      last.t = c.t;
      if (c.interactive === 'maybe-not') last.m.maybeNotClickable = true;
      continue;
    }
    const m: ClickMarker = { rootId, x: c.x!, y: c.y!, count: 1, t: c.t, ...(c.elementRef ? { elementRef: c.elementRef } : {}), maybeNotClickable: c.interactive === 'maybe-not' };
    out.push(m);
    last = { m, t: c.t };
  }
  return out;
}

export interface MaybeNotClickableSpot {
  rootId: number;
  x: number;
  y: number;
  clicks: number;
}

/** Positions of clicks whose target did not look structurally interactive, grouped by location. */
export function maybeNotClickableSpots(clicks: readonly ClickEvent[]): MaybeNotClickableSpot[] {
  const out: MaybeNotClickableSpot[] = [];
  for (const c of clicks) {
    if (c.interactive !== 'maybe-not' || c.x === undefined || c.y === undefined) continue;
    const rootId = c.rootId ?? 0;
    const near = out.find((s) => s.rootId === rootId && Math.hypot(s.x - c.x!, s.y - c.y!) <= MAYBE_NOT_GROUP_PX);
    if (near) near.clicks++;
    else out.push({ rootId, x: Math.round(c.x), y: Math.round(c.y), clicks: 1 });
  }
  return out.sort((a, b) => b.clicks - a.clicks || a.y - b.y || a.x - b.x);
}
