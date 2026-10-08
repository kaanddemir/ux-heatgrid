/**
 * TabRuntime — composes the per-tab capabilities behind one message handler:
 *  - SessionController (Record)  and  PredictionController (Predict) — independent of each other
 *  - the shared PageAnalyzer (and its ElementRegistry)
 *  - the OverlayController (page overlay; created lazily on first use)
 * and publishes one combined TabSnapshot (protocol v3) on every state change.
 * Chrome wiring (listeners, injection guard) lives in index.ts.
 */
import { createPageAnalyzer, type PageAnalyzer } from './analyzer';
import { SessionController, type CommandResult } from './controller';
import { PredictionController, type PredictionCommandResult } from './prediction/controller';
import type { StaleWatcher } from './prediction/stale';
import { toElementDetails, toSummaryResult } from './prediction/summary';
import type { PredictionSummaryResult } from './prediction/types';
import { OverlayController } from './overlay/controller';
import { createRecIndicator } from './overlay/rec';
import { liveRecorderListeners, startRecorder, type Recorder } from './recorder';
import { pageIdentity, type ContinuityChannel, type PageCaptureSegment, type RecordingSessionResult } from './recorder/segment';
import { RecordedOverlay } from './overlay/recorded';
import { recordedTitle } from './overlay/legend';
import { LAYOUT_CHANGE_SHARE } from './recorded/config';
import { processSession } from './recorded/process';
import type { RectOf } from './recorded/reproject';
import { toPageView, toSessionView } from './recorded/result';
import { DEFAULT_LAYERS, type RecordedFocusResult, type RecordedLayers, type RecordedPageResult, type RecordedSessionResult, type RecordedSnapshot } from './recorded/types';
import { movedMaterially, needsScroll } from './overlay/positioning';
import {
  ACTIVE_STATES,
  makeError,
  type FocusResult,
  type InteractionView,
  type StaleReason,
  type TabSnapshot,
} from '../shared/model';
import { fail, makeEvent, ok, type EventEnvelope, type RequestEnvelope, type Response } from '../shared/protocol';

/** The overlay surface TabRuntime drives (OverlayController, or a fake in tests). */
export type OverlayLike = Pick<OverlayController, 'setVisible' | 'setPrediction' | 'setStale' | 'setShowLow' | 'select' | 'dispose'> &
  Partial<Pick<OverlayController, 'stats'>>;

/** The Recorded overlay surface TabRuntime drives (RecordedOverlay, or a fake in tests). */
export type RecordedOverlayLike = Pick<RecordedOverlay, 'show' | 'hide' | 'dispose'> & Partial<Pick<RecordedOverlay, 'stats' | 'inspect' | 'flush'>>;

export interface TabRuntimeDeps {
  buildId: string;
  emit: (event: EventEnvelope) => void;
  analyzer?: PageAnalyzer;
  createWatcher?: (onStale: (reason: StaleReason) => void) => StaleWatcher;
  now?: () => number;
  clock?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Overlay factory (default: OverlayController on the real document). */
  createOverlay?: (resolve: (id: number) => Element | null) => OverlayLike;
  /** Window used for scrolling and reduced-motion checks (default: global window). */
  win?: Window;
  /** Recorder factory (default: real recorder on this page, with the REC indicator). */
  createRecorder?: (analyzer: PageAnalyzer) => Recorder;
  /** Cross-navigation recording continuity (service worker channel). */
  continuity?: ContinuityChannel;
  /** Recorded overlay factory (default: RecordedOverlay on the real document). */
  createRecordedOverlay?: (resolve: (id: number) => Element | null) => RecordedOverlayLike;
}

export interface TabRuntime {
  handle(msg: RequestEnvelope): Response<unknown>;
  snapshot(): TabSnapshot;
  /** True while a session exists that navigation would end. */
  hasActiveSession(): boolean;
  /** pagehide while recording: finalize this page segment once and hand it off (see SessionController.handoff). */
  handoffRecording(): PageCaptureSegment | null;
  /** Overlay frame statistics (diagnostics; isolated world only, never sent over the protocol). */
  overlayStats(): OverlayController['stats'] | null;
  /** Recorder diagnostics (isolated world only): live listeners and a bounded slice of samples. */
  recorderDiagnostics(limit?: number): {
    listeners: number;
    samples: { rootId: number[]; x: number[]; y: number[]; elementRef: number[] } | null;
    segments: Array<{ index: number; path: string; samples: number; folded: number; clicks: number; yMin: number | null; yMax: number | null; bytes: number }> | null;
  };
  /** Recorded Interaction diagnostics (isolated world only; never sent over the protocol). */
  recordedDiagnostics(): unknown;
  dispose(): void;
}

export function createTabRuntime(deps: TabRuntimeDeps): TabRuntime {
  const analyzer = deps.analyzer ?? createPageAnalyzer();
  let interactionView: InteractionView = 'none';
  let showLow = true;
  let focusedElementId: number | null = null;
  let overlay: OverlayLike | null = null;
  let overlayPredictionId: string | null = null;
  let summaryCache: PredictionSummaryResult | null = null;

  // Recorded Interaction (Phase 6): processed result, selected page, layers, selected control.
  let recorded: RecordedSessionResult | null = null;
  let recordedPage = 0;
  let layers: RecordedLayers = { ...DEFAULT_LAYERS };
  let recordedFocus: number | null = null;
  let recordedOverlay: RecordedOverlayLike | null = null;

  const resolve = (id: number): Element | null => analyzer.registry.resolve(id);
  const win = (): Window => deps.win ?? window;
  const getRecordedOverlay = (): RecordedOverlayLike => {
    recordedOverlay ??= deps.createRecordedOverlay
      ? deps.createRecordedOverlay(resolve)
      : new RecordedOverlay({ resolve, onLayers: setRecordedLayers, onClose: () => setView('none', undefined) });
    return recordedOverlay;
  };

  /** Privacy-safe identity match (origin + path) between the live page and a recorded page. */
  const pageOpen = (p: RecordedPageResult): boolean => {
    let live: { origin: string; path: string };
    try {
      live = pageIdentity(win().location.href, '');
    } catch {
      return false;
    }
    return live.origin === p.pageIdentity.origin && live.path === p.pageIdentity.path;
  };
  const selectedPage = (): RecordedPageResult | null => recorded?.segments[recordedPage] ?? null;

  const recordedSnapshot = (): RecordedSnapshot | null => {
    const p = selectedPage();
    if (!recorded || !p) return null;
    return { page: recordedPage, pageCount: recorded.segments.length, layers: { ...layers }, focusedElementId: recordedFocus, pageOpen: pageOpen(p) };
  };

  /** Shows the selected page's map only when it is the live page; never paints another page's map. */
  const syncRecorded = (): void => {
    const p = selectedPage();
    if (interactionView !== 'recorded' || !recorded || !p || !pageOpen(p)) {
      recordedOverlay?.hide();
      return;
    }
    getRecordedOverlay().show(p, { title: recordedTitle(recordedPage, recorded.segments.length), layers, focusedElementId: p.local ? recordedFocus : null });
  };

  function setRecordedLayers(next: RecordedLayers): void {
    layers = { ...next };
    emitState();
  }

  const dropRecorded = (): void => {
    recorded = null;
    recordedPage = 0;
    recordedFocus = null;
    if (interactionView === 'recorded') interactionView = 'none';
    recordedOverlay?.hide();
  };

  /** Live rect of a control of the LOCAL segment, in its root's content coordinates. */
  const liveRectOf = (rs: RecordingSessionResult, localIndex: number): RectOf => {
    const seg = rs.segments.find((s) => s.index === localIndex);
    const containers = new Map((seg?.scroll.roots ?? []).filter((r) => r.kind === 'container').map((r) => [r.rootId, r.elementRef]));
    const w = win();
    return (ref, rootId) => {
      const el = resolve(ref);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!containers.has(rootId)) return { x: r.x + w.scrollX, y: r.y + w.scrollY, width: r.width, height: r.height };
      const cRef = containers.get(rootId);
      const c = cRef !== undefined ? resolve(cRef) : null;
      if (!c) return null;
      const cr = c.getBoundingClientRect();
      return { x: r.x - cr.left - c.clientLeft + c.scrollLeft, y: r.y - cr.top - c.clientTop + c.scrollTop, width: r.width, height: r.height };
    };
  };

  const layoutMayHaveChanged = (p: RecordedPageResult): boolean => {
    if (p.limitations.includes('PAGE_CHANGED')) return true;
    const w = win();
    const se = w.document.scrollingElement ?? w.document.documentElement;
    const changed = (a: number, b: number): boolean => a > 0 && b > 0 && Math.abs(a - b) / b > LAYOUT_CHANGE_SHARE;
    return changed(se.scrollHeight, p.dimensions.documentHeight) || changed(w.innerWidth, p.dimensions.viewport.width);
  };
  const getOverlay = (): OverlayLike => {
    overlay ??= deps.createOverlay
      ? deps.createOverlay(resolve)
      : new OverlayController({ resolve, onClose: () => setView('none', undefined) });
    return overlay;
  };

  const snapshot = (): TabSnapshot => ({
    buildId: deps.buildId,
    session: session.snapshot(),
    prediction: prediction.snapshot(),
    interactionView,
    overlay: { showLow, focusedElementId },
    recorded: recordedSnapshot(),
  });

  /** Keeps view/overlay consistent with the prediction state. Never triggers a prediction. */
  const syncOverlay = (): void => {
    const p = prediction.snapshot();
    const result = prediction.getResult();
    const hasResult = (p.state === 'ready' || p.state === 'stale' || p.state === 'analyzing') && result !== null;
    if (!hasResult) {
      // No prediction (cleared / failed): nothing to show.
      if (interactionView === 'predicted') interactionView = 'none';
      focusedElementId = null;
      overlayPredictionId = null;
      overlay?.setPrediction(null);
      overlay?.setVisible(false);
      return;
    }
    if (!overlay && interactionView !== 'predicted') return; // overlay never used yet
    const o = getOverlay();
    if (overlayPredictionId !== result.predictionId) {
      overlayPredictionId = result.predictionId;
      o.setPrediction(result.elements.map((e) => ({ id: e.elementRef.id, band: e.band, rank: e.rank })));
      if (focusedElementId !== null && !result.elements.some((e) => e.elementRef.id === focusedElementId && e.band !== 'not-assessed')) {
        focusedElementId = null;
      }
      o.select(focusedElementId);
    }
    o.setStale(p.state === 'stale');
    o.setShowLow(showLow);
    o.setVisible(interactionView === 'predicted');
  };

  const emitState = (): void => {
    // Only one interaction visualization at a time: hide before the other one mounts.
    if (interactionView !== 'recorded') recordedOverlay?.hide();
    syncOverlay();
    syncRecorded();
    deps.emit(makeEvent('STATE_CHANGED', { snapshot: snapshot() }));
  };

  const session: SessionController = new SessionController({
    buildId: deps.buildId,
    emit: deps.emit,
    onStateChange: emitState,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setInterval ? { setInterval: deps.setInterval } : {}),
    ...(deps.clearInterval ? { clearInterval: deps.clearInterval } : {}),
    ...(deps.continuity ? { continuity: deps.continuity } : {}),
    pageTitle: () => (typeof document !== 'undefined' ? document.title : ''),
    process: (rs, localIndex) => {
      recorded = processSession(rs, { localIndex, rectOf: liveRectOf(rs, localIndex) });
      const local = recorded.segments.findIndex((p) => p.local);
      recordedPage = local >= 0 ? local : recorded.segments.length - 1;
      recordedFocus = null;
    },
    createRecorder: () => (deps.createRecorder ? deps.createRecorder(analyzer) : startRecorder({ analyzer, indicator: () => createRecIndicator() })),
  });
  const prediction: PredictionController = new PredictionController({
    analyzer,
    emit: deps.emit,
    onStateChange: emitState,
    ...(deps.createWatcher ? { createWatcher: deps.createWatcher } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });

  const respond = (r: CommandResult | PredictionCommandResult): Response<unknown> => (r.ok ? ok(snapshot()) : fail(r.error));
  const noPrediction = () => fail(makeError('INVALID_STATE', 'No prediction for this page'));
  const hasShowablePrediction = (): boolean => {
    const st = prediction.snapshot().state;
    return (st === 'ready' || st === 'stale') && prediction.getResult() !== null;
  };

  const summary = (): PredictionSummaryResult | null => {
    const result = prediction.getResult();
    if (!result) return null;
    if (summaryCache?.predictionId !== result.predictionId) summaryCache = toSummaryResult(result);
    return summaryCache;
  };

  const recordingNow = (): boolean => {
    const s = session.snapshot().state;
    return s === 'preparing' || s === 'recording';
  };
  const notWhileRecording = () => fail(makeError('INVALID_STATE', 'Predicted Interaction is hidden while recording'));

  /** Recording must not be influenced by the predicted overlay: hide it (the result is kept). */
  function hidePredictedForRecording(): void {
    if (interactionView !== 'predicted' && focusedElementId === null) return;
    interactionView = 'none';
    focusedElementId = null;
    overlay?.select(null);
    overlay?.setVisible(false);
  }

  function setView(view: InteractionView, low: boolean | undefined): Response<unknown> {
    if (view === 'recorded' && (!recorded || session.snapshot().state !== 'ready')) return fail(makeError('INVALID_STATE', 'No recorded session'));
    if (view === 'predicted' && recordingNow()) return notWhileRecording();
    if (view === 'predicted' && !hasShowablePrediction()) return noPrediction();
    if (low !== undefined) showLow = low;
    interactionView = view;
    if (view !== 'predicted') {
      focusedElementId = null;
      overlay?.select(null);
    }
    emitState();
    return ok(snapshot());
  }

  function focus(elementId: number | null, scroll: boolean): Response<FocusResult> {
    if (elementId === null) {
      focusedElementId = null;
      overlay?.select(null);
      emitState();
      return ok({ status: 'cleared', moved: false, snapshot: snapshot() });
    }
    if (recordingNow()) return notWhileRecording();
    const result = prediction.getResult();
    if (!result || !hasShowablePrediction()) return noPrediction();
    const target = result.elements.find((e) => e.elementRef.id === elementId && e.band !== 'not-assessed');
    if (!target) return fail(makeError('INVALID_MESSAGE', `Element ${elementId} is not in the current prediction`));
    const live = resolve(elementId);
    if (!live) {
      // Do not paint the old location: report it as unavailable instead.
      if (focusedElementId === elementId) {
        focusedElementId = null;
        overlay?.select(null);
        emitState();
      }
      return ok({ status: 'unavailable', moved: false, snapshot: snapshot() });
    }
    const win = deps.win ?? window;
    const r = live.getBoundingClientRect();
    const fixed = target.features?.fixed === 1;
    const moved = !fixed && movedMaterially(target.rect, { x: r.x + win.scrollX, y: r.y + win.scrollY, width: r.width, height: r.height });
    focusedElementId = elementId;
    interactionView = 'predicted';
    getOverlay().select(elementId);
    if (scroll && !fixed && needsScroll(r, { width: win.innerWidth, height: win.innerHeight })) {
      const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      live.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
    emitState();
    return ok({ status: 'focused', moved, snapshot: snapshot() });
  }

  function focusRecorded(page: number, elementId: number | null, scroll: boolean): Response<RecordedFocusResult & { snapshot: TabSnapshot }> {
    if (!recorded) return fail(makeError('INVALID_STATE', 'No recorded session'));
    const p = recorded.segments[page];
    if (!p) return fail(makeError('INVALID_MESSAGE', `No recorded page ${page}`));
    if (elementId === null) {
      recordedPage = page;
      recordedFocus = null;
      emitState();
      return ok({ status: 'cleared', snapshot: snapshot() });
    }
    // Validate before mutating: a rejected request must not move the selection to another page.
    const known = p.elementStats.some((e) => e.elementRef === elementId) || p.lists.neverReached.items.some((e) => e.elementRef === elementId);
    if (!known) return fail(makeError('INVALID_MESSAGE', `Element ${elementId} is not in this recorded page`));
    recordedPage = page;
    recordedFocus = elementId;
    // Another page (or an earlier document of this page): show its facts, never a guessed element.
    const status = !pageOpen(p) ? 'not-open' : !p.local ? 'unavailable' : null;
    const live = status ? null : resolve(elementId);
    if (!live) {
      emitState();
      return ok({ status: status ?? 'unavailable', snapshot: snapshot() });
    }
    interactionView = 'recorded';
    focusedElementId = null;
    overlay?.select(null);
    const w = win();
    const r = live.getBoundingClientRect();
    if (scroll && needsScroll(r, { width: w.innerWidth, height: w.innerHeight })) {
      const reduce = w.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      live.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
    emitState();
    return ok({ status: 'focused', snapshot: snapshot() });
  }

  return {
    handle(msg) {
      switch (msg.type) {
        case 'PING':
          return ok({ buildId: deps.buildId });
        case 'GET_STATE':
          return ok(snapshot());
        case 'START_SESSION': {
          const st = session.snapshot().state;
          if (st === 'idle' || st === 'ready' || st === 'error') dropRecorded();
          hidePredictedForRecording();
          return respond(session.start());
        }
        case 'RESUME_RECORDING':
          dropRecorded();
          hidePredictedForRecording();
          return respond(session.resume((msg as RequestEnvelope<'RESUME_RECORDING'>).payload));
        case 'STOP_SESSION':
          return respond(session.stop());
        case 'CLEAR_SESSION': {
          const r = session.clear();
          if (r.ok) {
            dropRecorded();
            emitState();
          }
          return respond(r);
        }
        case 'GET_RECORDED_SESSION':
          return ok(recorded ? toSessionView(recorded, recordedPage) : null);
        case 'GET_RECORDED_PAGE': {
          const pos = (msg as RequestEnvelope<'GET_RECORDED_PAGE'>).payload.page;
          const p = recorded?.segments[pos];
          if (!recorded || !p) return ok(null);
          const open = pageOpen(p);
          return ok(toPageView(p, pos, recorded.segments.length, { pageOpen: open, elementsLive: open && p.local, layoutMayHaveChanged: open && layoutMayHaveChanged(p) }));
        }
        case 'SET_RECORDED_PAGE': {
          const pos = (msg as RequestEnvelope<'SET_RECORDED_PAGE'>).payload.page;
          if (!recorded) return fail(makeError('INVALID_STATE', 'No recorded session'));
          if (!recorded.segments[pos]) return fail(makeError('INVALID_MESSAGE', `No recorded page ${pos}`));
          if (pos !== recordedPage) recordedFocus = null;
          recordedPage = pos;
          emitState();
          return ok(snapshot());
        }
        case 'SET_RECORDED_LAYERS': {
          const { heatmap, clicks, scroll } = (msg as RequestEnvelope<'SET_RECORDED_LAYERS'>).payload;
          setRecordedLayers({ heatmap, clicks, scroll });
          return ok(snapshot());
        }
        case 'FOCUS_RECORDED_ELEMENT': {
          const { page, elementId, scroll } = (msg as RequestEnvelope<'FOCUS_RECORDED_ELEMENT'>).payload;
          return focusRecorded(page, elementId, scroll);
        }
        case 'RUN_PREDICTION':
          return respond(prediction.run());
        case 'CLEAR_PREDICTION':
          return respond(prediction.clear());
        case 'GET_PREDICTION':
          return ok(summary());
        case 'GET_PREDICTION_DETAILS': {
          const result = prediction.getResult();
          if (!result) return noPrediction();
          return ok(toElementDetails(result, (msg as RequestEnvelope<'GET_PREDICTION_DETAILS'>).payload.elementId));
        }
        case 'SET_INTERACTION_VIEW': {
          const { view, showLow: low } = (msg as RequestEnvelope<'SET_INTERACTION_VIEW'>).payload;
          return setView(view, low);
        }
        case 'FOCUS_ELEMENT': {
          const { elementId, scroll } = (msg as RequestEnvelope<'FOCUS_ELEMENT'>).payload;
          return focus(elementId, scroll);
        }
      }
    },
    snapshot,
    overlayStats: () => (overlay?.stats ? { ...overlay.stats } : null),
    recorderDiagnostics(limit = 2000) {
      const p = session.getCapture()?.pointer;
      const take = (a: ArrayLike<number>): number[] => Array.from(a).slice(0, limit);
      const rs = session.getRecordingSession();
      return {
        listeners: liveRecorderListeners,
        samples: p ? { rootId: take(p.rootId), x: take(p.x), y: take(p.y), elementRef: take(p.elementRef) } : null,
        segments: rs
          ? rs.segments.map((s) => ({
              index: s.index,
              path: s.page.path,
              samples: s.pointer.count,
              folded: s.pointer.foldedSamples,
              clicks: s.clicks.length,
              yMin: s.pointer.count ? Math.min(...s.pointer.y) : null,
              yMax: s.pointer.count ? Math.max(...s.pointer.y) : null,
              bytes: JSON.stringify(s).length,
            }))
          : null,
      };
    },
    recordedDiagnostics() {
      if (!recorded) return null;
      return {
        processMs: recorded.timings.processMs,
        pages: recorded.segments.map((p) => ({
          index: p.index,
          path: p.pageIdentity.path,
          local: p.local,
          open: pageOpen(p),
          processMs: p.timings.processMs,
          densityBytes: p.density.bytes,
          placedMs: p.density.placedMs,
          roots: p.density.roots.map((d) => {
            // Peak = centroid of the cells at the maximum (normalisation clamps a plateau at 255).
            let max = 0;
            for (const v of d.value) max = Math.max(max, v);
            let sx = 0;
            let sy = 0;
            let n = 0;
            for (let r = 0; r < d.rows; r++) {
              for (let i = d.rowStart[r]!; i < d.rowStart[r + 1]!; i++) {
                if (d.value[i] !== max) continue;
                sx += (d.col[i]! + 0.5) * d.cellPx;
                sy += (r + 0.5) * d.cellPx;
                n++;
              }
            }
            return { rootId: d.rootId, kind: d.kind, cellPx: d.cellPx, cols: d.cols, rows: d.rows, cells: d.value.length, peak: n ? { x: Math.round(sx / n), y: Math.round(sy / n) } : null };
          }),
          markers: p.clickMarkers,
          deepestPx: p.scrollMetrics.document?.deepestPx ?? null,
          reprojection: p.reprojection,
          limitations: p.limitations,
        })),
        overlay: recordedOverlay?.inspect?.() ?? null,
        stats: recordedOverlay?.stats ? { ...recordedOverlay.stats } : null,
      };
    },
    handoffRecording: () => session.handoff(),
    hasActiveSession: () => (ACTIVE_STATES as readonly string[]).includes(session.snapshot().state),
    dispose() {
      session.dispose();
      prediction.dispose();
      overlay?.dispose();
      overlay = null;
      recordedOverlay?.dispose();
      recordedOverlay = null;
      analyzer.dispose();
    },
  };
}
