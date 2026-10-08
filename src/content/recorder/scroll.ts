/**
 * Scroll tracking for the document and nested roots. Scroll events (captured on window, passive)
 * only mark a root dirty; measurement happens at most once per animation frame. A coarse
 * timeline keeps one point per root about every TIMELINE_INTERVAL_MS; when TIMELINE_CAP is
 * reached it is decimated (every other point dropped, interval doubled), so it stays bounded.
 */
import type { RecorderContext } from './context';
import type { TrackedRoot } from './roots';
import type { ScrollTimelinePoint } from './types';

export const TIMELINE_INTERVAL_MS = 250;
export const TIMELINE_CAP = 2_000;

export class ScrollTracker {
  readonly timeline: ScrollTimelinePoint[] = [];
  intervalMs = TIMELINE_INTERVAL_MS;
  private dirty = new Set<TrackedRoot>();
  private lastPoint = new Map<number, number>();
  private frame: number | null = null;

  constructor(
    private readonly ctx: RecorderContext,
    private readonly raf: (cb: () => void) => number,
    private readonly caf: (h: number) => void,
  ) {}

  onScroll(e: Event): void {
    if (!e.isTrusted) return;
    const t = this.ctx.now();
    this.ctx.input(t);
    this.ctx.roots.invalidate();
    const root = this.ctx.roots.rootForScrollTarget(e.target);
    if (!root) return;
    this.dirty.add(root);
    this.frame ??= this.raf(() => {
      this.frame = null;
      this.flush();
    });
  }

  /** Measures dirty roots (one read per root per frame) and appends timeline points. */
  flush(): void {
    const t = this.ctx.now() - this.ctx.t0;
    for (const root of this.dirty) {
      this.ctx.roots.measure(root);
      const last = this.lastPoint.get(root.id);
      if (last === undefined || t - last >= this.intervalMs) {
        this.lastPoint.set(root.id, t);
        this.push({ t, rootId: root.id, scrollTop: Math.round(root.scrollTop) });
      }
    }
    this.dirty.clear();
  }

  private push(p: ScrollTimelinePoint): void {
    if (this.timeline.length >= TIMELINE_CAP) {
      let w = 0;
      for (let i = 0; i < this.timeline.length; i += 2) this.timeline[w++] = this.timeline[i]!;
      this.timeline.length = w;
      this.intervalMs *= 2;
    }
    this.timeline.push(p);
  }

  dispose(): void {
    if (this.frame !== null) this.caf(this.frame);
    this.frame = null;
    this.dirty.clear();
  }
}
