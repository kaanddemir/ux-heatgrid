/**
 * In-memory analysis cache keyed by (layoutVersion, mode). Never persisted.
 * Holds only the current layout version: a new version drops everything older.
 * A full result also satisfies registry-mode requests (projected down).
 */
import type { CandidateFacts, FullAnalysisResult, PageAnalysisResult, RegistrySnapshot } from './types';

export function projectToRegistry(full: FullAnalysisResult): RegistrySnapshot {
  const elements: CandidateFacts[] = full.elements.map((e) => ({
    ref: e.ref,
    interactive: e.interactive,
    landmark: e.landmark,
    render: e.render,
    geometry: e.geometry,
    positioning: e.positioning,
    regionId: e.regionId,
  }));
  return {
    mode: 'registry',
    meta: { ...full.meta, mode: 'registry' },
    elements,
    regions: full.regions,
    scrollRoots: full.scrollRoots,
    coverage: full.coverage,
    warnings: full.warnings,
  };
}

export class AnalysisCache {
  private version: number | null = null;
  private full: FullAnalysisResult | null = null;
  private registry: RegistrySnapshot | null = null;

  get(layoutVersion: number, mode: 'full'): FullAnalysisResult | null;
  get(layoutVersion: number, mode: 'registry'): RegistrySnapshot | null;
  get(layoutVersion: number, mode: 'full' | 'registry'): PageAnalysisResult | null {
    if (this.version !== layoutVersion) return null;
    if (mode === 'full') return this.full;
    if (this.registry) return this.registry;
    if (this.full) {
      this.registry = projectToRegistry(this.full);
      return this.registry;
    }
    return null;
  }

  set(result: PageAnalysisResult): void {
    const v = result.meta.layoutVersion;
    if (this.version !== v) this.clear();
    this.version = v;
    if (result.mode === 'full') {
      this.full = result;
      this.registry = null; // re-project lazily so both modes agree
    } else {
      this.registry = result;
    }
  }

  clear(): void {
    this.version = null;
    this.full = null;
    this.registry = null;
  }
}
