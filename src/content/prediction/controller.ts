/**
 * PredictionController — owns the tab's prediction state and last result (runtime memory only).
 * Independent of SessionController: Record never triggers, waits for or clears a prediction.
 * No DOM logic here (the analyzer measures, the stale watcher observes) and no UI advice.
 */
import type { PageAnalyzer } from '../analyzer';
import { makeError, type HeatGridError, type PredictionSnapshot, type PredictionState, type StaleReason } from '../../shared/model';
import { makeEvent, type EventEnvelope } from '../../shared/protocol';
import { predict } from './engine';
import { predictionTransition, type PredictionAction } from './machine';
import type { StaleWatcher } from './stale';
import type { PredictionResult } from './types';

export interface PredictionControllerDeps {
  analyzer: Pick<PageAnalyzer, 'analyze' | 'invalidate'>;
  emit: (event: EventEnvelope) => void;
  /** Called after every state change (the runtime emits the combined TabSnapshot). */
  onStateChange: () => void;
  /** Factory for the stale watcher (injected so tests need no DOM observers). */
  createWatcher?: (onStale: (reason: StaleReason) => void) => StaleWatcher;
  now?: () => number;
  clock?: () => number;
}

export type PredictionCommandResult = { ok: true } | { ok: false; error: HeatGridError };

export class PredictionController {
  private state: PredictionState = 'idle';
  private result: PredictionResult | null = null;
  private staleReason: StaleReason | null = null;
  private error: HeatGridError | null = null;
  private disposed = false;
  private readonly watcher: StaleWatcher | null;
  private readonly now: () => number;
  private readonly clock: () => number;

  constructor(private readonly deps: PredictionControllerDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.clock = deps.clock ?? Date.now;
    this.watcher = deps.createWatcher ? deps.createWatcher((reason) => this.markStale(reason)) : null;
  }

  snapshot(): PredictionSnapshot {
    return {
      state: this.state,
      predictionId: this.result?.predictionId ?? null,
      predictorId: this.result?.predictorId ?? null,
      createdAt: this.result?.createdAt ?? null,
      summary: this.result ? { ...this.result.summary } : null,
      staleReason: this.staleReason,
      error: this.error,
    };
  }

  getResult(): PredictionResult | null {
    return this.result;
  }

  /** Runs a fresh prediction. Always re-measures: the user's explicit action defines "now". */
  run(): PredictionCommandResult {
    const guard = this.apply('RUN');
    if (guard) return guard;
    this.watcher?.disarm();
    this.error = null;
    this.staleReason = null;
    this.deps.onStateChange();
    try {
      this.deps.analyzer.invalidate('manual');
      const t0 = this.now();
      const analysis = this.deps.analyzer.analyze({ mode: 'full' });
      const analysisMs = this.now() - t0;
      this.result = predict(analysis, { analysisMs, createdAt: this.clock(), now: this.now });
      this.apply('DONE');
      this.watcher?.arm();
      this.deps.emit(makeEvent('PREDICTION_READY', { predictionId: this.result.predictionId, summary: { ...this.result.summary } }));
      this.deps.onStateChange();
      return { ok: true };
    } catch (e) {
      this.result = null;
      this.error = makeError('INTERNAL', e instanceof Error ? e.message : String(e));
      this.apply('FAIL');
      this.deps.onStateChange();
      return { ok: false, error: this.error };
    }
  }

  clear(): PredictionCommandResult {
    const guard = this.apply('CLEAR');
    if (guard) return guard;
    this.watcher?.disarm();
    this.result = null;
    this.staleReason = null;
    this.error = null;
    this.deps.onStateChange();
    return { ok: true };
  }

  /** Marks a ready prediction stale. Never recomputes. */
  markStale(reason: StaleReason): void {
    if (this.disposed || this.state !== 'ready') return;
    this.apply('STALE');
    this.staleReason = reason;
    this.watcher?.disarm();
    this.deps.onStateChange();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.result = null;
  }

  private apply(action: PredictionAction): PredictionCommandResult | null {
    if (this.disposed) return { ok: false, error: makeError('INVALID_STATE', 'Prediction controller disposed') };
    const r = predictionTransition(this.state, action);
    if (!r.ok) return r;
    this.state = r.next;
    return null;
  }
}
