/**
 * The HeatGrid inspector kit — every screen is composed from these, and Predict and Record use the
 * same ones in the same places:
 *
 *   notices · inspector head (title + actions) · summary (metric cells) · groups of inspector rows
 *   (expandable detail) · footer
 *
 * Mode identity comes only from `data-kind` on the screen (accent colour); structure never differs.
 */
import { el } from '../shared/render';
import { icon, type IconName } from '../shared/icons';

/** Evidence identity of a screen: drives the accent (`--kind`) of everything inside it. */
export type Kind = 'predicted' | 'recorded' | 'overview';

type Kids = Array<Node | null | false | undefined>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ButtonOpts {
  /** Filled in the screen's accent: the one main action of a view. */
  primary?: boolean;
  /** Text-only; for secondary actions and links. */
  subtle?: boolean;
  /** Reset / clear: quiet until hovered, then the danger tone. Always in a footer. */
  danger?: boolean;
  /** Stop recording: the live-state action (red). */
  stop?: boolean;
  key?: string;
  label?: string;
  icon?: IconName;
  /** Trailing icon (links: "Open full report →"). */
  after?: IconName;
}

export function button(text: string, onClick: () => void, enabled: boolean, opts: ButtonOpts = {}): HTMLButtonElement {
  const variant = opts.primary ? 'is-primary' : opts.stop ? 'is-stop' : opts.danger ? 'is-danger' : opts.subtle ? 'is-subtle' : '';
  const b = el('button', { class: variant ? `btn ${variant}` : 'btn', on: { click: (e) => (e.stopPropagation(), onClick()) } }, opts.icon ? icon(opts.icon) : null, text, opts.after ? icon(opts.after) : null);
  b.type = 'button';
  b.disabled = !enabled;
  if (opts.key) b.dataset.key = opts.key;
  if (opts.label) b.setAttribute('aria-label', opts.label);
  return b;
}

/** Square icon-only action with a visible tooltip (title) and an accessible name. */
export function iconButton(ic: IconName, label: string, onClick: () => void, enabled: boolean, opts: { key?: string; pressed?: boolean } = {}): HTMLButtonElement {
  const b = el('button', { class: opts.pressed ? 'icon-btn is-on' : 'icon-btn', attrs: { 'aria-label': label, title: label }, on: { click: (e) => (e.stopPropagation(), onClick()) } }, icon(ic));
  b.type = 'button';
  b.disabled = !enabled;
  if (opts.pressed !== undefined) b.setAttribute('aria-pressed', String(opts.pressed));
  if (opts.key) b.dataset.key = opts.key;
  return b;
}

/**
 * On/off control backed by a real checkbox (keyboard + screen-reader semantics for free).
 * `toggle` reads as a button (Show on page); `switchRow` reads as a settings row (popover).
 */
function checkbox(checked: boolean, enabled: boolean, onChange: (v: boolean) => void, key: string): HTMLInputElement {
  const input = el('input', { attrs: { type: 'checkbox' }, on: { change: (e) => onChange((e.target as HTMLInputElement).checked) } });
  input.checked = checked;
  input.disabled = !enabled;
  input.dataset.key = key;
  return input;
}

export function toggle(label: string, checked: boolean, enabled: boolean, onChange: (v: boolean) => void, key: string, ic?: IconName): HTMLLabelElement {
  return el('label', { class: 'toggle', attrs: { title: label } }, checkbox(checked, enabled, onChange, key), ic ? icon(ic) : null, el('span', { class: 'toggle-text', text: label }));
}

export function switchRow(label: string, checked: boolean, enabled: boolean, onChange: (v: boolean) => void, key: string, glyph?: string): HTMLLabelElement {
  return el(
    'label',
    { class: 'switch-row' },
    glyph ? el('span', { class: 'glyph', attrs: { 'data-glyph': glyph, 'aria-hidden': 'true' } }) : null,
    el('span', { class: 'switch-text', text: label }),
    checkbox(checked, enabled, onChange, key),
    el('span', { class: 'switch', attrs: { 'aria-hidden': 'true' } }),
  );
}

// ---------------------------------------------------------------------------
// Screen frame
// ---------------------------------------------------------------------------

/** A screen: one column with the shared rhythm. `kind` sets the accent colour. */
export function screen(kind: Kind, ...children: Kids): HTMLElement {
  return el('div', { class: 'screen', attrs: { 'data-kind': kind } }, ...children);
}

/** Inspector head: mode title (no subtitle) · trailing actions, on one line at every width. */
export function screenHead(title: string, opts: { trailing?: HTMLElement | null } = {}): HTMLElement {
  return el('div', { class: 'ihead' }, el('h1', { class: 'ihead-title', text: title }), opts.trailing ? el('div', { class: 'ihead-actions' }, opts.trailing) : null);
}

/** Inline action group (head actions, popover footers). */
export function actions(...children: Kids): HTMLElement {
  return el('div', { class: 'actions' }, ...children);
}

/** Bottom of a screen: quiet secondary info on the left, reset / clear on the right. */
export function footer(...children: Kids): HTMLElement {
  return el('div', { class: 'foot' }, ...children);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface Cell {
  label: string;
  value: string;
  /** De-emphasise (zero / not measured). */
  quiet?: boolean;
  /** Data attribute for mode-specific marks (Predict bands). */
  band?: string;
  /** Live cells are filled in place (recording ticks) without a re-render. */
  live?: (node: HTMLElement) => void;
}

/**
 * The one summary component: 3 or 4 equal cells (value over label) with an optional mode-specific
 * band bar above and a one-line scope caption below. Same type scale for 3 and 4 cells.
 */
export function summary(label: string, cells: Array<Cell | null>, opts: { bar?: HTMLElement | null; caption?: string | null; key?: string } = {}): HTMLElement {
  const shown = cells.filter((c): c is Cell => !!c);
  const root = el(
    'div',
    { class: 'summary', attrs: { role: 'group', 'aria-label': label, ...(opts.key ? { 'data-key': opts.key } : {}) } },
    opts.bar ?? null,
    el(
      'dl',
      { class: 'cells', attrs: { 'data-n': String(shown.length) } },
      ...shown.map((c) => {
        const value = el('dd', { class: 'cell-value', text: c.value });
        c.live?.(value);
        // dt before dd (valid list); CSS stacks the value on top.
        return el('div', { class: c.quiet ? 'cell is-quiet' : 'cell', attrs: c.band ? { 'data-band': c.band } : {} }, el('dt', { class: 'cell-label', text: c.label }), value);
      }),
    ),
    opts.caption ? el('p', { class: 'caption', text: opts.caption }) : null,
  );
  return root;
}

// ---------------------------------------------------------------------------
// Result groups and rows
// ---------------------------------------------------------------------------

/** Collapsible group state, owned by the app so it survives re-renders. */
export interface Collapse {
  id: string;
  collapsed: boolean;
  onToggle: () => void;
}

/** Result group: the whole heading toggles; the body is removed (not hidden) when collapsed. */
export function group(title: string, opts: { count: number; collapse?: Collapse; band?: string }, ...children: Kids): HTMLElement {
  const c = opts.collapse;
  const label = `${title} (${opts.count})`;
  const heading = [
    opts.band ? el('span', { class: 'band-key', attrs: { 'data-band': opts.band, 'aria-hidden': 'true' } }) : null,
    el('h2', { class: 'group-title', text: title }),
    el('span', { class: 'count', text: String(opts.count) }),
  ];
  if (!c) return el('section', { class: 'group', attrs: { 'aria-label': label } }, el('div', { class: 'group-head' }, ...heading), ...children);
  const bodyId = `grp-${c.id}`;
  const head = el('button', { class: 'group-head', attrs: { type: 'button', 'aria-expanded': String(!c.collapsed), 'aria-controls': bodyId }, on: { click: c.onToggle } }, icon('chevron', 'icon chev'), ...heading);
  head.dataset.key = `sec-${c.id}`;
  return el('section', { class: c.collapsed ? 'group is-collapsed' : 'group', attrs: { 'aria-label': label } }, head, c.collapsed ? null : el('div', { class: 'group-body', attrs: { id: bodyId } }, ...children));
}

/** "Show 5 more" under a group. */
export function more(onMore: () => void, key: string): HTMLButtonElement {
  return button('Show 5 more', onMore, true, { key, subtle: true });
}

export interface RowOpts {
  /** Stable id for aria-controls / data-key. */
  id: string;
  key: string;
  label: string;
  meta?: string | null;
  /** Accessible summary of the row (defaults to label · meta). */
  aria?: string;
  selected: boolean;
  onToggle: () => void;
  /** Quiet status mark after the label (e.g. lower prediction confidence). */
  status?: HTMLElement | null;
  /** Eye action shown on the open row only. */
  eye?: { on: boolean; enabled: boolean; key: string; onClick: () => void } | null;
  detail?: HTMLElement | null;
}

/**
 * The one inspector row. A full-row toggle button sits underneath pointer-transparent content, so
 * the eye can be a real sibling button (no nested buttons, and clicking it never toggles the row).
 */
export function inspectorRow(o: RowOpts): HTMLElement {
  const detailId = `detail-${o.id}`;
  const t = el('button', {
    class: 'row-toggle',
    attrs: { type: 'button', 'aria-expanded': String(o.selected), 'aria-controls': detailId, 'aria-label': o.aria ?? [o.label, o.meta].filter(Boolean).join(' · ') },
    on: { click: o.onToggle },
  });
  t.dataset.key = o.key;
  if (o.selected) t.dataset.selected = '';
  o.status?.addEventListener('click', o.onToggle); // the status mark sits above the toggle
  const eye = o.eye ? iconButton('eye', o.eye.on ? 'Clear highlight' : 'Show on page', o.eye.onClick, o.eye.enabled, { key: o.eye.key, pressed: o.eye.on }) : null;
  return el(
    'li',
    { class: o.selected ? 'row is-open' : 'row' },
    el(
      'div',
      { class: 'row-line' },
      t,
      el('span', { class: 'row-main', attrs: { 'aria-hidden': 'true' } }, el('span', { class: 'row-label', text: o.label }), o.status ?? null),
      o.meta ? el('span', { class: 'row-meta', attrs: { 'aria-hidden': 'true' }, text: o.meta }) : null,
      eye,
      icon('chevron', 'icon chev'),
    ),
    o.selected && o.detail ? withId(o.detail, detailId) : null,
  );
}

function withId(node: HTMLElement, id: string): HTMLElement {
  node.id = id;
  return node;
}

/** Expanded-row panel: an inset block under the row (no card), parts stacked. */
export function detail(label: string, ...parts: Kids): HTMLElement {
  return el('div', { class: 'detail', attrs: { role: 'region', 'aria-label': label } }, ...parts);
}

/** Small label + content block inside a detail panel. */
export function detailPart(label: string, ...children: Kids): HTMLElement {
  return el('div', { class: 'detail-part' }, el('p', { class: 'detail-label', text: label }), ...children);
}

/** Facts as a 2-column grid of label / value pairs (Predict structure, Record activity). */
export function statGrid(label: string, rows: Array<[string, string] | null>): HTMLElement {
  return el(
    'dl',
    { class: 'stat-grid', attrs: { 'aria-label': label } },
    ...rows.filter((r): r is [string, string] => !!r).map(([k, v]) => el('div', { class: 'stat' }, el('dt', { text: k }), el('dd', { text: v }))),
  );
}

/** Compact preview list (Overview): label · meta, not interactive. */
export function previewList(rows: Array<{ label: string; meta: string }>): HTMLElement | null {
  return rows.length ? el('ul', { class: 'preview' }, ...rows.map((r) => el('li', {}, el('span', { class: 'row-label', text: r.label }), el('span', { class: 'row-meta', text: r.meta })))) : null;
}

// ---------------------------------------------------------------------------
// Filter popover
// ---------------------------------------------------------------------------

export interface FilterOption<T extends string> {
  id: T;
  text: string;
  count?: number;
}

/**
 * Single-select choice group: "All" first, then options with subtle counts. Options with a count of 0
 * are dropped (except the current one); a group with nothing to choose between renders nothing.
 * Laid out as an equal-column grid (`--n` = option count) so rows stay balanced — see `.choices`.
 */
export function filterGroup<T extends string>(label: string, options: Array<FilterOption<T>>, current: T, onPick: (id: T) => void, enabled: boolean, keyPrefix: string, opts: { keep?: boolean } = {}): HTMLElement | null {
  const shown = options.filter((o) => o.count === undefined || o.count > 0 || o.id === current);
  if (!opts.keep && shown.length - 1 < 2 && current === shown[0]?.id) return null;
  return popoverGroup(
    label,
    el(
      'div',
      { class: 'choices', attrs: { 'data-n': String(Math.min(shown.length, 4)) } },
      ...shown.map((o) => {
        const b = el('button', { class: 'choice', on: { click: () => onPick(o.id) } }, o.text, o.count !== undefined ? el('span', { class: 'choice-n', text: String(o.count) }) : null);
        b.type = 'button';
        b.disabled = !enabled;
        b.dataset.key = `${keyPrefix}-${o.id}`;
        b.setAttribute('aria-pressed', String(current === o.id));
        return b;
      }),
    ),
  );
}

/** Labelled block inside the popover (choices or switch rows). */
export function popoverGroup(label: string, ...children: Kids): HTMLElement {
  return el('div', { class: 'pop-group', attrs: { role: 'group', 'aria-label': label } }, el('p', { class: 'pop-label', text: label }), ...children);
}

let filterPopoverCleanup: (() => void) | null = null;
let openPopoverLabel: string | null = null;
/** Bumped on every popover render/dismiss: a superseded render's deferred wiring must not attach. */
let popoverGeneration = 0;

/** Navigation cleanup: an open popover must not leave document listeners behind off-screen. */
export function dismissPopover(): void {
  popoverGeneration++;
  filterPopoverCleanup?.();
  filterPopoverCleanup = null;
  openPopoverLabel = null;
}

/**
 * The one Filter control (same trigger, placement and popover in both modes). Selections apply
 * immediately; Reset and Done close the loop. Outside pointer / Escape dismiss it.
 */
export function filterPopover(label: string, active: number, open: boolean, onOpen: ((open: boolean) => void) | undefined, onReset: (() => void) | undefined, ...groups: Array<HTMLElement | null>): HTMLElement | null {
  const shown = groups.filter((x): x is HTMLElement => !!x);
  if (!shown.length) return null;
  const generation = ++popoverGeneration;
  filterPopoverCleanup?.();
  filterPopoverCleanup = null;
  const root = el('div', { class: open ? 'filter is-open' : 'filter' });
  const trigger = el(
    'button',
    { class: active ? 'btn filter-trigger is-active' : 'btn filter-trigger', attrs: { type: 'button', 'aria-expanded': String(open), 'aria-haspopup': 'dialog', title: 'Filter' }, on: { click: (e) => (e.stopPropagation(), onOpen?.(!open)) } },
    icon('filter'),
    el('span', { class: 'filter-text', text: 'Filter' }),
    active ? el('span', { class: 'filter-count', text: String(active), attrs: { 'aria-label': `${active} active` } }) : null,
  );
  trigger.dataset.key = 'filter-toggle';
  root.append(trigger);
  if (!open) {
    if (openPopoverLabel === label) openPopoverLabel = null;
    return root;
  }
  const entering = openPopoverLabel !== label;
  openPopoverLabel = label;
  root.append(
    el(
      'div',
      { class: entering ? 'popover is-entering' : 'popover', attrs: { role: 'dialog', 'aria-label': label }, on: { click: (e) => e.stopPropagation() } },
      ...shown,
      el('div', { class: 'pop-actions' }, button('Reset', () => onReset?.(), active > 0, { key: 'filter-reset', subtle: true }), button('Done', () => close(), true, { key: 'filter-done', primary: true })),
    ),
  );
  /** Done / Escape hand focus back to the trigger (the re-render restores focus by data-key). */
  const close = (): void => {
    trigger.focus();
    onOpen?.(false);
  };
  queueMicrotask(() => {
    if (generation !== popoverGeneration) return; // re-rendered or dismissed before this ran
    fitPopover(root.querySelector<HTMLElement>('.popover'));
    const outside = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) onOpen?.(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    filterPopoverCleanup = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  });
  return root;
}

/**
 * Keeps the open popover inside the side panel. It is right-aligned to its trigger in CSS; here we
 * only correct what CSS can't know: shift right if the left edge would leave the view, flip above
 * the trigger when there is more room there, and scroll its content when neither side fits.
 */
function fitPopover(pop: HTMLElement | null): void {
  if (!pop?.isConnected) return;
  const view = pop.ownerDocument.documentElement;
  const margin = 8;
  const r = pop.getBoundingClientRect();
  if (r.left < margin) pop.style.right = `${r.left - margin}px`;
  const trig = (pop.previousElementSibling as HTMLElement | null)?.getBoundingClientRect();
  const below = view.clientHeight - (trig?.bottom ?? r.top) - margin;
  const above = (trig?.top ?? 0) - margin;
  if (r.height <= below) return;
  if (above > below) pop.classList.add('is-above');
  pop.style.maxHeight = `${Math.max(above > below ? above : below, 120) - 6}px`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type IssueSeverity = 'critical' | 'action' | 'warning' | 'info';
export interface NoticeIssue {
  /** Meaningful, stable identity used for de-duplication (not presentation copy). */
  id: string;
  severity: IssueSeverity;
  message: string;
  detail?: string;
  action?: HTMLElement | null;
}

const ISSUE_PRIORITY: Record<IssueSeverity, number> = { critical: 0, action: 1, warning: 2, info: 3 };

/**
 * The single warning surface shared by Predict and Record. One issue is a compact row; multiple
 * issues share one disclosure whose primary issue and recovery action always remain visible.
 */
export function noticePanel(
  issues: readonly NoticeIssue[],
  opts: { expanded?: boolean; onExpandedChange?: (expanded: boolean) => void; announce?: boolean } = {},
): HTMLElement | null {
  const byIdentity = new Map<string, NoticeIssue>();
  for (const issue of issues) {
    const existing = byIdentity.get(issue.id);
    if (!existing || ISSUE_PRIORITY[issue.severity] < ISSUE_PRIORITY[existing.severity]) byIdentity.set(issue.id, issue);
  }
  const distinct = [...byIdentity.values()].sort((a, b) => ISSUE_PRIORITY[a.severity] - ISSUE_PRIORITY[b.severity]);
  if (!distinct.length) return null;
  const primary = distinct[0]!;
  const multiple = distinct.length > 1;
  const expanded = multiple && !!opts.expanded;
  const bodyId = `notice-${primary.id.replace(/[^a-z0-9_-]/gi, '-')}-body`;
  const attrs: Record<string, string> = { 'data-severity': primary.severity };
  if (opts.announce !== false) attrs.role = primary.severity === 'critical' ? 'alert' : 'status';

  const copy = el(
    'span',
    { class: 'notice-copy' },
    el('span', { class: 'notice-message', text: primary.message }),
    primary.detail ? el('span', { class: 'notice-detail', text: primary.detail }) : null,
    multiple ? el('span', { class: 'notice-count', text: `${distinct.length} issues detected` }) : null,
  );
  const toggle = multiple
    ? el('button', { class: 'notice-toggle', attrs: { type: 'button', 'aria-expanded': String(expanded), 'aria-controls': bodyId, 'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${distinct.length} issues` }, on: { click: () => opts.onExpandedChange?.(!expanded) } }, copy, icon('chevron', 'icon chev'))
    : copy;
  if (toggle instanceof HTMLButtonElement) toggle.dataset.key = `notice-${primary.id}`;

  return el(
    'section',
    { class: `notice is-${primary.severity}${expanded ? ' is-open' : ''}`, attrs },
    el('div', { class: 'notice-head' }, icon(primary.severity === 'info' ? 'info' : 'warn'), toggle, primary.action ? el('span', { class: 'notice-action', on: { click: (event) => event.stopPropagation() } }, primary.action) : null),
    expanded
      ? el('ul', { class: 'notice-list', attrs: { id: bodyId } }, ...distinct.slice(1).map((issue) => el('li', { attrs: { 'data-severity': issue.severity } }, icon(issue.severity === 'info' ? 'info' : 'warn'), el('span', {}, el('span', { class: 'notice-message', text: issue.message }), issue.detail ? el('span', { class: 'notice-detail', text: issue.detail }) : null), issue.action ? el('span', { class: 'notice-action' }, issue.action) : null)))
      : null,
  );
}

/** Empty state: icon · short title · one short line · one action. Same block for loading. */
export function emptyState(title: string, body: string, action: HTMLElement | null, ic: IconName = 'info', tone: 'kind' | 'warn' = 'kind'): HTMLElement {
  return el(
    'div',
    { class: 'empty', attrs: { 'data-tone': tone } },
    el('span', { class: 'empty-icon', attrs: { 'aria-hidden': 'true' } }, icon(ic)),
    el('p', { class: 'empty-title', text: title }),
    body ? el('p', { class: 'empty-body', text: body }) : null,
    action ? el('div', { class: 'empty-action' }, action) : null,
  );
}

export function loadingState(text: string): HTMLElement {
  return el('div', { class: 'empty is-loading', attrs: { role: 'status', 'data-tone': 'kind' } }, el('span', { class: 'empty-icon', attrs: { 'aria-hidden': 'true' } }, el('span', { class: 'spinner' })), el('p', { class: 'empty-body', text }));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Roving keyboard support for a role="tablist" (arrow keys / Home / End). */
export function tablist(label: string, tabs: Array<{ id: string; text: string; selected: boolean; onSelect: () => void; controls?: string }>, key: string): HTMLElement {
  const list = el('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': label } });
  const buttons = tabs.map((t, i) => {
    const b = el('button', { class: 'tab', attrs: { role: 'tab', 'aria-selected': String(t.selected), tabindex: t.selected ? '0' : '-1', ...(t.controls ? { 'aria-controls': t.controls } : {}) }, on: { click: t.onSelect } }, t.text);
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
