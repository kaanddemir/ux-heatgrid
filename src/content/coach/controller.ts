/**
 * CoachController — owns the cached CoachResult for this tab runtime. Recomputes only when an
 * input changes (analysis id, prediction id, recorded session id); never on scroll or pointer
 * events, never by polling. `get()` reuses an existing full analysis; only `run()` (explicit
 * Coach request) may run a full analysis, and the analyzer caches it per layout version.
 */
import type { PageAnalyzer } from '../analyzer';
import type { FullAnalysisResult } from '../analyzer/types';
import type { PredictionResult } from '../prediction/types';
import type { RecordedSessionResult } from '../recorded/types';
import { runCoach } from './engine';
import { predictionEvidence, recordedEvidence, structureEvidence, type StructureEvidence } from './evidence';
import type { CoachResult, CoachView, CombinedInsight } from './types';

export interface CoachDeps {
  analyzer: Pick<PageAnalyzer, 'analyze' | 'peek'>;
  prediction: () => PredictionResult | null;
  recorded: () => RecordedSessionResult | null;
}

const perf = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class CoachController {
  private result: CoachResult | null = null;
  private structure: StructureEvidence | null = null;

  constructor(private readonly deps: CoachDeps) {}

  private currentFull(): FullAnalysisResult | null {
    const a = this.deps.analyzer.peek();
    return a && a.mode === 'full' ? a : null;
  }

  private compute(full: FullAnalysisResult | null): CoachResult {
    const p = this.deps.prediction();
    const r = this.deps.recorded();
    const key = { analysisId: full?.meta.analysisId ?? null, predictionId: p?.predictionId ?? null, recordedSessionId: r?.sessionId ?? null };
    const prev = this.result?.inputs;
    if (this.result && prev && prev.analysisId === key.analysisId && prev.predictionId === key.predictionId && prev.recordedSessionId === key.recordedSessionId) return this.result;
    const t0 = perf();
    if (full && this.structure?.analysisId !== full.meta.analysisId) this.structure = structureEvidence(full);
    const input = { structure: full ? this.structure : null, prediction: p ? predictionEvidence(p) : null, recorded: r ? recordedEvidence(r) : null };
    const evidenceMs = perf() - t0;
    this.result = runCoach(input, { evidenceMs });
    return this.result;
  }

  /** Current result from the evidence that already exists (no new analysis). */
  get(): CoachResult {
    return this.compute(this.currentFull());
  }

  /** Explicit Coach run: reuses or creates the full analysis for the current layout. */
  run(): CoachResult {
    return this.compute(this.deps.analyzer.analyze({ mode: 'full' }));
  }

  find(id: string): CombinedInsight | null {
    return this.result?.insights.find((i) => i.id === id) ?? null;
  }

  structureRegionRect(regionId: number): { x: number; y: number; width: number; height: number } | null {
    return this.structure?.regions.find((r) => r.id === regionId)?.rect ?? null;
  }

  hasStructure(): boolean {
    return this.currentFull() !== null;
  }

  clear(): void {
    this.result = null;
    this.structure = null;
  }
}

export function toCoachView(r: CoachResult, pagePath: (page: number) => string | null, structureAnalyzed: boolean): CoachView {
  return {
    version: r.version,
    generatedAt: r.generatedAt,
    availableModes: [...r.availableModes],
    insights: r.insights.map((i) => ({
      id: i.id,
      mode: i.mode,
      category: i.category,
      subject: { kind: i.subject.kind, label: i.subject.label, page: i.subject.page, pagePath: i.subject.page === null ? null : pagePath(i.subject.page) },
      observation: i.copy.observation,
      suggestion: i.copy.suggestion,
      confidence: i.confidence,
      caveats: [...i.caveats],
      evidence: [...i.observationFacts, ...i.contextFacts].map((f) => ({ key: f.key, label: f.label, value: f.value, display: f.display })),
      debug: { ...i.debug, facts: [...i.observationFacts, ...i.contextFacts] },
    })),
    summary: r.summary,
    limitations: [...r.limitations],
    timings: r.timings,
    structureAnalyzed,
  };
}
