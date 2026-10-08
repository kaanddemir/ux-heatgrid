/**
 * Target resolution for recorder events: which interactive CANDIDATE (from the start snapshot)
 * an event target belongs to, through the shared ElementRegistry (WeakMap; cached per target).
 * Plus the conservative "looks clickable" test for "May not be clickable" classification.
 */
import type { ElementRegistry } from '../registry';

const MAX_DEPTH = 12;

export interface ResolvedControl {
  id: number;
  el: Element;
}

export class CandidateResolver {
  private cache = new WeakMap<Element, ResolvedControl | null>();

  constructor(
    private readonly registry: Pick<ElementRegistry, 'get'>,
    private readonly candidates: ReadonlySet<number>,
  ) {}

  /** Nearest candidate control at or above `target` (crossing open shadow roots), or null. */
  controlFor(target: Element | null): ResolvedControl | null {
    if (!target) return null;
    const hit = this.cache.get(target);
    if (hit !== undefined) return hit;
    let found: ResolvedControl | null = null;
    let a: Element | null = target;
    for (let d = 0; a && d < MAX_DEPTH; d++) {
      const ref = this.registry.get(a);
      if (ref && this.candidates.has(ref.id)) {
        found = { id: ref.id, el: a };
        break;
      }
      a = a.parentElement ?? ((a.parentNode as ShadowRoot | null)?.host ?? null);
    }
    this.cache.set(target, found);
    return found;
  }
}

const CLICKABLE_SELECTOR =
  'a[href],area[href],button,input,select,textarea,label,summary,option,audio[controls],video[controls],[contenteditable=""],[contenteditable="true"],[onclick]';
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch',
  'option', 'combobox', 'slider', 'spinbutton', 'textbox', 'searchbox', 'treeitem', 'gridcell', 'row',
]);

/**
 * True when the target or an ancestor is (or looks) interactive. Conservative: any of semantic
 * control, interactive ARIA role, contenteditable, tabindex ≥ 0, inline onclick or computed
 * cursor:pointer counts. Only a click where none applies is "maybe-not".
 */
export function looksClickable(target: Element, win: Window): boolean {
  let a: Element | null = target;
  for (let d = 0; a && d < MAX_DEPTH; d++) {
    if (a.matches(CLICKABLE_SELECTOR)) return true;
    const role = a.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    const tabindex = a.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    if (win.getComputedStyle(a).cursor === 'pointer') return true;
    a = a.parentElement ?? ((a.parentNode as ShadowRoot | null)?.host ?? null);
  }
  return false;
}

/** Element check that works across realms (no instanceof on a specific window). */
export function asElement(x: EventTarget | null | undefined): Element | null {
  return x && (x as Node).nodeType === 1 ? (x as Element) : null;
}
