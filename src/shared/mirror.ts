/**
 * Pure helpers for the service worker's storage.session lifecycle mirror.
 * The mirror is a fallback only; the content runtime is authoritative while alive.
 */
import { ACTIVE_STATES, type EndedReason, type LifecycleMirror, type TabSnapshot } from './model';
import { MIRROR_KEY_PREFIX } from './constants';

export function mirrorKey(tabId: number): string {
  return `${MIRROR_KEY_PREFIX}${tabId}`;
}

/**
 * Builds the mirror entry for a tab snapshot, or null when nothing needs mirroring
 * (session idle and no prediction). Only lightweight state — never a PredictionResult.
 */
export function mirrorFromSnapshot(tabId: number, tab: TabSnapshot, now: number): LifecycleMirror | null {
  const session = tab.session;
  const prediction = tab.prediction.state === 'idle' ? null : { state: tab.prediction.state, predictionId: tab.prediction.predictionId };
  if (session.state === 'idle' && !prediction) return null;
  return {
    tabId,
    state: session.state,
    endedReason: null,
    sessionId: session.sessionId,
    startedAt: session.summary?.startedAt ?? null,
    summary: session.summary,
    prediction,
    updatedAt: now,
  };
}

/** A runtime-backed session exists that navigation would destroy. */
export function shouldEndOnNavigation(mirror: LifecycleMirror | null | undefined): boolean {
  return !!mirror && mirror.state !== 'ended' && (ACTIVE_STATES as readonly string[]).includes(mirror.state);
}

export function markEnded(mirror: LifecycleMirror, reason: EndedReason, now: number): LifecycleMirror {
  // A prediction lives in the runtime; it is gone with it.
  return { ...mirror, state: 'ended', endedReason: reason, prediction: null, updatedAt: now };
}

/**
 * Mirror update when the content runtime is gone (navigation/reload). An active session is marked
 * ended; a prediction-only entry is dropped (nothing to recover).
 */
export function onRuntimeGone(mirror: LifecycleMirror | null, reason: EndedReason, now: number): { next: LifecycleMirror | null; sessionEnded: boolean } {
  if (!mirror) return { next: null, sessionEnded: false };
  if (shouldEndOnNavigation(mirror)) return { next: markEnded(mirror, reason, now), sessionEnded: true };
  // Session already ended earlier: keep its record, drop any prediction.
  if (mirror.state === 'ended') return { next: mirror.prediction ? { ...mirror, prediction: null, updatedAt: now } : mirror, sessionEnded: false };
  return { next: null, sessionEnded: false };
}
