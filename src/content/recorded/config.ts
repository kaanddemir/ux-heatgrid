/**
 * Recorded Interaction tuning constants, in one place for later calibration. These are visual and
 * engineering choices, not scientific values: they shape how one session's measured pointer time
 * is drawn, and nothing here is a probability or a score.
 */

/** Base density cell (CSS px). */
export const BASE_CELL_PX = 8;
/**
 * Adaptive grid: the cell doubles (8 → 16 → 32 …) until a root fits in MAX_ROWS rows and
 * MAX_COLS columns. Powers of two keep Phase 5's 16 px coarse cells aligned with the grid.
 */
export const MAX_ROWS = 4096;
export const MAX_COLS = 1024;

/** Gaussian smoothing, in cells (σ ≈ 2 cells, radius ≈ 3σ). */
export const SIGMA_CELLS = 2;
export const KERNEL_RADIUS = Math.ceil(3 * SIGMA_CELLS);

/** Robust visual upper bound: this percentile of the non-zero smoothed cells (per page). */
export const UPPER_PERCENTILE = 0.98;
/** Intensities (after the sqrt transfer) below this are fully transparent: sparse stays sparse. */
export const MIN_INTENSITY = 0.06;

/** Opacity mapping: alpha = ALPHA_MAX · intensity^ALPHA_GAMMA (zero density → fully transparent). */
export const ALPHA_MAX = 0.58;
export const ALPHA_GAMMA = 1.25;

/** Tiles: TILE_HEIGHT_PX of root content per tile, full recorded width; LRU per page. */
export const TILE_HEIGHT_PX = 512;
export const TILE_CACHE_SIZE = 16;

/**
 * Anchored reprojection (per control, using its LIVE rect on the same document):
 *  - the median displacement must be ≤ REPROJECT_MAX_SHIFT_PX, and
 *  - the spread of displacements (p90 − p10, per axis) must be ≤ max(REPROJECT_MIN_SPREAD_PX,
 *    REPROJECT_SPREAD_SHARE × the control's current size on that axis).
 * A moderate move or resize passes; a radically different geometry keeps the original points.
 * When more than REPROJECT_UNCERTAIN_SHARE of anchored dwell kept its original position,
 * the page gets REPROJECTION_UNCERTAIN.
 */
export const REPROJECT_MAX_SHIFT_PX = 320;
export const REPROJECT_MIN_SPREAD_PX = 24;
export const REPROJECT_SPREAD_SHARE = 0.5;
export const REPROJECT_UNCERTAIN_SHARE = 0.2;

/** Click markers: consecutive clicks this close in space and time are drawn as one "×N" marker. */
export const CLICK_CLUSTER_PX = 12;
export const CLICK_CLUSTER_MS = 600;

/** Lists. */
export const LIST_MAX = 10;
/** "Most hovered" needs at least this much hover dwell. */
export const HOVER_MEANINGFUL_MS = 500;
/** "In view, no interaction" needs at least this much exposure (≥ 50% visible, active time). */
export const IN_VIEW_MEANINGFUL_MS = 5000;
/** "May not be clickable" clicks closer than this are listed as one location. */
export const MAYBE_NOT_GROUP_PX = 24;

/** Layout drift between recording and the live page that triggers the "may have changed" note. */
export const LAYOUT_CHANGE_SHARE = 0.15;
