/**
 * Does the recorded map still match the open page? (pure; live geometry comes in as arguments)
 *
 * The map is drawn in the root content coordinates captured while recording, and anchored samples
 * were already moved to the controls' rects at Stop. So the question is whether the page has moved
 * SINCE Stop, in a way that matters for what the map shows:
 *  - REPROJECTION_UNCERTAIN: controls already moved too far during recording to be corrected
 *  - the viewport width changed materially (zoom, window, device mode): responsive layouts reflow
 *  - layout anchors (the controls that explain most of the map) moved or disappeared
 * With anchors, document height is ignored: content appended below (lazy loading, infinite
 * scroll) or a closed menu does not move what was recorded. Without anchors (no control was used)
 * the coarse fallback is the old rule: document height drift or a page that changed while recording.
 */
import { LAYOUT_CHANGE_SHARE, LAYOUT_MOVED_SHARE, LAYOUT_SHIFT_PX } from './config';
import type { RectOf } from './reproject';
import type { RecordedPageResult } from './types';

export interface LiveLayout {
  documentHeight: number;
  viewportWidth: number;
  rectOf: RectOf;
}

const drifted = (live: number, recorded: number): boolean => live > 0 && recorded > 0 && Math.abs(live - recorded) / recorded > LAYOUT_CHANGE_SHARE;

/** Weight share of the anchors that moved more than LAYOUT_SHIFT_PX or no longer resolve. */
export function movedAnchorShare(p: Pick<RecordedPageResult, 'layoutAnchors'>, rectOf: RectOf): number {
  let total = 0;
  let moved = 0;
  for (const a of p.layoutAnchors) {
    total += a.weight;
    const r = rectOf(a.elementRef, a.rootId);
    if (!r || !(r.width > 0 && r.height > 0) || Math.abs(r.x - a.x) > LAYOUT_SHIFT_PX || Math.abs(r.y - a.y) > LAYOUT_SHIFT_PX) moved += a.weight;
  }
  return total > 0 ? moved / total : 0;
}

export function layoutMayHaveChanged(p: Pick<RecordedPageResult, 'limitations' | 'layoutAnchors' | 'dimensions'>, live: LiveLayout): boolean {
  if (p.limitations.includes('REPROJECTION_UNCERTAIN')) return true;
  if (drifted(live.viewportWidth, p.dimensions.viewport.width)) return true;
  if (p.layoutAnchors.length) return movedAnchorShare(p, live.rectOf) > LAYOUT_MOVED_SHARE;
  return p.limitations.includes('PAGE_CHANGED') || drifted(live.documentHeight, p.dimensions.documentHeight);
}
