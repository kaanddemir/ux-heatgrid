/**
 * Pointer movement → time-weighted samples.
 * - mouse and pen only (touch movement is ignored in V2)
 * - at most MAX_HZ retained samples per second (≤ one per frame at 60 Hz), and only after
 *   moving ≥ MIN_MOVE_PX since the last retained sample
 * - each sample's weight = ACTIVE time until the next retained sample (or until the dwell is
 *   closed: pointer leaves the document, tab hidden, stop), capped at DWELL_CAP_MS.
 *   Active time already excludes idle and hidden periods (see idle.ts), so sampling frequency
 *   does not determine the total weight — time does.
 * - samples over a candidate control are anchored: elementRef + position within it (0–1).
 * Per sample: one cached root lookup, one cached geometry read, one cached element rect read.
 */
import { toRootCoords } from './roots';
import type { RecorderContext } from './context';
import { asElement } from './targets';

export const MAX_HZ = 30;
export const MIN_INTERVAL_MS = 1000 / MAX_HZ;
export const MIN_MOVE_PX = 4;
export const DWELL_CAP_MS = 1000;

export class PointerTracker {
  private last: { t: number; cx: number; cy: number; active: number } | null = null;
  private rects = new Map<Element, { epoch: number; r: DOMRect }>();

  constructor(private readonly ctx: RecorderContext) {}

  onMove(e: PointerEvent): void {
    if (e.pointerType === 'touch' || !e.isTrusted) return;
    const t = this.ctx.now();
    this.ctx.input(t);
    const last = this.last;
    if (last) {
      if (t - last.t < MIN_INTERVAL_MS - 0.5) return;
      if (Math.hypot(e.clientX - last.cx, e.clientY - last.cy) < MIN_MOVE_PX) return;
    }
    this.closeDwell(t);
    const target = asElement(e.target);
    const root = this.ctx.roots.rootFor(target);
    const { x, y } = toRootCoords(e.clientX, e.clientY, this.ctx.roots.geometryOf(root));
    const control = this.ctx.resolver.controlFor(target);
    let anchorX = Number.NaN;
    let anchorY = Number.NaN;
    if (control) {
      const r = this.rectOf(control.el);
      if (r.width > 0 && r.height > 0) {
        anchorX = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        anchorY = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      }
    }
    this.ctx.buffer.push({ t: t - this.ctx.t0, rootId: root.id, x, y, elementRef: control?.id ?? 0, anchorX, anchorY });
    this.last = { t, cx: e.clientX, cy: e.clientY, active: this.ctx.clock.activeAt(t) };
  }

  /** Closes the open sample's dwell at time t (leave / hidden / stop / next sample). */
  closeDwell(t: number): void {
    if (!this.last || !this.ctx.buffer.hasOpen) return;
    const weight = Math.min(DWELL_CAP_MS, Math.max(0, this.ctx.clock.activeAt(t) - this.last.active));
    const ref = this.ctx.buffer.closeOpen(weight);
    if (ref) {
      const s = this.ctx.stats.get(ref);
      if (s) s.pointerMs += weight;
    }
  }

  /** Pointer left the document or the tab was hidden: close, and retain the next move. */
  leave(t: number): void {
    this.closeDwell(t);
    this.last = null;
  }

  private rectOf(el: Element): DOMRect {
    const epoch = this.ctx.roots.currentEpoch;
    const c = this.rects.get(el);
    if (c && c.epoch === epoch) return c.r;
    if (this.rects.size > 2000) this.rects.clear();
    const r = el.getBoundingClientRect();
    this.rects.set(el, { epoch, r });
    return r;
  }
}
