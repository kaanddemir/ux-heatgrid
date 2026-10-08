/**
 * Pure view-model for the Predict tab (no DOM, no chrome APIs), so the panel's states,
 * grouping and row copy are unit-testable.
 */
import type { PredictionSnapshot } from '../../shared/model';
import type { Band, PredictionSummaryElement, PredictionSummaryResult } from '../../content/prediction/types';
import { CONTROL_TYPE_COPY, STALE_COPY, confidenceQualifier, reasonText } from '../shared/predictionCopy';
import { cleanSubject, meaningfulRegion } from '../shared/regionLabel';

export type Filter = 'all' | 'high' | 'medium' | 'low';
export type ListedBand = Exclude<Band, 'not-assessed'>;
export const LISTED_BANDS: readonly ListedBand[] = ['high', 'medium', 'low'];

export type PredictedViewState =
  | { kind: 'empty'; action: 'Predict' }
  | { kind: 'analyzing'; message: string }
  | { kind: 'ready'; action: 'Re-run prediction' }
  | { kind: 'stale'; action: 'Run again'; notice: string }
  | { kind: 'error'; action: 'Try again'; message: string };

export function predictedViewState(p: PredictionSnapshot | null | undefined): PredictedViewState {
  switch (p?.state ?? 'idle') {
    case 'analyzing':
      return { kind: 'analyzing', message: 'Analysing page structure…' };
    case 'ready':
      return { kind: 'ready', action: 'Re-run prediction' };
    case 'stale':
      return { kind: 'stale', action: 'Run again', notice: STALE_COPY };
    case 'error':
      return { kind: 'error', action: 'Try again', message: "The prediction couldn't be completed on this page." };
    default:
      return { kind: 'empty', action: 'Predict' };
  }
}

/** Item-type filter: control kinds plus "Nav" (anything in the Navigation / Header area). */
export type KindFilter = 'all' | 'nav' | 'link' | 'button' | 'field' | 'choice' | 'menu';
export const KIND_COPY: Record<Exclude<KindFilter, 'all'>, string> = { nav: 'Nav', link: 'Links', button: 'Buttons', field: 'Fields', choice: 'Choices', menu: 'Menus' };

const KIND_OF: Partial<Record<NonNullable<PredictionSummaryElement['controlType']>, KindFilter>> = { link: 'link', button: 'button', field: 'field', editable: 'field', choice: 'choice', 'tab-menu': 'menu' };

export function matchesKind(r: PredictionSummaryResult, e: PredictionSummaryElement, kind: KindFilter): boolean {
  if (kind === 'all') return true;
  if (kind === 'nav') {
    const region = e.regionId === null ? null : meaningfulRegion(r.regions.find((g) => g.regionId === e.regionId)?.label);
    return region === 'Navigation' || region === 'Header';
  }
  return (e.controlType ? KIND_OF[e.controlType] : undefined) === kind;
}

/** Groups in High → Medium → Low order; prediction rank order within a band. Not assessed is excluded. */
export function groupByBand(r: PredictionSummaryResult, filter: Filter, kind: KindFilter = 'all'): Array<{ band: ListedBand; items: PredictionSummaryElement[] }> {
  const bands = filter === 'all' ? LISTED_BANDS : [filter];
  return bands.map((band) => ({
    band,
    items: r.elements
      .filter((e) => e.band === band && matchesKind(r, e, kind))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id - b.id),
  }));
}

export interface RowModel {
  label: string;
  /** Collapsed-row meta: the element type only ("Button"). The page area lives in `area`. */
  meta: string;
  type: string;
  area: string | null;
  /** null for high confidence (no extra label). */
  qualifier: string | null;
  preview: { direction: 'raises' | 'lowers'; text: string } | null;
}

const TAG_TYPE: Record<string, string> = { a: 'Link', button: 'Button', input: 'Input', select: 'Select', textarea: 'Textarea' };

export function rowModel(r: PredictionSummaryResult, e: PredictionSummaryElement): RowModel {
  // Row meta answers "what is it" only; the named page area is kept for the expanded detail.
  const type = TAG_TYPE[e.tagName.toLowerCase()] ?? (e.controlType ? CONTROL_TYPE_COPY[e.controlType] : e.tagName);
  const area = e.regionId === null ? null : meaningfulRegion(r.regions.find((g) => g.regionId === e.regionId)?.label);
  const first = e.topReasons[0];
  const sourceLabel = e.label ?? `Unlabelled ${e.tagName}`;
  return {
    label: cleanSubject(sourceLabel),
    meta: type,
    type,
    area,
    qualifier: confidenceQualifier(e.confidence),
    preview: first ? { direction: first.polarity === 'raises' ? 'raises' : 'lowers', text: reasonText(first.code) } : null,
  };
}
