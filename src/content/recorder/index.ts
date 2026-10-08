/**
 * Recorder — captures what happens during ONE session on this page. Owned by SessionController.
 *
 * Start: a registry-mode (light) analysis gives candidates, regions, scroll roots and the layout
 * version; then capture modules attach passive capture-phase listeners on window. Every listener
 * goes through `listen()` and is removed by stop()/dispose(). Nothing is analysed, predicted or
 * rendered while recording. The capture stays in this runtime; the UI only gets a summary.
 */
import type { PageAnalyzer } from '../analyzer';
import type { RegistrySnapshot } from '../analyzer/types';
import { isMaterialResize } from '../prediction/stale';
import { OVERLAY_TAG, REC_TAG } from '../../shared/constants';
import { PointerBuffer, POINTER_CAP } from './buffer';
import { ClickTracker } from './clicks';
import type { RecorderContext } from './context';
import { ExposureTracker } from './exposure';
import { HoverTracker } from './hover';
import { ActivityClock } from './idle';
import { PointerTracker } from './pointer';
import { RootRegistry } from './roots';
import { ScrollTracker } from './scroll';
import { CandidateResolver } from './targets';
import type {
  LimitationCode,
  LiveCaptureStats,
  RecordedElementStats,
  RecordedRegionStats,
  SessionCapture,
  SessionCaptureDetails,
} from './types';
import { summarizeCapture } from './summary';

export { summarizeCapture };

export const SHORT_SESSION_MS = 10_000;
export const FEW_EVENTS = 30;
/** Document scroll travel below this share of the viewport height is LITTLE_SCROLL. */
export const LITTLE_SCROLL_SHARE = 0.25;
/** Element nodes changed during recording that mark PAGE_CHANGED. */
export const PAGE_CHANGE_NODES = 100;

/** Listeners currently attached by all recorders in this runtime (diagnostics / tests). */
export let liveRecorderListeners = 0;

export interface RecorderDeps {
  analyzer: Pick<PageAnalyzer, 'analyze' | 'registry'>;
  win?: Window;
  now?: () => number;
  raf?: (cb: () => void) => number;
  caf?: (h: number) => void;
  IntersectionObserver?: ConstructorParameters<typeof ExposureTracker>[1];
  MutationObserver?: typeof MutationObserver;
  pointerCap?: number;
  /** Small page REC indicator (default: none). */
  indicator?: () => { remove(): void };
}

export interface Recorder {
  live(): LiveCaptureStats;
  /** Finalizes and detaches everything; returns the capture. Idempotent (same capture). */
  stop(): SessionCapture;
  dispose(): void;
  listenerCount(): number;
}

export function startRecorder(deps: RecorderDeps): Recorder {
  const win = deps.win ?? window;
  const now = deps.now ?? (() => performance.now());
  const raf = deps.raf ?? ((cb) => win.requestAnimationFrame(cb));
  const caf = deps.caf ?? ((h) => win.cancelAnimationFrame(h));
  const IO = 'IntersectionObserver' in deps ? deps.IntersectionObserver : (win as Window & typeof globalThis).IntersectionObserver;
  const MO = deps.MutationObserver ?? (win as Window & typeof globalThis).MutationObserver;

  const snapshot = deps.analyzer.analyze({ mode: 'registry' }) as RegistrySnapshot;
  const registry = deps.analyzer.registry;
  const t0 = now();
  const startedAtWall = Date.now();
  const candidates = snapshot.elements.filter((e) => e.interactive !== null && e.ref.kind === 'control');
  const stats = new Map<number, RecordedElementStats>();
  for (const c of candidates) {
    stats.set(c.ref.id, {
      elementRef: c.ref.id,
      tagName: c.ref.tagName,
      ...(c.ref.role ? { role: c.ref.role } : {}),
      ...(c.ref.label ? { label: c.ref.label } : {}),
      ...(c.positioning.inFixed ? {} : { docTop: Math.round(c.geometry.document.y) }),
      regionId: c.regionId,
      hoverEntries: 0,
      hoverDwellMs: 0,
      pointerMs: 0,
      clicks: 0,
      activations: 0,
      focusEvents: 0,
      exposure: { elementRef: c.ref.id, reached: false, exposureMs: 0, maxVisibleRatio: 0 },
      hasActiveInteraction: false,
    });
  }
  const roots = new RootRegistry(
    win,
    snapshot.scrollRoots.map((r) => ({
      id: r.id,
      kind: r.kind,
      el: r.elementRef !== undefined ? registry.resolve(r.elementRef) : null,
      ...(r.elementRef !== undefined ? { elementRef: r.elementRef } : {}),
    })),
    // Lazily discovered containers get a registry id too, so Recorded can find them again on this page.
    (el) => registry.register(el, { kind: 'scroll-container', labelMode: 'aria-only' }).id,
  );
  const clock = new ActivityClock(t0, win.document.visibilityState === 'visible');
  const ctx: RecorderContext = {
    win,
    now,
    t0,
    clock,
    roots,
    resolver: new CandidateResolver(registry, new Set(stats.keys())),
    buffer: new PointerBuffer(deps.pointerCap ?? POINTER_CAP),
    stats,
    input: (t) => clock.input(t),
  };
  const pointer = new PointerTracker(ctx);
  const hover = new HoverTracker(ctx);
  const clicks = new ClickTracker(ctx);
  const scroll = new ScrollTracker(ctx, raf, caf);
  const exposure = new ExposureTracker(ctx, IO);
  for (const c of candidates) {
    if (!c.render.rendered) continue;
    const el = registry.resolve(c.ref.id);
    if (el) exposure.observe(c.ref.id, el);
  }

  // Page changes while recording (context only; recording continues).
  let pageChanged = false;
  let changedNodes = 0;
  const baseViewport = { width: win.innerWidth, height: win.innerHeight };
  const mutations = MO
    ? new MO((records) => {
        if (pageChanged) return;
        changedNodes += changedElementCount(records);
        if (changedNodes >= PAGE_CHANGE_NODES) pageChanged = true;
      })
    : null;
  mutations?.observe(win.document.documentElement, { childList: true, subtree: true });

  // Listeners.
  const removers: Array<() => void> = [];
  const listen = <K extends keyof WindowEventMap>(target: Window | Document, type: K | 'visibilitychange', fn: (e: WindowEventMap[K]) => void): void => {
    const opts = { capture: true, passive: true };
    target.addEventListener(type, fn as EventListener, opts);
    liveRecorderListeners++;
    removers.push(() => {
      target.removeEventListener(type, fn as EventListener, opts);
      liveRecorderListeners--;
    });
  };
  listen(win, 'pointermove', (e) => pointer.onMove(e));
  listen(win, 'pointerover', (e) => hover.onOver(e));
  listen(win, 'pointerout', (e) => {
    if (e.relatedTarget === null && e.isTrusted) {
      const t = now();
      pointer.leave(t);
      hover.close(t);
    }
  });
  listen(win, 'pointerdown', (e) => e.isTrusted && clock.input(now()));
  listen(win, 'click', (e) => clicks.onClick(e));
  listen(win, 'focusin', (e) => clicks.onFocus(e));
  listen(win, 'blur', (e) => e.target === win && clicks.resetFocus());
  // Key presses only mark activity; the key value is never read.
  listen(win, 'keydown', (e) => e.isTrusted && clock.input(now()));
  listen(win, 'scroll', (e) => scroll.onScroll(e));
  listen(win, 'resize', () => {
    roots.invalidate();
    if (isMaterialResize(baseViewport, { width: win.innerWidth, height: win.innerHeight })) pageChanged = true;
  });
  listen<'focus'>(win.document, 'visibilitychange', () => {
    const t = now();
    const visible = win.document.visibilityState === 'visible';
    if (!visible) {
      pointer.leave(t);
      hover.close(t);
    }
    clock.setVisible(visible, t);
  });
  const indicator = deps.indicator?.() ?? null;

  let capture: SessionCapture | null = null;
  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    for (const r of removers.splice(0)) r();
    mutations?.disconnect();
    exposure.disconnect();
    scroll.dispose();
    indicator?.remove();
  };

  const docFraction = (): number => {
    const d = roots.document;
    return d.scrollHeight > 0 ? Math.min(1, d.deepestPx / d.scrollHeight) : 0;
  };

  function finalize(): SessionCapture {
    const t = now();
    // 1–4: close dwell, hover, exposure, active time — before listeners go away.
    pointer.leave(t);
    hover.close(t);
    exposure.closeAll(t);
    scroll.flush();
    const activeMs = clock.stop(t);
    detach();

    const elements = [...stats.values()].map((s) => ({
      ...s,
      hasActiveInteraction: s.hoverEntries + s.clicks + s.activations + s.focusEvents > 0,
    }));
    const pointerCapture = ctx.buffer.finalize();
    const regions = regionStats(snapshot, elements, pointerCapture, clicks.events);
    for (const r of roots.roots) roots.measure(r);
    const d = roots.document;
    const limitations: LimitationCode[] = [];
    if (activeMs < SHORT_SESSION_MS) limitations.push('SHORT_SESSION');
    if (d.scrollHeight > d.clientHeight * 1.25 && d.deepestPx - d.clientHeight < d.clientHeight * LITTLE_SCROLL_SHARE) limitations.push('LITTLE_SCROLL');
    if (pointerCapture.count + clicks.total < FEW_EVENTS) limitations.push('FEW_EVENTS');
    if (pageChanged) limitations.push('PAGE_CHANGED');
    if (snapshot.coverage.framesNotAnalyzed > 0) limitations.push('FRAMES_UNSUPPORTED');
    if (roots.untracked || snapshot.coverage.scrollRootsCapped) limitations.push('NESTED_SCROLL_UNTRACKED');
    if (pointerCapture.coarse) limitations.push('LONG_SESSION_COARSENED');
    if (snapshot.coverage.elementsCapped) limitations.push('CANDIDATES_CAPPED');

    return {
      meta: {
        startedAt: startedAtWall,
        endedAt: startedAtWall + (t - t0),
        elapsedMs: t - t0,
        activeMs,
        layoutVersion: snapshot.meta.layoutVersion,
        viewportWidth: snapshot.meta.viewportWidth,
        viewportHeight: snapshot.meta.viewportHeight,
        url: snapshot.meta.url,
      },
      pointer: pointerCapture,
      clicks: clicks.events.slice(),
      clicksDropped: clicks.dropped,
      elements,
      regions,
      scroll: {
        roots: roots.roots.map((r) => ({
          rootId: r.id,
          kind: r.kind,
          ...(r.elementRef !== undefined ? { elementRef: r.elementRef } : {}),
          lazy: r.lazy,
          scrollTop: r.scrollTop,
          scrollHeight: r.scrollHeight,
          clientHeight: r.clientHeight,
          deepestPx: r.deepestPx,
          deepestFraction: r.scrollHeight > 0 ? Math.min(1, r.deepestPx / r.scrollHeight) : 0,
        })),
        timeline: scroll.timeline.slice(),
        timelineIntervalMs: scroll.intervalMs,
      },
      limitations,
    };
  }

  return {
    live: () => ({ activeMs: clock.activeAt(now()), clicks: clicks.total, deepestScroll: docFraction() }),
    stop() {
      capture ??= finalize();
      return capture;
    },
    dispose: detach,
    listenerCount: () => removers.length,
  };
}

const OWN_HOSTS = new Set([OVERLAY_TAG.toUpperCase(), REC_TAG.toUpperCase()]);

/** Element nodes added/removed, including their descendants (bounded per node); HeatGrid's own hosts excluded. */
export function changedElementCount(records: ReadonlyArray<Pick<MutationRecord, 'addedNodes' | 'removedNodes'>>): number {
  let n = 0;
  for (const r of records) {
    for (const list of [r.addedNodes, r.removedNodes]) {
      for (let i = 0; i < list.length; i++) {
        const node = list[i]!;
        if (node.nodeType !== 1 || OWN_HOSTS.has(node.nodeName)) continue;
        n += 1 + Math.min(PAGE_CHANGE_NODES, (node as Element).getElementsByTagName('*').length);
      }
    }
  }
  return n;
}

/** Region facts: pointer dwell (anchored → element's region; document samples → containing region), clicks, reach. */
function regionStats(
  snapshot: RegistrySnapshot,
  elements: RecordedElementStats[],
  p: SessionCapture['pointer'],
  clicks: SessionCapture['clicks'],
): RecordedRegionStats[] {
  const out = new Map<number, RecordedRegionStats>(
    snapshot.regions.map((r) => [r.id, { regionId: r.id, label: r.label, controls: r.stats.interactiveCount, pointerWeightMs: 0, clicks: 0, reached: false, interactedElements: 0 }]),
  );
  const regionOfElement = new Map(elements.map((e) => [e.elementRef, e.regionId]));
  // Smallest containing region wins (regions can nest).
  const byArea = [...snapshot.regions].sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
  const docRoot = snapshot.scrollRoots.find((r) => r.kind === 'document')?.id ?? 0;
  const regionAt = (x: number, y: number): number | null =>
    byArea.find((r) => x >= r.rect.x && x < r.rect.x + r.rect.width && y >= r.rect.y && y < r.rect.y + r.rect.height)?.id ?? null;
  const add = (regionId: number | null | undefined, key: 'pointerWeightMs' | 'clicks', v: number): void => {
    const r = regionId !== null && regionId !== undefined ? out.get(regionId) : undefined;
    if (r) r[key] += v;
  };
  for (let i = 0; i < p.count; i++) {
    const w = p.weightMs[i]!;
    if (w <= 0) continue;
    const ref = p.elementRef[i]!;
    if (ref) add(regionOfElement.get(ref), 'pointerWeightMs', w);
    else if (p.rootId[i] === docRoot) add(regionAt(p.x[i]!, p.y[i]!), 'pointerWeightMs', w);
  }
  for (const c of p.coarse?.cells ?? []) {
    if (c.rootId === docRoot) add(regionAt((c.cx + 0.5) * p.coarse!.cellPx, (c.cy + 0.5) * p.coarse!.cellPx), 'pointerWeightMs', c.weightMs);
  }
  for (const c of clicks) {
    if (c.elementRef) add(regionOfElement.get(c.elementRef), 'clicks', 1);
    else if (c.rootId === docRoot && c.x !== undefined && c.y !== undefined) add(regionAt(c.x, c.y), 'clicks', 1);
  }
  for (const e of elements) {
    const r = e.regionId !== null ? out.get(e.regionId) : undefined;
    if (!r) continue;
    if (e.exposure.reached) r.reached = true;
    if (e.hasActiveInteraction) r.interactedElements++;
  }
  for (const r of out.values()) r.pointerWeightMs = Math.round(r.pointerWeightMs);
  return [...out.values()];
}


export function captureDetails(c: SessionCapture): SessionCaptureDetails {
  return {
    summary: summarizeCapture(c),
    pointer: { samples: c.pointer.count, capacity: c.pointer.capacity, totalWeightMs: Math.round(c.pointer.totalWeightMs), coarseCells: c.pointer.coarse?.cells.length ?? 0 },
    clickCounts: {
      pointer: c.clicks.filter((x) => x.kind === 'pointer').length,
      activation: c.clicks.filter((x) => x.kind === 'activation').length,
      maybeNotClickable: c.clicks.filter((x) => x.interactive === 'maybe-not').length,
      dropped: c.clicksDropped,
    },
    elements: c.elements
      .filter((e) => e.hasActiveInteraction || e.pointerMs > 0 || e.exposure.reached)
      .map((e) => ({ ...e, pointerMs: Math.round(e.pointerMs), hoverDwellMs: Math.round(e.hoverDwellMs), exposure: { ...e.exposure, exposureMs: Math.round(e.exposure.exposureMs) } })),
    regions: c.regions.map((r) => ({ ...r })),
    scrollRoots: c.scroll.roots.map((r) => ({ ...r })),
    timelinePoints: c.scroll.timeline.length,
  };
}
