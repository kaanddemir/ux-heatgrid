/**
 * RecordedOverlay — draws one Recorded page map over the LIVE page it was recorded on.
 * Owned by TabRuntime; shares the overlay host (closed shadow root, pointer-events none,
 * aria-hidden) with Predicted, and only one of them is visible at a time.
 *
 * - Two fixed viewport canvases: heat (density tiles) and marks (clicks, deepest-scroll line,
 *   neutral selection outline). Never one canvas covering the document.
 * - Scrolling only re-composites: one rAF per burst of scroll/resize events reads geometry,
 *   plans which cached tiles intersect the viewport, and draws them. No density work, no
 *   smoothing and no analysis happens while scrolling; tiles are rasterised once (LRU cache).
 * - Nested scroll roots: their tiles move with the container's scroll offset and are clipped to
 *   its visible client box; document heat under that box is cleared first, so roots never mix.
 *   A nested root is drawn only when its container resolves in THIS document (local page).
 */
import type { ClickMarker } from '../recorded/markers';
import type { PackedDensity } from '../recorded/normalize';
import { LruCache, tilePixels, tileRows, tilesForBand } from '../recorded/tiles';
import type { RecordedLayers, RecordedPageResult } from '../recorded/types';
import { renderRecordedLabel } from './legend';
import { intersect, type Box } from './positioning';
import { createOverlayRoot, type OverlayRoot } from './root';

export interface RootPlacement {
  /** Viewport position of the root's content origin (0,0). */
  originX: number;
  originY: number;
  /** Visible client box of the container in viewport coordinates (already cut to the viewport). */
  clip: Box | null;
}

export interface ViewState {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface HeatDraw {
  rootId: number;
  tile: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  clip: Box;
}

export interface FramePlan {
  heat: HeatDraw[];
  /** Nested containers' visible boxes: document heat is cleared there before nested heat is drawn. */
  holes: Box[];
  markers: Array<{ x: number; y: number; count: number; maybeNotClickable: boolean }>;
  /** Viewport y of the deepest-scroll line, or null when off screen / hidden. */
  line: number | null;
  /** Roots with data that were not drawn (container not resolvable on this document). */
  skippedRoots: number[];
}

const MARKER_MARGIN = 16;
/** Marker ring diameter: closer markers are merged for drawing. */
const MARKER_MERGE_PX = 16;

/** Pure: what to draw this frame. */
export function planFrame(page: RecordedPageResult, view: ViewState, nested: ReadonlyMap<number, RootPlacement | null>, layers: RecordedLayers): FramePlan {
  const viewport: Box = { x: 0, y: 0, width: view.width, height: view.height };
  const plan: FramePlan = { heat: [], holes: [], markers: [], line: null, skippedRoots: [] };
  const placement = (rootId: number, kind: 'document' | 'container'): RootPlacement | null =>
    kind === 'document' ? { originX: -view.scrollX, originY: -view.scrollY, clip: viewport } : (nested.get(rootId) ?? null);
  const kindOf = (rootId: number): 'document' | 'container' => page.density.roots.find((r) => r.rootId === rootId)?.kind ?? (page.scrollMetrics.nested.some((n) => n.rootId === rootId) ? 'container' : 'document');

  for (const d of [...page.density.roots].sort((a, b) => (a.kind === b.kind ? a.rootId - b.rootId : a.kind === 'document' ? -1 : 1))) {
    const pl = placement(d.rootId, d.kind);
    if (!pl) {
      if (d.value.length) plan.skippedRoots.push(d.rootId);
      continue;
    }
    if (!pl.clip) continue;
    if (d.kind === 'container') plan.holes.push(pl.clip);
    if (!layers.heatmap) continue;
    const tilePx = tileRows(d) * d.cellPx;
    for (const t of tilesForBand(d, pl.clip.y - pl.originY, pl.clip.y + pl.clip.height - pl.originY)) {
      const rows = Math.min(tileRows(d), d.rows - t * tileRows(d));
      plan.heat.push({ rootId: d.rootId, tile: t, dx: pl.originX, dy: pl.originY + t * tilePx, dw: d.cols * d.cellPx, dh: rows * d.cellPx, clip: pl.clip });
    }
  }
  if (layers.clicks) {
    for (const m of page.clickMarkers) {
      const pl = placement(m.rootId, kindOf(m.rootId));
      if (!pl?.clip) continue;
      const x = pl.originX + m.x;
      const y = pl.originY + m.y;
      const c = pl.clip;
      if (x < c.x - MARKER_MARGIN || y < c.y - MARKER_MARGIN || x > c.x + c.width + MARKER_MARGIN || y > c.y + c.height + MARKER_MARGIN) continue;
      // Markers whose rings would overlap are drawn as one (counts summed) — repeated clicks on
      // the same spot over time otherwise stack into an unreadable pile. Drawing aid only.
      const near = plan.markers.find((o) => Math.hypot(o.x - x, o.y - y) < MARKER_MERGE_PX);
      if (near) {
        near.count += m.count;
        near.maybeNotClickable ||= m.maybeNotClickable;
      } else plan.markers.push({ x, y, count: m.count, maybeNotClickable: m.maybeNotClickable });
    }
  }
  const doc = page.scrollMetrics.document;
  if (layers.scroll && doc && doc.deepestPx > 0) {
    const y = doc.deepestPx - view.scrollY;
    if (y >= 0 && y <= view.height) plan.line = y;
  }
  return plan;
}

export interface RecordedOverlayDeps {
  /** Live element for a registry id of THIS document, or null. */
  resolve: (id: number) => Element | null;
  win?: Window;
  raf?: (cb: () => void) => number;
  caf?: (handle: number) => void;
  /** Presentation-only layer controls in the floating on-page card. */
  onLayers?: (layers: RecordedLayers) => void;
  /** Closes the complete on-page visualization, including its control card. */
  onClose?: () => void;
}

export interface RecordedShowOptions {
  title: string;
  layers: RecordedLayers;
  focusedElementId: number | null;
}

type TileSource = OffscreenCanvas | HTMLCanvasElement;

export class RecordedOverlay {
  private readonly win: Window;
  private readonly raf: (cb: () => void) => number;
  private readonly caf: (handle: number) => void;
  private root: OverlayRoot | null = null;
  private heat: HTMLCanvasElement | null = null;
  private marks: HTMLCanvasElement | null = null;
  private page: RecordedPageResult | null = null;
  private opts: RecordedShowOptions | null = null;
  private tiles = new LruCache<TileSource | null>();
  private frame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastPlan: FramePlan | null = null;
  private lastSelection: Box | null = null;
  private disposed = false;
  readonly stats = { frames: 0, totalMs: 0, maxMs: 0, lastMs: 0, tilesBuilt: 0, tileMs: 0, lastTiles: 0 };

  constructor(private readonly deps: RecordedOverlayDeps) {
    this.win = deps.win ?? window;
    this.raf = deps.raf ?? ((cb) => this.win.requestAnimationFrame(cb));
    this.caf = deps.caf ?? ((h) => this.win.cancelAnimationFrame(h));
  }

  /** Shows `page` (must be the live page's segment — the caller verifies the page identity). */
  show(page: RecordedPageResult, opts: RecordedShowOptions): void {
    if (this.disposed) return;
    if (this.page !== page) this.tiles.clear();
    this.page = page;
    this.opts = opts;
    if (!this.root) this.mount();
    renderRecordedLabel(this.root!.label, opts.title, opts.layers, this.deps.onLayers, this.deps.onClose);
    this.schedule();
  }

  hide(): void {
    this.unmount();
    this.page = null;
    this.opts = null;
    this.tiles.clear();
  }

  get visible(): boolean {
    return this.root !== null;
  }

  inspect(): { mounted: boolean; title: string; plan: FramePlan | null; selection: Box | null; tilesCached: number; hostPointerEvents: string } {
    return {
      mounted: this.root !== null && this.root.host.isConnected,
      title: this.root?.label.querySelector('.title')?.textContent ?? '',
      plan: this.lastPlan,
      selection: this.lastSelection,
      tilesCached: this.tiles.size,
      hostPointerEvents: this.root?.host.style.getPropertyValue('pointer-events') ?? '',
    };
  }

  flush(): void {
    if (this.frame !== null) {
      this.caf(this.frame);
      this.frame = null;
    }
    if (this.root) this.compose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
  }

  // -------------------------------------------------------------------------

  private mount(): void {
    this.root = createOverlayRoot(this.win.document);
    const doc = this.win.document;
    this.heat = doc.createElement('canvas');
    this.heat.className = 'canvas heat';
    this.marks = doc.createElement('canvas');
    this.marks.className = 'canvas marks';
    this.root.layer.insertBefore(this.heat, this.root.label);
    this.root.layer.insertBefore(this.marks, this.root.label);
    this.root.label.dataset.kind = 'recorded';
    this.win.addEventListener('scroll', this.onChange, { capture: true, passive: true });
    this.win.addEventListener('resize', this.onChange, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onChange);
      this.resizeObserver.observe(doc.documentElement);
    }
  }

  private unmount(): void {
    if (this.frame !== null) this.caf(this.frame);
    this.frame = null;
    this.win.removeEventListener('scroll', this.onChange, { capture: true });
    this.win.removeEventListener('resize', this.onChange);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.root = null;
    this.heat = null;
    this.marks = null;
    this.lastPlan = null;
    this.lastSelection = null;
  }

  private readonly onChange = (): void => this.schedule();

  private schedule(): void {
    if (this.frame !== null || !this.root) return;
    this.frame = this.raf(() => {
      this.frame = null;
      this.compose();
    });
  }

  private placements(page: RecordedPageResult, viewport: Box): Map<number, RootPlacement | null> {
    const out = new Map<number, RootPlacement | null>();
    for (const n of page.scrollMetrics.nested) {
      const el = page.local && n.elementRef !== undefined ? this.deps.resolve(n.elementRef) : null;
      if (!el) {
        out.set(n.rootId, null);
        continue;
      }
      const r = el.getBoundingClientRect();
      const box: Box = { x: r.left + el.clientLeft, y: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
      out.set(n.rootId, { originX: box.x - el.scrollLeft, originY: box.y - el.scrollTop, clip: intersect(box, viewport) });
    }
    return out;
  }

  private tile(d: PackedDensity, t: number): TileSource | null {
    return this.tiles.get(`${d.rootId}:${t}`, () => {
      const t0 = performance.now();
      const px = tilePixels(d, t);
      const canvas: TileSource =
        typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px.width, px.height) : Object.assign(this.win.document.createElement('canvas'), { width: px.width, height: px.height });
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!ctx || typeof ImageData === 'undefined') return null;
      ctx.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
      this.stats.tilesBuilt++;
      this.stats.tileMs += performance.now() - t0;
      return canvas;
    });
  }

  private compose(): void {
    const page = this.page;
    const opts = this.opts;
    if (!page || !opts || !this.heat || !this.marks) return;
    const t0 = performance.now();
    const doc = this.win.document;
    // Reads.
    const view: ViewState = { width: doc.documentElement.clientWidth || this.win.innerWidth, height: this.win.innerHeight, scrollX: this.win.scrollX, scrollY: this.win.scrollY };
    const viewport: Box = { x: 0, y: 0, width: view.width, height: view.height };
    const plan = planFrame(page, view, this.placements(page, viewport), opts.layers);
    let selection: Box | null = null;
    if (opts.focusedElementId !== null && page.local) {
      const el = this.deps.resolve(opts.focusedElementId);
      if (el) {
        const r = el.getBoundingClientRect();
        selection = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    // Writes.
    const dpr = this.win.devicePixelRatio || 1;
    const heat = this.prepare(this.heat, view, dpr);
    const marks = this.prepare(this.marks, view, dpr);
    if (heat) {
      heat.imageSmoothingEnabled = true;
      heat.imageSmoothingQuality = 'high';
      heat.globalAlpha = selection ? 0.55 : 1;
      const byId = new Map(page.density.roots.map((d) => [d.rootId, d]));
      let holesCleared = false;
      for (const h of plan.heat) {
        const d = byId.get(h.rootId)!;
        if (d.kind === 'container' && !holesCleared) {
          for (const b of plan.holes) heat.clearRect(b.x, b.y, b.width, b.height);
          holesCleared = true;
        }
        const src = this.tile(d, h.tile);
        if (!src) continue;
        heat.save();
        heat.beginPath();
        heat.rect(h.clip.x, h.clip.y, h.clip.width, h.clip.height);
        heat.clip();
        // Source skips the one padding row above/below (it only feeds bilinear blending).
        heat.drawImage(src, 0, 1, d.cols, h.dh / d.cellPx, h.dx, h.dy, h.dw, h.dh);
        heat.restore();
      }
      if (!holesCleared) for (const b of plan.holes) heat.clearRect(b.x, b.y, b.width, b.height);
    }
    if (marks) {
      if (plan.line !== null) drawScrollLine(marks, plan.line, view.width, view.height);
      for (const m of plan.markers) drawMarker(marks, m);
      if (selection) drawSelection(marks, selection);
    }
    this.lastPlan = plan;
    this.lastSelection = selection;
    const ms = performance.now() - t0;
    this.stats.frames++;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.lastMs = ms;
    this.stats.lastTiles = plan.heat.length;
  }

  private prepare(c: HTMLCanvasElement, view: ViewState, dpr: number): CanvasRenderingContext2D | null {
    const w = Math.max(1, Math.round(view.width * dpr));
    const h = Math.max(1, Math.round(view.height * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      c.style.width = `${view.width}px`;
      c.style.height = `${view.height}px`;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    return ctx;
  }
}

/*
 * Marks share one language with the legend: white strokes on a soft dark halo (legible over the
 * heat ramp and on light or dark pages), small glass pills for text.
 */
const WHITE = '#ffffff';
const HALO = 'rgba(14, 15, 22, 0.55)';
const PILL = 'rgba(16, 17, 24, 0.82)';
const PILL_EDGE = 'rgba(255, 255, 255, 0.14)';
/** Height kept free above the bottom edge for the responsive floating control card. */
const LEGEND_BAND = 88;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function pillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = Math.min(h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 1;
  pillPath(ctx, x, y, w, h);
  ctx.fillStyle = PILL;
  ctx.fill();
  ctx.restore();
  pillPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.lineWidth = 1;
  ctx.strokeStyle = PILL_EDGE;
  ctx.stroke();
}

/** Click marker: thin ring + centre dot; repeated clicks get a compact count pill. */
function drawMarker(ctx: CanvasRenderingContext2D, m: FramePlan['markers'][number]): void {
  const R = 5.5;
  ctx.save();
  // Halo first (wider, dark, slightly transparent), then the white ring on top. "May not be
  // clickable" dashes both, so the gaps stay clean.
  ctx.setLineDash(m.maybeNotClickable ? [3, 2.5] : []);
  ctx.beginPath();
  ctx.arc(m.x, m.y, R, 0, Math.PI * 2);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = HALO;
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = WHITE;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(m.x, m.y, 2, 0, Math.PI * 2);
  ctx.fillStyle = WHITE;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = HALO;
  ctx.stroke();
  if (m.count > 1) {
    const text = `×${m.count}`;
    ctx.font = `600 10px ${FONT}`;
    const w = Math.ceil(ctx.measureText(text).width) + 9;
    const h = 15;
    const x = m.x + R + 2;
    const y = m.y - R - h + 3;
    pill(ctx, x, y, w, h);
    ctx.fillStyle = WHITE;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 4.5, y + h / 2 + 0.5);
  }
  ctx.restore();
}

/** Deepest scroll: a thin dashed rule with a small pill at the right edge. */
function drawScrollLine(ctx: CanvasRenderingContext2D, y: number, width: number, height: number): void {
  const ly = Math.round(y) + 0.5;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(0, ly);
  ctx.lineTo(width, ly);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(14, 15, 22, 0.28)';
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.stroke();
  ctx.setLineDash([]);
  const text = 'Deepest scroll';
  ctx.font = `500 10.5px ${FONT}`;
  const h = 18;
  const w = Math.ceil(ctx.measureText(text).width) + 14;
  const x = width - w - 14;
  // Centred on the rule, but never in the legend's band at the bottom right.
  const top = Math.max(2, Math.min(ly - h / 2, height - LEGEND_BAND - h));
  pill(ctx, x, top, w, h);
  ctx.fillStyle = WHITE;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 7, top + h / 2 + 0.5);
  ctx.restore();
}

/** Selected control: neutral rounded outline (white on a dark halo). */
function drawSelection(ctx: CanvasRenderingContext2D, b: Box): void {
  const x = b.x - 4;
  const y = b.y - 4;
  const w = b.width + 8;
  const h = b.height + 8;
  const r = Math.min(8, w / 2, h / 2);
  const path = (): void => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.save();
  path();
  ctx.lineWidth = 4;
  ctx.strokeStyle = HALO;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = WHITE;
  ctx.stroke();
  ctx.restore();
}

/** CSS gradient for the legend swatch (same ramp as the heat). */

export type { ClickMarker };
