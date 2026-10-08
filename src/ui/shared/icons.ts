/**
 * Local stroke icons (24-grid, 1.75 stroke, currentColor). Built with createElementNS — no
 * innerHTML, no remote assets. Decorative: always aria-hidden; the adjacent text names the action.
 */
const PATHS = {
  predict: ['M3 12h3l3-7 4 14 3-7h5'], // pulse: structure signal
  record: ['M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0', 'M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0'],
  page: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  click: ['M9 9l10 4-4 2-2 4z', 'M5 3v3', 'M3 5h3', 'M8.5 4.5l-1.5 1.5'],
  scroll: ['M12 3v18', 'M8 7l4-4 4 4', 'M8 17l4 4 4-4'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  pages: ['M8 3h10v14H8z', 'M5 7v14h10'],
  chevron: ['M9 6l6 6-6 6'],
  info: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 11v5', 'M12 8h.01'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  stop: ['M7 7h10v10H7z'],
  warn: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  up: ['M12 19V5', 'M6 11l6-6 6 6'],
  down: ['M12 5v14', 'M6 13l6 6 6-6'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
} as const;

export type IconName = keyof typeof PATHS;

const NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, cls = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
