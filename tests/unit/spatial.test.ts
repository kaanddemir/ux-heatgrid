import { describe, expect, it } from 'vitest';
import { SpatialIndex, rectDistance } from '../../src/content/analyzer/spatial';

const r = (x: number, y: number, width = 10, height = 10) => ({ x, y, width, height });

describe('SpatialIndex', () => {
  const index = SpatialIndex.build(
    [
      { id: 1, rect: r(0, 0) },
      { id: 2, rect: r(50, 0) },
      { id: 3, rect: r(500, 500) },
      { id: 4, rect: r(0, 0, 1000, 20) }, // spans many cells
      { id: 5, rect: r(130, 0) },
    ],
    64,
  );

  it('queryRect returns intersecting items without duplicates', () => {
    const hits = index.queryRect(r(0, 0, 200, 15));
    expect(hits).toEqual([1, 2, 4, 5]);
    expect(new Set(hits).size).toBe(hits.length);
  });

  it('queryRadius filters by true distance and sorts by distance', () => {
    expect(index.queryRadius(5, 5, 50)).toEqual([1, 4, 2]);
    expect(index.queryRadius(505, 505, 1)).toEqual([3]);
  });

  it('nearest uses edge distance and honours filters', () => {
    expect(index.nearest(r(48, 30, 4, 4), (id) => id !== 4)?.id).toBe(2);
    expect(index.nearest(r(400, 400), (id) => id !== 4)?.id).toBe(3);
    expect(index.nearest(r(400, 400), (id) => id === 99)).toBeNull();
  });

  it('nearest respects maxDistance', () => {
    expect(index.nearest(r(2000, 2000), undefined, 100)).toBeNull();
  });

  it('nearest agrees with brute force on random data', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const items = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, rect: r(rand() * 3000, rand() * 3000, rand() * 80, rand() * 40) }));
    const idx = SpatialIndex.build(items, 100);
    for (let q = 0; q < 50; q++) {
      const probe = r(rand() * 3000, rand() * 3000, 20, 20);
      const brute = items
        .map((it) => ({ id: it.id, d: rectDistance(probe, it.rect) }))
        .sort((a, b) => a.d - b.d || a.id - b.id)[0]!;
      const got = idx.nearest(probe)!;
      expect(got.distance).toBeCloseTo(brute.d);
      expect(got.id).toBe(brute.id);
    }
  });

  it('queryWithin matches a brute-force edge-distance filter', () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const items = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, rect: r(rand() * 2000 - 200, rand() * 2000 - 200, rand() * 120, rand() * 60) }));
    const idx = SpatialIndex.build(items, 128);
    for (let q = 0; q < 40; q++) {
      const probe = r(rand() * 2000, rand() * 2000, rand() * 200, rand() * 80);
      const d = rand() * 320;
      const got = idx.queryWithin(probe, d).sort((a, b) => a - b);
      const exp = items.filter((it) => rectDistance(probe, it.rect) <= d).map((it) => it.id);
      expect(got).toEqual(exp);
    }
  });

  it('rejects duplicate ids', () => {
    const idx = new SpatialIndex(32);
    idx.insert({ id: 1, rect: r(0, 0) });
    expect(() => idx.insert({ id: 1, rect: r(5, 5) })).toThrow();
  });

  it('empty index returns nothing', () => {
    const idx = new SpatialIndex();
    expect(idx.nearest(r(0, 0))).toBeNull();
    expect(idx.queryRect(r(0, 0))).toEqual([]);
  });
});
