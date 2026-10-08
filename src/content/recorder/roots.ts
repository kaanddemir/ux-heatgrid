/**
 * Scroll roots for the recorder: the document plus up to MAX_ROOTS - 1 nested scroll containers
 * (from the start snapshot, plus containers discovered lazily when the pointer or a scroll
 * reaches them). Pointer and click coordinates are stored in the coordinate space of the root
 * they happened in:
 *  - document root: document space (client + window scroll)
 *  - container root: root-content space (client − container content-box origin + its scroll)
 * Viewport coordinates are never mixed with scroll-content coordinates.
 */
export const MAX_ROOTS = 8;
/** A nested container qualifies when it is at least this large… */
export const MIN_ROOT_W = 300;
export const MIN_ROOT_H = 200;
/** …or covers at least this share of the viewport area. */
export const MIN_ROOT_VIEWPORT_SHARE = 0.2;
const SCROLLABLE = /^(auto|scroll|overlay)$/;

export type RootGeometry =
  | { kind: 'document'; scrollX: number; scrollY: number }
  | { kind: 'container'; left: number; top: number; clientLeft: number; clientTop: number; scrollLeft: number; scrollTop: number };

/** Client (viewport) point → root coordinates. Pure. */
export function toRootCoords(clientX: number, clientY: number, g: RootGeometry): { x: number; y: number } {
  if (g.kind === 'document') return { x: clientX + g.scrollX, y: clientY + g.scrollY };
  return { x: clientX - g.left - g.clientLeft + g.scrollLeft, y: clientY - g.top - g.clientTop + g.scrollTop };
}

export interface ScrollBox {
  overflowX: string;
  overflowY: string;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

/** Whether a container is a relevant nested scroll root. Pure. */
export function qualifiesAsRoot(b: ScrollBox, viewport: { width: number; height: number }): boolean {
  const scrollY = SCROLLABLE.test(b.overflowY) && b.scrollHeight > b.clientHeight + 1;
  const scrollX = SCROLLABLE.test(b.overflowX) && b.scrollWidth > b.clientWidth + 1;
  if (!scrollY && !scrollX) return false;
  const big = b.clientWidth >= MIN_ROOT_W && b.clientHeight >= MIN_ROOT_H;
  const share = (b.clientWidth * b.clientHeight) / Math.max(1, viewport.width * viewport.height);
  return big || share >= MIN_ROOT_VIEWPORT_SHARE;
}

export interface TrackedRoot {
  id: number;
  kind: 'document' | 'container';
  el: Element | null;
  elementRef?: number;
  lazy: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  deepestPx: number;
}

export class RootRegistry {
  readonly roots: TrackedRoot[] = [];
  private byEl = new Map<Element, TrackedRoot>();
  /** Per-element: the root its content belongs to (cached for the session). */
  private rootOf = new WeakMap<Element, TrackedRoot>();
  private qualifies = new WeakMap<Element, boolean>();
  private geometry = new Map<TrackedRoot, { epoch: number; g: RootGeometry }>();
  private epoch = 0;
  private nextId = 1;
  /** A qualifying container could not be tracked (cap reached). */
  untracked = false;

  constructor(
    private readonly win: Window,
    initial: Array<{ id: number; kind: 'document' | 'container'; el: Element | null; elementRef?: number }>,
    private readonly register?: (el: Element) => number,
  ) {
    const doc = initial.find((r) => r.kind === 'document');
    this.add({ id: doc?.id ?? 0, kind: 'document', el: null, lazy: false });
    for (const r of initial) {
      if (r.kind !== 'container' || !r.el || this.roots.length >= MAX_ROOTS) continue;
      this.add({ id: r.id, kind: 'container', el: r.el, ...(r.elementRef !== undefined ? { elementRef: r.elementRef } : {}), lazy: false });
    }
    this.nextId = Math.max(0, ...this.roots.map((r) => r.id)) + 1;
  }

  get document(): TrackedRoot {
    return this.roots[0]!;
  }

  private add(r: Omit<TrackedRoot, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'deepestPx'>): TrackedRoot {
    const root: TrackedRoot = { ...r, scrollTop: 0, scrollHeight: 0, clientHeight: 0, deepestPx: 0 };
    this.roots.push(root);
    if (root.el) this.byEl.set(root.el, root);
    this.measure(root);
    return root;
  }

  /** Scroll or resize happened: cached root (and element) geometry is stale. */
  invalidate(): void {
    this.epoch++;
  }

  /** Increments whenever cached geometry becomes stale (scroll / resize). */
  get currentEpoch(): number {
    return this.epoch;
  }

  private viewport(): { width: number; height: number } {
    return { width: this.win.innerWidth, height: this.win.innerHeight };
  }

  private isQualifying(el: Element): boolean {
    let q = this.qualifies.get(el);
    if (q === undefined) {
      const s = this.win.getComputedStyle(el);
      q = qualifiesAsRoot(
        { overflowX: s.overflowX, overflowY: s.overflowY, clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight },
        this.viewport(),
      );
      this.qualifies.set(el, q);
    }
    return q;
  }

  /** Tracks `el` as a root if it qualifies (lazily). Null when it does not qualify or the cap is hit. */
  private track(el: Element): TrackedRoot | null {
    const known = this.byEl.get(el);
    if (known) return known;
    if (!this.isQualifying(el)) return null;
    if (this.roots.length >= MAX_ROOTS) {
      this.untracked = true;
      return null;
    }
    const elementRef = this.register?.(el);
    return this.add({ id: this.nextId++, kind: 'container', el, ...(elementRef !== undefined ? { elementRef } : {}), lazy: true });
  }

  /** The root whose content contains `target` (nearest tracked or qualifying scroll ancestor). */
  rootFor(target: Element | null): TrackedRoot {
    if (!target) return this.document;
    const cached = this.rootOf.get(target);
    if (cached) return cached;
    const body = this.win.document.body;
    const html = this.win.document.documentElement;
    let found: TrackedRoot | null = null;
    for (let a = target.parentElement; a && a !== body && a !== html; a = a.parentElement) {
      found = this.byEl.get(a) ?? this.track(a);
      if (found) break;
    }
    const root = found ?? this.document;
    this.rootOf.set(target, root);
    return root;
  }

  /** Root for a scroll event target (document / scrolling element → document root). */
  rootForScrollTarget(target: EventTarget | null): TrackedRoot | null {
    const doc = this.win.document;
    if (!target || target === doc || target === this.win || target === doc.documentElement || target === doc.body || target === doc.scrollingElement) {
      return this.document;
    }
    const el = target as Element;
    if ((el as Node).nodeType !== 1) return null;
    return this.track(el);
  }

  geometryOf(root: TrackedRoot): RootGeometry {
    const c = this.geometry.get(root);
    if (c && c.epoch === this.epoch) return c.g;
    let g: RootGeometry;
    if (root.kind === 'document' || !root.el) {
      g = { kind: 'document', scrollX: this.win.scrollX, scrollY: this.win.scrollY };
    } else {
      const r = root.el.getBoundingClientRect();
      g = { kind: 'container', left: r.left, top: r.top, clientLeft: root.el.clientLeft, clientTop: root.el.clientTop, scrollLeft: root.el.scrollLeft, scrollTop: root.el.scrollTop };
    }
    this.geometry.set(root, { epoch: this.epoch, g });
    return g;
  }

  /** Reads scroll extents and updates the deepest visible point. */
  measure(root: TrackedRoot): void {
    if (root.kind === 'document' || !root.el) {
      const se = this.win.document.scrollingElement ?? this.win.document.documentElement;
      root.scrollTop = this.win.scrollY;
      root.clientHeight = this.win.innerHeight;
      root.scrollHeight = Math.max(se.scrollHeight, this.win.innerHeight);
    } else {
      root.scrollTop = root.el.scrollTop;
      root.clientHeight = root.el.clientHeight;
      root.scrollHeight = Math.max(root.el.scrollHeight, root.el.clientHeight);
    }
    root.deepestPx = Math.max(root.deepestPx, Math.min(root.scrollHeight, root.scrollTop + root.clientHeight));
  }
}
