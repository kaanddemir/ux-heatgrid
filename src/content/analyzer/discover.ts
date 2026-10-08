/**
 * Discovery: one bounded traversal of the document (including open shadow roots) that
 * classifies elements into interactive candidates, context elements and scroll-root
 * candidates. No geometry is read here except scroll extents.
 */
import { OVERLAY_TAG, REC_TAG } from '../../shared/constants';
import type { DomReader } from './measure';
import type { ElementKind, InteractiveBasis, LandmarkType } from './types';

export const MAX_NODES = 60_000;
/** Style reads spent on the `cursor: pointer` heuristic. */
export const MAX_CURSOR_CHECKS = 4_000;
/** Elements checked for scrollable extent. */
export const MAX_SCROLL_CHECKS = 20_000;

const SKIP_SUBTREE = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK',
  'SVG', 'svg', 'CANVAS', 'VIDEO', 'AUDIO', 'SELECT', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED',
  OVERLAY_TAG.toUpperCase(), // HeatGrid's own page overlay
  REC_TAG.toUpperCase(), // and REC indicator
]);
const FRAMES = new Set(['IFRAME', 'FRAME']);

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio',
  'switch', 'option', 'combobox', 'slider', 'spinbutton', 'textbox', 'searchbox', 'treeitem',
]);

const LANDMARK_TAGS: Record<string, LandmarkType> = {
  HEADER: 'header', NAV: 'nav', MAIN: 'main', FOOTER: 'footer',
  ASIDE: 'aside', FORM: 'form', ARTICLE: 'article', SECTION: 'section',
};
const LANDMARK_ROLES: Record<string, LandmarkType> = {
  banner: 'header', navigation: 'nav', main: 'main', contentinfo: 'footer',
  complementary: 'aside', form: 'form', search: 'form', article: 'article', region: 'section',
};

const TEXT_TAGS = new Set(['P', 'BLOCKQUOTE', 'FIGCAPTION', 'DD']);
const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'svg', 'PICTURE']);

export interface Found {
  el: Element;
  /** Traversal order — the deterministic tiebreaker everywhere. */
  order: number;
  kind: ElementKind;
  interactive: InteractiveBasis | null;
  landmark: LandmarkType | null;
  headingLevel: number | null;
  role: string | undefined;
}

export interface DiscoveryOutput {
  interactive: Found[];
  context: Found[];
  scrollCandidates: Element[];
  nodesVisited: number;
  openShadowRoots: number;
  frames: number;
  traversalCapped: boolean;
  cursorScanCapped: boolean;
  elementErrors: number;
}

function firstRole(el: Element): string | undefined {
  const raw = el.getAttribute('role');
  if (!raw) return undefined;
  // Malformed/multi-token roles: the first recognized token wins (ARIA fallback semantics).
  for (const token of raw.trim().toLowerCase().split(/\s+/)) {
    if (INTERACTIVE_ROLES.has(token) || token in LANDMARK_ROLES || token === 'heading' || token === 'presentation' || token === 'none') {
      return token;
    }
  }
  return undefined;
}

/** Semantic interactivity. Returns null when only a heuristic could apply. */
export function semanticBasis(el: Element, role: string | undefined): InteractiveBasis | null {
  const tag = el.tagName;
  switch (tag) {
    case 'A':
    case 'AREA':
      if (el.hasAttribute('href')) return 'native';
      break;
    case 'BUTTON':
    case 'SELECT':
    case 'TEXTAREA':
    case 'SUMMARY':
      return 'native';
    case 'INPUT':
      if ((el.getAttribute('type') ?? '').toLowerCase() !== 'hidden') return 'native';
      break;
    case 'VIDEO':
    case 'AUDIO':
      if (el.hasAttribute('controls')) return 'native';
      break;
  }
  if (role && INTERACTIVE_ROLES.has(role)) return 'aria-role';
  const ce = el.getAttribute('contenteditable');
  if (ce !== null && ce.toLowerCase() !== 'false') return 'contenteditable';
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) return 'tabindex';
  if (el.hasAttribute('onclick')) return 'onclick';
  return null;
}

function headingLevel(el: Element, role: string | undefined): number | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  if (m) return Number(m[1]);
  if (role === 'heading') {
    const level = Number.parseInt(el.getAttribute('aria-level') ?? '2', 10);
    return level >= 1 && level <= 6 ? level : 2;
  }
  return null;
}

function landmarkOf(el: Element, role: string | undefined): LandmarkType | null {
  if (role && LANDMARK_ROLES[role]) return LANDMARK_ROLES[role]!;
  return LANDMARK_TAGS[el.tagName] ?? null;
}

export interface DiscoverOptions {
  reader: DomReader;
  root?: Document;
  cursorHeuristic?: boolean;
}

export function discover({ reader, root = document, cursorHeuristic = true }: DiscoverOptions): DiscoveryOutput {
  const out: DiscoveryOutput = {
    interactive: [],
    context: [],
    scrollCandidates: [],
    nodesVisited: 0,
    openShadowRoots: 0,
    frames: 0,
    traversalCapped: false,
    cursorScanCapped: false,
    elementErrors: 0,
  };
  const start = root.body ?? root.documentElement;
  if (!start) return out;

  let cursorChecks = 0;
  let scrollChecks = 0;
  let order = 0;

  // Explicit stack: [element, insideInteractive]. Children pushed in reverse to keep document order.
  const stack: Array<[Element, boolean]> = [];
  const pushChildren = (parent: Element | ShadowRoot, inside: boolean): void => {
    const kids = parent.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, inside]);
  };
  pushChildren(start, false);

  while (stack.length > 0) {
    if (out.nodesVisited >= MAX_NODES) {
      out.traversalCapped = true;
      break;
    }
    const [el, insideInteractive] = stack.pop()!;
    out.nodesVisited++;
    try {
      const tag = el.tagName;
      if (FRAMES.has(tag)) out.frames++;

      const role = firstRole(el);
      let basis = semanticBasis(el, role);
      if (!basis && cursorHeuristic && !insideInteractive) {
        // Heuristic only: cursor: pointer is inherited, so descendants of a candidate are not re-checked.
        if (cursorChecks < MAX_CURSOR_CHECKS) {
          cursorChecks++;
          if (reader.style(el).getPropertyValue('cursor') === 'pointer') basis = 'cursor';
        } else {
          out.cursorScanCapped = true;
        }
      }

      const level = headingLevel(el, role);
      const landmark = landmarkOf(el, role);
      const base = { el, order: order++, role };
      if (basis) {
        out.interactive.push({ ...base, kind: 'control', interactive: basis, landmark: null, headingLevel: null });
      } else if (level !== null) {
        out.context.push({ ...base, kind: 'heading', interactive: null, landmark: null, headingLevel: level });
      } else if (landmark) {
        out.context.push({ ...base, kind: 'landmark', interactive: null, landmark, headingLevel: null });
      } else if (TEXT_TAGS.has(tag)) {
        out.context.push({ ...base, kind: 'text', interactive: null, landmark: null, headingLevel: null });
      } else if (MEDIA_TAGS.has(tag)) {
        out.context.push({ ...base, kind: 'media', interactive: null, landmark: null, headingLevel: null });
      }

      if (scrollChecks < MAX_SCROLL_CHECKS && !SKIP_SUBTREE.has(tag)) {
        scrollChecks++;
        const m = reader.scrollMetrics(el);
        if ((m.clientHeight > 0 && m.scrollHeight > m.clientHeight + 1) || (m.clientWidth > 0 && m.scrollWidth > m.clientWidth + 1)) {
          out.scrollCandidates.push(el);
        }
      }

      if (SKIP_SUBTREE.has(tag)) continue;
      const inside = insideInteractive || basis !== null;
      // Open shadow roots only; closed roots are invisible to extensions by design.
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) {
        out.openShadowRoots++;
        pushChildren(shadow, inside);
      }
      pushChildren(el, inside);
    } catch {
      out.elementErrors++;
    }
  }
  return out;
}
