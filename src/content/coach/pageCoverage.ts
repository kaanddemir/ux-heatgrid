/**
 * INACTIVE (see ./README.md). Analysis coverage notes (pure) for the former Coach Limitations: what the latest full analysis could not
 * cover. Derived from the analysis — never the raw JSON.
 */
import type { FullAnalysisResult } from '../analyzer/types';

export interface PageCoverage {
  analysisId: string;
  /** Embedded frames that were not analysed. */
  frames: number;
  /** Text whose contrast could not be measured (never guessed). */
  contrastUnresolved: number;
}

export function pageCoverage(a: FullAnalysisResult): PageCoverage {
  return {
    analysisId: a.meta.analysisId,
    frames: a.coverage.framesNotAnalyzed,
    contrastUnresolved: a.elements.filter((e) => e.render.rendered && e.contrast && !e.contrast.resolved).length,
  };
}
