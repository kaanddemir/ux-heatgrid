/**
 * Bounded pointer-sample buffer (column-oriented typed arrays, grown by doubling up to the cap).
 *
 * Long sessions: once POINTER_CAP raw samples are stored, the first POINTER_CAP samples stay raw
 * and every later sample's dwell is ADDED to a coarse grid cell (COARSE_CELL_PX per root, in root
 * coordinates). Element dwell stats stay exact (they are aggregated separately). The grid is
 * itself capped at COARSE_MAX_CELLS; dwell in new cells beyond that is counted as dropped.
 * Nothing already stored is ever overwritten.
 */
import type { PointerCapture } from './types';

export const POINTER_CAP = 150_000;
export const COARSE_CELL_PX = 16;
export const COARSE_MAX_CELLS = 50_000;
const INITIAL = 8_192;

export interface SampleInput {
  t: number;
  rootId: number;
  x: number;
  y: number;
  elementRef: number;
  anchorX: number;
  anchorY: number;
}

export class PointerBuffer {
  count = 0;
  private capacity: number;
  t: Float64Array;
  rootId: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  weightMs: Float32Array;
  elementRef: Int32Array;
  anchorX: Float32Array;
  anchorY: Float32Array;
  /** Index of the last sample whose weight is still open, or -1 (or -2: open sample is coarse). */
  private open = -1;
  private openCoarse: SampleInput | null = null;
  private coarse: Map<string, { rootId: number; cx: number; cy: number; weightMs: number }> | null = null;
  private dropped = 0;
  total = 0;

  constructor(private readonly cap = POINTER_CAP) {
    this.capacity = Math.min(INITIAL, cap);
    this.t = new Float64Array(this.capacity);
    this.rootId = new Uint8Array(this.capacity);
    this.x = new Float32Array(this.capacity);
    this.y = new Float32Array(this.capacity);
    this.weightMs = new Float32Array(this.capacity);
    this.elementRef = new Int32Array(this.capacity);
    this.anchorX = new Float32Array(this.capacity);
    this.anchorY = new Float32Array(this.capacity);
  }

  get coarsened(): boolean {
    return this.coarse !== null;
  }

  private grow(): void {
    const next = Math.min(this.capacity * 2, this.cap);
    const g = <T extends Float64Array | Float32Array | Int32Array | Uint8Array>(a: T, C: new (n: number) => T): T => {
      const b = new C(next);
      b.set(a);
      return b;
    };
    this.t = g(this.t, Float64Array);
    this.rootId = g(this.rootId, Uint8Array);
    this.x = g(this.x, Float32Array);
    this.y = g(this.y, Float32Array);
    this.weightMs = g(this.weightMs, Float32Array);
    this.elementRef = g(this.elementRef, Int32Array);
    this.anchorX = g(this.anchorX, Float32Array);
    this.anchorY = g(this.anchorY, Float32Array);
    this.capacity = next;
  }

  /** Appends a sample (its weight stays open until closeOpen). Returns false once coarse. */
  push(s: SampleInput): boolean {
    if (this.count >= this.cap) {
      this.coarse ??= new Map();
      this.openCoarse = s;
      this.open = -2;
      return false;
    }
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    this.t[i] = s.t;
    this.rootId[i] = s.rootId;
    this.x[i] = s.x;
    this.y[i] = s.y;
    this.weightMs[i] = 0;
    this.elementRef[i] = s.elementRef;
    this.anchorX[i] = s.anchorX;
    this.anchorY[i] = s.anchorY;
    this.open = i;
    return true;
  }

  /** Closes the open sample with `weight` ms. Returns the closed sample's elementRef (0 = none). */
  closeOpen(weight: number): number {
    if (this.open === -1) return 0;
    this.total += weight;
    if (this.open === -2) {
      const s = this.openCoarse!;
      const cx = Math.floor(s.x / COARSE_CELL_PX);
      const cy = Math.floor(s.y / COARSE_CELL_PX);
      const key = `${s.rootId}:${cx}:${cy}`;
      const cell = this.coarse!.get(key);
      if (cell) cell.weightMs += weight;
      else if (this.coarse!.size < COARSE_MAX_CELLS) this.coarse!.set(key, { rootId: s.rootId, cx, cy, weightMs: weight });
      else this.dropped += weight;
      this.open = -1;
      this.openCoarse = null;
      return s.elementRef;
    }
    this.weightMs[this.open] = weight;
    const ref = this.elementRef[this.open]!;
    this.open = -1;
    return ref;
  }

  get hasOpen(): boolean {
    return this.open !== -1;
  }

  /** Read-only views trimmed to `count`. */
  finalize(): PointerCapture {
    const n = this.count;
    return {
      count: n,
      capacity: this.cap,
      t: this.t.slice(0, n),
      rootId: this.rootId.slice(0, n),
      x: this.x.slice(0, n),
      y: this.y.slice(0, n),
      weightMs: this.weightMs.slice(0, n),
      elementRef: this.elementRef.slice(0, n),
      anchorX: this.anchorX.slice(0, n),
      anchorY: this.anchorY.slice(0, n),
      coarse: this.coarse ? { cellPx: COARSE_CELL_PX, cells: [...this.coarse.values()], droppedWeightMs: this.dropped } : null,
      totalWeightMs: this.total,
    };
  }
}
