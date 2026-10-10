/**
 * Side-panel theme: System (follows the OS) · Light · Dark. The choice lives in the extension
 * page's localStorage (no extra permission, no sync infrastructure) and is applied before the first
 * render, so the panel never opens in the wrong theme. tokens.css maps data-theme to the palette.
 */
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
export const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const KEY = 'hg-theme';

export function readTheme(doc: Document): Theme {
  try {
    const t = doc.defaultView?.localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** Applies `theme` to the document and remembers it (storage failures still apply it for this view). */
export function applyTheme(doc: Document, theme: Theme): void {
  if (theme === 'system') delete doc.documentElement.dataset.theme;
  else doc.documentElement.dataset.theme = theme;
  try {
    doc.defaultView?.localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: the choice holds until the panel closes.
  }
}

export const nextTheme = (t: Theme): Theme => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]!;
