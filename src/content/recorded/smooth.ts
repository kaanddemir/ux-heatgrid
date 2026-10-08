/**
 * Deterministic separable Gaussian smoothing on a sparse grid (pure).
 * - one root at a time: density never blurs across scroll-root boundaries
 * - at grid edges the kernel is truncated and renormalised, so the total is preserved exactly and
 *   edges do not darken or brighten
 * - work is proportional to non-zero cells × kernel width; empty areas stay empty beyond the radius
 */
import { KERNEL_RADIUS, SIGMA_CELLS } from './config';
import type { DensityGrid } from './density';

export function gaussianKernel(sigma = SIGMA_CELLS, radius = KERNEL_RADIUS): Float64Array {
  const k = new Float64Array(2 * radius + 1);
  for (let i = -radius; i <= radius; i++) k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  return k;
}

function pass(cells: Map<number, number>, cols: number, rows: number, k: Float64Array, horizontal: boolean): Map<number, number> {
  const r = (k.length - 1) / 2;
  const out = new Map<number, number>();
  for (const [key, v] of cells) {
    const row = Math.floor(key / cols);
    const col = key - row * cols;
    const pos = horizontal ? col : row;
    const n = horizontal ? cols : rows;
    const lo = Math.max(0, pos - r);
    const hi = Math.min(n - 1, pos + r);
    let norm = 0;
    for (let p = lo; p <= hi; p++) norm += k[p - pos + r]!;
    for (let p = lo; p <= hi; p++) {
      const w = (v * k[p - pos + r]!) / norm;
      const nk = horizontal ? row * cols + p : p * cols + col;
      out.set(nk, (out.get(nk) ?? 0) + w);
    }
  }
  return out;
}

export function smoothGrid(g: DensityGrid, sigma = SIGMA_CELLS, radius = KERNEL_RADIUS): DensityGrid {
  if (g.cells.size === 0) return { ...g, cells: new Map() };
  const k = gaussianKernel(sigma, radius);
  return { ...g, cells: pass(pass(g.cells, g.cols, g.rows, k, true), g.cols, g.rows, k, false) };
}
