/**
 * Hover on candidate controls via delegated pointerover / pointerout.
 * A hover counts once it lasted ≥ HOVER_MIN_MS of active time; one continuous hover contributes
 * at most HOVER_CAP_MS. Moving between children of the same control is one continuous hover
 * (targets resolve to the same candidate).
 */
import type { RecorderContext } from './context';
import { asElement } from './targets';

export const HOVER_MIN_MS = 300;
export const HOVER_CAP_MS = 10_000;

export class HoverTracker {
  private current: { id: number; enterActive: number } | null = null;

  constructor(private readonly ctx: RecorderContext) {}

  onOver(e: PointerEvent): void {
    if (e.pointerType === 'touch' || !e.isTrusted) return;
    const t = this.ctx.now();
    const control = this.ctx.resolver.controlFor(asElement(e.target));
    if (control?.id === this.current?.id) return;
    this.close(t);
    if (control) this.current = { id: control.id, enterActive: this.ctx.clock.activeAt(t) };
  }

  close(t: number): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const dur = this.ctx.clock.activeAt(t) - c.enterActive;
    if (dur < HOVER_MIN_MS) return;
    const s = this.ctx.stats.get(c.id);
    if (!s) return;
    s.hoverEntries++;
    s.hoverDwellMs += Math.min(dur, HOVER_CAP_MS);
  }
}
