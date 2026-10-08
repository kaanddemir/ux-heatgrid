import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  composite,
  compositeStack,
  contrastRatio,
  isLargeText,
  parseColor,
  relativeLuminance,
  srgbToLinear,
} from '../../src/content/analyzer/color';
import { contrastFromParts } from '../../src/content/analyzer/contrast';

describe('parseColor', () => {
  it('parses rgb and rgba (comma syntax)', () => {
    expect(parseColor('rgb(255, 0, 10)')).toEqual({ r: 255, g: 0, b: 10, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  it('parses space syntax with slash alpha and percentages', () => {
    expect(parseColor('rgb(0 128 255 / 25%)')).toEqual({ r: 0, g: 128, b: 255, a: 0.25 });
    expect(parseColor('rgb(100% 0% 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses hex and keywords', () => {
    expect(parseColor('#fff')).toEqual(WHITE);
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.502, 2);
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('parses color(srgb …)', () => {
    expect(parseColor('color(srgb 1 0 0 / 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  });

  it('returns null (unknown) for unsupported formats instead of guessing', () => {
    expect(parseColor('hsl(0 100% 50%)')).toBeNull();
    expect(parseColor('rebeccapurple')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor('rgb(1, 2)')).toBeNull();
  });
});

describe('compositing', () => {
  it('opaque top wins', () => {
    expect(composite({ r: 10, g: 20, b: 30, a: 1 }, WHITE)).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it('50% black over white is mid grey', () => {
    const c = composite({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE);
    expect(c.r).toBeCloseTo(127.5);
    expect(c.a).toBe(1);
  });

  it('transparent over anything is unchanged', () => {
    expect(composite({ r: 0, g: 0, b: 0, a: 0 }, { r: 1, g: 2, b: 3, a: 1 })).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });

  it('nested alpha layers compose in order', () => {
    // 50% white over 50% red over blue
    const out = compositeStack([{ r: 255, g: 255, b: 255, a: 0.5 }, { r: 255, g: 0, b: 0, a: 0.5 }], { r: 0, g: 0, b: 255, a: 1 });
    expect(out.r).toBeCloseTo(191.25);
    expect(out.g).toBeCloseTo(127.5);
    expect(out.b).toBeCloseTo(191.25);
  });
});

describe('luminance and contrast', () => {
  it('linearizes sRGB', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(255)).toBeCloseTo(1);
    expect(srgbToLinear(10)).toBeCloseTo(10 / 255 / 12.92);
  });

  it('relative luminance of black and white', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1);
  });

  it('black on white is 21:1 and symmetric', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1);
  });

  it('known mid-grey ratio (#767676 on white ≈ 4.54)', () => {
    expect(contrastRatio(parseColor('#767676')!, WHITE)).toBeCloseTo(4.54, 1);
  });

  it('large text rule', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(19, 700)).toBe(true);
    expect(isLargeText(19, 400)).toBe(false);
  });
});

describe('contrastFromParts', () => {
  it('composites translucent text over the background', () => {
    const c = contrastFromParts('rgba(0, 0, 0, 0.5)', 16, 400, { resolved: true, color: WHITE, assumedCanvasBase: false });
    expect(c.resolved).toBe(true);
    if (c.resolved) {
      expect(c.textColor.r).toBeCloseTo(127.5);
      expect(c.ratio).toBeLessThan(4.5);
      expect(c.meetsNormalTextAA).toBe(false);
      expect(c.meetsLargeTextAA).toBe(true);
    }
  });

  it('propagates unknown backgrounds', () => {
    expect(contrastFromParts('rgb(0,0,0)', 16, 400, { resolved: false, reason: 'background-image' })).toEqual({
      resolved: false,
      reasonIfUnknown: 'background-image',
    });
  });

  it('unparseable text color is unknown', () => {
    const c = contrastFromParts('hsl(0 0% 0%)', 16, 400, { resolved: true, color: WHITE, assumedCanvasBase: false });
    expect(c).toEqual({ resolved: false, reasonIfUnknown: 'unparseable-color' });
  });
});
