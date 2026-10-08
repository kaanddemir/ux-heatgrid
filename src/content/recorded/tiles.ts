/**
 * Heat tiles (pure raster + small LRU cache). A tile covers TILE_HEIGHT_PX of one root's content
 * at the root's full recorded width, rasterised at CELL resolution (one pixel per cell, e.g.
 * 160 × 64 px for a 1280 px wide page) and scaled up with bilinear smoothing when composited.
 * One extra row above and below lets neighbouring tiles blend without a seam.
 */
import { heatLut } from './colormap';
import { TILE_CACHE_SIZE, TILE_HEIGHT_PX } from './config';
import type { PackedDensity } from './normalize';

export function tileRows(d: Pick<PackedDensity, 'cellPx'>): number {
  return Math.max(1, Math.floor(TILE_HEIGHT_PX / d.cellPx));
}

export function tileCount(d: PackedDensity): number {
  return Math.ceil(d.rows / tileRows(d));
}

/** Tile indexes intersecting the root-content band [y0, y1). */
export function tilesForBand(d: PackedDensity, y0: number, y1: number): number[] {
  const tr = tileRows(d) * d.cellPx;
  const first = Math.max(0, Math.floor(y0 / tr));
  const last = Math.min(tileCount(d) - 1, Math.floor((y1 - 1e-6) / tr));
  const out: number[] = [];
  for (let t = first; t <= last; t++) if (tileHasData(d, t)) out.push(t);
  return out;
}

function tileHasData(d: PackedDensity, t: number): boolean {
  const tr = tileRows(d);
  const r0 = Math.max(0, t * tr - 1);
  const r1 = Math.min(d.rows, (t + 1) * tr + 1);
  return d.rowStart[r1]! > d.rowStart[r0]!;
}

export interface TilePixels {
  /** Pixels (= cells). Height includes one padding row above and below. */
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Root-content y of the first NON-padding row, and its height in CSS px. */
  y: number;
  heightPx: number;
}

/** RGBA pixels of tile t (warm colour map). */
export function tilePixels(d: PackedDensity, t: number): TilePixels {
  const tr = tileRows(d);
  const r0 = t * tr;
  const rows = Math.min(tr, d.rows - r0);
  const width = d.cols;
  const height = rows + 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const lut = heatLut();
  for (let pr = 0; pr < height; pr++) {
    const row = r0 - 1 + pr;
    if (row < 0 || row >= d.rows) continue;
    for (let i = d.rowStart[row]!; i < d.rowStart[row + 1]!; i++) {
      const o = (pr * width + d.col[i]!) * 4;
      const l = d.value[i]! * 4;
      data[o] = lut[l]!;
      data[o + 1] = lut[l + 1]!;
      data[o + 2] = lut[l + 2]!;
      data[o + 3] = lut[l + 3]!;
    }
  }
  return { width, height, data, y: r0 * d.cellPx, heightPx: rows * d.cellPx };
}

/** Tiny LRU cache (Map insertion order). */
export class LruCache<V> {
  private map = new Map<string, V>();
  hits = 0;
  misses = 0;
  constructor(readonly limit = TILE_CACHE_SIZE, private readonly onEvict?: (v: V) => void) {}
  get(key: string, make: () => V): V {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.hits++;
      this.map.delete(key);
      this.map.set(key, v);
      return v;
    }
    this.misses++;
    const nv = make();
    this.map.set(key, nv);
    if (this.map.size > this.limit) {
      const [oldKey, old] = this.map.entries().next().value as [string, V];
      this.map.delete(oldKey);
      this.onEvict?.(old);
    }
    return nv;
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    for (const v of this.map.values()) this.onEvict?.(v);
    this.map.clear();
  }
}
