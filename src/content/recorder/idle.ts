/**
 * Activity clock: integrates ACTIVE time — recording, document visible, and less than IDLE_MS since
 * the last meaningful input (pointer move, click, key, scroll). Elapsed time is separate.
 *
 * Everything time-weighted (pointer dwell, hover dwell, exposure) is measured as a difference of
 * this integral, so idle and hidden-tab periods are excluded everywhere without timers.
 * Lazy and O(1): the idle boundary is lastInput + IDLE_MS.
 */
export const IDLE_MS = 30_000;

export class ActivityClock {
  private accum = 0;
  private segmentStart: number | null = null;
  private lastInput = -Infinity;
  private visible: boolean;
  private stopped = false;

  constructor(t0: number, visible: boolean) {
    this.visible = visible;
    this.input(t0); // pressing Record is a meaningful action
  }

  private get activeUntil(): number {
    return this.lastInput + IDLE_MS;
  }

  /** Active ms integrated up to time t (t must not go backwards). */
  activeAt(t: number): number {
    if (this.segmentStart === null) return this.accum;
    return this.accum + Math.max(0, Math.min(t, this.activeUntil) - this.segmentStart);
  }

  isActive(t: number): boolean {
    return !this.stopped && this.visible && this.segmentStart !== null && t < this.activeUntil;
  }

  private close(t: number): void {
    if (this.segmentStart === null) return;
    this.accum += Math.max(0, Math.min(t, this.activeUntil) - this.segmentStart);
    this.segmentStart = null;
  }

  /** Meaningful input. Resumes from idle. */
  input(t: number): void {
    if (this.stopped) return;
    if (this.segmentStart !== null && t >= this.activeUntil) this.close(t);
    this.lastInput = t;
    if (this.visible && this.segmentStart === null) this.segmentStart = t;
  }

  /** Document hidden: pause. Shown again: stays paused until the next input (nothing synthetic). */
  setVisible(visible: boolean, t: number): void {
    if (this.visible === visible) return;
    if (!visible) this.close(t);
    this.visible = visible;
  }

  stop(t: number): number {
    this.close(t);
    this.stopped = true;
    return this.accum;
  }
}
