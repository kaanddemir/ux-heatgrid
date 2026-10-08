/**
 * Recorded Interaction colour map: a restrained magma/inferno-like warm ramp
 * (transparent → dark purple → magenta → orange → warm yellow). Never the Prediction indigo.
 * Opacity rises with intensity (see config.ts), so low density stays very transparent and the
 * page underneath stays readable at the top of the scale.
 */
import { ALPHA_GAMMA, ALPHA_MAX, MIN_INTENSITY } from './config';

/** [position 0–1, r, g, b] */
export const HEAT_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 96, 18, 96], // dark plum-purple (kept clear of the Predicted indigo)
  [0.3, 140, 41, 129], // magenta-purple
  [0.55, 222, 73, 104], // magenta-red
  [0.8, 254, 159, 109], // orange
  [1.0, 252, 211, 77], // warm yellow
];

/** Colour (no alpha) at intensity t (0–1). */
export function heatRgb(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [p1, r1, g1, b1] = HEAT_STOPS[i]!;
    if (x <= p1) {
      const [p0, r0, g0, b0] = HEAT_STOPS[i - 1]!;
      const f = (x - p0) / (p1 - p0);
      return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f)];
    }
  }
  const last = HEAT_STOPS[HEAT_STOPS.length - 1]!;
  return [last[1], last[2], last[3]];
}

/** Opacity (0–1) at intensity t; zero below MIN_INTENSITY. */
export function heatAlpha(t: number): number {
  if (!(t >= MIN_INTENSITY)) return 0;
  return ALPHA_MAX * Math.pow(Math.min(1, t), ALPHA_GAMMA);
}

let lut: Uint8ClampedArray | null = null;

/** 256-entry RGBA lookup table indexed by quantized intensity (index 0 is transparent). */
export function heatLut(): Uint8ClampedArray {
  if (lut) return lut;
  lut = new Uint8ClampedArray(256 * 4);
  for (let i = 1; i < 256; i++) {
    const t = i / 255;
    const [r, g, b] = heatRgb(t);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = Math.round(heatAlpha(t) * 255);
  }
  return lut;
}
