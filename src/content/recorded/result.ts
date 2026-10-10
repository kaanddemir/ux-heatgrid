/** Lightweight protocol views of a Recorded result (no density, tiles or samples ever leave). */
import type { RecordedPageResult, RecordedPageView, RecordedSessionResult, RecordedSessionView } from './types';

export function toSessionView(r: RecordedSessionResult, selectedPage: number): RecordedSessionView {
  const single = r.segments.length === 1 ? r.segments[0]! : null;
  return {
    sessionId: r.sessionId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    elapsedMs: r.elapsedMs,
    activeMs: r.activeMs,
    totals: { ...r.totals },
    deepestScroll: single ? scrollDepth(single) : null,
    pages: r.segments.map((p, position) => ({ position, path: p.pageIdentity.path, title: p.pageIdentity.title, clicks: p.facts.clicks + p.facts.activations, activeMs: p.facts.activeMs })),
    selectedPage,
    limitations: [...r.limitations],
    timings: { processMs: r.timings.processMs, perPageMs: [...r.timings.perPageMs] },
  };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Deepest point of the page that was on screen, as a share of its height (the first screen
 * counts). null when the page never needed scrolling: "100%" would claim scrolling that cannot
 * have happened.
 */
export function scrollDepth(p: Pick<RecordedPageResult, 'scrollMetrics'>): number | null {
  const d = p.scrollMetrics.document;
  if (!d || d.scrollHeight <= d.clientHeight + 1) return null;
  return round3(d.deepestFraction);
}

export function toPageView(
  p: RecordedPageResult,
  position: number,
  pageCount: number,
  live: { pageOpen: boolean; elementsLive: boolean; layoutMayHaveChanged: boolean },
): RecordedPageView {
  return {
    position,
    pageCount,
    path: p.pageIdentity.path,
    title: p.pageIdentity.title,
    ...live,
    facts: {
      ...p.facts,
      deepestScroll: scrollDepth(p),
      nestedScroll: p.scrollMetrics.nested.map((n) => ({ rootId: n.rootId, label: null, deepestFraction: round3(n.deepestFraction) })),
    },
    lists: p.lists,
    maybeNotClickable: p.maybeNotClickable.slice(0, 10),
    limitations: [...p.limitations],
  };
}

