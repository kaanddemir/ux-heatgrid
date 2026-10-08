// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { PredictionController } from '../../src/content/prediction/controller';
import { predictionTransition } from '../../src/content/prediction/machine';
import { classifyMutations, createStaleWatcher, DEBOUNCE_MS, isMaterialResize, LARGE_CHANGE_NODES } from '../../src/content/prediction/stale';
import { createTabRuntime } from '../../src/content/tabRuntime';
import type { StaleReason, TabSnapshot } from '../../src/shared/model';
import { makeRequest, type EventEnvelope, type RequestEnvelope } from '../../src/shared/protocol';
import { fixtureReader, mount } from '../helpers/fixtureReader';
import { pages } from '../fixtures/predictionPages';

describe('prediction state machine', () => {
  const ok = (from: Parameters<typeof predictionTransition>[0], a: Parameters<typeof predictionTransition>[1]) => {
    const r = predictionTransition(from, a);
    return r.ok ? r.next : null;
  };
  it('valid transitions', () => {
    expect(ok('idle', 'RUN')).toBe('analyzing');
    expect(ok('analyzing', 'DONE')).toBe('ready');
    expect(ok('analyzing', 'FAIL')).toBe('error');
    expect(ok('ready', 'STALE')).toBe('stale');
    expect(ok('stale', 'RUN')).toBe('analyzing');
    expect(ok('ready', 'RUN')).toBe('analyzing');
    for (const s of ['idle', 'ready', 'stale', 'error'] as const) expect(ok(s, 'CLEAR')).toBe('idle');
  });
  it('invalid transitions are INVALID_STATE', () => {
    expect(ok('analyzing', 'RUN')).toBeNull();
    expect(ok('analyzing', 'CLEAR')).toBeNull();
    expect(ok('idle', 'STALE')).toBeNull();
    expect(ok('stale', 'STALE')).toBeNull();
    const r = predictionTransition('idle', 'DONE');
    expect(!r.ok && r.error.code).toBe('INVALID_STATE');
  });
});

function setupController(analyzerOverride?: ConstructorParameters<typeof PredictionController>[0]['analyzer']) {
  mount(pages.landing);
  const analyzer = analyzerOverride ?? createPageAnalyzer({ reader: fixtureReader({ docHeight: 2200 }) });
  const events: EventEnvelope[] = [];
  const states: string[] = [];
  let staleCb: ((r: StaleReason) => void) | null = null;
  const watcher = { arm: vi.fn(), disarm: vi.fn(), dispose: vi.fn() };
  const c: PredictionController = new PredictionController({
    analyzer,
    emit: (e) => events.push(e),
    onStateChange: () => states.push(c.snapshot().state),
    createWatcher: (cb) => ((staleCb = cb), watcher),
    clock: () => 42,
  });
  return { c, events, states, watcher, stale: (r: StaleReason) => staleCb!(r) };
}

describe('PredictionController', () => {
  it('run: analyzing → ready, stores result, emits PREDICTION_READY, arms stale watcher', () => {
    const { c, events, states, watcher } = setupController();
    expect(c.run()).toEqual({ ok: true });
    expect(states).toEqual(['analyzing', 'ready']);
    const snap = c.snapshot();
    expect(snap).toMatchObject({ state: 'ready', predictorId: 'heuristic-v1', createdAt: 42, staleReason: null, error: null });
    expect(snap.summary!.assessed).toBeGreaterThan(0);
    expect(c.getResult()!.predictionId).toBe(snap.predictionId);
    expect(events.map((e) => e.type)).toEqual(['PREDICTION_READY']);
    expect(watcher.arm).toHaveBeenCalledTimes(1);
  });

  it('re-run is deterministic for the same page', () => {
    const { c } = setupController();
    c.run();
    const a = c.getResult()!;
    c.run();
    const b = c.getResult()!;
    expect(b.layoutVersion).toBeGreaterThan(a.layoutVersion); // always re-measured
    expect(b.elements.map((e) => [e.elementRef.id, e.band, e.score])).toEqual(a.elements.map((e) => [e.elementRef.id, e.band, e.score]));
  });

  it('stale: ready → stale with reason and one state change; never recomputes', () => {
    const { c, events, states, watcher } = setupController();
    c.run();
    const id = c.getResult()!.predictionId;
    s(c);
    function s(ctrl: PredictionController) {
      ctrl.markStale('dom-change');
    }
    expect(c.snapshot()).toMatchObject({ state: 'stale', staleReason: 'dom-change', predictionId: id });
    expect(states.at(-1)).toBe('stale');
    expect(watcher.disarm).toHaveBeenCalled();
    c.markStale('resize'); // already stale: no-op
    expect(states.filter((x) => x === 'stale')).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['PREDICTION_READY']); // stale reaches the panel via STATE_CHANGED
    expect(c.getResult()!.predictionId).toBe(id); // result kept, not recomputed
  });

  it('watcher callback marks stale', () => {
    const { c, stale } = setupController();
    c.run();
    stale('same-document-navigation');
    expect(c.snapshot().state).toBe('stale');
  });

  it('clear drops the result; invalid clear while idle is allowed (idempotent)', () => {
    const { c } = setupController();
    c.run();
    expect(c.clear()).toEqual({ ok: true });
    expect(c.snapshot()).toMatchObject({ state: 'idle', predictionId: null, summary: null });
    expect(c.getResult()).toBeNull();
  });

  it('analyzer failure → error state with typed error; run again recovers', () => {
    let fail = true;
    const real = createPageAnalyzer({ reader: fixtureReader() });
    const { c } = setupController({
      invalidate: real.invalidate,
      analyze: ((o?: unknown) => {
        if (fail) throw new Error('boom');
        return real.analyze(o as never);
      }) as never,
    });
    expect(c.run().ok).toBe(false);
    expect(c.snapshot()).toMatchObject({ state: 'error', error: { code: 'INTERNAL' } });
    fail = false;
    expect(c.run().ok).toBe(true);
    expect(c.snapshot().state).toBe('ready');
  });

  it('dispose blocks further runs', () => {
    const { c, watcher } = setupController();
    c.dispose();
    expect(c.run().ok).toBe(false);
    expect(watcher.dispose).toHaveBeenCalled();
  });
});

describe('TabRuntime (protocol v2)', () => {
  function setup() {
    mount(pages.landing);
    const events: EventEnvelope[] = [];
    let t = 1000;
    const timers = new Map<number, () => void>();
    let next = 1;
    const rt = createTabRuntime({
      buildId: 'test',
      emit: (e) => events.push(e),
      analyzer: createPageAnalyzer({ reader: fixtureReader({ docHeight: 2200 }) }),
      now: () => t,
      clock: () => 7,
      setInterval: (fn) => {
        const id = next++;
        timers.set(id, fn);
        return id;
      },
      clearInterval: (id) => timers.delete(id as number),
    });
    const call = <T extends Parameters<typeof makeRequest>[0]>(type: T, payload: Parameters<typeof makeRequest<T>>[1]) =>
      rt.handle(makeRequest(type, payload) as RequestEnvelope);
    const snaps = () => events.filter((e): e is EventEnvelope<'STATE_CHANGED'> => e.type === 'STATE_CHANGED').map((e) => e.payload.snapshot);
    return { rt, call, events, snaps, advance: (ms: number) => (t += ms) };
  }

  it('GET_STATE returns a combined TabSnapshot', () => {
    const { call } = setup();
    const r = call('GET_STATE', null);
    expect(r.ok && (r.data as TabSnapshot)).toMatchObject({ buildId: 'test', session: { state: 'idle' }, prediction: { state: 'idle' }, interactionView: 'none' });
  });

  it('Record does not trigger, require or clear Prediction', () => {
    const { call, snaps } = setup();
    call('START_SESSION', { source: 'sidepanel' });
    expect(snaps().every((s) => s.prediction.state === 'idle')).toBe(true);
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const predId = (call('GET_STATE', null) as { ok: true; data: TabSnapshot }).data.prediction.predictionId;
    expect(predId).not.toBeNull();
    call('STOP_SESSION', null);
    call('CLEAR_SESSION', null);
    call('START_SESSION', { source: 'sidepanel' });
    const s = (call('GET_STATE', null) as { ok: true; data: TabSnapshot }).data;
    expect(s.session.state).toBe('recording');
    expect(s.prediction).toMatchObject({ state: 'ready', predictionId: predId });
  });

  it('Prediction does not require or touch a session', () => {
    const { call } = setup();
    const r = call('RUN_PREDICTION', { source: 'sidepanel' });
    expect(r.ok && (r.data as TabSnapshot).session.state).toBe('idle');
    call('CLEAR_PREDICTION', null);
    const s = (call('GET_STATE', null) as { ok: true; data: TabSnapshot }).data;
    expect(s.session.state).toBe('idle');
    expect(s.prediction.state).toBe('idle');
  });

  it('every state change emits STATE_CHANGED with the combined snapshot', () => {
    const { call, snaps, events } = setup();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    expect(snaps().map((s) => s.prediction.state)).toEqual(['analyzing', 'ready']);
    expect(events.some((e) => e.type === 'PREDICTION_READY')).toBe(true);
    call('START_SESSION', { source: 'sidepanel' });
    expect(snaps().slice(-2).map((s) => [s.session.state, s.prediction.state])).toEqual([['preparing', 'ready'], ['recording', 'ready']]);
  });

  it('GET_PREDICTION returns the lightweight summary or null', () => {
    const { call } = setup();
    expect(call('GET_PREDICTION', null)).toEqual({ ok: true, data: null });
    call('RUN_PREDICTION', { source: 'sidepanel' });
    const r = call('GET_PREDICTION', null);
    expect(r.ok && (r.data as { predictorId: string }).predictorId).toBe('heuristic-v1');
    expect(JSON.stringify(r.ok && r.data)).not.toContain('contributions');
  });

  it('invalid prediction commands return INVALID_STATE', () => {
    const { rt } = setup();
    rt.dispose();
    const r = rt.handle(makeRequest('RUN_PREDICTION', { source: 'sidepanel' }) as RequestEnvelope);
    expect(!r.ok && r.error.code).toBe('INVALID_STATE');
  });

  it('hasActiveSession tracks only the session', () => {
    const { rt, call } = setup();
    call('RUN_PREDICTION', { source: 'sidepanel' });
    expect(rt.hasActiveSession()).toBe(false);
    call('START_SESSION', { source: 'sidepanel' });
    expect(rt.hasActiveSession()).toBe(true);
  });
});

describe('stale detection', () => {
  afterEach(() => vi.useRealTimers());
  /** Real timers: the test DOM delivers MutationObserver records asynchronously. */
  const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 150));

  const added = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return { type: 'childList', target: document.body, addedNodes: [d], removedNodes: [] as Node[] };
  };

  it('classifies material DOM changes', () => {
    expect(classifyMutations([added('<button>x</button>')]).material).toBe(true);
    expect(classifyMutations([added('<span>text</span>')]).material).toBe(false);
    const many = Array.from({ length: LARGE_CHANGE_NODES }, () => added('<span>x</span>'));
    expect(classifyMutations(many).material).toBe(true);
    const btn = document.createElement('button');
    expect(classifyMutations([{ type: 'attributes', target: btn, attributeName: 'disabled', addedNodes: [], removedNodes: [] }]).material).toBe(true);
    const span = document.createElement('span');
    expect(classifyMutations([{ type: 'attributes', target: span, attributeName: 'hidden', addedNodes: [], removedNodes: [] }]).material).toBe(false);
  });

  it('resize threshold', () => {
    expect(isMaterialResize({ width: 1000, height: 800 }, { width: 1100, height: 800 })).toBe(false);
    expect(isMaterialResize({ width: 1000, height: 800 }, { width: 700, height: 800 })).toBe(true);
    expect(isMaterialResize({ width: 1000, height: 800 }, { width: 1000, height: 500 })).toBe(true);
  });

  it('watcher: debounced DOM change → one stale callback; then it is disarmed', async () => {
    mount('<main><button>a</button></main>');
    const reasons: string[] = [];
    const w = createStaleWatcher((r) => reasons.push(r));
    w.arm();
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button>b</button>');
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button>c</button>');
    await settle();
    expect(reasons).toEqual(['dom-change']);
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button>d</button>');
    await settle();
    expect(reasons).toEqual(['dom-change']);
    w.dispose();
  });

  it('watcher ignores non-material churn (class/style changes, text edits)', async () => {
    mount('<main><p id="p">a</p><button id="b">x</button></main>');
    const reasons: string[] = [];
    const w = createStaleWatcher((r) => reasons.push(r));
    w.arm();
    document.getElementById('b')!.className = 'hover';
    document.getElementById('b')!.setAttribute('style', 'color: red');
    document.getElementById('p')!.textContent = 'changed';
    await settle();
    expect(reasons).toEqual([]);
    // Sanity: the same watcher does observe a material change (so the silence above is real).
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<a href="/x">x</a>');
    await settle();
    expect(reasons).toEqual(['dom-change']);
    w.dispose();
  });

  it('watcher: disabling a control is material', async () => {
    mount('<main><button id="b">x</button></main>');
    const reasons: string[] = [];
    const w = createStaleWatcher((r) => reasons.push(r));
    w.arm();
    document.getElementById('b')!.setAttribute('disabled', '');
    await settle();
    expect(reasons).toEqual(['dom-change']);
    w.dispose();
  });

  it('watcher: same-document navigation', async () => {
    mount('<main></main>');
    const reasons: string[] = [];
    const w = createStaleWatcher((r) => reasons.push(r));
    w.arm();
    history.pushState({}, '', '/other-route');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    expect(reasons).toEqual(['same-document-navigation']);
    w.dispose();
  });

  it('a disarmed watcher observes nothing', async () => {
    mount('<main></main>');
    const reasons: string[] = [];
    const w = createStaleWatcher((r) => reasons.push(r));
    w.arm();
    w.disarm();
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<button>b</button>');
    await settle();
    expect(reasons).toEqual([]);
  });
});
