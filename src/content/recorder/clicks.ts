/**
 * Clicks, keyboard activation and focus.
 * - pointer click: actual event position (root + viewport coordinates), button, pointer type
 * - activation: a click with detail === 0 (keyboard / assistive activation) — no coordinates
 * - "maybe-not": a non-touch pointer click where nothing at or above the target is (or looks)
 *   interactive, outside any text selection. Clicks on the empty html/body background are ignored.
 * - focus: focusin on candidate controls; moving focus inside one control is not a new event.
 * Only trusted events are recorded. Key values are never read.
 */
import { toRootCoords } from './roots';
import { asElement, looksClickable } from './targets';
import type { RecorderContext } from './context';
import type { ClickEvent } from './types';

export const CLICK_CAP = 5_000;

export class ClickTracker {
  readonly events: ClickEvent[] = [];
  dropped = 0;
  total = 0;
  private lastFocusId: number | null = null;

  constructor(private readonly ctx: RecorderContext) {}

  onClick(e: MouseEvent): void {
    if (!e.isTrusted) return;
    const t = this.ctx.now();
    const path = e.composedPath();
    const first = path[0];
    const target = asElement(first) ?? asElement(e.target);
    const doc = this.ctx.win.document;
    if (!target || target === doc.documentElement || target === doc.body) return; // empty background
    this.ctx.input(t);
    const control = this.ctx.resolver.controlFor(target);
    const activation = e.detail === 0;
    const pointerType = (e as PointerEvent).pointerType || undefined;
    let ev: ClickEvent;
    if (activation) {
      ev = { id: this.total + 1, t: t - this.ctx.t0, kind: 'activation', ...(control ? { elementRef: control.id } : {}), interactive: 'yes' };
    } else {
      const root = this.ctx.roots.rootFor(target);
      const { x, y } = toRootCoords(e.clientX, e.clientY, this.ctx.roots.geometryOf(root));
      const selection = this.ctx.win.getSelection?.();
      const flaggable = pointerType !== 'touch' && !control && (!selection || selection.isCollapsed);
      ev = {
        id: this.total + 1,
        t: t - this.ctx.t0,
        kind: 'pointer',
        rootId: root.id,
        x,
        y,
        viewportX: e.clientX,
        viewportY: e.clientY,
        button: e.button,
        ...(pointerType ? { pointerType } : {}),
        ...(control ? { elementRef: control.id } : {}),
        interactive: flaggable && !looksClickable(target, this.ctx.win) ? 'maybe-not' : 'yes',
      };
    }
    this.total++;
    if (this.events.length < CLICK_CAP) this.events.push(ev);
    else this.dropped++;
    if (control) {
      const s = this.ctx.stats.get(control.id);
      if (s) {
        if (activation) s.activations++;
        else s.clicks++;
      }
    }
  }

  onFocus(e: FocusEvent): void {
    if (!e.isTrusted) return;
    const control = this.ctx.resolver.controlFor(asElement(e.target));
    if (!control || control.id === this.lastFocusId) return;
    this.lastFocusId = control.id;
    const s = this.ctx.stats.get(control.id);
    if (!s) return;
    s.focusEvents++;
    s.firstFocusAt ??= this.ctx.now() - this.ctx.t0;
  }

  /** Focus left the page (window blur): the next focus on the same control counts again. */
  resetFocus(): void {
    this.lastFocusId = null;
  }
}
