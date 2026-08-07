/**
 * The size of the world — the pond, the shore, and where rocks are allowed.
 *
 * Until now there was no world, only a beach that ran off in every direction: a
 * 512 m heightfield under a 3600 x 4000 m water quad that met the horizon. That
 * is a sea, and this game has a pond (CLAUDE.md).
 *
 *   POND    a disc, 200 m across, its near edge at the waterline.
 *   SHORE   70 m along that edge, 25 m deep. Walkable, and the only ground
 *           that carries rocks.
 *
 * The shore is a small bite out of the pond's rim, which is the shape docs/09
 * asks for: "the walkable area is one small coastal stretch — at most 1/8 of
 * the pond's shoreline". 70 m of a 628 m perimeter is about 1/9.
 *
 * Round, so the shore curves
 * --------------------------
 * The pond was a rectangle first, and a rectangle has a dead straight
 * shoreline. A disc gives the strip 6.3 m of bow from its ends to its middle:
 * the water is nearest straight ahead and falls back on both sides, so you
 * stand in a shallow bay with the shore wrapping past you rather than on the
 * edge of a swimming pool.
 *
 * Two coordinates come with that, and most of this file is them:
 *
 *   `shoreDistance(x, z)`   metres from the water's edge, positive on land
 *   `shoreArc(x, z)`        metres along the shoreline, signed like x
 *
 * The strip is a rectangle in *those*, not in world x/z. That is what keeps it
 * 70 x 25 m everywhere on the curve — an axis-aligned box would have run 25 m
 * deep in the middle and 31 m at the ends.
 *
 * Why the profile is written against `shoreDistance`
 * --------------------------------------------------
 * The foreshore ramp used to be `-(z - waterline) * slope` — monotonic, so the
 * ground fell away for ever seaward and the seabed clamp caught it 2.5 m down.
 * Bound the water and that is a hole: past the pond's edge the sand is still
 * 2.5 m under the water level with nothing on top of it. Written against the
 * signed distance instead, one slope raises the beach, digs the basin and
 * lifts the far bank, and the pond is closed on every side by construction.
 *
 * It is also what made curving the shore cheap. Height, walk bounds and rock
 * density all read these two functions, so changing the pond's *shape* is a
 * change to this file and nothing else has an opinion.
 *
 * Conventions, unchanged: metres, water toward +Z, waterline at `WATERLINE_Z`.
 */

import { WATERLINE_Z, FORESHORE_SLOPE, SEABED_DEPTH } from "./shoreRamp.js";

/**
 * Pond radius, metres. Round, so the shoreline curves away on both sides
 * instead of running to a corner: the 70 m you walk is an arc of it, bowing
 * 6.3 m from the ends to the middle.
 */
export const POND_RADIUS = 100;
export const POND_SIZE = POND_RADIUS * 2;

/**
 * Pond centre. Placed a radius behind the waterline so the near edge touches
 * `WATERLINE_Z` exactly at x = 0.
 */
export const POND_CENTER_X = 0;
export const POND_CENTER_Z = WATERLINE_Z + POND_RADIUS;

/** z of the far bank, on the pond's axis. */
export const POND_FAR_Z = WATERLINE_Z + POND_SIZE;

/**
 * The walkable, rock-bearing strip: 70 m of shoreline, 25 m deep.
 *
 * "70 m of shoreline" is now measured along the water's edge rather than along
 * x, and "25 m deep" straight out from it. Both bend with the pond, so the
 * strip is the same size everywhere on it — which the old rectangle was not
 * once the shore curved: it would have run 25 m deep in the middle and 31 m at
 * the ends.
 */
export const SHORE_WIDTH = 70;
export const SHORE_DEPTH = 25;
export const SHORE_HALF_ARC = SHORE_WIDTH / 2;

/**
 * Metres of wading allowed past the waterline.
 *
 * Not part of the 25 m: the strip is measured from the water's edge landward,
 * and this is the bit you are allowed to stand *in*.
 */
export const WADE_DEPTH = 2;

/**
 * No rocks within this many metres of the water.
 *
 * The waves work this band over; shingle ends up thrown further up the beach,
 * which is also why the density climbs landward rather than being uniform.
 */
export const ROCK_FREE_MARGIN = 5;

/**
 * Signed distance from the water's edge, in metres, positive on land.
 *
 * The pond is a disc, so this is a circle's signed distance: negative inside
 * the water, reaching its minimum at the centre, so the same ramp that raises
 * the beach digs the basin and lifts the far bank.
 *
 * @param {number} x @param {number} z world metres
 */
export function shoreDistance(x, z) {
    return Math.hypot(x - POND_CENTER_X, z - POND_CENTER_Z) - POND_RADIUS;
}

/**
 * Position along the shoreline, in metres of arc, zero straight out from the
 * spawn and signed the same way as x.
 *
 * Measured at the waterline rather than at the walker's own radius, so a step
 * sideways at the back of the strip and the same step at the water's edge are
 * the same number — the strip is a rectangle in (arc, depth), which is what
 * makes it 70 m wide everywhere.
 *
 * @param {number} x @param {number} z world metres
 */
export function shoreArc(x, z) {
    return POND_RADIUS * Math.atan2(x - POND_CENTER_X, POND_CENTER_Z - z);
}

/** World position of the point `arc` along the shore and `depth` inland. */
export function shorePoint(arc, depth, out = { x: 0, z: 0 }) {
    const theta = arc / POND_RADIUS;
    const r = POND_RADIUS + depth;
    out.x = POND_CENTER_X + Math.sin(theta) * r;
    out.z = POND_CENTER_Z - Math.cos(theta) * r;
    return out;
}

/**
 * How far the ramp has to run before the seabed clamp takes over, metres.
 *
 * At the pond's radius a 0.035 slope would dig 3.5 m, past the 2.5 m seabed —
 * so the basin is flat-bottomed across its middle and the clamp does the work.
 * Stated here so a change to either number is visibly a change to the floor.
 */
export const RAMP_REACH = SEABED_DEPTH / FORESHORE_SLOPE;

/** True if (x, z) is inside the walkable strip (wading included). */
export function inShore(x, z) {
    const d = shoreDistance(x, z);
    if (d < -WADE_DEPTH || d > SHORE_DEPTH) return false;
    return Math.abs(shoreArc(x, z)) <= SHORE_HALF_ARC;
}

/** True if (x, z) may carry a rock. */
export function inRockField(x, z) {
    const d = shoreDistance(x, z);
    if (d < ROCK_FREE_MARGIN || d > SHORE_DEPTH) return false;
    return Math.abs(shoreArc(x, z)) <= SHORE_HALF_ARC;
}

/**
 * Pull a point back into the walkable strip.
 *
 * In (arc, depth) rather than in x/z: clamping the two world axes would let
 * you cut the corner of the curve, and past the ends of the strip it would
 * slide you along a straight line the shore has left behind.
 *
 * @param {{x:number, z:number}} v mutated in place
 */
export function clampToShore(v) {
    const d = shoreDistance(v.x, v.z);
    const a = shoreArc(v.x, v.z);
    const cd = Math.min(Math.max(d, -WADE_DEPTH), SHORE_DEPTH);
    const ca = Math.min(Math.max(a, -SHORE_HALF_ARC), SHORE_HALF_ARC);
    if (cd === d && ca === a) return;
    shorePoint(ca, cd, v);
}
