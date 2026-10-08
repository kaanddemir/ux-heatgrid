/**
 * OverlayController — draws Predicted Interaction on the page. Owned by TabRuntime; one per runtime.
 *
 * - Element-based outlines, never a density map (warm heat colours are reserved for Recorded).
 * - Positions come from LIVE getBoundingClientRect() of elements resolved through the shared
 *   ElementRegistry (cached id → Element), never from analysis-time rects.
 * - Updates are event-driven: scroll (capture, passive) / resize / document size changes schedule
 *   ONE requestAnimationFrame; the frame does all reads, then all writes. No polling, no DOM-wide
 *   queries, no analysis and no prediction work during scrolling.
 * - Elements that can no longer be resolved are simply not drawn.
 */
import { overlayBox, sameBox, type Box } from './positioning';
import { renderPredictionFilter } from './legend';
import { selectOverlayItems, type OverlayBandFilter, type OverlayCandidate, type OverlayItem, type PaintedBand } from './predicted';
import { createOverlayRoot, type OverlayRoot } from './root';

export interface OverlayDeps {
  /** Live element for a registry id, or null (collected / detached). */
  resolve: (id: number) => Element | null;
  win?: Window;
  raf?: (cb: () => void) => number;
  caf?: (handle: number) => void;
  /** Closes the complete on-page visualization, including its control card. */
  onClose?: () => void;
}

export interface OverlayInspection {
  mounted: boolean;
  stale: boolean;
  showLow: boolean;
  filter: OverlayBandFilter;
  selectedId: number | null;
  title: string;
  boxes: Array<{ id: number; band: PaintedBand; selected: boolean; dimmed: boolean; drawn: boolean; box: Box | null }>;
  /** Selected items whose element could not be resolved this frame. */
  missing: number[];
}

interface Slot {
  item: OverlayItem;
  node: HTMLElement;
  el: Element | null;
  box: Box | null;
}

const CLIPPING = /(hidden|scroll|auto|clip)/;

export class OverlayController {
  private readonly win: Window;
  private readonly raf: (cb: () => void) => number;
  private readonly caf: (handle: number) => void;
  private root: OverlayRoot | null = null;
  private visible = false;
  private stale = false;
  private showLow = true;
  private filter: OverlayBandFilter = 'all';
  private selectedId: number | null = null;
  private candidates: readonly OverlayCandidate[] = [];
  private slots = new Map<number, Slot>();
  private frame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Clipping ancestors per element (computed once per element, style reads only). */
  private clipAncestors = new WeakMap<Element, Element[]>();
  private disposed = false;
  /** Layout frame cost (ms), for performance measurement only. */
  readonly stats = { frames: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastBoxes: 0 };

  constructor(private readonly deps: OverlayDeps) {
    this.win = deps.win ?? window;
    this.raf = deps.raf ?? ((cb) => this.win.requestAnimationFrame(cb));
    this.caf = deps.caf ?? ((h) => this.win.cancelAnimationFrame(h));
  }

  /** Shows or hides the overlay (InteractionView 'predicted' vs anything else). */
  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    this.sync();
  }

  /** Sets the predicted elements (null clears). Keeps the selection if it is still present. */
  setPrediction(candidates: readonly OverlayCandidate[] | null): void {
    if (this.disposed) return;
    this.candidates = candidates ?? [];
    if (this.selectedId !== null && !this.candidates.some((c) => c.id === this.selectedId)) this.selectedId = null;
    this.stale = false;
    this.sync();
  }

  setStale(stale: boolean): void {
    if (this.disposed || this.stale === stale) return;
    this.stale = stale;
    this.sync();
  }

  setShowLow(showLow: boolean): void {
    if (this.disposed || this.showLow === showLow) return;
    this.showLow = showLow;
    this.sync();
  }

  /** Changes the compact on-page legend filter without changing prediction data. */
  setBandFilter(filter: OverlayBandFilter): void {
    if (this.disposed || this.filter === filter) return;
    this.filter = filter;
    if (filter === 'all' || filter === 'low') this.showLow = true;
    this.sync();
  }

  /** Selects (highlights) one predicted element, or clears with null. */
  select(id: number | null): void {
    if (this.disposed) return;
    this.selectedId = id;
    this.sync();
  }

  get selection(): number | null {
    return this.selectedId;
  }

  inspect(): OverlayInspection {
    const boxes = [...this.slots.values()].map((s) => ({
      id: s.item.id,
      band: s.item.band,
      selected: s.item.selected,
      dimmed: this.selectedId !== null && !s.item.selected,
      drawn: s.box !== null,
      box: s.box,
    }));
    return {
      mounted: this.root !== null && this.root.host.isConnected,
      stale: this.stale,
      showLow: this.showLow,
      filter: this.filter,
      selectedId: this.selectedId,
      title: this.root?.label.querySelector('.title')?.textContent ?? '',
      boxes,
      missing: [...this.slots.values()].filter((s) => s.el === null).map((s) => s.item.id),
    };
  }

  /** Runs the pending layout frame immediately (tests and measurement). */
  flush(): void {
    if (this.frame !== null) {
      this.caf(this.frame);
      this.frame = null;
    }
    if (this.root) this.layout();
  }

  dispose(): void {
    if (this.disposed) return;
    this.unmount();
    this.disposed = true;
    this.candidates = [];
  }

  // -------------------------------------------------------------------------

  private sync(): void {
    const shouldShow = this.visible && this.candidates.length > 0;
    if (!shouldShow) {
      this.unmount();
      return;
    }
    if (!this.root) this.mount();
    const root = this.root!;
    renderPredictionFilter(root.label, {
      stale: this.stale,
      filter: this.filter,
      onFilter: this.setBandFilter.bind(this),
      onClose: this.deps.onClose,
    });
    if (this.selectedId !== null) root.layer.dataset.focus = '';
    else delete root.layer.dataset.focus;
    this.rebuildSlots(selectOverlayItems(this.candidates, { showLow: this.showLow, selectedId: this.selectedId, filter: this.filter }));
    this.schedule();
  }

  private rebuildSlots(items: OverlayItem[]): void {
    const root = this.root!;
    const next = new Map<number, Slot>();
    for (const item of items) {
      const prev = this.slots.get(item.id);
      const node = prev?.node ?? root.layer.ownerDocument.createElement('div');
      if (!prev) {
        node.className = 'box';
        node.dataset.id = String(item.id); // inside the closed shadow root: diagnostics only
        node.style.display = 'none';
        root.layer.insertBefore(node, root.label);
      }
      node.dataset.band = item.band;
      if (item.selected) node.dataset.selected = '';
      else delete node.dataset.selected;
      next.set(item.id, { item, node, el: prev?.el ?? null, box: prev?.box ?? null });
    }
    for (const [id, slot] of this.slots) if (!next.has(id)) slot.node.remove();
    this.slots = next;
  }

  private mount(): void {
    this.root = createOverlayRoot(this.win.document);
    this.win.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    this.win.addEventListener('resize', this.onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onScroll);
      this.resizeObserver.observe(this.win.document.documentElement);
    }
  }

  private unmount(): void {
    if (this.frame !== null) this.caf(this.frame);
    this.frame = null;
    this.win.removeEventListener('scroll', this.onScroll, { capture: true });
    this.win.removeEventListener('resize', this.onScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.root = null;
    this.slots = new Map();
  }

  private readonly onScroll = (): void => this.schedule();

  private schedule(): void {
    if (this.frame !== null || !this.root) return;
    this.frame = this.raf(() => {
      this.frame = null;
      this.layout();
    });
  }

  /** Viewport rects of the element's clipping ancestors (cached per frame). */
  private clipsFor(el: Element, frameCache: Map<Element, Box>): Box[] {
    let ancestors = this.clipAncestors.get(el);
    if (!ancestors) {
      ancestors = [];
      const docEl = this.win.document.documentElement;
      for (let a = el.parentElement; a && a !== docEl && a !== this.win.document.body; a = a.parentElement) {
        const s = this.win.getComputedStyle(a);
        if (CLIPPING.test(s.overflowX) || CLIPPING.test(s.overflowY)) ancestors.push(a);
        if (s.position === 'fixed') break;
      }
      this.clipAncestors.set(el, ancestors);
    }
    return ancestors.map((a) => {
      let r = frameCache.get(a);
      if (!r) {
        const b = a.getBoundingClientRect();
        r = { x: b.x, y: b.y, width: b.width, height: b.height };
        frameCache.set(a, r);
      }
      return r;
    });
  }

  private layout(): void {
    const t0 = performance.now();
    const doc = this.win.document;
    const viewport = { width: doc.documentElement.clientWidth || this.win.innerWidth, height: this.win.innerHeight };
    const frameCache = new Map<Element, Box>();
    // Reads.
    const boxes: Array<Box | null> = [];
    for (const slot of this.slots.values()) {
      if (!slot.el || !slot.el.isConnected) slot.el = this.deps.resolve(slot.item.id);
      if (!slot.el) {
        boxes.push(null);
        continue;
      }
      const r = slot.el.getBoundingClientRect();
      boxes.push(overlayBox({ x: r.x, y: r.y, width: r.width, height: r.height }, this.clipsFor(slot.el, frameCache), viewport));
    }
    // Writes (only for boxes that changed).
    let i = 0;
    for (const slot of this.slots.values()) {
      const box = boxes[i++] ?? null;
      if (sameBox(slot.box, box)) continue;
      slot.box = box;
      const s = slot.node.style;
      if (!box) {
        s.display = 'none';
        continue;
      }
      s.display = 'block';
      s.width = `${Math.round(box.width)}px`;
      s.height = `${Math.round(box.height)}px`;
      s.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
    }
    const ms = performance.now() - t0;
    this.stats.frames++;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.lastMs = ms;
    this.stats.lastBoxes = this.slots.size;
  }
}
