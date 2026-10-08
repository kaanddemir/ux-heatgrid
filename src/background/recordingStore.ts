/**
 * Tab-level recording continuity store (service worker side). ALL state lives in
 * chrome.storage.session (injected `storage`), never in worker memory, so a suspended or
 * restarted service worker loses nothing. Written only at lifecycle boundaries:
 * begin, segment finalized (pagehide), interruption, collect (Stop), clear.
 *
 * Keys: `rec:<tabId>` → RecordingMeta (small); `seg:<tabId>:<index>` → one PageCaptureSegment.
 */
import { enforceBudget, priorTotals, segmentBytes, SESSION_BUDGET_BYTES, type PageCaptureSegment, type ResumePayload, type SessionLimitationCode } from '../content/recorder/segment';

export type { ResumePayload };

export interface StorageLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface RecordingMeta {
  tabId: number;
  sessionId: string;
  startedAt: number;
  state: 'recording';
  continuity: 'continuous' | 'interrupted';
  /** Indexes of stored segments, ascending. */
  segments: number[];
  /** Index handed to the next resumed document (gaps are harmless; collisions are not). */
  nextIndex: number;
  /** Small per-segment summaries (for totals without loading segments). */
  totals: Array<{ index: number; bytes: number; summary: PageCaptureSegment['summary'] }>;
  limitations: SessionLimitationCode[];
}


const metaKey = (tabId: number): string => `rec:${tabId}`;
const segKey = (tabId: number, index: number): string => `seg:${tabId}:${index}`;

export function createRecordingStore(storage: StorageLike, budget = SESSION_BUDGET_BYTES) {
  // Per-tab serialization: segment arrival (pagehide) and resume (next document) can overlap.
  const locks = new Map<number, Promise<unknown>>();
  const serial = <T>(tabId: number, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(tabId) ?? Promise.resolve()).then(fn, fn);
    locks.set(tabId, run.catch(() => {}));
    return run;
  };

  async function meta(tabId: number): Promise<RecordingMeta | null> {
    const v = (await storage.get(metaKey(tabId)))[metaKey(tabId)];
    return (v as RecordingMeta | undefined) ?? null;
  }

  async function clear(tabId: number): Promise<void> {
    const m = await meta(tabId);
    await storage.remove([metaKey(tabId), ...(m?.segments ?? []).map((i) => segKey(tabId, i))]);
  }

  return {
    meta,
    clear: (tabId: number) => serial(tabId, () => clear(tabId)),

    /** Clears only when the stored recording is `sessionId` (a stale clear never removes a newer one). */
    clearSession: (tabId: number, sessionId: string) =>
      serial(tabId, async () => {
        if ((await meta(tabId))?.sessionId === sessionId) await clear(tabId);
      }),

    /** A new recording starts on this tab (replaces any previous one). */
    begin: (tabId: number, sessionId: string, startedAt: number) =>
      serial(tabId, async () => {
        await clear(tabId);
        const m: RecordingMeta = { tabId, sessionId, startedAt, state: 'recording', continuity: 'continuous', segments: [], nextIndex: 1, totals: [], limitations: [] };
        await storage.set({ [metaKey(tabId)]: m });
      }),

    /**
     * Stores one finalized page segment. Idempotent: a segment index is stored once (duplicate
     * lifecycle signals are ignored). Enforces the session budget by coarsening older segments.
     */
    addSegment: (tabId: number, seg: PageCaptureSegment): Promise<'stored' | 'duplicate' | 'no-session'> => serial(tabId, async () => {
      const m = await meta(tabId);
      if (!m || m.sessionId !== seg.sessionId) return 'no-session';
      if (m.segments.includes(seg.index)) return 'duplicate';
      const total = m.totals.reduce((a, t) => a + t.bytes, 0) + segmentBytes(seg);
      let toWrite: PageCaptureSegment[] = [seg];
      let coarsened = false;
      if (total > budget) {
        const stored = await storage.get(m.segments.map((i) => segKey(tabId, i)));
        const all = [...m.segments.map((i) => stored[segKey(tabId, i)] as PageCaptureSegment).filter(Boolean), seg];
        const r = enforceBudget(all, budget);
        toWrite = r.segments;
        coarsened = r.coarsened;
      }
      const totals = new Map(m.totals.map((t) => [t.index, t]));
      for (const s of toWrite) totals.set(s.index, { index: s.index, bytes: segmentBytes(s), summary: s.summary });
      const next: RecordingMeta = {
        ...m,
        segments: [...m.segments, seg.index].sort((a, b) => a - b),
        totals: [...totals.values()].sort((a, b) => a.index - b.index),
        limitations: coarsened && !m.limitations.includes('MULTI_PAGE_SESSION_COARSENED') ? [...m.limitations, 'MULTI_PAGE_SESSION_COARSENED'] : m.limitations,
      };
      await storage.set({ ...Object.fromEntries(toWrite.map((s) => [segKey(tabId, s.index), s])), [metaKey(tabId)]: next });
      return 'stored' as const;
    }),

    /** What a new document needs to continue the recording; null when there is none. */
    resumePayload: (tabId: number): Promise<ResumePayload | null> => serial(tabId, async () => {
      const m = await meta(tabId);
      if (!m) return null;
      await storage.set({ [metaKey(tabId)]: { ...m, nextIndex: m.nextIndex + 1 } });
      return { sessionId: m.sessionId, startedAt: m.startedAt, segmentIndex: m.nextIndex, prior: priorTotals(m.totals), continuity: m.continuity };
    }),

    /** The recording reached a page where HeatGrid cannot run. Earlier data is kept. */
    interrupt: (tabId: number): Promise<void> => serial(tabId, async () => {
      const m = await meta(tabId);
      if (!m) return;
      const limitations: SessionLimitationCode[] = m.limitations.includes('RECORDING_INTERRUPTED_UNSUPPORTED_PAGE') ? m.limitations : [...m.limitations, 'RECORDING_INTERRUPTED_UNSUPPORTED_PAGE'];
      await storage.set({ [metaKey(tabId)]: { ...m, continuity: 'interrupted', limitations } });
    }),

    /** Stop: hands over every stored segment of the session and removes the temporary storage. */
    collect: (tabId: number, sessionId: string): Promise<{ segments: PageCaptureSegment[]; limitations: SessionLimitationCode[] } | null> => serial(tabId, async () => {
      const m = await meta(tabId);
      if (!m || m.sessionId !== sessionId) return null;
      const stored = await storage.get(m.segments.map((i) => segKey(tabId, i)));
      const segments = m.segments.map((i) => stored[segKey(tabId, i)] as PageCaptureSegment).filter(Boolean);
      await clear(tabId);
      return { segments, limitations: m.limitations };
    }),
  };
}

export type RecordingStore = ReturnType<typeof createRecordingStore>;
