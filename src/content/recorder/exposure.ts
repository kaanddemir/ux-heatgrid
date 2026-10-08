/**
 * Exposure of candidate controls (IntersectionObserver; ancestor scroll clipping included).
 * - reached: any part became visible
 * - exposureMs: ACTIVE time while ≥ EXPOSED_RATIO visible (so hidden tab / idle never count)
 * - maxVisibleRatio
 * Exposure is opportunity, never interaction.
 */
import type { RecorderContext } from './context';

export const EXPOSED_RATIO = 0.5;
export const THRESHOLDS = [0, 0.1, 0.25, 0.5, 0.75, 1];

type IOCtor = new (cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) => Pick<IntersectionObserver, 'observe' | 'disconnect'>;

export class ExposureTracker {
  private io: Pick<IntersectionObserver, 'observe' | 'disconnect'> | null = null;
  private ids = new WeakMap<Element, number>();
  private open = new Map<number, number>(); // id → active time at enter
  observed = 0;

  constructor(private readonly ctx: RecorderContext, IO: IOCtor | undefined) {
    if (IO) this.io = new IO((entries) => this.onEntries(entries), { threshold: THRESHOLDS });
  }

  get supported(): boolean {
    return this.io !== null;
  }

  observe(id: number, el: Element): void {
    if (!this.io) return;
    this.ids.set(el, id);
    this.io.observe(el);
    this.observed++;
  }

  onEntries(entries: ReadonlyArray<Pick<IntersectionObserverEntry, 'target' | 'isIntersecting' | 'intersectionRatio'>>): void {
    const t = this.ctx.now();
    for (const e of entries) {
      const id = this.ids.get(e.target);
      const s = id !== undefined ? this.ctx.stats.get(id) : undefined;
      if (id === undefined || !s) continue;
      const ratio = e.isIntersecting ? e.intersectionRatio : 0;
      if (e.isIntersecting && ratio > 0) {
        s.exposure.reached = true;
        s.exposure.firstReachedAt ??= t - this.ctx.t0;
      }
      s.exposure.maxVisibleRatio = Math.max(s.exposure.maxVisibleRatio, ratio);
      const isOpen = this.open.has(id);
      if (ratio >= EXPOSED_RATIO && !isOpen) this.open.set(id, this.ctx.clock.activeAt(t));
      else if (ratio < EXPOSED_RATIO && isOpen) this.closeOne(id, t);
    }
  }

  private closeOne(id: number, t: number): void {
    const enter = this.open.get(id)!;
    this.open.delete(id);
    const s = this.ctx.stats.get(id);
    if (s) s.exposure.exposureMs += Math.max(0, this.ctx.clock.activeAt(t) - enter);
  }

  closeAll(t: number): void {
    for (const id of [...this.open.keys()]) this.closeOne(id, t);
  }

  disconnect(): void {
    this.io?.disconnect();
    this.io = null;
  }
}
