/**
 * DOM reads and pure measurement helpers.
 *
 * All layout/style reads go through `DomReader` so the analyzer can be tested with
 * deterministic fixture geometry (test DOMs have no layout engine). The analyzer only
 * READS: it never writes styles/classes, inserts nodes or scrolls.
 */
import type { ClipState, GeometryFacts, PositioningFacts, Rect, RenderFacts, StyleFacts } from './types';

export interface StyleSource {
  getPropertyValue(property: string): string;
}

export interface ViewportInfo {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

export interface ScrollMetrics {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

export interface DomReader {
  rect(el: Element): Rect;
  /** Computed style; `pseudo` is '::before' / '::after'. */
  style(el: Element, pseudo?: string): StyleSource;
  /** Scheme of the default canvas painted behind a page with no opaque background. */
  canvasColorScheme(): 'light' | 'dark';
  viewport(): ViewportInfo;
  documentSize(): { width: number; height: number };
  scrollMetrics(el: Element): ScrollMetrics;
  documentScrollMetrics(): ScrollMetrics;
  now(): number;
}

export function browserReader(): DomReader {
  return {
    rect(el) {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    style: (el, pseudo) => getComputedStyle(el, pseudo ?? null),
    canvasColorScheme() {
      // The canvas follows the root's used color-scheme (CSS property or <meta name="color-scheme">).
      const css = getComputedStyle(document.documentElement).getPropertyValue('color-scheme');
      const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? '';
      const value = `${css} ${meta}`.toLowerCase();
      if (!/\bdark\b/.test(value)) return 'light';
      if (/\blight\b/.test(value)) return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      return 'dark';
    },
    viewport: () => ({
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      dpr: window.devicePixelRatio || 1,
    }),
    documentSize() {
      const root = document.scrollingElement ?? document.documentElement;
      return { width: root.scrollWidth, height: root.scrollHeight };
    },
    scrollMetrics: (el) => ({
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
    }),
    documentScrollMetrics() {
      const root = document.scrollingElement ?? document.documentElement;
      return {
        clientWidth: root.clientWidth,
        clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth,
        scrollHeight: root.scrollHeight,
      };
    },
    now: () => performance.now(),
  };
}

// ---------------------------------------------------------------------------
// Style normalization (Chrome returns resolved values; '' covers partial environments)
// ---------------------------------------------------------------------------

export function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function fontWeightNumber(value: string): number {
  if (value === 'bold' || value === 'bolder') return 700;
  if (value === 'normal' || value === '' || value === 'lighter') return 400;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 400;
}

export function lineHeightPx(value: string, fontSize: number): number | null {
  if (!value || value === 'normal') return null;
  if (value.endsWith('px')) return px(value);
  const n = Number.parseFloat(value);
  // Unitless multiplier (not normally returned by Chrome, but cheap to support).
  return Number.isFinite(n) ? n * fontSize : null;
}

export function opacityOf(value: string): number {
  if (value === '') return 1;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 1;
}

const get = (s: StyleSource, p: string, fallback: string): string => s.getPropertyValue(p) || fallback;

/** Light style subset used by every mode (render facts + positioning). */
export interface CoreStyle {
  display: string;
  visibility: string;
  opacity: number;
  position: string;
  cursor: string;
}

export function readCoreStyle(s: StyleSource): CoreStyle {
  return {
    display: get(s, 'display', 'inline'),
    visibility: get(s, 'visibility', 'visible'),
    opacity: opacityOf(s.getPropertyValue('opacity')),
    position: get(s, 'position', 'static'),
    cursor: get(s, 'cursor', 'auto'),
  };
}

const four = (s: StyleSource, prefix: string, suffix: string): [number, number, number, number] => [
  px(s.getPropertyValue(`${prefix}-top${suffix}`)),
  px(s.getPropertyValue(`${prefix}-right${suffix}`)),
  px(s.getPropertyValue(`${prefix}-bottom${suffix}`)),
  px(s.getPropertyValue(`${prefix}-left${suffix}`)),
];

/** Full compact style facts (full mode only). */
export function readStyleFacts(s: StyleSource): StyleFacts {
  const core = readCoreStyle(s);
  const fontSize = px(get(s, 'font-size', '16px')) || 16;
  return {
    display: core.display,
    visibility: core.visibility,
    opacity: core.opacity,
    position: core.position,
    overflowX: get(s, 'overflow-x', 'visible'),
    overflowY: get(s, 'overflow-y', 'visible'),
    color: s.getPropertyValue('color'),
    backgroundColor: get(s, 'background-color', 'rgba(0, 0, 0, 0)'),
    backgroundImage: get(s, 'background-image', 'none'),
    fontSize,
    fontWeight: fontWeightNumber(s.getPropertyValue('font-weight')),
    lineHeight: lineHeightPx(s.getPropertyValue('line-height'), fontSize),
    padding: four(s, 'padding', ''),
    borderWidth: four(s, 'border', '-width'),
    borderStyle: get(s, 'border-top-style', 'none'),
    borderColor: s.getPropertyValue('border-top-color'),
    cursor: core.cursor,
    textDecoration: get(s, 'text-decoration-line', 'none'),
    pointerEvents: get(s, 'pointer-events', 'auto'),
    textShadow: get(s, 'text-shadow', 'none'),
  };
}

// ---------------------------------------------------------------------------
// Pure fact derivation
// ---------------------------------------------------------------------------

export const MIN_RENDER_OPACITY = 0.05;

export function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || (el.matches?.(':disabled') ?? false);
}

export function deriveRenderFacts(input: {
  connected: boolean;
  style: CoreStyle;
  rect: Rect;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  disabled: boolean;
  ariaDisabled: boolean;
  clip?: ClipFacts;
}): RenderFacts {
  const { connected, style, rect } = input;
  const clip = input.clip ?? NO_CLIP;
  const rectArea = Math.max(0, rect.width) * Math.max(0, rect.height);
  const docLeft = rect.x + input.scrollX;
  const docTop = rect.y + input.scrollY;
  // Content inside a nested scroller can legitimately extend past the document bounds.
  const outsideDocument =
    rectArea > 0 &&
    !clip.inScrollContainer &&
    (docLeft + rect.width <= 0 ||
      docTop + rect.height <= 0 ||
      docLeft >= Math.max(input.documentWidth, 1) ||
      docTop >= Math.max(input.documentHeight, 1));
  const rendered =
    connected &&
    style.display !== 'none' &&
    style.visibility === 'visible' &&
    rectArea > 1 &&
    style.opacity > MIN_RENDER_OPACITY &&
    !outsideDocument &&
    clip.state !== 'full';
  return {
    connected,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    disabled: input.disabled,
    ariaDisabled: input.ariaDisabled,
    rectArea,
    outsideDocument,
    clip: clip.state,
    clipVisibleFraction: clip.fraction,
    rendered,
  };
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, btm - y) };
}

/** Visible-area fraction of `rect` within `clip`, relative to the full box. */
function clippedFraction(rect: Rect, clipRect: Rect | null, frame: Rect): number {
  const area = rect.width * rect.height;
  if (area <= 0) return 0;
  const visible = intersect(clipRect ? intersect(rect, clipRect) : rect, frame);
  return (visible.width * visible.height) / area;
}

export function deriveGeometry(rect: Rect, vp: ViewportInfo, fixed: boolean, clipRect: Rect | null = null): GeometryFacts {
  // Fixed elements live in viewport space: their document position is their viewport position.
  const sx = fixed ? 0 : vp.scrollX;
  const sy = fixed ? 0 : vp.scrollY;
  const doc: Rect = { x: rect.x + sx, y: rect.y + sy, width: rect.width, height: rect.height };
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  return {
    viewport: { ...rect },
    document: doc,
    area: rect.width * rect.height,
    center: { x: doc.x + rect.width / 2, y: doc.y + rect.height / 2 },
    viewportVisibleFraction: round(clippedFraction(rect, clipRect, { x: 0, y: 0, width: vp.width, height: vp.height })),
    firstScreenFraction: round(
      clippedFraction(doc, clipRect && { ...clipRect, x: clipRect.x + sx, y: clipRect.y + sy }, { x: 0, y: 0, width: vp.width, height: vp.height }),
    ),
    topInViewportHeights: vp.height > 0 ? round(doc.y / vp.height) : 0,
  };
}

export interface ClipFacts {
  /** From non-scrollable clippers only (overflow hidden/clip, contain: paint). */
  state: ClipState;
  fraction: number;
  /**
   * Viewport-relative rect of ALL clipping ancestors, including scroll containers (content scrolled
   * out of a nested scroller is reachable, so it affects visibility but not `rendered`).
   */
  rect: Rect | null;
  /** The element sits inside a scrollable container (its document position may exceed the document). */
  inScrollContainer: boolean;
}

const NO_CLIP: ClipFacts = { state: 'none', fraction: 1, rect: null, inScrollContainer: false };
const HARD_CLIP_OVERFLOW = new Set(['hidden', 'clip']);
const SCROLL_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

interface AncestorInfo {
  position: string;
  /** 'hard': clips with no user scrolling; 'scroll': a scroll container; null: no clipping. */
  clips: 'hard' | 'scroll' | null;
  /** Establishes a containing block for fixed/absolute descendants (transform, filter, contain…). */
  containsFixed: boolean;
  /** clip-path / mask: clipping we do not model. */
  unmodelledClip: boolean;
}

/**
 * Ancestor facts with per-analysis memoization: positioning (fixed/sticky ancestry) and a
 * conservative ancestor-clip model.
 *
 * Clip model: walk up from the element; an ancestor with non-visible overflow (or contain:
 * paint) clips the element unless the element escapes it through positioning — an absolutely
 * positioned box escapes clippers below its containing block (nearest positioned or
 * transformed ancestor); a fixed box escapes everything up to a transformed/filtered/contained
 * ancestor. html/body are skipped (their overflow applies to the viewport). Ancestors with
 * clip-path/mask make the result `uncertain` instead of guessing.
 */
export function ancestorModel(reader: DomReader): {
  positioning(el: Element, ownPosition: string): PositioningFacts;
  clip(el: Element, ownPosition: string, rect: Rect): ClipFacts;
} {
  const info = new Map<Element, AncestorInfo>();
  const rects = new Map<Element, Rect>();
  const chainMemo = new Map<Element, { fixed: boolean; sticky: boolean }>();
  const isRoot = (el: Element): boolean => el === el.ownerDocument.documentElement || el === el.ownerDocument.body;

  const infoOf = (el: Element): AncestorInfo => {
    let i = info.get(el);
    if (i) return i;
    const s = reader.style(el);
    const v = (p: string, d: string): string => s.getPropertyValue(p) || d;
    const contain = v('contain', 'none');
    const transform = v('transform', 'none');
    const filter = v('filter', 'none');
    const willChange = v('will-change', 'auto');
    const ox = v('overflow-x', 'visible');
    const oy = v('overflow-y', 'visible');
    i = {
      position: v('position', 'static'),
      clips:
        SCROLL_OVERFLOW.has(ox) || SCROLL_OVERFLOW.has(oy)
          ? 'scroll'
          : HARD_CLIP_OVERFLOW.has(ox) || HARD_CLIP_OVERFLOW.has(oy) || /\b(paint|strict|content)\b/.test(contain)
            ? 'hard'
            : null,
      containsFixed:
        transform !== 'none' || filter !== 'none' || /\b(paint|layout|strict|content)\b/.test(contain) || /transform|filter/.test(willChange),
      unmodelledClip: v('clip-path', 'none') !== 'none' || v('mask-image', 'none') !== 'none' || v('-webkit-mask-image', 'none') !== 'none',
    };
    info.set(el, i);
    return i;
  };
  const rectOf = (el: Element): Rect => {
    let r = rects.get(el);
    if (!r) {
      r = reader.rect(el);
      rects.set(el, r);
    }
    return r;
  };
  const chain = (el: Element | null): { fixed: boolean; sticky: boolean } => {
    if (!el || isRoot(el)) return { fixed: false, sticky: false };
    const cached = chainMemo.get(el);
    if (cached) return cached;
    const pos = infoOf(el).position;
    const up = chain(parentElementOrHost(el));
    const out = { fixed: up.fixed || pos === 'fixed', sticky: up.sticky || pos === 'sticky' };
    chainMemo.set(el, out);
    return out;
  };

  return {
    positioning(el, ownPosition) {
      const up = chain(parentElementOrHost(el));
      return { position: ownPosition, inFixed: up.fixed || ownPosition === 'fixed', inSticky: up.sticky || ownPosition === 'sticky' };
    },
    clip(el, ownPosition, rect) {
      let mode: 'normal' | 'absolute' | 'fixed' = ownPosition === 'fixed' ? 'fixed' : ownPosition === 'absolute' ? 'absolute' : 'normal';
      let clipRect: Rect | null = null;
      let hardRect: Rect | null = null;
      let inScrollContainer = false;
      for (let a = parentElementOrHost(el); a && !isRoot(a); a = parentElementOrHost(a)) {
        const i = infoOf(a);
        if (i.unmodelledClip) return { state: 'uncertain', fraction: 1, rect: null, inScrollContainer };
        const isContainingBlock =
          mode === 'normal' ||
          (mode === 'absolute' && (i.position !== 'static' || i.containsFixed)) ||
          (mode === 'fixed' && i.containsFixed);
        if (!isContainingBlock) continue; // the positioned box escapes this ancestor's clip
        if (i.clips) {
          const r = rectOf(a);
          clipRect = clipRect ? intersect(clipRect, r) : r;
          if (i.clips === 'hard') hardRect = hardRect ? intersect(hardRect, r) : r;
          else inScrollContainer = true;
        }
        mode = i.position === 'fixed' ? 'fixed' : i.position === 'absolute' ? 'absolute' : 'normal';
      }
      if (!clipRect) return NO_CLIP;
      const area = rect.width * rect.height;
      if (!hardRect || area <= 0) return { state: 'none', fraction: 1, rect: clipRect, inScrollContainer };
      const visible = intersect(rect, hardRect);
      const fraction = Math.round(((visible.width * visible.height) / area) * 1000) / 1000;
      const state: ClipState = fraction >= 0.999 ? 'none' : fraction <= 0.001 ? 'full' : 'partial';
      return { state, fraction, rect: clipRect, inScrollContainer };
    },
  };
}

/** Parent element, crossing open shadow-root boundaries to the host. */
export function parentElementOrHost(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode?.();
  return root instanceof ShadowRoot ? root.host : null;
}
