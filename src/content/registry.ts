/**
 * Shared ElementRef registry. Predict and Record resolve page elements through the same
 * registry so they refer to the same logical elements.
 *
 * - Element → ref via WeakMap (no leaks when nodes are removed).
 * - id → Element via WeakRef (resolves to null once the node is garbage-collected or detached).
 * - Ids are runtime-local: stable for the same live Element for the life of this content
 *   runtime, never persisted, never meaningful across page loads.
 *
 * Privacy: labels are short accessible-name-like strings. Form values (input, textarea,
 * select, contenteditable content, passwords) are never read.
 */
import type { ElementKind, ElementRef } from './analyzer/types';

export const LABEL_MAX = 60;

export function normalizeLabel(text: string | null | undefined, max = LABEL_MAX): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Bounded visible-ish text: text nodes joined with a space when they come from different
 * elements, so "Releases<span>244</span>" or stacked lines don't read as one glued word.
 */
export function boundedText(el: Element, max = 400): string {
  const doc = el.ownerDocument;
  if (!doc?.createTreeWalker) return (el.textContent ?? '').slice(0, max);
  const walker = doc.createTreeWalker(el, 1 | 4 /* SHOW_ELEMENT | SHOW_TEXT */);
  let out = '';
  let lastParent: Node | null = null;
  for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if ((n as Element).tagName === 'BR') lastParent = null, (out += ' ');
      continue;
    }
    const parent = n.parentNode;
    const tag = (parent as Element | null)?.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
    const t = n.nodeValue ?? '';
    if (!t) continue;
    out += lastParent && parent !== lastParent ? ` ${t}` : t;
    lastParent = parent;
  }
  return out.slice(0, max);
}

const VALUE_BEARING = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
const BUTTON_INPUT_TYPES: Record<string, string> = {
  submit: 'Submit',
  reset: 'Reset',
  button: 'Button',
  image: 'Image button',
};

function textOfIds(el: Element, ids: string): string | undefined {
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts: string[] = [];
  for (const id of ids.split(/\s+/).filter(Boolean).slice(0, 4)) {
    const target = root.getElementById?.(id);
    if (target && !VALUE_BEARING.has(target.tagName)) parts.push(target.textContent ?? '');
  }
  return parts.join(' ');
}

function associatedLabel(el: Element): string | undefined {
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    // Label text can contain the control itself (wrapping label); textContent of an input is empty.
    return Array.from(labels, (l) => l.textContent ?? '').join(' ');
  }
  return undefined;
}

/**
 * Approximate accessible name. Order: aria-label → aria-labelledby → <label> → alt → title →
 * (non-form elements) text content → placeholder / generic input type. Never `.value`.
 */
export function readLabel(el: Element): string | undefined {
  const aria = normalizeLabel(el.getAttribute('aria-label'));
  if (aria) return aria;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = normalizeLabel(textOfIds(el, labelledBy));
    if (t) return t;
  }
  const tag = el.tagName;
  if (VALUE_BEARING.has(tag)) {
    const lab = normalizeLabel(associatedLabel(el));
    if (lab) return lab;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'INPUT' && type === 'password') return 'Password field';
    const alt = tag === 'INPUT' && type === 'image' ? normalizeLabel(el.getAttribute('alt')) : undefined;
    if (alt) return alt;
    const title = normalizeLabel(el.getAttribute('title'));
    if (title) return title;
    if (tag === 'INPUT' && BUTTON_INPUT_TYPES[type]) return BUTTON_INPUT_TYPES[type];
    return normalizeLabel(el.getAttribute('placeholder'));
  }
  if (el instanceof HTMLElement && el.isContentEditable) return 'Editable region';
  const alt = normalizeLabel(el.getAttribute('alt'));
  if (alt) return alt;
  // Never take text from subtrees holding form fields (a textarea's textContent is its value).
  // textContent is bounded before normalizing so huge nodes don't cost a full string scan.
  if (!el.querySelector?.('textarea, select, [contenteditable]')) {
    const text = normalizeLabel(boundedText(el, 400));
    if (text) return text;
  }
  const title = normalizeLabel(el.getAttribute('title'));
  if (title) return title;
  // Icon-only controls: fall back to an inner image/svg label.
  const img = el.querySelector?.('img[alt], svg[aria-label], [aria-label]');
  return normalizeLabel(img?.getAttribute('alt') ?? img?.getAttribute('aria-label'));
}

const SAFE_ID = /^[A-Za-z][\w-]{0,40}$/;
const SAFE_CLASS = /^[A-Za-z_-][\w-]{0,30}$/;

/** Debug-only hint: tag#id.class1.class2. Skips generated-looking tokens. Not a unique selector. */
export function selectorHint(el: Element): string {
  let out = el.tagName.toLowerCase();
  const id = el.getAttribute('id');
  if (id && SAFE_ID.test(id) && !/\d{3,}/.test(id)) out += `#${id}`;
  const classes = Array.from(el.classList ?? [])
    .filter((c) => SAFE_CLASS.test(c) && !/\d{3,}/.test(c))
    .slice(0, 2);
  for (const c of classes) out += `.${c}`;
  return out;
}

/**
 * - `auto`: accessible-name approximation (controls, headings)
 * - `aria-only`: aria-label / aria-labelledby only (landmarks — never their full text)
 * - `none`: no label (paragraphs and other page content)
 */
export type LabelMode = 'auto' | 'aria-only' | 'none';

export interface RegisterInit {
  kind: ElementKind;
  role?: string;
  labelMode?: LabelMode;
}

function labelFor(el: Element, mode: LabelMode): string | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'aria-only') {
    const aria = normalizeLabel(el.getAttribute('aria-label'));
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    return by ? normalizeLabel(textOfIds(el, by)) : undefined;
  }
  return readLabel(el);
}

export class ElementRegistry {
  private byElement = new WeakMap<Element, ElementRef>();
  private byId = new Map<number, WeakRef<Element>>();
  private nextId = 1;

  /** Returns the existing ref for `el` (refreshing descriptive fields) or creates a new one. */
  register(el: Element, init: RegisterInit): ElementRef {
    const existing = this.byElement.get(el);
    const ref: ElementRef = {
      id: existing?.id ?? this.nextId++,
      kind: init.kind,
      tagName: el.tagName.toLowerCase(),
      ...(init.role ? { role: init.role } : {}),
      ...optional('label', labelFor(el, init.labelMode ?? 'auto')),
      selectorHint: selectorHint(el),
    };
    this.byElement.set(el, ref);
    if (!existing) this.byId.set(ref.id, new WeakRef(el));
    return ref;
  }

  get(el: Element): ElementRef | undefined {
    return this.byElement.get(el);
  }

  /** Live element for an id, or null if it was collected or detached from the document. */
  resolve(id: number): Element | null {
    const el = this.byId.get(id)?.deref();
    if (!el) {
      this.byId.delete(id);
      return null;
    }
    return el.isConnected ? el : null;
  }

  get size(): number {
    return this.byId.size;
  }

  /** Forget every element. Ids are not reused after a reset. */
  reset(): void {
    this.byElement = new WeakMap();
    this.byId.clear();
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
