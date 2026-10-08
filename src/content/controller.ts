/**
 * SessionController — the single source of truth for a tab's session. Owns at most one Recorder.
 *
 * preparing: start the recorder (registry-mode analysis + listeners); recording: live ticks;
 * processing: finalize the capture; ready: the capture is kept in runtime memory and only a
 * lightweight summary leaves it. Without a recorder factory (lifecycle unit tests) it falls back
 * to the Phase 1 timer-only behaviour.
 */
import { SESSION_TICK_MS } from '../shared/constants';
import { makeEvent, type EventEnvelope } from '../shared/protocol';
import {
  makeError,
  type HeatGridError,
  type SessionSnapshot,
  type SessionState,
  type SessionSummary,
} from '../shared/model';
import { transition, type SessionAction } from './machine';
import { summarizeCapture, type Recorder } from './recorder';
import {
  enforceBudget,
  NO_PRIOR,
  sessionSummary,
  toSegment,
  type ContinuityChannel,
  type PageCaptureSegment,
  type PriorTotals,
  type RecordingSessionResult,
  type ResumePayload,
  type SessionLimitationCode,
} from './recorder/segment';
import type { SessionCapture } from './recorder/types';

export interface ControllerDeps {
  buildId: string;
  /** Session events (SESSION_TICK). */
  emit: (event: EventEnvelope) => void;
  /** Called after every state change; the runtime emits the combined TabSnapshot (protocol v2). */
  onStateChange: (snapshot: SessionSnapshot) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Creates and starts a recorder (attaches listeners). */
  createRecorder?: () => Recorder;
  /** Cross-navigation continuity (service worker store); absent in unit tests without it. */
  continuity?: ContinuityChannel;
  /** Page title for the segment's identity (truncated). */
  pageTitle?: () => string;
  /**
   * Recorded Interaction processing, run while in `processing` (before `ready`). Receives the
   * completed recording and the index of the segment recorded by this (still open) document.
   */
  process?: (recording: RecordingSessionResult, localIndex: number) => void;
}

export type CommandResult = { ok: true; snapshot: SessionSnapshot } | { ok: false; error: HeatGridError };

let sessionCounter = 0;

export class SessionController {
  private state: SessionState = 'idle';
  private sessionId: string | null = null;
  private summary: SessionSummary | null = null;
  private result: SessionSnapshot['result'] = null;
  private recorder: Recorder | null = null;
  private capture: SessionCapture | null = null;
  /** Tab-level recording: this document's segment index and totals of earlier pages. */
  private segmentIndex = 0;
  private prior: PriorTotals = NO_PRIOR;
  private continuityState: 'continuous' | 'interrupted' = 'continuous';
  private recordingSession: RecordingSessionResult | null = null;
  private error: HeatGridError | null = null;
  private tickHandle: unknown = null;
  private disposed = false;

  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.clearIntervalFn =
      deps.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>));
  }

  snapshot(): SessionSnapshot {
    return {
      buildId: this.deps.buildId,
      state: this.state,
      sessionId: this.sessionId,
      summary: this.summary ? { ...this.liveSummary(this.summary) } : null,
      result: this.result,
      error: this.error,
      recording: this.recordingInfo(),
    };
  }

  private recordingInfo(): SessionSnapshot['recording'] {
    if (this.state === 'idle' || !this.sessionId) return null;
    const pages = this.recordingSession ? this.recordingSession.segments.length : this.prior.pages + 1;
    return { segmentCount: pages, currentSegmentIndex: this.segmentIndex, continuity: this.continuityState };
  }

  start(): CommandResult {
    const guard = this.apply('START');
    if (guard) return guard;

    // A new Record replaces any previous session.
    this.stopTicker();
    this.dropRecorder();
    sessionCounter += 1;
    const sessionId = `s${this.now().toString(36)}-${sessionCounter}`;
    const r = this.beginSegment({ sessionId, startedAt: this.now(), segmentIndex: 0, prior: NO_PRIOR, continuity: 'continuous' });
    if (r.ok) this.deps.continuity?.begin(sessionId, this.summary!.startedAt);
    return r;
  }

  /**
   * A new document continues the tab's recording (sent by the service worker after a full
   * navigation). Idempotent: already recording this session → no-op. Never runs Prediction.
   */
  resume(p: ResumePayload): CommandResult {
    if (this.state === 'recording' && this.sessionId === p.sessionId) return { ok: true, snapshot: this.snapshot() };
    const guard = this.apply('START');
    if (guard) return guard;
    this.stopTicker();
    this.dropRecorder();
    return this.beginSegment(p);
  }

  private beginSegment(p: ResumePayload): CommandResult {
    this.sessionId = p.sessionId;
    this.segmentIndex = p.segmentIndex;
    this.prior = p.prior;
    this.continuityState = p.continuity;
    this.recordingSession = null;
    this.summary = null;
    this.result = null;
    this.error = null;
    this.emitState();
    try {
      this.recorder = this.deps.createRecorder?.() ?? null;
      this.summary = { startedAt: p.startedAt, endedAt: null, elapsedMs: 0, activeMs: 0, clicks: 0, scrollDepth: 0 };
      this.apply('PREPARED');
      this.startTicker();
      this.emitState();
    } catch (e) {
      return this.fail(e);
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  /**
   * The document is going away (pagehide) while recording: finalize this page segment ONCE and
   * hand it to the service worker. The tab's recording continues on the next document.
   * Silent (no state event: the next document reports state). Returns the segment, or null when
   * not recording (so repeated lifecycle signals never produce a second segment).
   */
  handoff(): PageCaptureSegment | null {
    if (this.state !== 'recording' || !this.recorder || !this.sessionId) return null;
    this.stopTicker();
    const seg = toSegment(this.recorder.stop(), { sessionId: this.sessionId, index: this.segmentIndex, title: this.deps.pageTitle?.() ?? '' });
    this.dropRecorder();
    this.state = 'idle';
    this.sessionId = null;
    this.summary = null;
    this.deps.continuity?.segment(seg);
    return seg;
  }

  stop(): CommandResult {
    const guard = this.apply('STOP');
    if (guard) return guard;

    this.stopTicker();
    // Close dwell / hover / exposure / active time and detach listeners before "processing".
    let capture: SessionCapture | null = null;
    try {
      capture = this.recorder?.stop() ?? null;
    } catch (e) {
      return this.fail(e);
    }
    const endedAt = this.now();
    if (this.summary) {
      const elapsedMs = endedAt - this.summary.startedAt;
      const s = capture ? summarizeCapture(capture) : null;
      this.summary = s
        ? { ...this.summary, endedAt, elapsedMs, activeMs: this.prior.activeMs + s.activeMs, clicks: this.prior.clicks + this.prior.activations + s.clicks + s.activations, scrollDepth: s.deepestScroll ?? 0 }
        : { ...this.summary, endedAt, elapsedMs, activeMs: elapsedMs };
    }
    this.capture = capture;
    this.emitState();

    const sessionId = this.sessionId!;
    const current = capture ? toSegment(capture, { sessionId, index: this.segmentIndex, title: this.deps.pageTitle?.() ?? '' }) : null;
    const channel = this.deps.continuity;
    if (current && channel && this.prior.pages > 0) {
      // Earlier pages live in the service worker's session storage: collect them (async), then finish.
      channel
        .collect(sessionId)
        .catch(() => null)
        .then((prev) => {
          if (this.state === 'processing' && this.sessionId === sessionId) this.finishStop(current, prev?.segments ?? [], prev?.limitations ?? [], endedAt);
        });
      return { ok: true, snapshot: this.snapshot() };
    }
    if (current) channel?.clear(sessionId);
    return this.finishStop(current, [], [], endedAt);
  }

  private finishStop(current: PageCaptureSegment | null, earlier: PageCaptureSegment[], limitations: SessionLimitationCode[], endedAt: number): CommandResult {
    try {
      if (current) {
        const budget = enforceBudget([...earlier, current]);
        const lims: SessionLimitationCode[] = [...limitations];
        if (this.continuityState === 'interrupted' && !lims.includes('RECORDING_INTERRUPTED_UNSUPPORTED_PAGE')) lims.push('RECORDING_INTERRUPTED_UNSUPPORTED_PAGE');
        if (budget.coarsened && !lims.includes('MULTI_PAGE_SESSION_COARSENED')) lims.push('MULTI_PAGE_SESSION_COARSENED');
        this.recordingSession = { sessionId: this.sessionId!, startedAt: this.summary?.startedAt ?? endedAt, endedAt, segments: budget.segments, limitations: lims };
        this.result = budget.segments.length > 1 || lims.length ? sessionSummary(this.recordingSession) : summarizeCapture(this.capture!);
        this.deps.process?.(this.recordingSession, this.segmentIndex);
      } else {
        this.result = { kind: 'placeholder', note: 'No recorder attached: session lifecycle only.' };
      }
      this.apply('PROCESSED');
      this.emitState();
    } catch (e) {
      return this.fail(e);
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  /** The completed recording (all page segments), or null. Runtime memory only. */
  getRecordingSession(): RecordingSessionResult | null {
    return this.recordingSession;
  }

  clear(): CommandResult {
    const guard = this.apply('CLEAR');
    if (guard) return guard;

    this.stopTicker();
    this.dropRecorder();
    if (this.sessionId) this.deps.continuity?.clear(this.sessionId);
    this.recordingSession = null;
    this.prior = NO_PRIOR;
    this.segmentIndex = 0;
    this.continuityState = 'continuous';
    this.sessionId = null;
    this.summary = null;
    this.result = null;
    this.error = null;
    this.emitState();
    return { ok: true, snapshot: this.snapshot() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTicker();
    this.dropRecorder();
  }

  /** The finished capture (runtime memory only), or null. */
  getCapture(): SessionCapture | null {
    return this.capture;
  }

  private dropRecorder(): void {
    this.recorder?.dispose();
    this.recorder = null;
    this.capture = null;
  }

  // -------------------------------------------------------------------------

  /** Applies an action; returns a failed CommandResult if the transition is invalid. */
  private apply(action: SessionAction): CommandResult | null {
    if (this.disposed) {
      return { ok: false, error: makeError('INVALID_STATE', 'Runtime has been disposed', false) };
    }
    const t = transition(this.state, action);
    if (!t.ok) return { ok: false, error: t.error };
    this.state = t.next;
    return null;
  }

  private fail(e: unknown): CommandResult {
    this.stopTicker();
    this.dropRecorder();
    const error = makeError('INTERNAL', e instanceof Error ? e.message : String(e));
    this.apply('FAIL');
    this.error = error;
    this.emitState();
    return { ok: false, error };
  }

  private liveSummary(summary: SessionSummary): SessionSummary {
    if (this.state !== 'recording') return summary;
    const elapsedMs = this.now() - summary.startedAt;
    if (!this.recorder) return { ...summary, elapsedMs, activeMs: elapsedMs };
    const live = this.recorder.live();
    const p = this.prior;
    return { ...summary, elapsedMs, activeMs: Math.round(p.activeMs + live.activeMs), clicks: p.clicks + p.activations + live.clicks, scrollDepth: Math.round(live.deepestScroll * 1000) / 1000 };
  }

  private startTicker(): void {
    this.stopTicker();
    this.tickHandle = this.setIntervalFn(() => {
      if (this.state !== 'recording' || !this.summary || !this.sessionId) return;
      this.deps.emit(
        makeEvent('SESSION_TICK', { sessionId: this.sessionId, summary: this.liveSummary(this.summary) }),
      );
    }, SESSION_TICK_MS);
  }

  private stopTicker(): void {
    if (this.tickHandle !== null) {
      this.clearIntervalFn(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private emitState(): void {
    this.deps.onStateChange(this.snapshot());
  }
}
