/// <reference types="vite/client" />
/**
 * UI copy rule: user-visible text never uses an en dash (–) or em dash (—) as punctuation. Scans every
 * string literal in the panel, shared UI copy and on-page overlay sources (comments are ignored).
 * The only allowed form is a lone '—': the placeholder for a missing value (e.g. no scroll data).
 */
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(['../../src/ui/**/*.ts', '../../src/content/overlay/**/*.ts', '../../src/shared/**/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** String literals ('…', "…", `…`) with comments stripped first. */
const literals = (src: string): string[] =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    .match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];

describe('UI copy', () => {
  it('never uses en or em dashes in user-visible sentences (a lone "—" placeholder is allowed)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20); // the glob really found the sources
    const placeholder = /^(['"`])—\1$/;
    const hits = Object.entries(sources).flatMap(([f, src]) => literals(src).filter((l) => /[–—]/.test(l) && !placeholder.test(l)).map((l) => `${f}: ${l}`));
    expect(hits).toEqual([]);
  });
});
