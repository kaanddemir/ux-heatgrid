/**
 * Effective-background resolution and contrast facts.
 *
 * resolved(el) = own background is opaque  → own
 *              = own background translucent → composite(own, resolved(parent))
 *              = background image / filter / blend / opacity < 1 / media element → UNKNOWN
 *              = a ::before/::after box with a background covering ≥ 50% of el → UNKNOWN
 * The root falls back to the white canvas base (flagged `assumedCanvasBase`), unless the
 * page's default canvas is dark (color-scheme: dark) — then UNKNOWN.
 *
 * Unknown is returned instead of guessing: a gradient is never treated as black or white.
 * Results are memoized per element for the duration of one analysis.
 *
 * Known blind spot (documented): content painted *behind* an element by a non-ancestor
 * (absolutely positioned siblings, canvases, videos) cannot be seen from ancestry.
 */
import { AA_LARGE_TEXT, AA_NORMAL_TEXT, WHITE, composite, contrastRatio, isLargeText, parseColor } from './color';
import { opacityOf, parentElementOrHost, px, type DomReader } from './measure';
import type { BackgroundResolution, ContrastFacts, RGBA } from './types';

const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'svg', 'SVG']);

const unknown = (reason: Extract<BackgroundResolution, { resolved: false }>['reason']): BackgroundResolution => ({
  resolved: false,
  reason,
});

export interface BackgroundResolver {
  /** Effective background painted behind `el`'s own content (includes `el`'s own background). */
  resolve(el: Element): BackgroundResolution;
  /** Effective background behind `el` itself (its parent's resolution). */
  behind(el: Element): BackgroundResolution;
}

/** Pseudo boxes smaller than this share of the host (icons, bullets) are ignored. */
const PSEUDO_COVER_SHARE = 0.5;

export function createBackgroundResolver(reader: DomReader, base: RGBA = WHITE): BackgroundResolver {
  const memo = new Map<Element, BackgroundResolution>();
  const canvas: BackgroundResolution =
    reader.canvasColorScheme() === 'dark'
      ? unknown('dark-canvas')
      : { resolved: true, color: base, assumedCanvasBase: true };

  /** True when a ::before/::after box with a visible background covers most of `el`. */
  const pseudoCovers = (el: Element): boolean => {
    for (const pseudo of ['::before', '::after']) {
      const p = reader.style(el, pseudo);
      const content = p.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal') continue;
      const bg = parseColor(p.getPropertyValue('background-color'));
      const image = p.getPropertyValue('background-image');
      if (!(bg && bg.a > 0) && !(image && image !== 'none')) continue;
      const host = reader.rect(el);
      const hostArea = host.width * host.height;
      const w = px(p.getPropertyValue('width'));
      const h = px(p.getPropertyValue('height'));
      // Unresolvable size (auto/inline) → treat as covering: unknown is the safe answer.
      if (hostArea <= 0 || w <= 0 || h <= 0 || (w * h) / hostArea >= PSEUDO_COVER_SHARE) return true;
    }
    return false;
  };

  const resolve = (el: Element | null): BackgroundResolution => {
    if (!el) return canvas;
    const cached = memo.get(el);
    if (cached) return cached;
    const out = compute(el);
    memo.set(el, out);
    return out;
  };

  const compute = (el: Element): BackgroundResolution => {
    if (MEDIA.has(el.tagName)) return unknown('media-element');
    const s = reader.style(el);
    const image = s.getPropertyValue('background-image');
    if (image && image !== 'none') return unknown('background-image');
    const filter = s.getPropertyValue('filter');
    const blend = s.getPropertyValue('mix-blend-mode');
    const backdrop = s.getPropertyValue('backdrop-filter');
    if ((filter && filter !== 'none') || (blend && blend !== 'normal') || (backdrop && backdrop !== 'none')) {
      return unknown('filter-or-blend');
    }
    if (opacityOf(s.getPropertyValue('opacity')) < 1) return unknown('opacity');
    if (pseudoCovers(el)) return unknown('pseudo-element');

    const raw = s.getPropertyValue('background-color');
    const own = raw === '' ? { r: 0, g: 0, b: 0, a: 0 } : parseColor(raw);
    if (!own) return unknown('unparseable-color');
    if (own.a >= 1) return { resolved: true, color: own, assumedCanvasBase: false };

    const below = resolve(parentElementOrHost(el));
    if (!below.resolved) return below;
    if (own.a === 0) return below;
    return { resolved: true, color: composite(own, below.color), assumedCanvasBase: below.assumedCanvasBase };
  };

  return {
    resolve: (el) => resolve(el),
    behind: (el) => resolve(parentElementOrHost(el)),
  };
}

/** Pure: contrast facts from a text color string, font facts and a resolved background. */
export function contrastFromParts(
  textColorRaw: string,
  fontSize: number,
  fontWeight: number,
  background: BackgroundResolution,
): ContrastFacts {
  if (!background.resolved) return { resolved: false, reasonIfUnknown: background.reason };
  const text = parseColor(textColorRaw);
  if (!text) return { resolved: false, reasonIfUnknown: 'unparseable-color' };
  const textOnBg = text.a < 1 ? composite(text, background.color) : text;
  const ratio = Math.round(contrastRatio(textOnBg, background.color) * 100) / 100;
  const largeText = isLargeText(fontSize, fontWeight);
  return {
    resolved: true,
    textColor: textOnBg,
    backgroundColor: background.color,
    ratio,
    largeText,
    meetsNormalTextAA: ratio >= AA_NORMAL_TEXT,
    meetsLargeTextAA: ratio >= AA_LARGE_TEXT,
    assumedCanvasBase: background.assumedCanvasBase,
  };
}

