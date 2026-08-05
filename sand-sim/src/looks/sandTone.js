/**
 * The sand palette — single source of truth for every renderer and material.
 *
 * The WGSL sand material, the WebGL PBR plugin and any bare PBR fallback all
 * read these, so one edit retunes the whole project. Default is the pale cool
 * grey-beige the user chose (fits the game's cool greens-and-blues palette;
 * the warm HDRI light supplies the warmth).
 *
 * Linear-space RGB.
 */

export const SAND_DRY = { r: 0.62, g: 0.61, b: 0.57 };
/** Wet sand: hard darkening, slight cool shift. */
export const SAND_WET = { r: 0.35, g: 0.345, b: 0.335 };
/** Pebble base tint (phase 6) — grey stones per the game palette. */
export const PEBBLE_TINT = { r: 0.50, g: 0.51, b: 0.53 };

/**
 * The analytic shore-wetness band, metres landward of the waterline: fully wet
 * within WET_NEAR, dry past WET_FAR, tide-noise wobbled between.
 */
export const WET_NEAR = 1.0;
export const WET_FAR = 7.5;
