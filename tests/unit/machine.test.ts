import { describe, expect, it } from 'vitest';
import { transition } from '../../src/content/machine';
import { SESSION_STATES } from '../../src/shared/model';

describe('session state machine', () => {
  const step = (from: Parameters<typeof transition>[0], action: Parameters<typeof transition>[1]) => {
    const r = transition(from, action);
    if (!r.ok) throw new Error(r.error.message);
    return r.next;
  };

  it('idle → preparing → recording', () => {
    expect(step('idle', 'START')).toBe('preparing');
    expect(step('preparing', 'PREPARED')).toBe('recording');
  });

  it('recording → processing → ready', () => {
    expect(step('recording', 'STOP')).toBe('processing');
    expect(step('processing', 'PROCESSED')).toBe('ready');
  });

  it('ready → Record → recording (replaces session)', () => {
    expect(step(step('ready', 'START'), 'PREPARED')).toBe('recording');
  });

  it('error → Record retries', () => {
    expect(step('error', 'START')).toBe('preparing');
  });

  it.each(['idle', 'recording', 'ready', 'error'] as const)('Clear from %s → idle', (s) => {
    expect(step(s, 'CLEAR')).toBe('idle');
  });

  it('Clear is rejected during transient states', () => {
    expect(transition('preparing', 'CLEAR').ok).toBe(false);
    expect(transition('processing', 'CLEAR').ok).toBe(false);
  });

  it('Stop from idle is INVALID_STATE', () => {
    const r = transition('idle', 'STOP');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATE');
  });

  it('Start while recording is INVALID_STATE', () => {
    const r = transition('recording', 'START');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATE');
  });

  it('FAIL only from transient states', () => {
    expect(step('preparing', 'FAIL')).toBe('error');
    expect(step('processing', 'FAIL')).toBe('error');
    for (const s of SESSION_STATES.filter((x) => x !== 'preparing' && x !== 'processing')) {
      expect(transition(s, 'FAIL').ok).toBe(false);
    }
  });
});
