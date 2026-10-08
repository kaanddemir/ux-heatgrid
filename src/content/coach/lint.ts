/**
 * Banned-claim lint for user-facing Coach copy. Rejects population claims, attention/emotion
 * language, outcome promises, scores and blunt judgments. Templates are checked by tests; the
 * composer also checks every composed sentence and never emits one that fails.
 */
export const BANNED_PATTERNS: readonly RegExp[] = [
  /\busers?\b/i,
  /\bvisitors?\b/i,
  /\bpeople\b/i,
  /\battention\b/i,
  /\bgaze\b/i,
  /\bnotic(e|ed|es|ing)\b/i,
  /\bignor(e|ed|es|ing)\b/i,
  /\boverlooked\b/i,
  /\bconfus\w*/i,
  /\bfrustrat\w*/i,
  /\brage\b/i,
  /\bcaus(e|ed|es|ing)\b/i,
  /\bwill (improve|increase|boost|fix)\b/i,
  /\bconversions?\b/i,
  /\bengagement\b/i,
  /\bAI\b/,
  /\bUX score\b/i,
  /\bscore\b/i,
  /\bgrade\b/i,
  /\bbad\b/i,
  /\bwrong\b/i,
  /\bfix this\b/i,
  /\bbroken\b/i,
  /\bfailed\b/i,
  /\berror\b/i,
  /\babandon\w*/i,
  /\bnobody\b/i,
];

export function bannedIn(text: string): string[] {
  return BANNED_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
