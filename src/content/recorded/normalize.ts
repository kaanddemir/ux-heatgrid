/**
 * Robust intensity normalisation (pure). The visual upper bound is a high percentile of the
 * non-zero smoothed cells of the whole page (all roots share one scale), so one extreme spot
 * cannot wash out everything else. Above it values clamp; a sqrt transfer lifts low values.
 * Output intensities are 0–255 for drawing only — never shown as percentages or probabilities.
 */
import { MIN_INTENSITY, UPPER_PERCENTILE } from './config';
import type { DensityGrid } from './density';

/** Nearest-rank percentile (p in 0–1) of the values; 0 when empty. */
export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return 0;
  const a = Float64Array.from(values).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))]!;
}

export function upperBound(grids: readonly DensityGrid[], p = UPPER_PERCENTILE): number {
  const vals: number[] = [];
  for (const g of grids) for (const v of g.cells.values()) if (v > 0) vals.push(v);
  return percentile(vals, p);
}

/** Visual intensity 0–1 of a smoothed value. */
export function intensity(v: number, upper: number): number {
  if (!(upper > 0) || !(v > 0)) return 0;
  const t = Math.sqrt(Math.min(1, v / upper));
  return t < MIN_INTENSITY ? 0 : t;
}

/** Packed, row-sorted intensities of one root (CSR layout); what tiles are drawn from. */
export interface PackedDensity {
  rootId: number;
  kind: 'document' | 'container';
  cellPx: number;
  cols: number;
  rows: number;
  /** rowStart[r] … rowStart[r+1] index into col/value. Length rows + 1. */
  rowStart: Uint32Array;
  col: Uint16Array;
  /** Quantized intensity 1–255. */
  value: Uint8Array;
}

export function packDensity(g: DensityGrid, upper: number): PackedDensity {
  const keys: number[] = [];
  for (const [k, v] of g.cells) if (intensity(v, upper) > 0) keys.push(k);
  keys.sort((a, b) => a - b);
  const rowStart = new Uint32Array(g.rows + 1);
  const col = new Uint16Array(keys.length);
  const value = new Uint8Array(keys.length);
  keys.forEach((k, i) => {
    const row = Math.floor(k / g.cols);
    rowStart[row + 1]!++;
    col[i] = k - row * g.cols;
    value[i] = Math.max(1, Math.round(intensity(g.cells.get(k)!, upper) * 255));
  });
  for (let r = 0; r < g.rows; r++) rowStart[r + 1]! += rowStart[r]!;
  return { rootId: g.rootId, kind: g.kind, cellPx: g.cellPx, cols: g.cols, rows: g.rows, rowStart, col, value };
}

export function packedBytes(d: PackedDensity): number {
  return d.rowStart.byteLength + d.col.byteLength + d.value.byteLength;
}
