/**
 * weights-v1 — every weight, budget and threshold of heuristic-v1 lives here.
 *
 * These are HEURISTIC values chosen from structural design assumptions and checked against
 * fixtures. They are not fitted to behavioural data and are not scientifically validated.
 *
 * Score model: score = BASE + Σ component subtotals (each subtotal clamped to its budget),
 * clamped to [0, 1]. Budgets are what guarantee "no single signal creates High":
 * HIGH_FLOOR - BASE = 0.32, and no single sub-budget below exceeds 0.22.
 */
export const WEIGHTS_VERSION = 'weights-v1';

export const W = {
  /** Neutral starting point for an eligible control. */
  BASE: 0.3,

  // ---------------------------------------------------------------- Prominence
  /** Larger than its peers (region first, page fallback) → stands out. Log-scaled, so diminishing returns. */
  relSize: 0.16,
  /** Overall size rank on the page; small supporting signal. */
  areaPercentile: 0.06,
  /** Size can contribute at most this much in total (alone it can never reach High). */
  SIZE_BUDGET: { min: -0.16, max: 0.22 },

  /** Visible on the first screen without scrolling. */
  firstViewport: 0.12,
  /** Further down the page needs more scrolling to be reached; smooth decay, penalty only. */
  foldDecay: 0.12,
  /** Fold decay starts after this many viewport heights. */
  FOLD_GRACE_VIEWPORTS: 0.75,
  /** Exponential decay rate per viewport height after the grace distance. */
  FOLD_DECAY_RATE: 0.45,
  POSITION_BUDGET: { min: -0.14, max: 0.2 },

  /** Text contrast relative to an AA-ish midpoint; saturates at 7:1. Unknown contrast contributes 0. */
  contrast: 0.06,
  /** Contrast value (log(ratio)/log 7) treated as neutral; ≈ 3.2:1. */
  CONTRAST_NEUTRAL: 0.6,
  /** A filled control that contrasts with its backdrop reads as a distinct object. */
  fillStrength: 0.08,
  /** A visible border separates the control from surrounding content (weaker than fill). */
  bordered: 0.02,
  /** Larger type than other controls. */
  fontSizeRel: 0.04,
  /** Heavier type than regular text. */
  fontWeight: 0.02,
  /** Generous padding gives a larger, button-like target. */
  paddingRel: 0.02,
  /** Visual style not repeated by other controls (heuristic). */
  styleUniqueness: 0.04,
  /** Clearly stronger than every nearby peer (≥ 2 peers) — stands out within its group (heuristic). */
  strongestInGroup: 0.03,
  VISUAL_BUDGET: { min: -0.1, max: 0.2 },

  /** Prominence as a whole. */
  PROMINENCE_BUDGET: { min: -0.3, max: 0.55 },

  // ---------------------------------------------------------------- Competition
  /** Few nearby controls → less competition; many → diluted. Saturating in the peer count. */
  peers: 0.08,
  /** Peer count at which competition reaches ~63% of its maximum penalty. */
  PEER_SATURATION: 4,
  /**
   * A nearby peer that is visually stronger dilutes this control. Penalty only, so adding peers
   * can never improve competition (being the strongest is a prominence bonus instead).
   */
  peerStrength: 0.1,
  /** Dense regions (relative to the page's other regions) dilute every control in them. */
  regionDensity: 0.04,
  /** Whitespace around a control (isolation). Neutral at CLEARANCE_NEUTRAL. */
  clearance: 0.04,
  CLEARANCE_NEUTRAL: 0.3,
  /**
   * Competition radius: PEER_RADIUS_DIAGONALS × own diagonal, clamped to [MIN, MAX] px. The cap
   * matters: an uncapped radius makes large controls count most of the page as competitors.
   */
  PEER_RADIUS_MIN: 150,
  PEER_RADIUS_MAX: 320,
  PEER_RADIUS_DIAGONALS: 2,
  /** Own strength must exceed the strongest peer by this much to count as strongest in group. */
  STRONGEST_MARGIN: 0.05,
  COMPETITION_BUDGET: { min: -0.25, max: 0.12 },

  // ---------------------------------------------------------------- Availability (penalties only)
  /** Below the 24px target-size minimum: harder to operate, less likely to read as a primary control. */
  tinyTarget: 0.12,
  /** Part of the control is clipped away by an ancestor. */
  clipLoss: 0.1,
  /** Reduced opacity reads as de-emphasised. */
  opacityLoss: 0.1,
  AVAILABILITY_BUDGET: { min: -0.25, max: 0 },

  // ---------------------------------------------------------------- Context (small, bounded)
  /** Fixed controls stay on screen while scrolling. */
  fixed: 0.04,
  /** Sticky is weaker: we cannot tell whether it is currently stuck. */
  sticky: 0.02,
  /** Directly below a section heading → part of that section's primary content (heuristic). */
  headingRelation: 0.03,
  /** Max gap (px) between a heading above and the control. */
  HEADING_GAP_PX: 300,
  /** A control inside a navigation landmark with ≥ NAV_CLUSTER_PEERS nearby peers is one of a set. */
  navCluster: 0.04,
  NAV_CLUSTER_PEERS: 4,
  /** Footer landmarks usually repeat site-wide links. Deliberately small, never decisive. */
  footer: 0.03,
  /** Detected only through cursor:pointer — weaker evidence that it is a control at all. */
  heuristicDetection: 0.03,
  CONTEXT_BUDGET: { min: -0.1, max: 0.08 },

  // ---------------------------------------------------------------- Suppressions / eligibility
  /** Suppressed controls are capped here and forced to Low. */
  SUPPRESSED_SCORE_CAP: 0.15,
  /** Opacity below this is near-invisible. */
  NEAR_INVISIBLE_OPACITY: 0.2,
  /** Resolved contrast below this with no fill is near-invisible text. */
  NEAR_INVISIBLE_CONTRAST: 1.25,
  /** Short side (px) below which geometry is unusable. */
  UNUSABLE_SHORT_SIDE: 6,
  /** Short side (px) below which the tiny-target penalty applies. */
  TINY_SHORT_SIDE: 24,
  /** Region-relative size needs at least this many assessed peers in the region. */
  REGION_MIN_PEERS: 3,

  // ---------------------------------------------------------------- Banding
  /** High requires at least this absolute score (rank alone never creates High). */
  HIGH_FLOOR: 0.62,
  /**
   * High also requires visual distinction: size + visual-treatment contributions ≥ this. Position,
   * isolation and context alone mean "easy to find", not "stands out".
   */
  HIGH_MIN_DISTINCTION: 0.1,
  // Controls detected only through cursor:pointer are capped at Medium: without semantic evidence
  // that the element is a control at all, a High would be unjustified (abstention).
  /** High must also beat the page median by this margin (with ≥ 3 candidates). */
  HIGH_MEDIAN_MARGIN: 0.1,
  /** High is limited to the top share of assessed candidates… */
  HIGH_TOP_SHARE: 0.1,
  /** …and to at most this many elements. */
  HIGH_MAX: 5,
  /** Anything below this is Low regardless of rank. */
  LOW_FLOOR: 0.2,
  /** With ≥ LOW_RELATIVE_MIN_N candidates, the bottom share is Low if also below median − margin. */
  LOW_BOTTOM_SHARE: 0.4,
  LOW_MEDIAN_MARGIN: 0.06,
  LOW_RELATIVE_MIN_N: 5,

  // ---------------------------------------------------------------- Reasons / confidence
  /** Contributions smaller than this are not reported as reasons. */
  REASON_MIN_CONTRIBUTION: 0.015,
  /** Within this distance of a band threshold → NEAR_BAND_BOUNDARY. */
  BOUNDARY_EPSILON: 0.03,
  /** Strong prominence with strong competition counts as contradictory evidence. */
  CONTRADICTION_PROMINENCE: 0.25,
  CONTRADICTION_COMPETITION: -0.15,
  /** Caveat count thresholds: ≤ 0 → high, ≤ 2 → medium, otherwise low. */
  CONFIDENCE_MEDIUM_AT: 1,
  CONFIDENCE_LOW_AT: 3,
} as const;
