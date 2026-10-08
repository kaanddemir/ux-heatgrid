/**
 * Deduplication + ranking (pure). Priority is an internal ordering key built from evidence
 * strength, actionability, confidence and scope — never shown, never a UX score.
 *
 * Dedupe: insights of one mode, on one page, in one region that say essentially the same thing
 * (density / competition / separation / spacing form one family; other categories group by
 * themselves) collapse into the strongest one; the others' leading facts are kept as evidence.
 * Repeated patterns (same rule, source and subject label — e.g. one button repeated on every
 * product card) collapse into one card; the repeats stay traceable in `mergedFrom`.
 */
import { confidenceWeight, insightConfidence } from './confidence';
import type { InsightCandidate, InsightCategory } from './types';

export const DEFAULT_VISIBLE = 5;
export const MAX_INSIGHTS = 10;
/** At most this many cards per category (Phase 9: real pages repeated one category many times). */
export const MAX_PER_CATEGORY = 3;

const FAMILY: Partial<Record<InsightCategory, string>> = { DENSITY: 'crowding', COMPETING_CONTROLS: 'crowding', SEPARATION: 'crowding', SPACING: 'crowding' };

export function priorityOf(c: InsightCandidate): number {
  const scope = c.subject.kind === 'element' ? 1 : c.subject.kind === 'region' ? 0.85 : 0.6;
  return 0.4 * c.strength + 0.25 * c.actionability + 0.2 * confidenceWeight(insightConfidence(c.baseConfidence, c.caveats)) + 0.15 * scope;
}

/** Region-level families collapse per region; every other category stays per subject. */
const REGIONAL = new Set<InsightCategory>(['DENSITY', 'COMPETING_CONTROLS', 'SEPARATION', 'SPACING', 'HIERARCHY']);

function regionOf(c: InsightCandidate): string {
  const s = c.subject;
  if (!REGIONAL.has(c.category)) return s.kind === 'element' ? `e${s.elementId}` : s.kind === 'region' ? `r${s.regionId}` : s.point ? `pt${s.point.rootId}:${s.point.x},${s.point.y}` : 'page';
  if (s.kind === 'region') return `r${s.regionId}`;
  if (s.kind === 'element') return s.regionId === null ? `e${s.elementId}` : `r${s.regionId}`;
  return s.point ? `pt${Math.round(s.point.y / 48)}:${Math.round(s.point.x / 48)}` : 'page';
}

export interface Ranked {
  candidate: InsightCandidate;
  priority: number;
  mergedFrom: string[];
}

export function dedupeAndRank(candidates: readonly InsightCandidate[], limit = MAX_INSIGHTS): Ranked[] {
  const groups = new Map<string, Ranked>();
  for (const c of candidates) {
    const key = `${c.mode}|${c.subject.page ?? '-'}|${regionOf(c)}|${FAMILY[c.category] ?? c.category}`;
    const r: Ranked = { candidate: c, priority: priorityOf(c), mergedFrom: [] };
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, r);
      continue;
    }
    const [keep, drop] = r.priority > prev.priority || (r.priority === prev.priority && c.ruleId < prev.candidate.ruleId) ? [r, prev] : [prev, r];
    // Keep one supporting fact from the merged insight (as evidence context, ≤ 2 in total).
    const extra = drop.candidate.observationFacts.find((f) => ![...keep.candidate.observationFacts, ...keep.candidate.contextFacts].some((k) => k.key === f.key));
    keep.candidate = { ...keep.candidate, contextFacts: extra && keep.candidate.contextFacts.length < 2 ? [...keep.candidate.contextFacts, extra] : keep.candidate.contextFacts };
    keep.mergedFrom = [...keep.mergedFrom, `${drop.candidate.ruleId}:${drop.candidate.subject.kind}`, ...drop.mergedFrom];
    groups.set(key, keep);
  }
  // One card per subject per evidence source: a second angle on the same control becomes evidence.
  const bySubject = new Map<string, Ranked>();
  for (const r of [...groups.values()].sort((a, b) => b.priority - a.priority || a.candidate.ruleId.localeCompare(b.candidate.ruleId))) {
    const s = r.candidate.subject;
    const key = s.kind === 'element' ? `${r.candidate.mode}|${s.page ?? '-'}|e${s.elementId}` : `${r.candidate.mode}|${s.page ?? '-'}|${r.candidate.category}|${regionOf(r.candidate)}`;
    const keep = bySubject.get(key);
    if (!keep) bySubject.set(key, r);
    else keep.mergedFrom = [...keep.mergedFrom, `${r.candidate.ruleId}:${s.kind}`, ...r.mergedFrom];
  }
  // Repeated pattern: the same rule firing on identically-labelled subjects is one finding.
  const byPattern = new Map<string, Ranked>();
  for (const r of [...bySubject.values()].sort((a, b) => b.priority - a.priority || a.candidate.ruleId.localeCompare(b.candidate.ruleId))) {
    const c = r.candidate;
    const key = `${c.mode}|${c.subject.page ?? '-'}|${c.ruleId}|${c.subject.kind}|${c.subject.label}`;
    const keep = byPattern.get(key);
    if (!keep) byPattern.set(key, r);
    else keep.mergedFrom = [...keep.mergedFrom, `${c.ruleId}:${c.subject.kind}:repeat`, ...r.mergedFrom];
  }
  // Greedy order with a diversity penalty: repeated categories sink, and each is capped.
  const pool = [...byPattern.values()].sort((a, b) => b.priority - a.priority || a.candidate.ruleId.localeCompare(b.candidate.ruleId));
  const out: Ranked[] = [];
  const seen = new Map<string, number>();
  while (pool.length && out.length < limit) {
    let bi = -1;
    let best = -Infinity;
    pool.forEach((r, i) => {
      if ((seen.get(r.candidate.category) ?? 0) >= MAX_PER_CATEGORY) return;
      const v = r.priority * Math.pow(0.85, seen.get(r.candidate.category) ?? 0);
      if (v > best + 1e-9) ((best = v), (bi = i));
    });
    if (bi < 0) break;
    const [r] = pool.splice(bi, 1);
    seen.set(r!.candidate.category, (seen.get(r!.candidate.category) ?? 0) + 1);
    out.push(r!);
  }
  return out;
}
