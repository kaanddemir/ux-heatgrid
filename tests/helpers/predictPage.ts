/** Test helper: analyze a fixture DOM (fixture geometry) and run the prediction engine. */
import { createPageAnalyzer } from '../../src/content/analyzer';
import type { FullAnalysisResult } from '../../src/content/analyzer/types';
import { predict } from '../../src/content/prediction/engine';
import type { ElementPrediction, PredictionResult } from '../../src/content/prediction/types';
import { fixtureReader, mount } from './fixtureReader';

/** Document height = lowest data-rect bottom (at least one viewport). */
function contentHeight(): number {
  let max = 800;
  for (const el of document.querySelectorAll('[data-rect]')) {
    const [, y, , h] = (el.getAttribute('data-rect') ?? '').split(/\s+/).map(Number);
    if (Number.isFinite(y) && Number.isFinite(h)) max = Math.max(max, y! + h!);
  }
  return max;
}

export function analyzePage(html: string): FullAnalysisResult {
  mount(html);
  return createPageAnalyzer({ reader: fixtureReader({ docHeight: contentHeight() }) }).analyze();
}

export function predictPage(html: string): { analysis: FullAnalysisResult; result: PredictionResult } {
  const analysis = analyzePage(html);
  return { analysis, result: predict(analysis, { createdAt: 0, predictionId: 'p-test' }) };
}

export function el(result: PredictionResult, id: string): ElementPrediction {
  const hit = result.elements.find((e) => e.elementRef.selectorHint?.split('.')[0]?.endsWith(`#${id}`));
  if (!hit) throw new Error(`no prediction for #${id}`);
  return hit;
}
