/**
 * Deterministic DomReader for DOM fixtures (test DOMs have no layout engine).
 * - data-rect="x y w h": viewport-relative rect (default 0×0)
 * - data-scroll="clientW clientH scrollW scrollH": scroll extents (default: no overflow)
 * - computed style comes from the test DOM (inline styles); `hidden` maps to display:none.
 * - data-before / data-after='{"content":"\"\"","background-color":"…","width":"…px","height":"…px"}':
 *   pseudo-element computed style (the test DOM does not compute pseudo-elements).
 */
import type { DomReader, ScrollMetrics, StyleSource } from '../../src/content/analyzer/measure';
import type { Rect } from '../../src/content/analyzer/types';

export interface FixtureOptions {
  width?: number;
  height?: number;
  scrollX?: number;
  scrollY?: number;
  docWidth?: number;
  docHeight?: number;
  dpr?: number;
  canvas?: 'light' | 'dark';
}

function nums(attr: string | null, n: number): number[] | null {
  if (!attr) return null;
  const parts = attr.trim().split(/\s+/).map(Number);
  return parts.length === n && parts.every(Number.isFinite) ? parts : null;
}

export function fixtureReader(opts: FixtureOptions = {}): DomReader & { styleReads: number } {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  let clock = 0;
  const reader = {
    styleReads: 0,
    rect(el: Element): Rect {
      const n = nums(el.getAttribute('data-rect'), 4);
      return n ? { x: n[0]!, y: n[1]!, width: n[2]!, height: n[3]! } : { x: 0, y: 0, width: 0, height: 0 };
    },
    style(el: Element, pseudo?: string): StyleSource {
      reader.styleReads++;
      if (pseudo) {
        const raw = el.getAttribute(pseudo === '::before' ? 'data-before' : 'data-after');
        const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
        return { getPropertyValue: (p: string) => map[p] ?? (p === 'content' ? 'none' : '') };
      }
      const cs = getComputedStyle(el);
      return {
        getPropertyValue(p: string): string {
          if (p === 'display' && el.hasAttribute('hidden')) return 'none';
          // Inline style first: the test DOM does not compute every longhand.
          const inline = (el as HTMLElement).style;
          const v = inline?.getPropertyValue(p) || cs.getPropertyValue(p);
          // Chrome expands the overflow shorthand in computed style; the test DOM does not.
          if (!v && (p === 'overflow-x' || p === 'overflow-y')) return inline?.getPropertyValue('overflow') || cs.getPropertyValue('overflow');
          return v;
        },
      };
    },
    canvasColorScheme: () => opts.canvas ?? 'light',
    viewport: () => ({ width, height, scrollX: opts.scrollX ?? 0, scrollY: opts.scrollY ?? 0, dpr: opts.dpr ?? 2 }),
    documentSize: () => ({ width: opts.docWidth ?? width, height: opts.docHeight ?? height }),
    scrollMetrics(el: Element): ScrollMetrics {
      const n = nums(el.getAttribute('data-scroll'), 4);
      const r = reader.rect(el);
      return n
        ? { clientWidth: n[0]!, clientHeight: n[1]!, scrollWidth: n[2]!, scrollHeight: n[3]! }
        : { clientWidth: r.width, clientHeight: r.height, scrollWidth: r.width, scrollHeight: r.height };
    },
    documentScrollMetrics: () => ({
      clientWidth: width,
      clientHeight: height,
      scrollWidth: opts.docWidth ?? width,
      scrollHeight: opts.docHeight ?? height,
    }),
    now: () => (clock += 1),
  };
  return reader;
}

export function mount(html: string): void {
  document.body.innerHTML = html;
}
