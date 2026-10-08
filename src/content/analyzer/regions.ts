/**
 * Region model (pure, no DOM). Algorithm:
 *
 * 1. Landmarks: header/nav/main/footer/aside/form/article (and sections only when they carry an
 *    aria label) become regions if their area ≥ MIN_AREA (2% of the viewport, at least 5 000 px²).
 * 2. Near-duplicates (IoU ≥ 0.85) collapse to the higher-priority landmark
 *    (nav > header/footer > aside > form > article > section > main).
 * 3. Heading sections: the content container (largest `main`, else the whole document) is split
 *    at heading boundaries. Boundary level = smallest L ∈ {1,2,3} with ≥ 2 headings of that level
 *    inside the container (headings inside nav/header/footer/aside/form regions are ignored);
 *    every heading with level ≤ L starts a section. Sections shorter than 24px merge into the
 *    previous one. If sections are produced, they replace the `main` region (no nested duplicate).
 * 4. Fallback: when steps 1–3 produce nothing, large top-level layout blocks, and failing that,
 *    document bands one viewport tall. When steps 1–3 cover less than half of the document
 *    (e.g. only a sidebar is a landmark), large layout blocks that do not duplicate an existing
 *    region are added so the main content is not left without a region.
 * 5. Cap (40) by priority: landmarks, heading sections, blocks, bands; then document order.
 * 6. Every member (rendered elements only) is assigned to the smallest region containing its
 *    center. Members no region contains geometrically (e.g. content scrolled inside a nested
 *    scroller) can be assigned by the caller through DOM ancestry (assignMember).
 */
import type { LandmarkType, Rect, Region, RegionKind, RegionStats } from './types';

export const MAX_REGIONS = 40;
const DUPLICATE_IOU = 0.85;
const MIN_SECTION_HEIGHT = 24;

export interface RegionInput {
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  landmarks: Array<{ id: number; landmark: LandmarkType; rect: Rect; label?: string; ariaLabelled: boolean }>;
  headings: Array<{ id: number; level: number; rect: Rect; label?: string }>;
  blocks: Array<{ id: number; rect: Rect }>;
  members: Array<{ id: number; center: { x: number; y: number }; interactive: boolean }>;
  maxRegions?: number;
}

export interface RegionOutput {
  regions: Region[];
  /** Region id per member id (null when no region contains it). */
  membership: Map<number, number | null>;
  found: number;
  capped: boolean;
}

const LANDMARK_PRIORITY: Record<LandmarkType, number> = {
  nav: 0, header: 1, footer: 1, aside: 2, form: 3, article: 4, section: 5, main: 6,
};
const KIND_PRIORITY: Record<RegionKind, number> = { landmark: 0, 'heading-section': 1, block: 2, band: 3 };
const GENERIC_LABEL: Record<LandmarkType, string> = {
  header: 'Header', nav: 'Navigation', main: 'Main', footer: 'Footer',
  aside: 'Sidebar', form: 'Form', article: 'Article', section: 'Section',
};

const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);

export function iou(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

const contains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

interface Draft {
  kind: RegionKind;
  landmark?: LandmarkType;
  label?: string;
  rect: Rect;
  sourceRef?: number;
  headingRef?: number;
  order: number;
}

export function buildRegions(input: RegionInput): RegionOutput {
  const maxRegions = input.maxRegions ?? MAX_REGIONS;
  const vpArea = input.viewport.width * input.viewport.height;
  const minArea = Math.max(0.02 * vpArea, 5_000);
  let order = 0;

  // 1–2. Landmarks
  const candidates = input.landmarks
    .filter((l) => area(l.rect) >= minArea && (l.landmark !== 'section' || l.ariaLabelled))
    .sort((a, b) => LANDMARK_PRIORITY[a.landmark] - LANDMARK_PRIORITY[b.landmark] || a.rect.y - b.rect.y || a.id - b.id);
  const landmarks: Draft[] = [];
  for (const l of candidates) {
    if (landmarks.some((k) => iou(k.rect, l.rect) >= DUPLICATE_IOU)) continue;
    landmarks.push({
      kind: 'landmark',
      landmark: l.landmark,
      ...(l.label ? { label: l.label } : {}),
      rect: l.rect,
      sourceRef: l.id,
      order: order++,
    });
  }

  // 3. Heading sections
  const mains = landmarks.filter((d) => d.landmark === 'main').sort((a, b) => area(b.rect) - area(a.rect));
  const main = mains[0];
  const container: Rect = main?.rect ?? { x: 0, y: 0, width: input.document.width, height: input.document.height };
  const excluded = landmarks.filter((d) => d.landmark && d.landmark !== 'main' && d.landmark !== 'article' && d.landmark !== 'section');
  const usable = input.headings
    .filter((h) => {
      const cx = h.rect.x + h.rect.width / 2;
      const cy = h.rect.y + h.rect.height / 2;
      return contains(container, cx, cy) && !excluded.some((d) => contains(d.rect, cx, cy));
    })
    .sort((a, b) => a.rect.y - b.rect.y || a.id - b.id);
  let boundaryLevel: number | null = null;
  for (const level of [1, 2, 3]) {
    if (usable.filter((h) => h.level === level).length >= 2) {
      boundaryLevel = level;
      break;
    }
  }
  const sections: Draft[] = [];
  if (boundaryLevel !== null) {
    const bounds = usable.filter((h) => h.level <= boundaryLevel!);
    const bottom = container.y + container.height;
    bounds.forEach((h, i) => {
      const top = Math.max(container.y, h.rect.y);
      const next = bounds[i + 1];
      const end = Math.min(bottom, next ? next.rect.y : bottom);
      const prev = sections[sections.length - 1];
      if (end - top < MIN_SECTION_HEIGHT && prev) {
        prev.rect = { ...prev.rect, height: end - prev.rect.y };
        return;
      }
      sections.push({
        kind: 'heading-section',
        ...(h.label ? { label: h.label } : {}),
        rect: { x: container.x, y: top, width: container.width, height: Math.max(0, end - top) },
        headingRef: h.id,
        order: order++,
      });
    });
  }
  const useSections = sections.length >= 2;
  let drafts: Draft[] = [
    ...(useSections ? landmarks.filter((d) => d !== main) : landmarks),
    ...(useSections ? sections : []),
  ];

  // 4. Fallback
  const docArea = Math.max(1, input.document.width * input.document.height);
  const coverage = drafts.reduce((sum, d) => sum + area(d.rect), 0) / docArea;
  if (drafts.length > 0 && coverage < 0.5) {
    const extra = input.blocks
      .filter((b) => area(b.rect) >= minArea && !drafts.some((d) => iou(d.rect, b.rect) >= DUPLICATE_IOU))
      .sort((a, b) => a.rect.y - b.rect.y || a.id - b.id);
    for (const b of extra) drafts.push({ kind: 'block', rect: b.rect, sourceRef: b.id, order: order++ });
  }
  if (drafts.length === 0) {
    const blocks = input.blocks.filter((b) => area(b.rect) >= minArea).sort((a, b) => a.rect.y - b.rect.y || a.id - b.id);
    if (blocks.length >= 2) {
      drafts = blocks.map((b) => ({ kind: 'block' as const, rect: b.rect, sourceRef: b.id, order: order++ }));
    } else {
      const bandH = Math.max(input.viewport.height, 1);
      const docH = Math.max(input.document.height, input.viewport.height);
      for (let y = 0; y < docH; y += bandH) {
        drafts.push({ kind: 'band', rect: { x: 0, y, width: input.document.width, height: Math.min(bandH, docH - y) }, order: order++ });
      }
    }
  }

  // 5. Cap
  const found = drafts.length;
  const kept = [...drafts]
    .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.order - b.order)
    .slice(0, maxRegions)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.order - b.order);

  // Labels: the region's own name when it has one; otherwise a generic name by landmark type
  // ("Section" for unnamed blocks/bands — no invented meaning), numbered only when repeated.
  // Repeated names get a suffix ("Attributes", "Attributes 2").
  const base = kept.map((d) => (d.label ? truncate(d.label, 40) : d.landmark ? GENERIC_LABEL[d.landmark] : 'Section'));
  const totals = new Map<string, number>();
  for (const b of base) totals.set(b, (totals.get(b) ?? 0) + 1);
  const counts = new Map<string, number>();
  const regions: Region[] = kept.map((d, i) => {
    const b = base[i]!;
    const n = (counts.get(b) ?? 0) + 1;
    counts.set(b, n);
    const generic = !d.label;
    const label = totals.get(b)! === 1 ? b : generic && !d.landmark ? `${b} ${n}` : n === 1 ? b : `${b} ${n}`;
    return {
      id: i + 1,
      kind: d.kind,
      ...(d.landmark ? { landmark: d.landmark } : {}),
      label,
      rect: d.rect,
      ...(d.sourceRef !== undefined ? { sourceRef: d.sourceRef } : {}),
      ...(d.headingRef !== undefined ? { headingRef: d.headingRef } : {}),
      elementRefs: [],
      stats: { area: area(d.rect), interactiveCount: 0, contextCount: 0, interactivePer100k: 0 },
    };
  });

  // 6. Membership
  const membership = new Map<number, number | null>();
  for (const m of input.members) {
    let best: Region | null = null;
    for (const r of regions) {
      if (!contains(r.rect, m.center.x, m.center.y)) continue;
      if (!best || r.stats.area < best.stats.area) best = r;
    }
    membership.set(m.id, best?.id ?? null);
    if (best) addMember(best, m.id, m.interactive);
  }

  return { regions, membership, found, capped: found > maxRegions };
}

function addMember(region: Region, id: number, interactive: boolean): void {
  region.elementRefs.push(id);
  if (interactive) region.stats.interactiveCount++;
  else region.stats.contextCount++;
  region.stats = withDensity(region.stats);
}

/** Assigns a member to a region outside the geometric pass (e.g. by DOM ancestry). */
export function assignMember(out: RegionOutput, regionId: number, memberId: number, interactive: boolean): void {
  const region = out.regions.find((r) => r.id === regionId);
  if (!region || out.membership.get(memberId) != null) return;
  out.membership.set(memberId, regionId);
  addMember(region, memberId, interactive);
}

function withDensity(s: RegionStats): RegionStats {
  return { ...s, interactivePer100k: s.area > 0 ? Math.round((s.interactiveCount / s.area) * 100_000 * 100) / 100 : 0 };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
