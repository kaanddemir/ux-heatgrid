/**
 * Overlay geometry (pure). Boxes always come from LIVE getBoundingClientRect() reads made by the
 * controller; analysis-time rects are only used to detect layout drift for the selected element.
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Outline gap around an element, so the outline does not cover its edge. */
export const BOX_PAD = 2;
/** Boxes this far outside the viewport are not drawn. */
export const VIEWPORT_MARGIN = 48;

export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}

/**
 * Viewport box to paint for an element: its live rect cut by its clipping ancestors (nested
 * scrollers / overflow:hidden), padded, or null when nothing of it is near the viewport.
 */
export function overlayBox(rect: Box, clips: readonly Box[], viewport: { width: number; height: number }, pad = BOX_PAD): Box | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  let visible: Box | null = rect;
  for (const c of clips) {
    visible = intersect(visible, c);
    if (!visible) return null;
  }
  const near = intersect(visible, { x: -VIEWPORT_MARGIN, y: -VIEWPORT_MARGIN, width: viewport.width + 2 * VIEWPORT_MARGIN, height: viewport.height + 2 * VIEWPORT_MARGIN });
  if (!near) return null;
  return { x: visible.x - pad, y: visible.y - pad, width: visible.width + 2 * pad, height: visible.height + 2 * pad };
}

/** True when the element is not (almost) fully inside the viewport — "Show on page" scrolls then. */
export function needsScroll(rect: Box, viewport: { width: number; height: number }): boolean {
  const m = 8;
  return rect.y < m || rect.x < 0 || rect.y + rect.height > viewport.height - m || rect.x + rect.width > viewport.width;
}

/** Position moved by more than max(16px, 25% of the size), or size changed by more than 25%. */
export function movedMaterially(before: Box, after: Box): boolean {
  const dx = Math.abs(after.x - before.x);
  const dy = Math.abs(after.y - before.y);
  const dw = Math.abs(after.width - before.width) / Math.max(1, before.width);
  const dh = Math.abs(after.height - before.height) / Math.max(1, before.height);
  return dx > Math.max(16, before.width * 0.25) || dy > Math.max(16, before.height * 0.25) || dw > 0.25 || dh > 0.25;
}

export function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}
