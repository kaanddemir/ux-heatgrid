import { describe, expect, it } from 'vitest';
import { buildRegions, iou, type RegionInput } from '../../src/content/analyzer/regions';

const vp = { width: 1280, height: 800 };
const base = (over: Partial<RegionInput>): RegionInput => ({
  viewport: vp,
  document: { width: 1280, height: 4000 },
  landmarks: [],
  headings: [],
  blocks: [],
  members: [],
  ...over,
});
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('regions', () => {
  it('builds landmark regions with generic labels', () => {
    const out = buildRegions(
      base({
        landmarks: [
          { id: 1, landmark: 'header', rect: rect(0, 0, 1280, 80), ariaLabelled: false },
          { id: 2, landmark: 'main', rect: rect(0, 80, 1280, 3000), ariaLabelled: false },
          { id: 3, landmark: 'footer', rect: rect(0, 3080, 1280, 200), ariaLabelled: false },
        ],
      }),
    );
    expect(out.regions.map((r) => r.label)).toEqual(['Header', 'Main', 'Footer']);
    expect(out.regions.every((r) => r.kind === 'landmark')).toBe(true);
  });

  it('splits main into heading-led sections and drops the duplicate main region', () => {
    const out = buildRegions(
      base({
        landmarks: [{ id: 2, landmark: 'main', rect: rect(0, 0, 1280, 3000), ariaLabelled: false }],
        headings: [
          { id: 10, level: 1, rect: rect(0, 10, 500, 50), label: 'Welcome' },
          { id: 11, level: 2, rect: rect(0, 1000, 500, 40), label: 'Features' },
          { id: 12, level: 2, rect: rect(0, 2000, 500, 40), label: 'Pricing' },
          { id: 13, level: 3, rect: rect(0, 2200, 500, 30), label: 'Small print' },
        ],
      }),
    );
    expect(out.regions.map((r) => [r.kind, r.label])).toEqual([
      ['heading-section', 'Welcome'],
      ['heading-section', 'Features'],
      ['heading-section', 'Pricing'],
    ]);
    expect(out.regions[2]!.rect).toEqual(rect(0, 2000, 1280, 1000));
    expect(out.regions[1]!.headingRef).toBe(11);
  });

  it('ignores headings inside navigation when splitting', () => {
    const out = buildRegions(
      base({
        landmarks: [{ id: 1, landmark: 'nav', rect: rect(0, 0, 1280, 400), ariaLabelled: false }],
        headings: [
          { id: 10, level: 2, rect: rect(0, 10, 100, 20) },
          { id: 11, level: 2, rect: rect(0, 100, 100, 20) },
          { id: 12, level: 2, rect: rect(0, 1000, 100, 20) },
        ],
      }),
    );
    expect(out.regions.filter((r) => r.kind === 'heading-section')).toHaveLength(0);
  });

  it('suppresses near-duplicate nested landmarks', () => {
    const out = buildRegions(
      base({
        landmarks: [
          { id: 1, landmark: 'header', rect: rect(0, 0, 1280, 100), ariaLabelled: false },
          { id: 2, landmark: 'nav', rect: rect(0, 0, 1280, 96), ariaLabelled: false },
        ],
      }),
    );
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0]!.landmark).toBe('nav');
    expect(iou(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBe(1);
  });

  it('falls back to layout blocks, then bands, on unsemantic pages', () => {
    const blocks = buildRegions(base({ blocks: [{ id: -1, rect: rect(0, 0, 1280, 600) }, { id: -2, rect: rect(0, 600, 1280, 900) }] }));
    expect(blocks.regions.map((r) => r.kind)).toEqual(['block', 'block']);
    const bands = buildRegions(base({}));
    expect(bands.regions.map((r) => r.kind)).toEqual(['band', 'band', 'band', 'band', 'band']);
    expect(bands.regions[0]!.label).toBe('Section 1');
  });

  it('ignores tiny landmarks and unlabeled sections', () => {
    const out = buildRegions(
      base({
        landmarks: [
          { id: 1, landmark: 'form', rect: rect(0, 0, 50, 50), ariaLabelled: false },
          { id: 2, landmark: 'section', rect: rect(0, 0, 1280, 800), ariaLabelled: false },
        ],
      }),
    );
    expect(out.regions.every((r) => r.kind === 'band')).toBe(true);
  });

  it('caps the region count and reports it', () => {
    const landmarks = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, landmark: 'form' as const, rect: rect(0, i * 200, 1280, 150), ariaLabelled: false }));
    const out = buildRegions(base({ landmarks, document: { width: 1280, height: 12000 } }));
    expect(out.regions).toHaveLength(40);
    expect(out.capped).toBe(true);
    expect(out.found).toBe(50);
  });

  it('assigns members to the smallest containing region and computes density', () => {
    const out = buildRegions(
      base({
        landmarks: [
          { id: 1, landmark: 'main', rect: rect(0, 0, 1280, 2000), ariaLabelled: false },
          { id: 2, landmark: 'form', rect: rect(0, 0, 500, 500), ariaLabelled: false },
        ],
        members: [
          { id: 10, center: { x: 100, y: 100 }, interactive: true },
          { id: 11, center: { x: 1000, y: 1000 }, interactive: true },
          { id: 12, center: { x: 1000, y: 1100 }, interactive: false },
          { id: 13, center: { x: 5000, y: 5000 }, interactive: true },
        ],
      }),
    );
    const form = out.regions.find((r) => r.landmark === 'form')!;
    const main = out.regions.find((r) => r.landmark === 'main')!;
    expect(out.membership.get(10)).toBe(form.id);
    expect(out.membership.get(11)).toBe(main.id);
    expect(out.membership.get(13)).toBeNull();
    expect(main.stats).toMatchObject({ interactiveCount: 1, contextCount: 1 });
    expect(form.stats.interactivePer100k).toBeCloseTo(0.4);
  });
});

describe('regions — coverage fallback', () => {
  it('adds non-duplicate layout blocks when landmarks cover < 50% of the document', () => {
    const out = buildRegions({
      viewport: { width: 1280, height: 800 },
      document: { width: 1280, height: 800 },
      landmarks: [{ id: 1, landmark: 'aside', rect: { x: 0, y: 0, width: 300, height: 800 }, ariaLabelled: false }],
      headings: [],
      blocks: [
        { id: -1, rect: { x: 0, y: 0, width: 300, height: 800 } }, // duplicates the aside
        { id: -2, rect: { x: 300, y: 0, width: 980, height: 800 } },
      ],
      members: [],
    });
    expect(out.regions.map((r) => [r.kind, r.sourceRef])).toEqual([
      ['landmark', 1],
      ['block', -2],
    ]);
  });

  it('does not add blocks when landmarks already cover the page', () => {
    const out = buildRegions({
      viewport: { width: 1280, height: 800 },
      document: { width: 1280, height: 800 },
      landmarks: [{ id: 1, landmark: 'main', rect: { x: 0, y: 0, width: 1280, height: 800 }, ariaLabelled: false }],
      headings: [],
      blocks: [{ id: -1, rect: { x: 0, y: 0, width: 640, height: 800 } }, { id: -2, rect: { x: 640, y: 0, width: 640, height: 800 } }],
      members: [],
    });
    expect(out.regions.map((r) => r.kind)).toEqual(['landmark']);
  });
});

describe('labels (Phase 9 real-site findings)', () => {
  it('repeated names get a suffix; a single generic fallback is not numbered', () => {
    const r = buildRegions(base({}));
    const labels = r.regions.map((x) => x.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => !/^Block|^Area/.test(l))).toBe(true);
  });
});
