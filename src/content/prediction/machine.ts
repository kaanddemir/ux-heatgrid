/**
 * Prediction state machine (pure). Independent of the session machine.
 *
 *   idle | ready | stale | error ──RUN──▶ analyzing ──DONE──▶ ready ──STALE──▶ stale
 *                                        analyzing ──FAIL──▶ error
 *   idle | ready | stale | error ──CLEAR──▶ idle
 */
import { makeError, type HeatGridError, type PredictionState } from '../../shared/model';

export type PredictionAction = 'RUN' | 'DONE' | 'FAIL' | 'STALE' | 'CLEAR';

const TRANSITIONS: Record<PredictionAction, Partial<Record<PredictionState, PredictionState>>> = {
  RUN: { idle: 'analyzing', ready: 'analyzing', stale: 'analyzing', error: 'analyzing' },
  DONE: { analyzing: 'ready' },
  FAIL: { analyzing: 'error' },
  STALE: { ready: 'stale' },
  CLEAR: { idle: 'idle', ready: 'idle', stale: 'idle', error: 'idle' },
};

export function predictionTransition(
  from: PredictionState,
  action: PredictionAction,
): { ok: true; next: PredictionState } | { ok: false; error: HeatGridError } {
  const next = TRANSITIONS[action][from];
  return next ? { ok: true, next } : { ok: false, error: makeError('INVALID_STATE', `Cannot ${action} prediction while ${from}`) };
}
