/**
 * Tiny DOM helpers for extension pages. Text is always set via textContent — never innerHTML.
 */
import type { ErrorCode, HeatGridError } from '../../shared/model';

type Child = Node | string | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      node.addEventListener(type, handler as EventListener);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Replaces all children of `root`. */
export function mount(root: Element, ...children: Child[]): void {
  root.replaceChildren(...children.filter((c): c is Node | string => !!c));
}

const ERROR_COPY: Record<ErrorCode, string> = {
  RESTRICTED_PAGE: 'Not available on this page.',
  NO_PERMISSION: 'Click the toolbar icon, then try again.',
  NOT_INJECTED: 'Reload the page.',
  INVALID_STATE: 'Not available right now.',
  INVALID_MESSAGE: 'Something went wrong. Reload the page.',
  INTERNAL: 'Something went wrong. Reload the page.',
};

export function errorText(error: HeatGridError): string {
  return ERROR_COPY[error.code];
}
