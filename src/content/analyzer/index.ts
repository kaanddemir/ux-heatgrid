/**
 * PageAnalyzer — the shared page-understanding layer for Predict and Record.
 *
 * Measure first, interpret later: this module reads DOM/layout/style facts and returns
 * plain data. It makes no product judgments (no scores, no prediction, no findings prose).
 *
 * Pipeline (synchronous, read-only — never writes styles, inserts nodes or scrolls):
 *   discover → measure (core style + rect) → select within caps → register refs
 *   → [full only] style/text/contrast facts → scroll roots → regions → spatial index
 *
 * Privacy: runs locally, makes no network requests, never reads form values, stores only
 * short labels and text *lengths*, and keeps results in memory only (never persisted).
 */
import { ElementRegistry, type LabelMode } from '../registry';
import { AnalysisCache } from './cache';
import { contrastFromParts, createBackgroundResolver } from './contrast';
import { discover, type Found } from './discover';
import {
  ancestorModel,
  browserReader,
  deriveGeometry,
  deriveRenderFacts,
  isDisabled,
  parentElementOrHost,
  readCoreStyle,
  readStyleFacts,
  type ClipFacts,
  type CoreStyle,
  type DomReader,
} from './measure';
import { assignMember, buildRegions, MAX_REGIONS } from './regions';
import { containerRoot, documentRoot, selectScrollRoots, type ScrollCandidate } from './scrollRoots';
import { SpatialIndex } from './spatial';
import type {
  AnalysisCoverage,
  AnalysisWarning,
  AnalyzeOptions,
  ElementFacts,
  FullAnalysisResult,
  LayoutInvalidationReason,
  PageAnalysisMeta,
  PageAnalysisResult,
  Rect,
  RegistrySnapshot,
  RenderFacts,
  TextFacts,
} from './types';

export const MAX_INTERACTIVE = 400;
export const MAX_CONTEXT = 200;
/** Upper bound on elements measured before cap selection (per category). */
export const MAX_MEASURED = 4_000;
/** Images/media smaller than this are not "major" layout context. */
export const MIN_MEDIA_AREA = 40_000;
export const TEXT_LENGTH_CAP = 10_000;
const SPATIAL_CELL = 128;

export interface PageAnalyzer {
  analyze(options: AnalyzeOptions & { mode: 'registry' }): RegistrySnapshot;
  analyze(options?: AnalyzeOptions & { mode?: 'full' }): FullAnalysisResult;
  analyze(options?: AnalyzeOptions): PageAnalysisResult;
  /** Registry-mode snapshot for the current layout version (cached). */
  getRegistrySnapshot(): RegistrySnapshot;
  /** Spatial index over the last analysis of the current layout version, if any. */
  getSpatialIndex(): SpatialIndex | null;
  /** Most recent result for the current layout version, if any (full preferred). */
  peek(): PageAnalysisResult | null;
  invalidate(reason: LayoutInvalidationReason): void;
  readonly layoutVersion: number;
  readonly registry: ElementRegistry;
  dispose(): void;
}

export interface PageAnalyzerDeps {
  reader?: DomReader;
  registry?: ElementRegistry;
  root?: Document;
  /** Wall clock for `analyzedAt`. */
  clock?: () => number;
}

interface Measured {
  found: Found;
  core: CoreStyle;
  rect: Rect;
  clip: ClipFacts;
  render: RenderFacts;
  docTop: number;
}

const FORM_FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function pageUrl(root: Document): string {
  try {
    const loc = root.location;
    if (!loc) return '';
    const origin = loc.origin && loc.origin !== 'null' ? loc.origin : `${loc.protocol}//`;
    return origin + loc.pathname; // never the query string or fragment
  } catch {
    return '';
  }
}

function labelModeFor(f: Found): LabelMode {
  if (f.kind === 'control' || f.kind === 'heading') return 'auto';
  if (f.kind === 'landmark' || f.kind === 'media') return 'aria-only';
  return 'none';
}

/** Top-level layout blocks for the region fallback: descend single-child wrappers (≤ 5 levels). */
function layoutBlocks(root: Document): Element[] {
  let parent: Element | null = root.body;
  for (let depth = 0; parent && depth < 5; depth++) {
    const kids: Element[] = Array.from(parent.children).filter((k) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(k.tagName));
    if (kids.length >= 2) return kids.slice(0, 30);
    parent = kids[0] ?? null;
  }
  return [];
}

export function createPageAnalyzer(deps: PageAnalyzerDeps = {}): PageAnalyzer {
  const reader = deps.reader ?? browserReader();
  const registry = deps.registry ?? new ElementRegistry();
  const root = deps.root ?? document;
  const clock = deps.clock ?? (() => Date.now());
  const cache = new AnalysisCache();

  let layoutVersion = 1;
  let analysisCounter = 0;
  let spatial: { version: number; index: SpatialIndex } | null = null;
  let disposed = false;

  function run(mode: 'full' | 'registry'): PageAnalysisResult {
    const t0 = reader.now();
    const vp = reader.viewport();
    const docSize = reader.documentSize();
    const docW = Math.max(docSize.width, vp.width);
    const docH = Math.max(docSize.height, vp.height);

    // 1. Discovery
    const d = discover({ reader, root });
    const t1 = reader.now();
    let elementErrors = d.elementErrors;

    // 2. Measure core facts for discovered elements (bounded), then select within caps.
    const ancestors = ancestorModel(reader);
    const measure = (list: Found[]): Measured[] => {
      const out: Measured[] = [];
      for (const found of list.slice(0, MAX_MEASURED)) {
        try {
          const el = found.el;
          const core = readCoreStyle(reader.style(el));
          const rect = reader.rect(el);
          const clip = ancestors.clip(el, core.position, rect);
          const render = deriveRenderFacts({
            connected: el.isConnected,
            style: core,
            rect,
            documentWidth: docW,
            documentHeight: docH,
            scrollX: vp.scrollX,
            scrollY: vp.scrollY,
            disabled: found.kind === 'control' && isDisabled(el),
            ariaDisabled: el.getAttribute('aria-disabled') === 'true',
            clip,
          });
          out.push({ found, core, rect, clip, render, docTop: rect.y + vp.scrollY });
        } catch {
          elementErrors++;
        }
      }
      return out;
    };

    const screen = (m: Measured): number => (vp.height > 0 ? Math.floor(Math.max(0, m.docTop) / vp.height) : 0);
    // Inclusion priority only (not a prediction): rendered, semantic before the cursor heuristic
    // (so heuristic tiles can never crowd real controls out of the cap), earlier screen, larger,
    // document order.
    const interactive = measure(d.interactive)
      .sort(
        (a, b) =>
          Number(b.render.rendered) - Number(a.render.rendered) ||
          Number(a.found.interactive === 'cursor') - Number(b.found.interactive === 'cursor') ||
          screen(a) - screen(b) ||
          b.render.rectArea - a.render.rectArea ||
          a.found.order - b.found.order,
      )
      .slice(0, MAX_INTERACTIVE);

    const contextRank = { landmark: 0, heading: 1, text: 2, media: 2, control: 3, 'scroll-container': 3 } as const;
    const contextEligible = measure(d.context).filter(
      (m) => m.render.rendered && (m.found.kind !== 'media' || m.render.rectArea >= MIN_MEDIA_AREA),
    );
    const context = [...contextEligible]
      // Landmarks, then headings by level (h1/h2 before card-level h4s, so section boundaries
      // survive the cap), then text/media; document order breaks ties.
      .sort(
        (a, b) =>
          contextRank[a.found.kind] - contextRank[b.found.kind] ||
          (a.found.headingLevel ?? 7) - (b.found.headingLevel ?? 7) ||
          a.found.order - b.found.order,
      )
      .slice(0, MAX_CONTEXT);

    // 3. Register + geometry/positioning
    const facts: ElementFacts[] = [];
    const elementById = new Map<number, Element>();
    for (const m of [...interactive, ...context].sort((a, b) => a.found.order - b.found.order)) {
      try {
        const f = m.found;
        const positioning = ancestors.positioning(f.el, m.core.position);
        const ref = registry.register(f.el, {
          kind: f.kind,
          ...(f.role ? { role: f.role } : {}),
          labelMode: labelModeFor(f),
        });
        elementById.set(ref.id, f.el);
        facts.push({
          ref,
          interactive: f.interactive ? { basis: f.interactive, semantic: f.interactive !== 'cursor' } : null,
          landmark: f.landmark,
          render: m.render,
          geometry: deriveGeometry(m.rect, vp, positioning.inFixed, m.clip.rect),
          positioning,
          regionId: null,
        });
      } catch {
        elementErrors++;
      }
    }
    const t2 = reader.now();

    // 4. Full mode: style, text and contrast facts.
    if (mode === 'full') {
      const resolver = createBackgroundResolver(reader);
      for (const fact of facts) {
        const el = elementById.get(fact.ref.id)!;
        try {
          const style = readStyleFacts(reader.style(el));
          fact.style = style;
          const kind = fact.ref.kind;
          const textBearing = kind === 'control' || kind === 'heading' || kind === 'text';
          if (!textBearing) continue;
          const formField = FORM_FIELDS.has(el.tagName);
          const textLength = formField ? 0 : Math.min((el.textContent ?? '').length, TEXT_LENGTH_CAP);
          const text: TextFacts = {
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            lineHeightRatio: style.lineHeight !== null ? Math.round((style.lineHeight / style.fontSize) * 100) / 100 : null,
            renderedWidth: fact.geometry.viewport.width,
            approxCharsPerLine: Math.round(fact.geometry.viewport.width / (style.fontSize * 0.5)),
            textLength,
            headingLevel: elementLevel(el),
          };
          fact.text = text;
          if (textLength > 0 || formField || fact.ref.label) {
            fact.contrast =
              style.textShadow !== 'none'
                ? { resolved: false, reasonIfUnknown: 'text-shadow' }
                : contrastFromParts(style.color, style.fontSize, style.fontWeight, resolver.resolve(el));
          }
          if (kind === 'control') fact.backdrop = resolver.behind(el);
        } catch {
          elementErrors++;
        }
      }
    }
    const t3 = reader.now();

    // 5. Scroll roots (both modes).
    const scrollCandidates: Array<ScrollCandidate & { el: Element }> = [];
    d.scrollCandidates.forEach((el, order) => {
      try {
        const s = reader.style(el);
        scrollCandidates.push({
          el,
          order,
          overflowX: s.getPropertyValue('overflow-x') || 'visible',
          overflowY: s.getPropertyValue('overflow-y') || 'visible',
          metrics: reader.scrollMetrics(el),
          rect: reader.rect(el),
        });
      } catch {
        elementErrors++;
      }
    });
    const pick = selectScrollRoots(scrollCandidates, vp);
    const scrollRoots = [documentRoot(reader, vp)];
    pick.chosen.forEach((index, i) => {
      const c = scrollCandidates[index]!;
      const ref = registry.register(c.el, { kind: 'scroll-container', labelMode: 'aria-only' });
      scrollRoots.push(containerRoot(i + 1, ref, c, vp));
    });

    // 6. Regions
    const rendered = facts.filter((f) => f.render.rendered);
    const blocks: Array<{ id: number; rect: Rect }> = [];
    const blockEls = new Map<number, Element>();
    layoutBlocks(root).forEach((el, i) => {
      try {
        const r = reader.rect(el);
        blocks.push({ id: -(i + 1), rect: { ...r, x: r.x + vp.scrollX, y: r.y + vp.scrollY } });
        blockEls.set(-(i + 1), el);
      } catch {
        elementErrors++;
      }
    });
    const regionOut = buildRegions({
      viewport: vp,
      document: { width: docW, height: docH },
      landmarks: rendered
        .filter((f) => f.landmark)
        .map((f) => ({
          id: f.ref.id,
          landmark: f.landmark!,
          rect: f.geometry.document,
          ...(f.ref.label ? { label: f.ref.label } : {}),
          ariaLabelled: f.ref.label !== undefined,
        })),
      headings: rendered
        .filter((f) => f.ref.kind === 'heading')
        .map((f) => ({
          id: f.ref.id,
          level: elementLevel(elementById.get(f.ref.id)!) ?? 2,
          rect: f.geometry.document,
          ...(f.ref.label ? { label: f.ref.label } : {}),
        })),
      blocks,
      // Only rendered elements are members: hidden menus must not inflate region counts.
      members: rendered.filter((f) => !f.landmark).map((f) => ({ id: f.ref.id, center: f.geometry.center, interactive: f.interactive !== null })),
      maxRegions: MAX_REGIONS,
    });
    // Members no region contains geometrically (e.g. scrolled content of a nested scroller):
    // assign through DOM ancestry to the nearest region source element.
    const regionBySource = new Map<Element, number>();
    for (const region of regionOut.regions) {
      if (region.sourceRef === undefined) continue;
      const el = region.sourceRef < 0 ? blockEls.get(region.sourceRef) : elementById.get(region.sourceRef);
      if (el) regionBySource.set(el, region.id);
    }
    for (const f of rendered) {
      if (f.landmark || regionOut.membership.get(f.ref.id) != null) continue;
      for (let a = parentElementOrHost(elementById.get(f.ref.id)!); a; a = parentElementOrHost(a)) {
        const regionId = regionBySource.get(a);
        if (regionId !== undefined) {
          assignMember(regionOut, regionId, f.ref.id, f.interactive !== null);
          break;
        }
      }
    }
    for (const f of facts) f.regionId = regionOut.membership.get(f.ref.id) ?? null;
    const t4 = reader.now();

    // 7. Spatial index over rendered elements (document coordinates).
    const index = SpatialIndex.build(
      rendered.map((f) => ({ id: f.ref.id, rect: f.geometry.document })),
      SPATIAL_CELL,
    );
    spatial = { version: layoutVersion, index };
    const t5 = reader.now();

    // 8. Coverage, warnings, meta
    const coverage: AnalysisCoverage = {
      nodesVisited: d.nodesVisited,
      interactiveFound: d.interactive.length,
      interactiveIncluded: interactive.length,
      contextFound: d.context.length,
      contextIncluded: context.length,
      elementsCapped: d.interactive.length > MAX_INTERACTIVE || contextEligible.length > MAX_CONTEXT,
      regionsFound: regionOut.found,
      regionsCapped: regionOut.capped,
      scrollRootsFound: pick.found,
      scrollRootsCapped: pick.capped,
      openShadowRoots: d.openShadowRoots,
      closedShadowRoots: 'not-inspected',
      framesNotAnalyzed: d.frames,
      elementErrors,
    };
    const warnings: AnalysisWarning[] = [];
    if (d.interactive.length > MAX_INTERACTIVE) warnings.push('INTERACTIVE_CAPPED');
    if (contextEligible.length > MAX_CONTEXT) warnings.push('CONTEXT_CAPPED');
    if (regionOut.capped) warnings.push('REGIONS_CAPPED');
    if (pick.capped) warnings.push('SCROLL_ROOTS_CAPPED');
    if (d.traversalCapped) warnings.push('TRAVERSAL_CAPPED');
    if (d.cursorScanCapped) warnings.push('CURSOR_SCAN_CAPPED');
    if (d.frames > 0) warnings.push('FRAMES_NOT_ANALYZED');
    if (elementErrors > 0) warnings.push('ELEMENT_ERRORS');

    const ms = (a: number, b: number): number => Math.round((b - a) * 100) / 100;
    analysisCounter += 1;
    const meta: PageAnalysisMeta = {
      analysisId: `a${layoutVersion}.${analysisCounter}`,
      layoutVersion,
      mode,
      url: pageUrl(root),
      title: (root.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      viewportWidth: vp.width,
      viewportHeight: vp.height,
      scrollX: vp.scrollX,
      scrollY: vp.scrollY,
      devicePixelRatio: vp.dpr,
      documentWidth: docW,
      documentHeight: docH,
      analyzedAt: clock(),
      timings: {
        discoveryMs: ms(t0, t1),
        measurementMs: ms(t1, t2),
        contrastMs: mode === 'full' ? ms(t2, t3) : 0,
        regionsMs: ms(t3, t4),
        spatialMs: ms(t4, t5),
        totalMs: ms(t0, reader.now()),
      },
    };
    const base = { meta, regions: regionOut.regions, scrollRoots, coverage, warnings };

    if (mode === 'full') {
      return {
        mode: 'full',
        ...base,
        elements: facts,
        firstScreen: {
          interactiveCount: rendered.filter((f) => f.interactive && f.geometry.firstScreenFraction > 0).length,
          headingCount: rendered.filter((f) => f.ref.kind === 'heading' && f.geometry.firstScreenFraction > 0).length,
        },
      };
    }
    return {
      mode: 'registry',
      ...base,
      elements: facts.map(({ ref, interactive: i, landmark, render, geometry, positioning, regionId }) => ({
        ref,
        interactive: i,
        landmark,
        render,
        geometry,
        positioning,
        regionId,
      })),
    };
  }

  function analyze(options: AnalyzeOptions = {}): PageAnalysisResult {
    if (disposed) throw new Error('PageAnalyzer is disposed');
    const mode = options.mode ?? 'full';
    if (!options.force) {
      const cached = mode === 'full' ? cache.get(layoutVersion, 'full') : cache.get(layoutVersion, 'registry');
      if (cached) return cached;
    }
    const result = run(mode);
    cache.set(result);
    return result;
  }

  return {
    analyze: analyze as PageAnalyzer['analyze'],
    getRegistrySnapshot: () => analyze({ mode: 'registry' }) as RegistrySnapshot,
    getSpatialIndex: () => (spatial && spatial.version === layoutVersion ? spatial.index : null),
    peek: () => cache.get(layoutVersion, 'full') ?? cache.get(layoutVersion, 'registry'),
    invalidate(_reason) {
      layoutVersion += 1;
      cache.clear();
      spatial = null;
    },
    get layoutVersion() {
      return layoutVersion;
    },
    registry,
    dispose() {
      disposed = true;
      cache.clear();
      spatial = null;
      registry.reset();
    },
  };
}

function elementLevel(el: Element): number | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  if (m) return Number(m[1]);
  if (el.getAttribute('role') === 'heading') {
    const level = Number.parseInt(el.getAttribute('aria-level') ?? '2', 10);
    return level >= 1 && level <= 6 ? level : 2;
  }
  return null;
}

export type { DomReader } from './measure';
export * from './types';
