/// <reference types="vite/client" />
/**
 * Production surface: the three entry points reach only V2 modules, and retired Coach messages are rejected.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, validateRequest } from '../../src/shared/protocol';

// Source of every module under src/, keyed '/src/…/x.ts' (Vite raw glob; no Node APIs needed).
const sources = import.meta.glob('/src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const ENTRIES = ['/src/content/index.ts', '/src/background/sw.ts', '/src/ui/sidepanel/panel.ts'];

function reachable(): Set<string> {
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
  for (const entry of ENTRIES) visit(entry);
  return seen;
}

describe('production entry points', () => {
  it('every source module is reachable from a production entry point (no orphaned modules)', () => {
    const seen = reachable();
    expect(seen).toContain('/src/content/prediction/engine.ts');
    expect(seen).toContain('/src/content/recorder/index.ts');
    expect(Object.keys(sources).filter((f) => !seen.has(f))).toEqual([]);
  });

  it('no Coach module exists in src/', () => {
    expect(Object.keys(sources).filter((f) => /coach/i.test(f))).toEqual([]);
  });

  it('the runtime protocol rejects retired Coach messages', () => {
    for (const type of ['GET_COACH', 'RUN_COACH', 'FOCUS_COACH_SUBJECT', 'GET_PAGE_COVERAGE']) {
      expect(validateRequest({ protocolVersion: PROTOCOL_VERSION, kind: 'query', type, requestId: 'r1', payload: null })?.code).toBe('INVALID_MESSAGE');
    }
  });
});
