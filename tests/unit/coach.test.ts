/// <reference types="vite/client" />
// @vitest-environment happy-dom
/**
 * Phase 7: HeatGrid Coach — rules, evidence requirements, composition, lint, dedupe,
 * multi-page isolation and the runtime/protocol surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compose, MAX_WORDS, OBSERVATIONS, plan, stableHash } from '../../src/content/coach/composer';
import { runCoach, type CoachInput } from '../../src/content/coach/engine';
import type { PredControl, PredictionEvidence, RecordedEvidence, RecordedPageEvidence, StructControl, StructureEvidence, StructText } from '../../src/content/coach/evidence';
import { BANNED_PATTERNS, bannedIn, wordCount } from '../../src/content/coach/lint';
import { dedupeAndRank } from '../../src/content/coach/rank';
import { RULES } from '../../src/content/coach/rules';
import { STRATEGY_OVERRIDES, STRATEGY_PHRASES } from '../../src/content/coach/strategies';
import type { InsightCandidate } from '../../src/content/coach/types';
import type { RecordedElementStats } from '../../src/content/recorder/types';
import { createPageAnalyzer } from '../../src/content/analyzer';
import { CoachController, toCoachView } from '../../src/content/coach/controller';
import { predict } from '../../src/content/prediction/engine';
import type { PredictionResult } from '../../src/content/prediction/types';
import { PROTOCOL_VERSION, validateRequest } from '../../src/shared/protocol';
import { fixtureReader, mount } from '../helpers/fixtureReader';
import { CATEGORY_COPY, COACH_EMPTY, COACH_INTRO, CAVEAT_COPY, FOCUS_COPY, MODE_COPY } from '../../src/content/coach/copy';

// ---------------------------------------------------------------------------
// Evidence builders
// ---------------------------------------------------------------------------

const ctrl = (id: number, o: Partial<StructControl> = {}): StructControl => ({
  id, label: `Action ${id}`, tagName: 'button', regionId: 1, rect: { x: id * 130, y: 100, width: 120, height: 44 }, shortSide: 44, area: 120 * 44,
  treated: true, styleKey: 'rgb(29, 78, 216)|none|16|600', peersNearby: 4, nearestGap: 10, heuristic: false, ...o,
});
const text = (id: number, o: Partial<StructText> = {}): StructText => ({ id, label: null, tagName: 'p', isControl: false, regionId: 2, contrast: { ratio: 7, target: 4.5, assumedCanvasBase: false }, fontSize: 16, textLength: 200, charsPerLine: 70, lineHeightRatio: 1.5, ...o });
const structure = (o: Partial<StructureEvidence> = {}): StructureEvidence => ({ analysisId: 'a1', viewportHeight: 800, documentHeight: 3000, controls: [], texts: [], regions: [], capped: false, ...o });
const pred = (id: number, o: Partial<PredControl> = {}): PredControl => ({
  id, label: `Action ${id}`, tagName: 'button', regionId: 1, band: 'medium', confidence: 'high', rank: id, raises: [], lowers: [], caveats: [],
  peersNearby: 4, peerStrength: 0.05, strongestInGroup: 0, viewportsDown: 0.2, landmark: 'main', ...o,
});
const prediction = (controls: PredControl[]): PredictionEvidence => ({ predictionId: 'p1', controls, regionLabels: new Map([[1, 'Hero']]), capped: false });
const stat = (ref: number, o: Partial<RecordedElementStats> & { exposureMs?: number; reached?: boolean } = {}): RecordedElementStats => {
  const { exposureMs = 0, reached = true, ...rest } = o;
  const s: RecordedElementStats = { elementRef: ref, tagName: 'button', label: `Control ${ref}`, regionId: 1, hoverEntries: 0, hoverDwellMs: 0, pointerMs: 0, clicks: 0, activations: 0, focusEvents: 0, exposure: { elementRef: ref, reached, exposureMs, maxVisibleRatio: 1 }, hasActiveInteraction: false, ...rest };
  s.hasActiveInteraction = s.hoverEntries + s.clicks + s.activations + s.focusEvents > 0;
  return s;
};
const recPage = (o: Partial<RecordedPageEvidence> = {}): RecordedPageEvidence => ({
  page: 0, path: '/a', activeMs: 40_000, limitations: [], deepestPx: 1600, elements: [], neverReached: [], regionControls: new Map([[1, 6]]), regionLabels: new Map([[1, 'Hero']]), maybeNotClickable: [], ...o,
});
const recorded = (pages: RecordedPageEvidence[], interrupted = false): RecordedEvidence => ({ sessionId: 's1', interrupted, pages });
const input = (o: Partial<CoachInput>): CoachInput => ({ structure: null, prediction: null, recorded: null, ...o });
const rules = (ids: string[]) => RULES.filter((r) => ids.includes(r.id));

// ---------------------------------------------------------------------------

/** Engine vocabulary that must not reach Coach copy. */
const ENGINE_TERMS = /structural|structurally|nearby controls|strongest nearby peer|screens down|predicted (prominence|High|Medium|Low)|\bcontrols?\b|\bregion\b|peers?\b/i;

describe('Coach rules', () => {
  it('structure: dense region and same-treatment hierarchy match; a clear primary removes the hierarchy tension', () => {
    const cs = [1, 2, 3, 4, 5, 6].map((i) => ctrl(i, { nearestGap: 8 }));
    const s = structure({ controls: cs, regions: [{ id: 1, label: 'Toolbar', landmark: null, rect: { x: 0, y: 80, width: 900, height: 80 }, controlIds: cs.map((c) => c.id) }] });
    const r = runCoach(input({ structure: s }));
    expect(r.insights.map((i) => i.category).sort()).toEqual(['DENSITY', 'HIERARCHY']);
    const dense = r.insights.find((i) => i.category === 'DENSITY')!;
    expect(dense.subject).toMatchObject({ kind: 'region', regionId: 1, label: 'Toolbar' });
    expect(dense.observationFacts.find((f) => f.key === 'regionControls')!.value).toBe(6);
    // A distinct, larger primary action: no hierarchy insight.
    const withPrimary = structure({ ...s, controls: [...cs, ctrl(7, { styleKey: 'primary', area: 200 * 56, rect: { x: 0, y: 200, width: 200, height: 56 } })], regions: [{ ...s.regions[0]!, controlIds: [1, 2, 3, 4, 5, 6, 7] }] });
    expect(runCoach(input({ structure: withPrimary })).insights.some((i) => i.category === 'HIERARCHY')).toBe(false);
  });

  it('prediction: similar prominence, crowded competition and strong-but-late; a High control alone produces nothing', () => {
    const p = prediction([
      pred(1, { peersNearby: 5, peerStrength: 0.04 }),
      pred(2, { band: 'low', regionId: 3, peersNearby: 7, peerStrength: -0.4, lowers: ['MANY_COMPETING_CONTROLS', 'WEAKER_THAN_PEERS'] }),
      pred(3, { band: 'high', regionId: 4, viewportsDown: 2.6, raises: ['FILLED_STYLE', 'LARGE_RELATIVE_SIZE'], lowers: ['FAR_DOWN_PAGE'], peersNearby: 0 }),
      pred(4, { band: 'high', regionId: 5, raises: ['FIRST_VIEWPORT', 'FILLED_STYLE', 'STRONGEST_IN_GROUP'], peersNearby: 1 }),
    ]);
    const r = runCoach(input({ prediction: p }));
    const byEl = Object.fromEntries(r.insights.map((i) => [(i.subject as { elementId: number }).elementId, i.category]));
    expect(byEl).toEqual({ 1: 'HIERARCHY', 2: 'COMPETING_CONTROLS', 3: 'PLACEMENT' });
    const h = r.insights.find((i) => i.category === 'HIERARCHY')!;
    expect(h.copy.observation).toMatch(/nearby actions|stand out|emphasis/);
    expect(h.observationFacts.find((f) => f.key === 'peersNearby')!.value).toBe(5); // the number stays in the evidence
    expect(h.strategyCode).toBe('STRENGTHEN_PRIMARY_HIERARCHY');
  });

  it('recorded: in view without interaction (crowded → Separation, otherwise Visibility), all session-scoped', () => {
    const r = runCoach(input({ recorded: recorded([recPage({ elements: [stat(1, { exposureMs: 17_000 }), stat(2, { exposureMs: 9000, regionId: 2 }), stat(3, { exposureMs: 3000 })], regionControls: new Map([[1, 6], [2, 2]]) })]) }));
    const one = r.insights.find((i) => (i.subject as { elementId: number }).elementId === 1)!;
    const two = r.insights.find((i) => (i.subject as { elementId: number }).elementId === 2)!;
    expect(one.category).toBe('SEPARATION');
    expect(one.copy.observation).toMatch(/17 s/);
    expect(one.copy.observation).toMatch(/this session|this recording/);
    expect(one.contextFacts.map((f) => f.key)).toContain('regionControls');
    expect(two.category).toBe('VISIBILITY');
    expect(two.confidence).toBe('medium');
    expect(r.insights.some((i) => (i.subject as { elementId?: number }).elementId === 3)).toBe(false); // 3 s: not enough
  });

  it('recorded: never reached needs a known position below the deepest scroll point; groups of 3+ become one page insight', () => {
    const below = (id: number, docTop?: number) => ({ elementRef: id, tagName: 'a', label: `Link ${id}`, ...(docTop !== undefined ? { docTop } : {}) });
    const single = runCoach(input({ recorded: recorded([recPage({ neverReached: [below(10, 2400), below(11, 900), below(12)] })]) }));
    expect(single.insights.map((i) => [i.category, (i.subject as { elementId: number }).elementId])).toEqual([['SCROLL_PLACEMENT', 10]]);
    expect(single.insights[0]!.copy.observation).toMatch(/not reached|didn’t reach|out of view/i);
    const many = runCoach(input({ recorded: recorded([recPage({ neverReached: [below(10, 2400), below(11, 2600), below(12, 3000)] })]) }));
    expect(many.insights).toHaveLength(1);
    expect(many.insights[0]!.subject.kind).toBe('page');
    expect(many.insights[0]!.copy.observation).toContain('3 actions');
  });

  it('click affordance: maybe-not-clickable spots and sustained hover without activation', () => {
    const r = runCoach(input({ recorded: recorded([recPage({ maybeNotClickable: [{ rootId: 0, x: 300, y: 820, clicks: 2 }], elements: [stat(5, { hoverEntries: 2, hoverDwellMs: 4200, regionId: 9 })] })]) }));
    const spot = r.insights.find((i) => i.subject.kind === 'page')!;
    expect(spot.category).toBe('CLICK_AFFORDANCE');
    expect(spot.copy.observation).toMatch(/doesn’t look clickable|looks clickable/);
    expect(spot.strategyCode).toBe('CLARIFY_INTERACTIVE_AFFORDANCE');
    // User-facing label, no coordinates; the point itself stays for highlighting and markers.
    expect(spot.subject.label).toBe('Unclear click target');
    expect(spot.subject).toMatchObject({ point: { rootId: 0, x: 300, y: 820 } });
    expect(spot.confidence).toBe('high'); // 2 clicks
    const hover = r.insights.find((i) => i.subject.kind === 'element')!;
    expect(hover.category).toBe('CLICK_AFFORDANCE');
    expect(hover.copy.observation).toMatch(/4\.2 s/);
  });

  it('contrast: resolved low contrast matches; unresolved contrast never does; canvas assumption lowers confidence', () => {
    const r = runCoach(input({ structure: structure({ texts: [text(1, { contrast: { ratio: 2.1, target: 4.5, assumedCanvasBase: false } }), text(2, { contrast: null }), text(3, { label: 'Caption', contrast: { ratio: 3.2, target: 4.5, assumedCanvasBase: true } }), text(4)] }) }));
    const ids = r.insights.filter((i) => i.category === 'CONTRAST').map((i) => [(i.subject as { elementId: number }).elementId, i.confidence]);
    expect(ids).toEqual([[1, 'high'], [3, 'medium']]);
  });
});

describe('Coach repetition (Phase 9 real-site finding)', () => {
  it('one rule on identically labelled subjects is one card; a category never exceeds 3 cards; total ≤ 10', () => {
    // Twelve repeated low-contrast paragraphs (e.g. one per product card).
    const texts = Array.from({ length: 12 }, (_, i) => text(i + 1, { contrast: { ratio: 2.1, target: 4.5, assumedCanvasBase: false } }));
    const r = runCoach(input({ structure: structure({ texts }) }));
    const contrast = r.insights.filter((i) => i.category === 'CONTRAST');
    expect(contrast).toHaveLength(1);
    expect(contrast[0]!.debug.mergedFrom.filter((m) => m.endsWith(':repeat'))).toHaveLength(11); // still traceable
    // Distinct labels: capped per category.
    const named = runCoach(input({ structure: structure({ texts: texts.map((t, i) => ({ ...t, label: `Paragraph ${i + 1}` })) }) }));
    expect(named.insights.filter((i) => i.category === 'CONTRAST')).toHaveLength(3);
    expect(named.insights.length).toBeLessThanOrEqual(10);
  });
});

describe('Coach evidence requirements', () => {
  it('missing evidence prevents unsupported strategies; abstains on no tension', () => {
    // Uncrowded in-view control: separation only, no "reduce competition" strategy.
    const r = runCoach(input({ recorded: recorded([recPage({ elements: [stat(1, { exposureMs: 12_000, regionId: 2 })], regionControls: new Map([[2, 2]]) })]) }));
    expect(r.insights[0]!.debug.strategies).toEqual(['INCREASE_VISUAL_SEPARATION']);
    // Calm page: clear hierarchy, good contrast, no crowding, normal recording → nothing.
    const calm = runCoach(input({
      structure: structure({ controls: [ctrl(1, { nearestGap: 80, peersNearby: 0 })], texts: [text(2)], regions: [{ id: 1, label: 'Hero', landmark: null, rect: { x: 0, y: 0, width: 1280, height: 600 }, controlIds: [1] }] }),
      prediction: prediction([pred(1, { band: 'high', peersNearby: 0, peerStrength: null })]),
      recorded: recorded([recPage({ elements: [stat(1, { clicks: 1, hoverEntries: 1, hoverDwellMs: 600, exposureMs: 9000 })], regionControls: new Map([[1, 1]]) })]),
    }));
    expect(calm.insights).toEqual([]);
    expect(calm.availableModes).toEqual(['structure', 'prediction', 'recorded']);
  });

  it('short recordings abstain from absence-based insights; limitations lower confidence of the rest', () => {
    const short = recPage({ activeMs: 4000, limitations: ['SHORT_SESSION'], elements: [stat(1, { exposureMs: 4000 }), stat(2, { hoverEntries: 1, hoverDwellMs: 3000 })], neverReached: [{ elementRef: 9, tagName: 'a', docTop: 3000 }], maybeNotClickable: [{ rootId: 0, x: 10, y: 10, clicks: 2 }] });
    const r = runCoach(input({ recorded: recorded([short]) }));
    // Presence evidence only (a click / hover happened); nothing from absence (in view, never reached, hover-without-click).
    expect(r.insights.map((i) => i.debug.ruleId).sort()).toEqual(['recorded.crowded-interaction', 'recorded.maybe-not-clickable']);
    for (const i of r.insights) expect([i.confidence, i.caveats.includes('SHORT_SESSION')]).toEqual(['low', true]);
    const changed = runCoach(input({ recorded: recorded([recPage({ limitations: ['PAGE_CHANGED'], elements: [stat(1, { exposureMs: 20_000 })] })], true) }));
    expect(changed.insights[0]!.confidence).toBe('medium');
    expect(changed.insights[0]!.caveats).toEqual(['PAGE_CHANGED', 'INTERRUPTED']);
  });
});

describe('Coach composition', () => {
  const sample = (): InsightCandidate[] => RULES.flatMap((r) => r.evaluate(input({
    structure: structure({ controls: [1, 2, 3, 4, 5, 6].map((i) => ctrl(i, { nearestGap: 6, shortSide: i === 1 ? 18 : 44 })), texts: [text(20, { contrast: { ratio: 2, target: 4.5, assumedCanvasBase: false } }), text(21, { fontSize: 10, textLength: 400, charsPerLine: 130 })], regions: [{ id: 1, label: 'Toolbar', landmark: null, rect: { x: 0, y: 0, width: 900, height: 80 }, controlIds: [1, 2, 3, 4, 5, 6] }] }),
    prediction: prediction([pred(1, { peersNearby: 5 }), pred(2, { band: 'low', peersNearby: 6, lowers: ['MANY_COMPETING_CONTROLS', 'CROWDED_REGION'] }), pred(3, { band: 'high', viewportsDown: 3, raises: ['FILLED_STYLE', 'UNIQUE_STYLE'], lowers: ['FAR_DOWN_PAGE'] })]),
    recorded: recorded([recPage({ elements: [stat(1, { exposureMs: 14_000 }), stat(2, { clicks: 2 }), stat(3, { hoverEntries: 1, hoverDwellMs: 5000 })], neverReached: [{ elementRef: 9, tagName: 'a', docTop: 2500 }], maybeNotClickable: [{ rootId: 0, x: 5, y: 900, clicks: 1 }] })]),
  })));

  it('deterministic: same input → identical result; every rule fires in this fixture', () => {
    const inp = () => input({ prediction: prediction([pred(1, { peersNearby: 5 })]), recorded: recorded([recPage({ elements: [stat(1, { exposureMs: 14_000 })] })]) });
    const a = runCoach(inp(), { now: 1 });
    const b = runCoach(inp(), { now: 1 });
    expect({ ...a, timings: null }).toEqual({ ...b, timings: null });
    expect(new Set(sample().map((c) => c.ruleId))).toEqual(new Set(RULES.map((r) => r.id)));
    for (const c of sample()) expect(c.subject.label, c.ruleId).not.toMatch(/\(\w+\)|\d+\s*,\s*\d+|Click location/); // no raw tags or coordinates
  });

  it('wording varies across subjects through a stable hash (never random)', () => {
    const c = sample().find((x) => x.ruleId === 'recorded.in-view-no-interaction')!;
    const texts = new Set<string>();
    for (let id = 1; id <= 40; id++) {
      const s = { ...c, subject: { ...c.subject, elementId: id } as typeof c.subject };
      texts.add(compose(s, `recorded:x:e${id}`).observation + compose(s, `recorded:x:e${id}`).suggestion);
      expect(compose(s, `recorded:x:e${id}`)).toEqual(compose(s, `recorded:x:e${id}`));
    }
    expect(texts.size).toBeGreaterThanOrEqual(4);
    expect(stableHash('abc')).toBe(stableHash('abc'));
    for (const v of Object.values(OBSERVATIONS)) expect(v.length).toBeGreaterThanOrEqual(3);
  });

  it('≤ 2 strategies, ≤ 45 words, banned-language lint passes for every composed variant and template', () => {
    for (const c of sample()) {
      for (let id = 0; id < 24; id++) {
        const out = compose(c, `${c.ruleId}#${id}`);
        expect(out.strategies.length).toBeLessThanOrEqual(2);
        expect(plan(c).contextSlots.length).toBeLessThanOrEqual(2);
        expect(wordCount(out.observation) + wordCount(out.suggestion)).toBeLessThanOrEqual(MAX_WORDS);
        expect(bannedIn(`${out.observation} ${out.suggestion}`)).toEqual([]);
        if (c.mode === 'recorded') expect(out.observation).toMatch(/this session|this recording/);
        // Direct, short suggestions (no hedged lead-ins) and no engine vocabulary anywhere.
        expect(out.suggestion).not.toMatch(/^(Consider|You could consider|It may be worth|One option is)\b/);
        expect(wordCount(out.suggestion)).toBeLessThanOrEqual(16);
        expect(`${out.observation} ${out.suggestion}`).not.toMatch(ENGINE_TERMS);
      }
    }
    const all = [...Object.values(OBSERVATIONS).flat(), ...Object.values(STRATEGY_PHRASES).flat(), ...Object.values(STRATEGY_OVERRIDES).flat(), COACH_EMPTY, COACH_INTRO, ...Object.values(CATEGORY_COPY), ...Object.values(CAVEAT_COPY), ...Object.values(FOCUS_COPY), ...Object.values(MODE_COPY).flatMap((m) => [m.filter, m.source])];
    for (const t of all) expect(bannedIn(t), t).toEqual([]);
    for (const t of [...Object.values(OBSERVATIONS).flat(), ...Object.values(STRATEGY_PHRASES).flat(), ...Object.values(STRATEGY_OVERRIDES).flat()]) expect(t, t).not.toMatch(ENGINE_TERMS);
    // The lint itself catches the claims it must reject.
    for (const bad of ['Users ignored this CTA', 'This will increase conversion', 'Visitors were confused', 'AI recommends this', 'This causes frustration', 'Fix this', 'UX score: 72']) expect(bannedIn(bad).length, bad).toBeGreaterThan(0);
    expect(BANNED_PATTERNS.length).toBeGreaterThan(20);
  });
});

describe('Coach dedupe, ranking, multi-page', () => {
  it('overlapping density / competition / separation insights in one region collapse to one card', () => {
    const cs = [1, 2, 3, 4, 5, 6, 7].map((i) => ctrl(i, { nearestGap: 4, shortSide: 20 }));
    const s = structure({ controls: cs, regions: [{ id: 1, label: 'Toolbar', landmark: null, rect: { x: 0, y: 0, width: 900, height: 80 }, controlIds: cs.map((c) => c.id) }] });
    const raw = RULES.flatMap((r) => r.evaluate(input({ structure: s })));
    expect(raw.filter((c) => c.category === 'SPACING' || c.category === 'DENSITY').length).toBe(8);
    const ranked = dedupeAndRank(raw);
    const crowding = ranked.filter((r) => ['SPACING', 'DENSITY'].includes(r.candidate.category));
    expect(crowding).toHaveLength(1);
    expect(crowding[0]!.mergedFrom.length).toBe(7);
    expect(crowding[0]!.candidate.contextFacts.length).toBeLessThanOrEqual(2);
    expect(runCoach(input({ structure: s })).insights.length).toBe(2); // crowding + hierarchy
  });

  it('recorded evidence stays within its page segment', () => {
    // Page A: long exposure, no interaction. Page B: the same element id is clicked. No mixing.
    const r = runCoach(input({ recorded: recorded([recPage({ page: 0, path: '/a', elements: [stat(4, { exposureMs: 15_000 })] }), recPage({ page: 1, path: '/b', elements: [stat(4, { clicks: 3, exposureMs: 15_000 })] })]) }));
    const inView = r.insights.filter((i) => i.debug.ruleId === 'recorded.in-view-no-interaction');
    expect(inView.map((i) => i.subject.page)).toEqual([0]);
    expect(r.insights.find((i) => i.subject.page === 1)?.debug.ruleId).toBe('recorded.crowded-interaction');
    expect(new Set(r.insights.map((i) => i.id)).size).toBe(r.insights.length);
  });
});

// ---------------------------------------------------------------------------
// Runtime / protocol / highlight
// ---------------------------------------------------------------------------

function rectFromAttr(this: Element): DOMRect {
  const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}
const originalRect = Element.prototype.getBoundingClientRect;

describe('Coach controller (preserved engine, inactive in the product)', () => {
  beforeEach(() => { Element.prototype.getBoundingClientRect = rectFromAttr; });
  afterEach(() => { Element.prototype.getBoundingClientRect = originalRect; vi.restoreAllMocks(); });

  const PAGE = `<main data-rect="0 0 1280 2400"><section data-rect="0 0 1280 200">
    ${[1, 2, 3, 4, 5, 6, 7].map((i) => `<button id="b${i}" data-rect="${20 + (i - 1) * 64} 40 60 30">Item ${i}</button>`).join('')}
    </section><p id="body" data-rect="20 300 600 80">Some text</p></main>`;

  it('get() reuses existing evidence (no analysis); run() analyses; a new prediction recomputes', () => {
    mount(PAGE);
    const analyzer = createPageAnalyzer({ reader: fixtureReader({ docHeight: 2400 }) });
    let prediction: PredictionResult | null = null;
    const coach = new CoachController({ analyzer, prediction: () => prediction, recorded: () => null });
    const view = () => toCoachView(coach.get(), () => null, coach.hasStructure());
    const spy = vi.spyOn(analyzer, 'analyze');
    expect(view()).toMatchObject({ availableModes: [], insights: [], structureAnalyzed: false });
    expect(spy).not.toHaveBeenCalled();
    coach.run();
    const v = view();
    expect(v.structureAnalyzed).toBe(true);
    expect(v.availableModes).toEqual(['structure']);
    const dense = v.insights.find((i) => i.category === 'DENSITY')!;
    expect(dense.evidence.length).toBeGreaterThan(0);
    expect(dense).not.toHaveProperty('why');
    expect(dense.debug.ruleId).toBe('structure.dense-region');
    expect(JSON.stringify(v)).not.toMatch(/contributions|"features"|rowStart/);
    expect(view().generatedAt).toBe(v.generatedAt); // cached: a second read recomputes nothing
    expect(coach.find(dense.id)).toBeTruthy();
    const full = analyzer.peek();
    if (full?.mode !== 'full') throw new Error('expected a full analysis');
    prediction = predict(full, { createdAt: 1, predictionId: 'p-coach' });
    const after = view();
    expect(after.availableModes).toContain('prediction');
    expect(after.generatedAt).toBeGreaterThanOrEqual(v.generatedAt);
  });
});

describe('Coach is inactive in the shipped product', () => {
  it('the runtime protocol no longer accepts Coach messages', () => {
    for (const type of ['GET_COACH', 'RUN_COACH', 'FOCUS_COACH_SUBJECT', 'GET_PAGE_COVERAGE']) {
      expect(validateRequest({ protocolVersion: PROTOCOL_VERSION, kind: 'query', type, requestId: 'r1', payload: null })?.code).toBe('INVALID_MESSAGE');
    }
  });

  it('no production entry point imports the Coach engine (so it is not bundled and never runs)', () => {
    // Source of every module under src/, keyed '/src/…/x.ts' (Vite raw glob; no Node APIs needed).
    const sources = import.meta.glob('/src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const resolveSpec = (from: string, spec: string): string | null => {
      const parts = from.split('/').slice(0, -1);
      for (const seg of spec.split('/')) seg === '..' ? parts.pop() : seg !== '.' && parts.push(seg);
      const base = parts.join('/');
      return [`${base}.ts`, `${base}/index.ts`].find((f) => f in sources) ?? null;
    };
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const m of sources[file]!.matchAll(/\bfrom\s+'(\.[^']+)'|\bimport\s+'(\.[^']+)'/g)) {
        const hit = resolveSpec(file, m[1] ?? m[2]!);
        if (hit) visit(hit);
      }
    };
    for (const entry of ['/src/content/index.ts', '/src/background/sw.ts', '/src/ui/sidepanel/panel.ts']) visit(entry);
    expect(seen.size).toBeGreaterThan(40);
    expect(seen).toContain('/src/content/prediction/engine.ts');
    expect(seen).toContain('/src/content/recorder/index.ts');
    expect([...seen].filter((f) => /coach/i.test(f))).toEqual([]);
});
});
