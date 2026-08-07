/**
 * The beach, as plain shared data — single source of truth for both renderers
 * and for the headless checks (`tools/beach-profile-check.mjs`).
 *
 * Convention: the sea lies toward +Z. The profile crosses y = WATER_LEVEL_Y
 * exactly at z = WATERLINE_Z, so the static water quad at that height defines
 * the waterline by construction and nothing has to be lined up by hand.
 *
 * The WGSL bake (`heightBake.fragment.wgsl`) and the JS twin below implement
 * the same *structure* but use different noise bases, so their dune fields
 * differ in detail. That is fine by design: each renderer is self-consistent
 * (the WebGPU path grounds on a readback of its own bake; the WebGL path
 * grounds on this function directly), and nothing compares heights across
 * renderers.
 *
 * The sifting pads are the exception to that arrangement, and deliberately so:
 * their WGSL is *generated* from `shared/siftPad.js` rather than hand-twinned,
 * because sand the grounding thinks is level while the bake tilts it is a bed of
 * stones half sunk at one end.
 */

import { padCoverage, padLevel } from "../../../shared/siftPad.js";
import {
    SHORE_HALF_ARC, SHORE_DEPTH, WADE_DEPTH, POND_RADIUS,
    shoreDistance, shorePoint, clampToShore,
} from "../../../shared/worldBounds.js";

export {
    POND_SIZE, POND_RADIUS, POND_CENTER_X, POND_CENTER_Z, POND_FAR_Z,
    SHORE_WIDTH, SHORE_DEPTH, SHORE_HALF_ARC,
    WADE_DEPTH, ROCK_FREE_MARGIN,
    shoreDistance, shoreArc, shorePoint, clampToShore, inShore, inRockField,
} from "../../../shared/worldBounds.js";

// The deterministic shape constants live in shared/shoreRamp.js — siftPad needs
// the foreshore slope to level a pad, and this module imports siftPad, so they
// cannot live here without a cycle. Re-exported, so every existing import site
// is unchanged.
export {
    WATERLINE_Z, WATER_LEVEL_Y, FORESHORE_SLOPE,
    SEABED_DEPTH, BERM_HEIGHT, BERM_RELAX,
} from "../../../shared/shoreRamp.js";

import {
    WATERLINE_Z, FORESHORE_SLOPE, SEABED_DEPTH, BERM_HEIGHT, BERM_RELAX,
} from "../../../shared/shoreRamp.js";

/** Dune backdrop: starts this far landward (z), fades in over DUNE_FADE m. */
export const DUNE_START = -60;
export const DUNE_FADE = 40;
export const DUNE_AMP = 2.2;
/** Base rise under the dune field, so dunes sit on a bank rather than the flat. */
export const DUNE_BASE = 1.0;

/** Micro-relief amplitude on the open beach, metres. Keeps the flat honest. */
export const MICRO_AMP = 0.09;

/**
 * The pebble band (docs decision: pebbles hug the waterline). A gaussian in z
 * centred just landward of the waterline — where waves actually dump shingle —
 * broken into patches along the shore by low-frequency noise.
 */
export const PEBBLE_BAND_CENTER_Z = -4;
export const PEBBLE_BAND_WIDTH = 2.6;

export const WORLD_SIZE = 512;   // metres across the whole field
export const HEIGHT_RES = 2048;  // 0.25 m per texel
export const AUX_RES = 1024;

/**
 * A world-space box around the walkable zone.
 *
 * NOT the zone itself any more. The strip is 70 m of curved shoreline by 25 m
 * deep, which is a rectangle in (arc, depth) and a banana in x/z — see
 * `shared/worldBounds.js`. This is its bounding box, kept for the coarse users
 * that only want "roughly where is the beach" (camera limits, bake extents).
 * Anything that decides whether the player may stand somewhere must go through
 * `inShore` or `clampToShore`.
 */
export const PLAY_RECT = (() => {
    // The strip is a rectangle in (arc, depth), not in x/z, so its world box is
    // the box AROUND the curve — widest at the back, where the arc has swung
    // furthest out, and deepest at the ends, where the shore has fallen back.
    const end = shorePoint(SHORE_HALF_ARC, SHORE_DEPTH);
    const lip = shorePoint(SHORE_HALF_ARC, -WADE_DEPTH);
    return {
        minX: -end.x, maxX: end.x,
        minZ: end.z, maxZ: Math.max(lip.z, WATERLINE_Z + WADE_DEPTH),
    };
})();

/** Where the walker spawns, and the initial view bearing (0 = facing the sea). */
export const SPAWN = { x: 0, z: -15, yaw: 0 };

// ---------------------------------------------------------------------------
// JS twin of the bake, for the WebGL path's grounding and the headless checks.
// ---------------------------------------------------------------------------

/**
 * Deterministic 2D value noise + fbm. Not the GPU's noise — see the header.
 */
function hash2(ix, iz) {
    let h = (ix * 374761393 + iz * 668265263) | 0;
    h = (h ^ (h >> 13)) | 0;
    h = Math.imul(h, 1274126177);
    h = (h ^ (h >> 16)) >>> 0;
    return h / 4294967295;
}

function vnoise(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx);
    const uz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz);
    const b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1);
    const d = hash2(ix + 1, iz + 1);
    return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}

function fbm2(x, z, octaves) {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
        sum += (vnoise(x * f, z * f) * 2 - 1) * amp;
        f *= 2.03;
        amp *= 0.5;
    }
    return sum;
}

function smoothstepJS(a, b, t) {
    const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return x * x * (3 - 2 * x);
}

/**
 * The shore profile, metres. Mirrors the WGSL bake's structure exactly:
 * foreshore ramp → soft seabed clamp → berm relax → dune backdrop → micro.
 * @param {number} x @param {number} z world metres
 * @param {number} [amp] relief multiplier (the `macroHeightScale` setting)
 */
export function shoreProfileJS(x, z, amp = 1) {
    // Foreshore ramp, measured from the water's edge — the signed distance to
    // the pond's disc, positive on land. One slope therefore raises the beach,
    // digs the basin and lifts the far bank, and the pond is closed on every
    // side by construction rather than by lining anything up.
    let h = shoreDistance(x, z) * FORESHORE_SLOPE;

    // Soft clamp into the flat seabed.
    const tSea = smoothstepJS(-SEABED_DEPTH - 1.0, -SEABED_DEPTH + 1.0, h);
    h = -SEABED_DEPTH + (h + SEABED_DEPTH) * tSea;

    // Berm: the upper beach relaxes toward flat.
    const tBerm = smoothstepJS(BERM_HEIGHT - 0.5, BERM_HEIGHT + 1.5, h);
    h = h * (1 - tBerm) + (BERM_HEIGHT + (h - BERM_HEIGHT) * BERM_RELAX) * tBerm;

    // Dune backdrop, fading in landward of DUNE_START.
    const duneT = smoothstepJS(DUNE_START, DUNE_START - DUNE_FADE, z);
    let relief = 0;
    if (duneT > 0) {
        relief += (DUNE_BASE + fbm2(x / 38, z / 24, 4) * DUNE_AMP) * duneT;
    }

    // Sifting pads — the sifting spots, from shared/siftPad.js. Applied before
    // micro relief because the pad has to end up flat AND level: rock-sift's
    // bed is poured on flat ground, so the pad damps micro relief in proportion
    // to its coverage rather than levelling on top of it. It adds no height.
    //
    // Outside `amp` on purpose: the pads are where the player sifts, so this is
    // a correctness term, not an art-direction relief tunable.
    const cov = padCoverage(x, z);

    // Micro relief on the open beach (fades out under the dunes, and under
    // the pads).
    relief += fbm2(x / 21 + 7.3, z / 21 - 4.1, 3) * MICRO_AMP *
        (1 - duneT * 0.7) * (1 - cov);

    return h + relief * amp + padLevel(x, z);
}

/** Pull the walker back into the strip, in place. */
export function clampToPlayRect(v) {
    // Kept under its old name because half the app calls it, but it is not a
    // rectangle clamp any more: clamping x and z independently would let you
    // cut the corner of the curve, and past the ends of the strip it would
    // slide you along a straight line the shore has left behind.
    clampToShore(v);
}
