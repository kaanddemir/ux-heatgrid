/**
 * Pure color math: CSS color parsing, alpha compositing, WCAG luminance and contrast.
 * No DOM access — fully unit-testable.
 */
import type { RGBA } from './types';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };
export const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

const NAMED: Record<string, RGBA> = {
  transparent: TRANSPARENT,
  black: BLACK,
  white: WHITE,
};

function channel(token: string): number | null {
  const t = token.trim();
  if (t.endsWith('%')) {
    const p = Number.parseFloat(t);
    return Number.isFinite(p) ? clamp((p / 100) * 255, 0, 255) : null;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? clamp(n, 0, 255) : null;
}

function alpha(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const t = token.trim();
  if (t.endsWith('%')) {
    const p = Number.parseFloat(t);
    return Number.isFinite(p) ? clamp(p / 100, 0, 1) : null;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? clamp(n, 0, 1) : null;
}

function parseHex(hex: string): RGBA | null {
  const h = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  const expand = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join('') : h;
  if (expand.length !== 6 && expand.length !== 8) return null;
  const n = (i: number): number => Number.parseInt(expand.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: expand.length === 8 ? n(6) / 255 : 1 };
}

/** Splits `a, b, c / d` or `a b c / d` into components. */
function components(body: string): { parts: string[]; alphaPart: string | undefined } {
  const [main = '', alphaPart] = body.split('/');
  const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
  return { parts: parts.map((p) => p.trim()).filter(Boolean), alphaPart: alphaPart?.trim() };
}

/**
 * Parses the CSS color formats browsers return from getComputedStyle
 * (rgb/rgba, comma or space syntax, `color(srgb …)`), plus hex and a few keywords.
 * Returns null for anything else (named colors beyond the basics, hsl, lab, …) —
 * callers must treat null as "unknown", never as black.
 */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === '') return null;
  const named = NAMED[s];
  if (named) return { ...named };
  if (s.startsWith('#')) return parseHex(s);

  const fn = /^(rgba?|color)\((.*)\)$/.exec(s);
  if (!fn) return null;
  const [, name, rawBody = ''] = fn;

  if (name === 'color') {
    // color(srgb r g b / a) with 0–1 channels
    const body = rawBody.trim();
    if (!body.startsWith('srgb ')) return null;
    const { parts, alphaPart } = components(body.slice(5));
    if (parts.length !== 3) return null;
    const vals = parts.map((p) => (p.endsWith('%') ? Number.parseFloat(p) / 100 : Number.parseFloat(p)));
    const a = alpha(alphaPart);
    if (vals.some((v) => !Number.isFinite(v)) || a === null) return null;
    const [r = 0, g = 0, b = 0] = vals.map((v) => clamp(v * 255, 0, 255));
    return { r, g, b, a };
  }

  const { parts, alphaPart } = components(rawBody);
  // Legacy rgba(r, g, b, a) puts alpha as the 4th comma component.
  const alphaToken = alphaPart ?? (parts.length === 4 ? parts[3] : undefined);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [r, g, b] = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)];
  const a = alpha(alphaToken);
  if (r === null || g === null || b === null || a === null) return null;
  return { r, g, b, a };
}

/** Source-over compositing of `top` onto `bottom`. */
export function composite(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { ...TRANSPARENT };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** Composites layers listed top-first onto an opaque base. */
export function compositeStack(layersTopFirst: readonly RGBA[], base: RGBA): RGBA {
  let out = base;
  for (let i = layersTopFirst.length - 1; i >= 0; i--) out = composite(layersTopFirst[i]!, out);
  return out;
}

export function srgbToLinear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque color. */
export function relativeLuminance(c: RGBA): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG contrast ratio (1–21) between two opaque colors. */
export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG "large text": ≥ 24px, or ≥ 18.66px (14pt) at bold weight. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
