/**
 * Time-weighted sparse density grid (pure). Weight = recorded pointer dwell (ms), never click
 * counts. One grid per scroll root, in that root's content coordinates; roots never mix.
 * Cells are keys (row · cols + col) in a Map, so memory follows the visited area, not the page.
 */
import { BASE_CELL_PX, MAX_COLS, MAX_ROWS } from './config';

export interface RootExtent {
  rootId: number;
  kind: 'document' | 'container';
  /** Content size in CSS px (recorded). */
  width: number;
  height: number;
}

export interface DensityGrid {
  rootId: number;
  kind: 'document' | 'container';
  cellPx: number;
  cols: number;
  rows: number;
  cells: Map<number, number>;
}

/** Smallest cell (8 px · 2^k) that keeps the root within MAX_ROWS × MAX_COLS. */
export function cellSizeFor(width: number, height: number): number {
  let cell = BASE_CELL_PX;
  while (Math.ceil(Math.max(1, height) / cell) > MAX_ROWS || Math.ceil(Math.max(1, width) / cell) > MAX_COLS) cell *= 2;
  return cell;
}

export function emptyGrid(e: RootExtent): DensityGrid {
  const cellPx = cellSizeFor(e.width, e.height);
  return { rootId: e.rootId, kind: e.kind, cellPx, cols: Math.max(1, Math.ceil(e.width / cellPx)), rows: Math.max(1, Math.ceil(e.height / cellPx)), cells: new Map() };
}

const clampCell = (v: number, n: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);

/** Adds `w` at a point (points outside the extent are clamped onto the edge, never dropped). */
export function addPoint(g: DensityGrid, x: number, y: number, w: number): void {
  if (!(w > 0)) return;
  const col = clampCell(Math.floor(x / g.cellPx), g.cols);
  const row = clampCell(Math.floor(y / g.cellPx), g.rows);
  const k = row * g.cols + col;
  g.cells.set(k, (g.cells.get(k) ?? 0) + w);
}

/**
 * Adds `w` spread over a square area (a Phase 5 coarse cell) in proportion to overlap, so a
 * 16 px coarse cell re-bins into four 8 px cells (or into one larger cell). Total is preserved.
 */
export function addArea(g: DensityGrid, x0: number, y0: number, size: number, w: number): void {
  if (!(w > 0)) return;
  const c0 = Math.floor(x0 / g.cellPx);
  const c1 = Math.floor((x0 + size - 1e-6) / g.cellPx);
  const r0 = Math.floor(y0 / g.cellPx);
  const r1 = Math.floor((y0 + size - 1e-6) / g.cellPx);
  const area = size * size;
  for (let r = r0; r <= r1; r++) {
    const oy = Math.min(y0 + size, (r + 1) * g.cellPx) - Math.max(y0, r * g.cellPx);
    for (let c = c0; c <= c1; c++) {
      const ox = Math.min(x0 + size, (c + 1) * g.cellPx) - Math.max(x0, c * g.cellPx);
      const part = (w * ox * oy) / area;
      const k = clampCell(r, g.rows) * g.cols + clampCell(c, g.cols);
      g.cells.set(k, (g.cells.get(k) ?? 0) + part);
    }
  }
}

export function gridTotal(g: DensityGrid): number {
  let t = 0;
  for (const v of g.cells.values()) t += v;
  return t;
}
