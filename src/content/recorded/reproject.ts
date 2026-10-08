/**
 * Anchored sample reprojection (pure; live geometry comes in through `rectOf`).
 *
 * Phase 5 stores, for samples over a control, its registry id and the position within it
 * (anchorX/anchorY, 0–1). When the SAME document is still open and the control resolves, each
 * sample can follow the control's current rect — useful when layout shifted during recording.
 * Conservative policy per control (constants in config.ts):
 *  - reproject when the median displacement is ≤ REPROJECT_MAX_SHIFT_PX and the displacement
 *    spread (p90 − p10 per axis) is ≤ max(REPROJECT_MIN_SPREAD_PX, REPROJECT_SPREAD_SHARE × size)
 *  - otherwise (radically different geometry) keep the original root coordinates
 * Unresolvable controls and unanchored samples always keep their original coordinates.
 * No sample is ever discarded, and samples never move between page segments or roots.
 */
import { REPROJECT_MAX_SHIFT_PX, REPROJECT_MIN_SPREAD_PX, REPROJECT_SPREAD_SHARE } from './config';
import type { SerializedPointer } from '../recorder/segment';

export interface RootRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Live rect of a control in the content coordinates of `rootId`, or null. */
export type RectOf = (elementRef: number, rootId: number) => RootRect | null;

export interface ReprojectionStats {
  /** Dwell (ms) of anchored samples. */
  anchoredMs: number;
  reprojectedMs: number;
  /** Anchored, control resolved, but geometry changed too much: original position kept. */
  preservedMs: number;
  /** Anchored, control not resolvable (other document / removed): original position kept. */
  unresolvedMs: number;
  controlsReprojected: number;
  controlsPreserved: number;
}

const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!;
};

export function plausibleShift(dx: number[], dy: number[], rect: RootRect): boolean {
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const med = Math.hypot(pct(dx, 0.5), pct(dy, 0.5));
  if (med > REPROJECT_MAX_SHIFT_PX) return false;
  const spreadX = pct(dx, 0.9) - pct(dx, 0.1);
  const spreadY = pct(dy, 0.9) - pct(dy, 0.1);
  return (
    spreadX <= Math.max(REPROJECT_MIN_SPREAD_PX, REPROJECT_SPREAD_SHARE * rect.width) &&
    spreadY <= Math.max(REPROJECT_MIN_SPREAD_PX, REPROJECT_SPREAD_SHARE * rect.height)
  );
}

export function reprojectPointer(p: SerializedPointer, rectOf: RectOf | null): { x: Float32Array; y: Float32Array; stats: ReprojectionStats } {
  const x = Float32Array.from(p.x);
  const y = Float32Array.from(p.y);
  const stats: ReprojectionStats = { anchoredMs: 0, reprojectedMs: 0, preservedMs: 0, unresolvedMs: 0, controlsReprojected: 0, controlsPreserved: 0 };
  const groups = new Map<string, number[]>();
  for (let i = 0; i < p.count; i++) {
    const ref = p.elementRef[i]!;
    if (!ref || p.anchorX[i] === null || p.anchorY[i] === null) continue;
    stats.anchoredMs += p.weightMs[i]!;
    const key = `${ref}:${p.rootId[i]}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }
  for (const idx of groups.values()) {
    const i0 = idx[0]!;
    const w = idx.reduce((a, i) => a + p.weightMs[i]!, 0);
    const rect = rectOf ? rectOf(p.elementRef[i0]!, p.rootId[i0]!) : null;
    if (!rect) {
      stats.unresolvedMs += w;
      continue;
    }
    const tx = idx.map((i) => rect.x + p.anchorX[i]! * rect.width);
    const ty = idx.map((i) => rect.y + p.anchorY[i]! * rect.height);
    const dx = idx.map((i, j) => tx[j]! - p.x[i]!);
    const dy = idx.map((i, j) => ty[j]! - p.y[i]!);
    if (!plausibleShift(dx, dy, rect)) {
      stats.preservedMs += w;
      stats.controlsPreserved++;
      continue;
    }
    idx.forEach((i, j) => {
      x[i] = tx[j]!;
      y[i] = ty[j]!;
    });
    stats.reprojectedMs += w;
    stats.controlsReprojected++;
  }
  return { x, y, stats };
}
