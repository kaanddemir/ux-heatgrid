/** Shared state of one recording, handed to every capture module. */
import type { PointerBuffer } from './buffer';
import type { ActivityClock } from './idle';
import type { RootRegistry } from './roots';
import type { CandidateResolver } from './targets';
import type { RecordedElementStats } from './types';

export interface RecorderContext {
  win: Window;
  /** Monotonic ms (performance.now-like). */
  now: () => number;
  /** Session start on the `now` timeline; stored times are relative to it. */
  t0: number;
  clock: ActivityClock;
  roots: RootRegistry;
  resolver: CandidateResolver;
  buffer: PointerBuffer;
  /** Per-candidate stats (keys: candidate ElementRef ids). */
  stats: Map<number, RecordedElementStats>;
  /** Marks meaningful input at time t (resumes from idle). */
  input: (t: number) => void;
}
