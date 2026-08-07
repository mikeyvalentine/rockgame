/**
 * Alignment facts for the pond world export (`public/assets/pond.0.glb`) —
 * pure data, no Babylon, so the headless check (`tools/env-glb-check.mjs`)
 * can hold the GLB to them without pulling an engine into node.
 *
 * The export was authored to `shared/worldBounds.js`: its pond is a disc of
 * radius 100 centred on the GLB origin, and its landscape runs to ±125 —
 * exactly POND_RADIUS + SHORE_DEPTH. Those are measured out of the file's
 * accessor bounds, and the check fails if a re-export drifts from them.
 */

import { POND_CENTER_X, POND_CENTER_Z } from "../../../shared/worldBounds.js";
import { WATER_LEVEL_Y } from "../../../shared/shoreRamp.js";

/** Where the export keeps its own water surface, GLB-local metres. */
export const GLB_WATER_Y = -2.457367420196533;

/** The GLB's pond is centred on its origin; its water disc has this radius. */
export const GLB_POND_RADIUS = 100;

/** Half-extent of the exported landscape in x/z, GLB-local metres. */
export const GLB_HALF_EXTENT = 125;

/**
 * Root offset that lands the export on the game's world: pond centre onto
 * pond centre, water surface onto the waterline. One translation, no scale —
 * the export is in metres and built to the same spec.
 */
export const ENV_OFFSET = {
    x: POND_CENTER_X,
    y: WATER_LEVEL_Y - GLB_WATER_Y,
    z: POND_CENTER_Z,
};

/**
 * The asset itself, and the draco decoder it cannot load without.
 *
 * The decoder lives UNDER `/assets` on purpose. `tools/build-site.mjs` ships
 * only `git ls-files public/assets` — nothing else in `public/` reaches the
 * deployed site — so a decoder anywhere else 404s in production (served as
 * the SPA HTML fallback, which the worker then refuses as a non-executable
 * `text/html` script) even though Vite's dev server serves all of `public/`.
 */
export const ENV_URL = "/assets/pond.0.glb";
export const DRACO_FILES = [
    "/assets/vendor/draco/draco_wasm_wrapper_gltf.js",
    "/assets/vendor/draco/draco_decoder_gltf.wasm",
    "/assets/vendor/draco/draco_decoder_gltf.js",
];
