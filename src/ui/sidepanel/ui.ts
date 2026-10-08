/**
 * Shared side-panel building blocks — the one visual language every screen is composed from:
 * screen · screen head · section · metric strip · inspector rows · notice · empty state · footer.
 */
import { el } from '../shared/render';
import { icon, type IconName } from '../shared/icons';

/** Evidence identity of a screen: drives the accent (`--kind`) of everything inside it. */
export type Kind = 'predicted' | 'recorded' | 'overview';

export interface ButtonOpts {
  primary?: boolean;
  subtle?: boolean;
  /** Reset / clear: quiet until hovered, then the danger tone. Always in a screen footer. */
  danger?: boolean;
  key?: string;
  label?: string;
  icon?: IconName;
}

export function button(text: string, onClick: () => void, enabled: boolean, opts: ButtonOpts = {}): HTMLButtonElement {
  const cls = ['btn', opts.primary ? 'primary' : opts.subtle || opts.danger ? 'subtle' : '', opts.danger ? 'danger' : ''].filter(Boolean).join(' ');
  const b = el('button', { class: cls, on: { click: onClick } }, opts.icon ? icon(opts.icon) : null, text);
  b.type = 'button';
  b.disabled = !enabled;
  if (opts.key) b.dataset.key = opts.key;
  if (opts.label) b.setAttribute('aria-label', opts.label);
  return b;
}

/** A screen: one column with the shared rhythm. `kind` sets the accent colour. */
export function screen(kind: Kind, ...children: Array<Node | null | false>): HTMLElement {
  return el('div', { class: 'screen', attrs: { 'data-kind': kind } }, ...children);
}

/** Screen title (no subtitle): title · optional count · trailing action. */
export function screenHead(title: string, opts: { count?: number | null; trailing?: HTMLElement | null } = {}): HTMLElement {
  return el(
    'div',
    { class: 'screen-head' },
    el('h1', { class: 'title', text: title }),
    opts.count !== undefined && opts.count !== null ? el('span', { class: 'count', text: String(opts.count) }) : null,
    opts.trailing ? el('div', { class: 'head-actions' }, opts.trailing) : null,
  );
}

/** Section: small heading (+ count, + trailing control) above its content. No wrapper card. */
/** Collapsible section state, owned by the app so it survives re-renders. */
export interface Collapse {
  id: string;
  collapsed: boolean;
  onToggle: () => void;
}

export function section(title: string, opts: { count?: number | null; trailing?: HTMLElement | null; band?: string; label?: string; collapse?: Collapse }, ...children: Array<Node | null | false>): HTMLElement {
  const label = opts.label ?? (opts.count !== undefined && opts.count !== null ? `${title} (${opts.count})` : title);
  const c = opts.collapse;
  if (!c) return el('section', { class: 'section', attrs: { 'aria-label': label } }, sectionHead(title, opts.count, opts.trailing, opts.band), ...children);
  // Collapsible: the whole heading is the toggle; the body is removed (not just hidden) when closed.
  const bodyId = `sec-body-${c.id}`;
  const toggle = el(
    'button',
    { class: 'section-head section-toggle', attrs: { type: 'button', 'aria-expanded': String(!c.collapsed), 'aria-controls': bodyId }, on: { click: c.onToggle } },
    icon('chevron', 'icon sec-chev'),
    el('h2', { class: 'section-title', text: title }),
    opts.count !== undefined && opts.count !== null ? el('span', { class: 'count', text: String(opts.count) }) : null,
  );
  toggle.dataset.key = `sec-${c.id}`;
  return el(
    'section',
    { class: c.collapsed ? 'section is-collapsed' : 'section', attrs: { 'aria-label': label } },
    opts.trailing ? el('div', { class: 'section-head-row' }, toggle, el('span', { class: 'section-trailing' }, opts.trailing)) : toggle,
    c.collapsed ? null : el('div', { class: 'section-body', attrs: { id: bodyId } }, ...children),
  );
}

export function sectionHead(title: string, count?: number | null, trailing?: HTMLElement | null, band?: string): HTMLElement {
  return el(
    'div',
    { class: 'section-head', attrs: band ? { 'data-band': band } : {} },
    el('h2', { class: 'section-title', text: title }),
    count !== undefined && count !== null ? el('span', { class: 'count', text: String(count) }) : null,
    trailing ? el('span', { class: 'section-trailing' }, trailing) : null,
  );
}

/** Bottom of a screen: quiet meta on the left, reset / clear on the right. */
export function footer(...children: Array<Node | null | false>): HTMLElement {
  return el('div', { class: 'screen-foot' }, ...children);
}

/** Toggle chip (a real checkbox, styled as a pill). */
export function check(label: string, checked: boolean, enabled: boolean, onChange: (v: boolean) => void, key: string, ic?: IconName): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox' }, on: { change: (e) => onChange((e.target as HTMLInputElement).checked) } });
  input.checked = checked;
  input.disabled = !enabled;
  input.dataset.key = key;
  return el('label', { class: 'chip' }, input, ic ? icon(ic) : null, el('span', { text: label }));
}

export interface FilterOption<T extends string> {
  id: T;
  text: string;
  count?: number;
  /** Replaces the visible text while `text` remains the accessible name. */
  glyph?: Node;
  title?: string;
}

/**
 * One filter group: "All" first, then single-select chips with subtle counts. Options with a count
 * of 0 are dropped (except the current one); a group with nothing to choose between renders nothing.
 */
export function filterGroup<T extends string>(label: string, options: Array<FilterOption<T>>, current: T, onPick: (id: T) => void, enabled: boolean, keyPrefix: string, opts: { keep?: boolean } = {}): HTMLElement | null {
  const shown = options.filter((o) => o.count === undefined || o.count > 0 || o.id === current);
  // The first option is "All": with fewer than two real choices the filter would equal All.
  if (!opts.keep && shown.length - 1 < 2 && current === shown[0]?.id) return null;
  return el(
    'div',
    { class: 'segmented', attrs: { role: 'group', 'aria-label': label, 'data-label': label } },
    ...shown.map((o) => {
      const b = el(
        'button',
        { class: 'seg', attrs: { ...(o.title ? { title: o.title } : {}), ...(o.glyph ? { 'aria-label': o.count !== undefined ? `${o.text} (${o.count})` : o.text } : {}) }, on: { click: () => onPick(o.id) } },
        o.glyph ?? o.text,
        o.count !== undefined ? el('span', { class: 'seg-n', text: String(o.count) }) : null,
      );
      b.type = 'button';
      b.disabled = !enabled;
      b.dataset.key = `${keyPrefix}-${o.id}`;
      b.setAttribute('aria-pressed', String(current === o.id));
      return b;
    }),
  );
}

let filterPopoverCleanup: (() => void) | null = null;

/** One compact filter entry point shared by Predict and Record. Selections apply
 * immediately (preserving the existing filtering behaviour); Reset and Done stay consistent. */
export function filterPopover(
  label: string,
  active: number,
  open: boolean,
  onOpen: ((open: boolean) => void) | undefined,
  onReset: (() => void) | undefined,
  ...groups: Array<HTMLElement | null>
): HTMLElement | null {
  const shown = groups.filter((x): x is HTMLElement => !!x);
  if (!shown.length) return null;
  filterPopoverCleanup?.();
  filterPopoverCleanup = null;
  const root = el('div', { class: open ? 'filter-control is-open' : 'filter-control' });
  const trigger = el(
    'button',
    {
      class: 'filter-trigger',
      attrs: { type: 'button', 'aria-expanded': String(open), 'aria-haspopup': 'dialog' },
      on: { click: (e) => (e.stopPropagation(), onOpen?.(!open)) },
    },
    icon('filter'),
    el('span', { text: 'Filter' }),
    active ? el('span', { class: 'filter-count', text: String(active), attrs: { 'aria-label': `${active} active` } }) : null,
  );
  trigger.dataset.key = 'filter-toggle';
  root.append(trigger);
  if (!open) return root;
  const panel = el(
    'div',
    { class: 'filter-popover', attrs: { role: 'dialog', 'aria-label': label }, on: { click: (e) => e.stopPropagation() } },
    ...shown,
    el(
      'div',
      { class: 'filter-actions' },
      button('Reset', () => onReset?.(), active > 0, { key: 'filter-reset', subtle: true }),
      button('Done', () => onOpen?.(false), true, { key: 'filter-done', primary: true }),
    ),
  );
  root.append(panel);
  queueMicrotask(() => {
    const outside = (e: PointerEvent) => { if (!root.contains(e.target as Node)) onOpen?.(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpen?.(false); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    filterPopoverCleanup = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  });
  return root;
}

/** Inline status line: icon · short text · optional action. Tone: warn (default), info, error. */
export function notice(text: string, opts: { tone?: 'warn' | 'info' | 'error'; action?: HTMLElement | null; role?: 'status' | 'alert' | null } = {}): HTMLElement {
  const tone = opts.tone ?? 'warn';
  const role = opts.role === undefined ? 'status' : opts.role;
  return el(
    'div',
    { class: `notice ${tone}`, attrs: role ? { role } : {} },
    icon(tone === 'info' ? 'info' : 'warn'),
    el('span', { class: 'notice-text', text }),
    opts.action ?? null,
  );
}

/** Stable first content slot for one or more immediate/actionable messages. */
export function noticeZone(...items: Array<HTMLElement | null | false>): HTMLElement | null {
  const shown = items.filter((n): n is HTMLElement => !!n);
  return shown.length ? el('div', { class: 'notice-zone', attrs: { 'aria-label': 'Status' } }, ...shown) : null;
}

const TONE: Partial<Record<IconName, string>> = { predict: 'pred', record: 'heat', warn: 'warn', page: 'neutral', check: 'ok' };

/** Empty state, shared by every screen: icon · short title · one short line · one action. */
export function emptyState(title: string, body: string, action: HTMLElement | null, ic: IconName = 'info'): HTMLElement {
  return el(
    'div',
    { class: 'empty', attrs: { 'data-tone': TONE[ic] ?? 'neutral' } },
    el('span', { class: 'empty-icon', attrs: { 'aria-hidden': 'true' } }, icon(ic)),
    el('p', { class: 'empty-title', text: title }),
    body ? el('p', { class: 'empty-body', text: body }) : null,
    action ? el('div', { class: 'empty-action' }, action) : null,
  );
}

/** Same composition while something is being prepared (no action; announced as a status). */
export function loadingState(text: string, ic: IconName = 'info'): HTMLElement {
  return el(
    'div',
    { class: 'empty is-loading', attrs: { role: 'status', 'data-tone': TONE[ic] ?? 'neutral' } },
    el('span', { class: 'empty-icon', attrs: { 'aria-hidden': 'true' } }, el('span', { class: 'spinner' })),
    el('p', { class: 'empty-body', text }),
  );
}

export interface Metric {
  label: string;
  value: string;
  /** 0..1 — draws a thin accent bar under the value (e.g. scroll depth). */
  fill?: number | null;
  /** De-emphasise (zero / not measured). */
  quiet?: boolean;
}

/**
 * Metric strip: large values over small labels, separated by hairlines. `inline` renders spans
 * instead of a definition list, for use inside a button (Overview summaries).
 */
export function metrics(label: string, rows: Array<Metric | null>, size: 'md' | 'sm' = 'md', inline = false, extraClass = ''): HTMLElement {
  const [list, item, term, value] = inline ? (['span', 'span', 'span', 'span'] as const) : (['dl', 'div', 'dt', 'dd'] as const);
  return el(
    list,
    { class: `metrics ${size}${extraClass ? ` ${extraClass}` : ''}`, attrs: inline ? {} : { 'aria-label': label } },
    ...rows
      .filter((r): r is Metric => !!r)
      .map((m) =>
        el(
          item,
          { class: m.quiet ? 'metric is-quiet' : 'metric' },
          el(term, { class: 'metric-label', text: m.label }),
          el(value, { class: 'metric-value', text: m.value }),
          m.fill !== undefined && m.fill !== null ? el('span', { class: 'metric-bar', attrs: { 'aria-hidden': 'true' } }, el('span', { attrs: { style: `width:${Math.max(3, Math.round(m.fill * 100))}%` } })) : null,
        ),
      ),
  );
}

/** Facts as a compact two-column list. */
export function facts(label: string, rows: Array<[string, string] | null>): HTMLElement {
  return el('dl', { class: 'facts', attrs: { 'aria-label': label } }, ...rows.filter((r): r is [string, string] => !!r).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

/** Secondary explanation, hidden until asked for. */
export function info(summary: string, ...body: Array<Node | string | null>): HTMLElement {
  return el('details', { class: 'info' }, el('summary', {}, icon('info'), summary), el('div', { class: 'info-body' }, ...body));
}

/** Small label + content block inside an expanded row. */
export function detailPart(label: string, ...children: Array<Node | null | false>): HTMLElement {
  return el('div', { class: 'detail-part' }, el('p', { class: 'detail-label', text: label }), ...children);
}

/** Full-width navigation row: icon · title · value · chevron. */
export function navRow(ic: IconName, title: string, value: string, onClick: () => void, key: string, opts: { kind?: string; empty?: boolean } = {}): HTMLButtonElement {
  const b = el(
    'button',
    { class: opts.empty ? 'nav-row is-empty' : 'nav-row', on: { click: onClick } },
    el('span', { class: 'nav-icon', attrs: opts.kind ? { 'data-kind': opts.kind } : {} }, icon(ic)),
    el('span', { class: 'nav-title', text: title }),
    el('span', { class: 'nav-value', text: value }),
    icon('chevron', 'icon chev'),
  );
  b.type = 'button';
  b.dataset.key = key;
  return b;
}

/** Roving keyboard support for a role="tablist" (arrow keys / Home / End). */
export function tablist(label: string, tabs: Array<{ id: string; text: string; selected: boolean; onSelect: () => void; controls?: string; icon?: IconName }>, key: string, cls = 'tabs'): HTMLElement {
  const list = el('div', { class: cls, attrs: { role: 'tablist', 'aria-label': label } });
  const buttons = tabs.map((t, i) => {
    const b = el('button', { class: 'tab', attrs: { role: 'tab', 'aria-selected': String(t.selected), tabindex: t.selected ? '0' : '-1', ...(t.controls ? { 'aria-controls': t.controls } : {}) }, on: { click: t.onSelect } }, t.icon ? icon(t.icon) : null, t.text);
    b.type = 'button';
    b.dataset.key = `${key}-${t.id}`;
    b.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      const n = k === 'ArrowRight' ? i + 1 : k === 'ArrowLeft' ? i - 1 : k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : null;
      if (n === null) return;
      e.preventDefault();
      const next = buttons[(n + tabs.length) % tabs.length]!;
      next.focus();
      next.click();
    });
    return b;
  });
  list.append(...buttons);
  return list;
}
