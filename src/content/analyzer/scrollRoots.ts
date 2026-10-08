/**
 * Scroll-root facts. No scroll listeners are attached here (Record will do that later).
 *
 * Heuristic for container roots:
 *  - discovery already found elements whose scroll extent exceeds their client extent;
 *  - keep those whose computed overflow on that axis is auto/scroll/overlay (overflow: hidden
 *    can't be scrolled by the user, so it is ignored);
 *  - require a meaningful visible footprint: ≥ 300×200 px, or ≥ 20% of the viewport area;
 *  - rank by visible area (larger first), then scrollable extent, then document order;
 *  - keep at most 8. The document root always exists and is not counted against the cap.
 */
import type { DomReader, ScrollMetrics, ViewportInfo } from './measure';
import type { Rect, ScrollRootFacts } from './types';

export const MAX_SCROLL_ROOTS = 8;
const SCROLLABLE = new Set(['auto', 'scroll', 'overlay']);

export interface ScrollCandidate {
  order: number;
  overflowX: string;
  overflowY: string;
  metrics: ScrollMetrics;
  /** Viewport-relative rect. */
  rect: Rect;
}

export function isScrollable(c: Pick<ScrollCandidate, 'overflowX' | 'overflowY' | 'metrics'>): { x: boolean; y: boolean } {
  const m = c.metrics;
  return {
    x: SCROLLABLE.has(c.overflowX) && m.scrollWidth > m.clientWidth + 1,
    y: SCROLLABLE.has(c.overflowY) && m.scrollHeight > m.clientHeight + 1,
  };
}

function visibleArea(rect: Rect, vp: { width: number; height: number }): number {
  const w = Math.max(0, Math.min(rect.x + rect.width, vp.width) - Math.max(rect.x, 0));
  const h = Math.max(0, Math.min(rect.y + rect.height, vp.height) - Math.max(rect.y, 0));
  return w * h;
}

/** Pure selection. Returns chosen candidates (by index into `candidates`) in rank order. */
export function selectScrollRoots(
  candidates: readonly ScrollCandidate[],
  vp: { width: number; height: number },
  max = MAX_SCROLL_ROOTS,
): { chosen: number[]; found: number; capped: boolean } {
  const vpArea = vp.width * vp.height;
  const eligible = candidates
    .map((c, index) => ({ c, index, area: visibleArea(c.rect, vp) }))
    .filter(({ c, area }) => {
      const s = isScrollable(c);
      if (!s.x && !s.y) return false;
      const bigEnough = (c.rect.width >= 300 && c.rect.height >= 200) || (vpArea > 0 && area / vpArea >= 0.2);
      return bigEnough && area > 0;
    })
    .sort((a, b) => {
      const extentA = a.c.metrics.scrollHeight - a.c.metrics.clientHeight + a.c.metrics.scrollWidth - a.c.metrics.clientWidth;
      const extentB = b.c.metrics.scrollHeight - b.c.metrics.clientHeight + b.c.metrics.scrollWidth - b.c.metrics.clientWidth;
      return b.area - a.area || extentB - extentA || a.c.order - b.c.order;
    });
  return { chosen: eligible.slice(0, max).map((e) => e.index), found: eligible.length, capped: eligible.length > max };
}

export function documentRoot(reader: DomReader, vp: ViewportInfo): ScrollRootFacts {
  const m = reader.documentScrollMetrics();
  const s = reader.style(document.documentElement);
  return {
    id: 0,
    kind: 'document',
    clientWidth: m.clientWidth || vp.width,
    clientHeight: m.clientHeight || vp.height,
    scrollWidth: m.scrollWidth,
    scrollHeight: m.scrollHeight,
    overflowX: s.getPropertyValue('overflow-x') || 'visible',
    overflowY: s.getPropertyValue('overflow-y') || 'visible',
    visibleArea: vp.width * vp.height,
  };
}

export function containerRoot(
  id: number,
  ref: { id: number; selectorHint?: string },
  c: ScrollCandidate,
  vp: { width: number; height: number },
): ScrollRootFacts {
  return {
    id,
    kind: 'container',
    elementRef: ref.id,
    ...(ref.selectorHint ? { selectorHint: ref.selectorHint } : {}),
    clientWidth: c.metrics.clientWidth,
    clientHeight: c.metrics.clientHeight,
    scrollWidth: c.metrics.scrollWidth,
    scrollHeight: c.metrics.scrollHeight,
    overflowX: c.overflowX,
    overflowY: c.overflowY,
    visibleArea: visibleArea(c.rect, vp),
  };
}
