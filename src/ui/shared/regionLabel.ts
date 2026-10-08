/**
 * Region name for row metadata — presentation only (region detection is unchanged).
 * The analyzer names unnamed blocks "Section" / "Article" (numbered when repeated); those carry
 * no meaning in a row, so they are hidden. Semantic landmarks keep their name without the repeat
 * number ("Navigation 2" → "Navigation"); real names (headings, aria labels) are kept as-is.
 */
const GENERIC = /^(Section|Article|Block)( \d+)?$/;
const LANDMARK = /^(Header|Navigation|Main|Footer|Sidebar|Form) \d+$/;

export function meaningfulRegion(label: string | null | undefined): string | null {
  if (!label) return null;
  if (GENERIC.test(label)) return null;
  return LANDMARK.test(label) ? label.replace(/ \d+$/, '') : label;
}

/** Subject name for display: drops link-hint noise ("opens in a new tab", trailing ↗). */
export function cleanSubject(label: string): string {
  return (
    label
      .replace(/[,\s]*[(\[]?\s*opens in (a )?new (tab|window)\s*[)\]]?\s*$/i, '')
      .replace(/[\s]*[↗→⧉]+\s*$/u, '')
      .trim() || label
  );
}
