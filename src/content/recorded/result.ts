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
    deepestScroll: single?.scrollMetrics.document ? round3(single.scrollMetrics.document.deepestFraction) : null,
    pages: r.segments.map((p, position) => ({ position, path: p.pageIdentity.path, title: p.pageIdentity.title, clicks: p.facts.clicks + p.facts.activations, activeMs: p.facts.activeMs })),
    selectedPage,
    limitations: [...r.limitations],
    timings: { processMs: r.timings.processMs, perPageMs: [...r.timings.perPageMs] },
  };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

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
      deepestScroll: p.scrollMetrics.document ? round3(p.scrollMetrics.document.deepestFraction) : null,
      nestedScroll: p.scrollMetrics.nested.map((n) => ({ rootId: n.rootId, label: null, deepestFraction: round3(n.deepestFraction) })),
    },
    lists: p.lists,
    maybeNotClickable: p.maybeNotClickable.slice(0, 10),
    limitations: [...p.limitations],
  };
}

