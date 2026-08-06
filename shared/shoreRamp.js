/**
 * The deterministic part of the shore profile — the constants that describe the
 * beach's shape before any noise.
 *
 * They lived in `sand-sim/src/terrain/beachParams.js`, which is still where the
 * profile is *composed*; this module only owns the numbers, and beachParams
 * re-exports them so nothing downstream changed.
 *
 * They moved because `shared/siftPad.js` needs the foreshore slope to level the
 * sand under a sift bed, and beachParams imports siftPad — so reading them from
 * there would be a cycle. A constant with two owners is the other way that ends,
 * and the wrong one.
 */

export const WATERLINE_Z = 0;
export const WATER_LEVEL_Y = 0;

/** Foreshore gradient, metres of rise per metre landward. ~2° — a flat beach. */
export const FORESHORE_SLOPE = 0.035;

/** The submerged profile flattens out at this depth, metres. */
export const SEABED_DEPTH = 2.5;

/** Upper-beach berm: above this height the slope relaxes to a walkable flat. */
export const BERM_HEIGHT = 1.2;
export const BERM_RELAX = 0.35;
