/**
 * Stale detection for a ready prediction. Event-driven only (no polling), active only while a
 * prediction is ready, and it never recomputes anything — it only reports "stale".
 *
 * Material changes:
 *  - DOM: interactive candidates added/removed, interactive-relevant attribute changes, or a large
 *    structural change (≥ LARGE_CHANGE_NODES element nodes added/removed in one debounce window).
 *    class/style churn is ignored (hover states, animations) to avoid flapping.
 *  - Resize: viewport width or height changes by more than RESIZE_RATIO.
 *  - Same-document navigation: URL (origin + path + query) differs from the predicted page.
 */
import { OVERLAY_TAG, REC_TAG } from '../../shared/constants';
import type { StaleReason } from '../../shared/model';

export const INTERACTIVE_SELECTOR =
  'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[contenteditable=""],[contenteditable="true"],[tabindex],[onclick]';
const RELEVANT_ATTRIBUTES = ['hidden', 'disabled', 'aria-disabled', 'href', 'role', 'tabindex', 'contenteditable', 'aria-hidden'];
export const LARGE_CHANGE_NODES = 25;
export const RESIZE_RATIO = 0.2;
export const DEBOUNCE_MS = 400;

interface MutationLike {
  type: string;
  target: Node;
  attributeName?: string | null;
  addedNodes: ArrayLike<Node>;
  removedNodes: ArrayLike<Node>;
}

const OWN_HOSTS = new Set([OVERLAY_TAG.toUpperCase(), REC_TAG.toUpperCase()]);
/** Element nodes, except HeatGrid's own hosts (overlay, REC indicator): mounting them is never a page change. */
const isElement = (n: Node): n is Element => n.nodeType === 1 && !OWN_HOSTS.has(n.nodeName);
const touchesInteractive = (el: Element): boolean => {
  try {
    return el.matches(INTERACTIVE_SELECTOR) || el.querySelector(INTERACTIVE_SELECTOR) !== null;
  } catch {
    return false;
  }
};

/** Pure classifier. Returns the number of changed element nodes and whether the batch is material. */
export function classifyMutations(records: readonly MutationLike[]): { material: boolean; changedNodes: number } {
  let changed = 0;
  let material = false;
  for (const r of records) {
    if (r.type === 'childList') {
      for (const list of [r.addedNodes, r.removedNodes]) {
        for (let i = 0; i < list.length; i++) {
          const n = list[i]!;
          if (!isElement(n)) continue;
          changed++;
          if (!material && touchesInteractive(n)) material = true;
        }
      }
    } else if (r.type === 'attributes' && isElement(r.target) && RELEVANT_ATTRIBUTES.includes(r.attributeName ?? '')) {
      if (touchesInteractive(r.target)) material = true;
    }
  }
  return { material: material || changed >= LARGE_CHANGE_NODES, changedNodes: changed };
}

export function isMaterialResize(base: { width: number; height: number }, next: { width: number; height: number }): boolean {
  const dw = Math.abs(next.width - base.width) / Math.max(1, base.width);
  const dh = Math.abs(next.height - base.height) / Math.max(1, base.height);
  return dw > RESIZE_RATIO || dh > RESIZE_RATIO;
}

export const pageKey = (loc: Pick<Location, 'origin' | 'pathname' | 'search'>): string => `${loc.origin}${loc.pathname}${loc.search}`;

export interface StaleWatcher {
  arm(): void;
  disarm(): void;
  dispose(): void;
}

export function createStaleWatcher(onStale: (reason: StaleReason) => void, win: Window = window): StaleWatcher {
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: StaleReason | null = null;
  let changedInWindow = 0;
  let base = { width: 0, height: 0, key: '' };
  let armed = false;

  const fire = (): void => {
    timer = null;
    if (!armed || !pending) return;
    const reason = pending;
    pending = null;
    disarm();
    onStale(reason);
  };
  const schedule = (reason: StaleReason): void => {
    if (!armed) return;
    // Navigation and resize outrank DOM churn when several happen in one window.
    if (!pending || reason !== 'dom-change') pending = reason;
    if (timer === null) timer = setTimeout(fire, DEBOUNCE_MS);
  };
  const checkUrl = (): void => {
    if (pageKey(win.location) !== base.key) schedule('same-document-navigation');
  };
  const onMutations = (records: MutationRecord[]): void => {
    checkUrl();
    const c = classifyMutations(records);
    changedInWindow += c.changedNodes;
    if (c.material || changedInWindow >= LARGE_CHANGE_NODES) schedule('dom-change');
    if (timer === null) changedInWindow = 0;
  };
  const onResize = (): void => {
    if (isMaterialResize(base, { width: win.innerWidth, height: win.innerHeight })) schedule('resize');
  };
  const nav = (win as Window & { navigation?: EventTarget }).navigation;

  function arm(): void {
    disarm();
    armed = true;
    base = { width: win.innerWidth, height: win.innerHeight, key: pageKey(win.location) };
    observer = new MutationObserver(onMutations);
    observer.observe(win.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: RELEVANT_ATTRIBUTES });
    win.addEventListener('resize', onResize);
    win.addEventListener('popstate', checkUrl);
    win.addEventListener('hashchange', checkUrl);
    nav?.addEventListener('navigatesuccess', checkUrl);
  }
  function disarm(): void {
    armed = false;
    observer?.disconnect();
    observer = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
    changedInWindow = 0;
    win.removeEventListener('resize', onResize);
    win.removeEventListener('popstate', checkUrl);
    win.removeEventListener('hashchange', checkUrl);
    nav?.removeEventListener('navigatesuccess', checkUrl);
  }
  return { arm, disarm, dispose: disarm };
}
