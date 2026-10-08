/**
 * Coach engine (pure): evidence → rules → dedupe/rank → plan → compose → CoachResult.
 * Same inputs always give the same result (wording included).
 */
import { compose, plan, subjectKey } from './composer';
import { insightConfidence } from './confidence';
import type { PredictionEvidence, RecordedEvidence, StructureEvidence } from './evidence';
import { dedupeAndRank } from './rank';
import { evaluateRules, RULES, type Rule } from './rules';
import { COACH_MODES, type CoachMode, type CoachResult, type CombinedInsight } from './types';

export const COACH_VERSION = 'coach-v1';

const perf = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface CoachInput {
  structure: StructureEvidence | null;
  prediction: PredictionEvidence | null;
  recorded: RecordedEvidence | null;
}

export function runCoach(input: CoachInput, opts: { now?: number; evidenceMs?: number; rules?: readonly Rule[] } = {}): CoachResult {
  const t0 = perf();
  const candidates = evaluateRules(input, opts.rules ?? RULES);
  const ranked = dedupeAndRank(candidates);
  const t1 = perf();
  const insights: CombinedInsight[] = ranked.map(({ candidate: c, priority, mergedFrom }) => {
    const id = `${c.mode}:${c.ruleId.split('.')[1]}:${subjectKey(c.subject)}`;
    const p = plan(c);
    const copy = compose(c, id, p);
    return {
      id,
      mode: c.mode,
      category: c.category,
      subject: c.subject,
      observationFacts: c.observationFacts,
      contextFacts: c.contextFacts,
      strategyCode: copy.strategies[0]!,
      supportingStrategy: copy.strategies[1] ?? null,
      confidence: insightConfidence(c.baseConfidence, c.caveats),
      caveats: c.caveats,
      copy: { observation: copy.observation, suggestion: copy.suggestion },
      priority: Math.round(priority * 1000) / 1000,
      debug: { ruleId: c.ruleId, thresholds: c.thresholds, strategies: copy.strategies, variants: copy.variants, mergedFrom },
    };
  });
  const t2 = perf();
  const byMode = Object.fromEntries(COACH_MODES.map((m) => [m, insights.filter((i) => i.mode === m).length])) as Record<CoachMode, number>;
  const byCategory: CoachResult['summary']['byCategory'] = {};
  for (const i of insights) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  const limitations: string[] = [];
  if (input.structure?.capped || input.prediction?.capped) limitations.push('Very many controls: only some were analysed.');
  if (input.recorded?.interrupted) limitations.push('Recording was interrupted on a page HeatGrid cannot access.');
  const r = (v: number): number => Math.round(v * 100) / 100;
  return {
    version: COACH_VERSION,
    generatedAt: opts.now ?? Date.now(),
    availableModes: COACH_MODES.filter((m) => (m === 'structure' ? input.structure : m === 'prediction' ? input.prediction : input.recorded) !== null),
    insights,
    summary: { total: insights.length, byMode, byCategory },
    limitations,
    timings: { evidenceMs: r(opts.evidenceMs ?? 0), rulesMs: r(t1 - t0), composeMs: r(t2 - t1), totalMs: r((opts.evidenceMs ?? 0) + t2 - t0) },
    inputs: { analysisId: input.structure?.analysisId ?? null, predictionId: input.prediction?.predictionId ?? null, recordedSessionId: input.recorded?.sessionId ?? null },
  };
}
