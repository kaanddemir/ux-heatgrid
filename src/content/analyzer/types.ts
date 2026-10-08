/**
 * Page Analyzer types. The analyzer MEASURES; later layers interpret.
 * Nothing here carries a judgment (no scores, no "bad", no prediction).
 * All result objects are plain JSON-serializable data.
 */

// ---------------------------------------------------------------------------
// Element identity
// ---------------------------------------------------------------------------

/** What an element is, structurally. Not how important it is. */
export type ElementKind = 'control' | 'heading' | 'text' | 'landmark' | 'media' | 'scroll-container';

/** Why an element is considered interactive. `cursor` is a heuristic, the rest are semantic. */
export type InteractiveBasis = 'native' | 'aria-role' | 'contenteditable' | 'tabindex' | 'onclick' | 'cursor';

export interface ElementRef {
  /** Runtime-local id. Stable for the same live Element within one content runtime; never persisted. */
  id: number;
  kind: ElementKind;
  tagName: string;
  role?: string;
  /** Short accessible-name-like label (≤ 60 chars, whitespace-normalized). Never an input value. */
  label?: string;
  /** Debug / re-finding aid only (tag#id.class). Not a unique selector. */
  selectorHint?: string;
}

// ---------------------------------------------------------------------------
// Measurement facts
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderFacts {
  connected: boolean;
  display: string;
  visibility: string;
  opacity: number;
  disabled: boolean;
  ariaDisabled: boolean;
  rectArea: number;
  /** Box lies entirely outside the document bounds (e.g. off-screen "sr-only" patterns). */
  outsideDocument: boolean;
  /**
   * Clipping by non-scrollable ancestors — overflow hidden/clip, contain: paint (see measure.ts):
   * - `none`: no such ancestor applies (content scrolled out of a nested scroller is NOT clipped
   *   here; like below-the-fold content it is reachable — it shows up in the visible fractions)
   * - `partial` / `full`: part / all of the box lies outside the ancestor clip rect
   * - `uncertain`: an ancestor uses clip-path/mask, which is not modelled — no claim is made
   */
  clip: ClipState;
  /** Fraction (0–1) of the box inside the ancestor clip rect. 1 for `none` / `uncertain`. */
  clipVisibleFraction: number;
  /**
   * connected && display != none && visibility visible && non-zero box && opacity > 0.05
   * && not outsideDocument && clip != full. Does NOT mean "seen by the user".
   */
  rendered: boolean;
}

export type ClipState = 'none' | 'partial' | 'full' | 'uncertain';

export interface GeometryFacts {
  /** Viewport-relative rect at analysis time (the element's own box, unclipped). */
  viewport: Rect;
  /** Document-relative rect (viewport rect + scroll). Meaningless for fixed elements; see positioning. */
  document: Rect;
  area: number;
  center: { x: number; y: number };
  /** Fraction (0–1) of the box inside the current viewport, after ancestor clipping. */
  viewportVisibleFraction: number;
  /** Fraction (0–1) of the box inside the first screen (document y ∈ [0, viewportHeight]), after ancestor clipping. */
  firstScreenFraction: number;
  /** Document top divided by viewport height ("which screen it starts on"). */
  topInViewportHeights: number;
}

export interface PositioningFacts {
  position: string;
  /** The element itself or an ancestor is position: fixed. */
  inFixed: boolean;
  /**
   * The element itself or an ancestor is position: sticky. This is a style fact only:
   * it does not mean the element is currently stuck.
   */
  inSticky: boolean;
}

export interface StyleFacts {
  display: string;
  visibility: string;
  opacity: number;
  position: string;
  overflowX: string;
  overflowY: string;
  color: string;
  backgroundColor: string;
  backgroundImage: string;
  fontSize: number;
  fontWeight: number;
  /** px, or null when `normal`/unparseable. */
  lineHeight: number | null;
  padding: [number, number, number, number];
  borderWidth: [number, number, number, number];
  borderStyle: string;
  borderColor: string;
  cursor: string;
  textDecoration: string;
  pointerEvents: string;
  textShadow: string;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

export type UnknownBackgroundReason =
  | 'background-image'
  | 'filter-or-blend'
  | 'opacity'
  | 'media-element'
  | 'unparseable-color'
  /** A ::before/::after box with a background covers most of an element in the chain. */
  | 'pseudo-element'
  /** Text has a text-shadow, which changes perceived contrast in ways the ratio ignores. */
  | 'text-shadow'
  /** Nothing opaque was found and the default canvas is not white (color-scheme: dark). */
  | 'dark-canvas';

export type BackgroundResolution =
  | { resolved: true; color: RGBA; /** True when no opaque layer was found and the white canvas base was assumed. */ assumedCanvasBase: boolean }
  | { resolved: false; reason: UnknownBackgroundReason };

export type ContrastFacts =
  | {
      resolved: true;
      textColor: RGBA;
      backgroundColor: RGBA;
      ratio: number;
      largeText: boolean;
      /** Raw guideline comparisons (WCAG 2.x thresholds 4.5 / 3.0), not UX judgments. */
      meetsNormalTextAA: boolean;
      meetsLargeTextAA: boolean;
      assumedCanvasBase: boolean;
    }
  | { resolved: false; reasonIfUnknown: UnknownBackgroundReason };

export interface TextFacts {
  fontSize: number;
  lineHeight: number | null;
  /** lineHeight / fontSize, null when line-height is `normal`. */
  lineHeightRatio: number | null;
  renderedWidth: number;
  /** Estimated characters per line, assuming an average glyph width of 0.5em. An estimate, not a count. */
  approxCharsPerLine: number;
  /** Text length, capped at TEXT_LENGTH_CAP. The text itself is not stored. */
  textLength: number;
  headingLevel: number | null;
}

export type LandmarkType = 'header' | 'nav' | 'main' | 'footer' | 'aside' | 'form' | 'article' | 'section';

export interface InteractiveFacts {
  basis: InteractiveBasis;
  /** Every basis except `cursor`. */
  semantic: boolean;
}

export interface ElementFacts {
  ref: ElementRef;
  interactive: InteractiveFacts | null;
  landmark: LandmarkType | null;
  render: RenderFacts;
  geometry: GeometryFacts;
  positioning: PositioningFacts;
  regionId: number | null;
  /** Full mode only. */
  style?: StyleFacts;
  /** Full mode only, text-bearing elements. */
  text?: TextFacts;
  /** Full mode only, text-bearing elements. Effective background behind the element's text. */
  contrast?: ContrastFacts;
  /** Full mode only, controls: effective background behind the element (its parent's resolved background). */
  backdrop?: BackgroundResolution;
}

// ---------------------------------------------------------------------------
// Regions, scroll roots
// ---------------------------------------------------------------------------

export type RegionKind = 'landmark' | 'heading-section' | 'block' | 'band';

export interface RegionStats {
  area: number;
  interactiveCount: number;
  contextCount: number;
  /** Interactive candidates per 100 000 px² of region area. */
  interactivePer100k: number;
}

export interface Region {
  id: number;
  kind: RegionKind;
  landmark?: LandmarkType;
  label: string;
  /** Document coordinates. */
  rect: Rect;
  /** The landmark element, when the region is a landmark. */
  sourceRef?: number;
  headingRef?: number;
  elementRefs: number[];
  stats: RegionStats;
}

export interface ScrollRootFacts {
  id: number;
  kind: 'document' | 'container';
  elementRef?: number;
  /** Debug aid (tag#id.class) for container roots. */
  selectorHint?: string;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  overflowX: string;
  overflowY: string;
  /** Viewport-relative visible area of the container (document root: the viewport). */
  visibleArea: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type AnalyzeMode = 'full' | 'registry';

export interface AnalyzeOptions {
  mode?: AnalyzeMode;
  /** Ignore the cache for the current layoutVersion. */
  force?: boolean;
}

export type LayoutInvalidationReason = 'manual' | 'dom-mutation' | 'resize' | 'navigation';

export interface AnalysisTimings {
  discoveryMs: number;
  measurementMs: number;
  /** Background resolution + contrast. 0 in registry mode. */
  contrastMs: number;
  regionsMs: number;
  spatialMs: number;
  totalMs: number;
}

export interface PageAnalysisMeta {
  analysisId: string;
  layoutVersion: number;
  mode: AnalyzeMode;
  /** origin + pathname only. No query string or fragment. */
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  documentWidth: number;
  documentHeight: number;
  analyzedAt: number;
  timings: AnalysisTimings;
}

export type AnalysisWarning =
  | 'INTERACTIVE_CAPPED'
  | 'CONTEXT_CAPPED'
  | 'REGIONS_CAPPED'
  | 'SCROLL_ROOTS_CAPPED'
  | 'TRAVERSAL_CAPPED'
  | 'CURSOR_SCAN_CAPPED'
  | 'FRAMES_NOT_ANALYZED'
  | 'ELEMENT_ERRORS';

export interface AnalysisCoverage {
  nodesVisited: number;
  interactiveFound: number;
  interactiveIncluded: number;
  contextFound: number;
  contextIncluded: number;
  elementsCapped: boolean;
  regionsFound: number;
  regionsCapped: boolean;
  scrollRootsFound: number;
  scrollRootsCapped: boolean;
  openShadowRoots: number;
  /** Closed shadow roots cannot be detected or inspected. */
  closedShadowRoots: 'not-inspected';
  /** iframes/frames on the page; their contents are not analyzed (cross- or same-origin). */
  framesNotAnalyzed: number;
  /** Elements skipped because reading them threw. */
  elementErrors: number;
}

export interface FirstScreenFacts {
  interactiveCount: number;
  headingCount: number;
}

interface ResultBase {
  meta: PageAnalysisMeta;
  regions: Region[];
  scrollRoots: ScrollRootFacts[];
  coverage: AnalysisCoverage;
  warnings: AnalysisWarning[];
}

/** Full analysis: everything Predict and Page findings will need. */
export interface FullAnalysisResult extends ResultBase {
  mode: 'full';
  elements: ElementFacts[];
  firstScreen: FirstScreenFacts;
}

/** Light analysis: what Record needs at session start. */
export interface RegistrySnapshot extends ResultBase {
  mode: 'registry';
  elements: CandidateFacts[];
}

/** Subset of ElementFacts collected in registry mode. */
export type CandidateFacts = Pick<
  ElementFacts,
  'ref' | 'interactive' | 'landmark' | 'render' | 'geometry' | 'positioning' | 'regionId'
>;

export type PageAnalysisResult = FullAnalysisResult | RegistrySnapshot;

