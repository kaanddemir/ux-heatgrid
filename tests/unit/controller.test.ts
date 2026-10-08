import { describe, expect, it } from 'vitest';
import { SessionController } from '../../src/content/controller';
import type { SessionState } from '../../src/shared/model';
import type { EventEnvelope } from '../../src/shared/protocol';

function setup() {
  let now = 1_000;
  const events: EventEnvelope[] = [];
  const stateLog: SessionState[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const controller = new SessionController({
    buildId: 'test',
    emit: (e) => events.push(e),
    onStateChange: (snap) => stateLog.push(snap.state),
    now: () => now,
    setInterval: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id as number),
  });
  const tick = (ms: number) => {
    now += ms;
    for (const fn of timers.values()) fn();
  };
  const states = () => stateLog;
  return { controller, events, timers, tick, states };
}

describe('SessionController (Phase 1 stub)', () => {
  it('start emits preparing then recording and starts a ticker', () => {
    const { controller, states, timers } = setup();
    const r = controller.start();
    expect(r.ok).toBe(true);
    expect(states()).toEqual(['preparing', 'recording']);
    expect(timers.size).toBe(1);
    expect(controller.snapshot().summary?.startedAt).toBe(1_000);
  });

  it('emits SESSION_TICK with elapsed time while recording', () => {
    const { controller, events, tick } = setup();
    controller.start();
    tick(1_000);
    tick(1_000);
    const ticks = events.filter((e): e is EventEnvelope<'SESSION_TICK'> => e.type === 'SESSION_TICK');
    expect(ticks.map((t) => t.payload.summary.elapsedMs)).toEqual([1_000, 2_000]);
  });

  it('stop goes processing → ready with a placeholder result and stops ticking', () => {
    const { controller, states, timers, tick } = setup();
    controller.start();
    tick(3_000);
    const r = controller.stop();
    expect(r.ok).toBe(true);
    expect(states()).toEqual(['preparing', 'recording', 'processing', 'ready']);
    expect(timers.size).toBe(0);
    const snap = controller.snapshot();
    expect(snap.result?.kind).toBe('placeholder');
    expect(snap.summary?.elapsedMs).toBe(3_000);
    expect(snap.summary?.endedAt).toBe(4_000);
  });

  it('record from ready replaces the previous session', () => {
    const { controller } = setup();
    controller.start();
    controller.stop();
    const first = controller.snapshot().sessionId;
    controller.start();
    const snap = controller.snapshot();
    expect(snap.state).toBe('recording');
    expect(snap.sessionId).not.toBe(first);
    expect(snap.result).toBeNull();
  });

  it('clear resets to idle and drops session data', () => {
    const { controller, timers } = setup();
    controller.start();
    const r = controller.clear();
    expect(r.ok).toBe(true);
    expect(timers.size).toBe(0);
    expect(controller.snapshot()).toMatchObject({ state: 'idle', sessionId: null, summary: null, result: null });
  });

  it('rejects invalid commands without emitting', () => {
    const { controller, events, states } = setup();
    const r = controller.stop();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATE');
    expect(events).toHaveLength(0);
    expect(states()).toHaveLength(0);
  });

  it('dispose clears timers and blocks further commands', () => {
    const { controller, timers } = setup();
    controller.start();
    controller.dispose();
    expect(timers.size).toBe(0);
    expect(controller.start().ok).toBe(false);
  });
});
