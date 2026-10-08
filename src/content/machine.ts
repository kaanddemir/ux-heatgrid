/**
 * Pure session state machine. No timers, no chrome APIs — fully unit-testable.
 */
import { makeError, type HeatGridError, type SessionState } from '../shared/model';

export type SessionAction = 'START' | 'PREPARED' | 'STOP' | 'PROCESSED' | 'CLEAR' | 'FAIL';

const TRANSITIONS: Record<SessionAction, Partial<Record<SessionState, SessionState>>> = {
  // Record from idle, from a finished session (replaces it), or to retry after an error.
  START: { idle: 'preparing', ready: 'preparing', error: 'preparing' },
  PREPARED: { preparing: 'recording' },
  STOP: { recording: 'processing' },
  PROCESSED: { processing: 'ready' },
  // Clear is allowed from every stable state; transient states must finish first.
  CLEAR: { idle: 'idle', recording: 'idle', ready: 'idle', error: 'idle' },
  FAIL: { preparing: 'error', processing: 'error' },
};

export type TransitionResult = { ok: true; next: SessionState } | { ok: false; error: HeatGridError };

export function transition(state: SessionState, action: SessionAction): TransitionResult {
  const next = TRANSITIONS[action][state];
  if (next === undefined) {
    return { ok: false, error: makeError('INVALID_STATE', `Cannot ${action} while ${state}`) };
  }
  return { ok: true, next };
}

export function canTransition(state: SessionState, action: SessionAction): boolean {
  return TRANSITIONS[action][state] !== undefined;
}
