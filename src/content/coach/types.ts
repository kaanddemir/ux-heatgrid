/**
 * HeatGrid Coach types. The Coach is a deterministic, evidence-driven inspector:
 *   Evidence → pattern (rule) → category → context → strategy → composed copy.
 * Structured facts are the source of truth; prose is generated from them. No LLM, no network,
 * no claims about users, attention, intent, emotion or outcomes.
 */

export type CoachMode = 'structure' | 'prediction' | 'recorded';
export const COACH_MODES: readonly CoachMode[] = ['structure', 'prediction', 'recorded'];

export type InsightCategory =
  | 'HIERARCHY'
  | 'SEPARATION'
  | 'PLACEMENT'
  | 'COMPETING_CONTROLS'
  | 'DENSITY'
  | 'VISIBILITY'
  | 'SCROLL_PLACEMENT'
  | 'SPACING'
  | 'READABILITY'
  | 'CONTRAST'
  | 'TYPOGRAPHY'
  | 'CLICK_AFFORDANCE';

export type StrategyCode =
  | 'STRENGTHEN_PRIMARY_HIERARCHY'
  | 'REDUCE_PEER_SIMILARITY'
  | 'INCREASE_VISUAL_SEPARATION'
  | 'REDUCE_NEARBY_COMPETITION'
  | 'GROUP_RELATED_CONTROLS'
  | 'MOVE_ACTION_EARLIER'
  | 'MOVE_ACTION_NEAR_RELATED_CONTENT'
  | 'INCREASE_TARGET_SIZE'
  | 'INCREASE_CONTRAST'
  | 'INCREASE_TEXT_LEGIBILITY'
  | 'CLARIFY_INTERACTIVE_AFFORDANCE'
  | 'SIMPLIFY_REGION'
  | 'INCREASE_SPACING'
  | 'DIFFERENTIATE_PRIMARY_ACTION';

export type InsightConfidence = 'high' | 'medium' | 'low';

/** One measured fact. `key` is stable (rules, debug); `label`/`display` are for the Evidence list. */
export interface EvidenceFact {
  key: string;
  label: string;
  value: number | string | boolean;
  display: string;
}

export interface ThresholdMatch {
  fact: string;
  op: '>=' | '<=' | '<' | '>' | '=' | 'in';
  threshold: number | string;
  value: number | string | boolean;
}

export type CoachSubject =
  | { kind: 'element'; elementId: number; label: string; regionId: number | null; page: number | null }
  | { kind: 'region'; regionId: number; label: string; elementIds: number[]; page: number | null }
  | { kind: 'page'; label: string; page: number | null; point?: { rootId: number; x: number; y: number } };

export type CoachCaveat =
  | 'SHORT_SESSION'
  | 'FEW_EVENTS'
  | 'PAGE_CHANGED'
  | 'COARSENED'
  | 'REPROJECTION_UNCERTAIN'
  | 'INTERRUPTED'
  | 'PREDICTION_LOW_CONFIDENCE'
  | 'ANALYSIS_CAPPED'
  | 'CANVAS_ASSUMED'
  | 'HEURISTIC_CONTROL';

/** A rule match before planning/composition. */
export interface InsightCandidate {
  ruleId: string;
  mode: CoachMode;
  category: InsightCategory;
  subject: CoachSubject;
  observationFacts: EvidenceFact[];
  contextFacts: EvidenceFact[];
  /** Strategies the evidence supports, in preference order (planner keeps ≤ 2). */
  strategies: StrategyCode[];
  thresholds: ThresholdMatch[];
  /** 0–1 strength of the matched evidence (internal ranking only). */
  strength: number;
  /** How actionable / specific the suggestion is (0–1, internal). */
  actionability: number;
  /** Starting confidence from the rule; caveats can only lower it. */
  baseConfidence: InsightConfidence;
  caveats: CoachCaveat[];
}

export interface GuidancePlan {
  category: InsightCategory;
  strategies: StrategyCode[];
  observationSlots: Record<string, string>;
  /** At most 2 context clauses. */
  contextSlots: string[];
  hedge: 'consider' | 'review';
  constraints: { maxWords: number; sessionScoped: boolean };
}

export interface CombinedInsight {
  id: string;
  mode: CoachMode;
  category: InsightCategory;
  subject: CoachSubject;
  observationFacts: EvidenceFact[];
  contextFacts: EvidenceFact[];
  strategyCode: StrategyCode;
  supportingStrategy: StrategyCode | null;
  confidence: InsightConfidence;
  caveats: CoachCaveat[];
  copy: { observation: string; suggestion: string };
  /** Internal ordering key (never shown as a metric). */
  priority: number;
  debug: {
    ruleId: string;
    thresholds: ThresholdMatch[];
    strategies: StrategyCode[];
    variants: { observation: number; suggestion: number };
    mergedFrom: string[];
  };
}

export interface CoachResult {
  version: string;
  generatedAt: number;
  availableModes: CoachMode[];
  insights: CombinedInsight[];
  summary: { total: number; byMode: Record<CoachMode, number>; byCategory: Partial<Record<InsightCategory, number>> };
  limitations: string[];
  timings: { evidenceMs: number; rulesMs: number; composeMs: number; totalMs: number };
  /** Inputs this result was computed from (recompute only when one changes). */
  inputs: { analysisId: string | null; predictionId: string | null; recordedSessionId: string | null };
}

// ---------------------------------------------------------------------------
// Lightweight protocol views
// ---------------------------------------------------------------------------

export interface CoachInsightView {
  id: string;
  mode: CoachMode;
  category: InsightCategory;
  subject: { kind: CoachSubject['kind']; label: string; page: number | null; pagePath: string | null };
  observation: string;
  suggestion: string;
  confidence: InsightConfidence;
  caveats: CoachCaveat[];
  /** Facts behind the insight; `key` / `value` let the panel phrase them in product terms. */
  evidence: Array<{ key: string; label: string; value: number | string | boolean; display: string }>;
  debug: CombinedInsight['debug'] & { facts: EvidenceFact[] };
}

export interface CoachView {
  version: string;
  generatedAt: number;
  availableModes: CoachMode[];
  insights: CoachInsightView[];
  summary: CoachResult['summary'];
  limitations: string[];
  timings: CoachResult['timings'];
  /** Structure evidence comes from a full page analysis (Run Coach); false until one exists. */
  structureAnalyzed: boolean;
}

export interface CoachFocusResult {
  status: 'focused' | 'cleared' | 'unavailable' | 'not-open';
}
