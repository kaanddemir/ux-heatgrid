/**
 * Uniform-grid spatial index over rects (document coordinates). Pure, no DOM.
 * Queries touch only the buckets they overlap, avoiding all-pairs scans.
 */
import type { Rect } from './types';

export interface SpatialItem {
  id: number;
  rect: Rect;
}

/** Shortest distance between two rects (0 when they touch or overlap). */
export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

export function pointRectDistance(x: number, y: number, r: Rect): number {
  const dx = Math.max(0, r.x - x, x - (r.x + r.width));
  const dy = Math.max(0, r.y - y, y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Numeric cell key (avoids building a string per visited cell). Valid for |cell| < 2^20. */
const CELL_OFFSET = 1 << 20;
const cellKey = (cx: number, cy: number): number => (cx + CELL_OFFSET) * (CELL_OFFSET * 2) + (cy + CELL_OFFSET);

export class SpatialIndex {
  private readonly buckets = new Map<number, number[]>();
  private readonly items = new Map<number, SpatialItem>();
  private bounds = { minCx: 0, minCy: 0, maxCx: -1, maxCy: -1 };

  constructor(readonly cellSize = 128) {
    if (!(cellSize > 0)) throw new Error('cellSize must be > 0');
  }

  static build(items: readonly SpatialItem[], cellSize?: number): SpatialIndex {
    const index = new SpatialIndex(cellSize);
    for (const item of items) index.insert(item);
    return index;
  }

  get size(): number {
    return this.items.size;
  }

  private cellRange(r: Rect): [number, number, number, number] {
    const s = this.cellSize;
    // Zero-size rects still occupy the cell they sit in.
    return [
      Math.floor(r.x / s),
      Math.floor(r.y / s),
      Math.floor((r.x + Math.max(r.width, 0)) / s),
      Math.floor((r.y + Math.max(r.height, 0)) / s),
    ];
  }

  insert(item: SpatialItem): void {
    if (this.items.has(item.id)) throw new Error(`Duplicate spatial id ${item.id}`);
    this.items.set(item.id, item);
    const [x0, y0, x1, y1] = this.cellRange(item.rect);
    const first = this.items.size === 1;
    this.bounds = {
      minCx: first ? x0 : Math.min(this.bounds.minCx, x0),
      minCy: first ? y0 : Math.min(this.bounds.minCy, y0),
      maxCx: first ? x1 : Math.max(this.bounds.maxCx, x1),
      maxCy: first ? y1 : Math.max(this.bounds.maxCy, y1),
    };
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = cellKey(cx, cy);
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(item.id);
        else this.buckets.set(key, [item.id]);
      }
    }
  }

  get(id: number): SpatialItem | undefined {
    return this.items.get(id);
  }

  private collect(x0: number, y0: number, x1: number, y1: number, seen: Set<number>, visit: (item: SpatialItem) => void): void {
    const b = this.bounds;
    for (let cy = Math.max(y0, b.minCy); cy <= Math.min(y1, b.maxCy); cy++) {
      for (let cx = Math.max(x0, b.minCx); cx <= Math.min(x1, b.maxCx); cx++) {
        const bucket = this.buckets.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          if (seen.has(id)) continue;
          seen.add(id);
          visit(this.items.get(id)!);
        }
      }
    }
  }

  /** Items whose rect intersects `rect` (or touches it, for zero-size rects). Sorted by id. */
  queryRect(rect: Rect): number[] {
    const out: number[] = [];
    const [x0, y0, x1, y1] = this.cellRange(rect);
    this.collect(x0, y0, x1, y1, new Set(), (item) => {
      if (rectsIntersect(item.rect, rect) || rectDistance(item.rect, rect) === 0) out.push(item.id);
    });
    return out.sort((a, b) => a - b);
  }

  /** Items whose rect lies within edge distance `distance` of `rect` (unsorted, single pass). */
  queryWithin(rect: Rect, distance: number): number[] {
    const out: number[] = [];
    const [x0, y0, x1, y1] = this.cellRange({ x: rect.x - distance, y: rect.y - distance, width: rect.width + 2 * distance, height: rect.height + 2 * distance });
    this.collect(x0, y0, x1, y1, new Set(), (item) => {
      if (rectDistance(rect, item.rect) <= distance) out.push(item.id);
    });
    return out;
  }

  /** Items whose rect is within `radius` of point (x, y). Sorted by distance, then id. */
  queryRadius(x: number, y: number, radius: number): number[] {
    const hits: Array<[number, number]> = [];
    const [x0, y0, x1, y1] = this.cellRange({ x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 });
    this.collect(x0, y0, x1, y1, new Set(), (item) => {
      const d = pointRectDistance(x, y, item.rect);
      if (d <= radius) hits.push([item.id, d]);
    });
    return hits.sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([id]) => id);
  }

  /**
   * Nearest item to `rect` by edge distance, excluding items for which `filter` returns false.
   * Searches outward ring by ring and stops once no closer item can exist. Ties → lower id.
   */
  nearest(rect: Rect, filter?: (id: number) => boolean, maxDistance = Number.POSITIVE_INFINITY): { id: number; distance: number } | null {
    if (this.items.size === 0) return null;
    const [x0, y0, x1, y1] = this.cellRange(rect);
    const seen = new Set<number>();
    const state: { best: { id: number; distance: number } | null } = { best: null };
    const b = this.bounds;
    const maxRing = Math.max(x0 - b.minCx, b.maxCx - x1, y0 - b.minCy, b.maxCy - y1, 0);
    for (let ring = 0; ring <= maxRing; ring++) {
      // Anything first seen in this ring is at least (ring - 1) * cellSize away.
      if (state.best && (ring - 1) * this.cellSize > state.best.distance) break;
      if ((ring - 1) * this.cellSize > maxDistance) break;
      const visit = (item: SpatialItem): void => {
        if (filter && !filter(item.id)) return;
        const d = rectDistance(rect, item.rect);
        if (d > maxDistance) return;
        const best = state.best;
        if (!best || d < best.distance || (d === best.distance && item.id < best.id)) state.best = { id: item.id, distance: d };
      };
      if (ring === 0) {
        this.collect(x0, y0, x1, y1, seen, visit);
        continue;
      }
      // Only the ring's border cells.
      const rx0 = x0 - ring, ry0 = y0 - ring, rx1 = x1 + ring, ry1 = y1 + ring;
      this.collect(rx0, ry0, rx1, ry0, seen, visit);
      this.collect(rx0, ry1, rx1, ry1, seen, visit);
      this.collect(rx0, ry0 + 1, rx0, ry1 - 1, seen, visit);
      this.collect(rx1, ry0 + 1, rx1, ry1 - 1, seen, visit);
    }
    return state.best;
  }
}
