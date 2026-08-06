/**
 * The size of the world — the pond, the shore, and where rocks are allowed.
 *
 * Until now there was no world, only a beach that ran off in every direction: a
 * 512 m heightfield under a 3600 x 4000 m water quad that met the horizon. That
 * is a sea, and this game has a pond (CLAUDE.md). Nothing bounded the walkable
 * strip either except `PLAY_RECT`, a rectangle picked by eye.
 *
 * Two rectangles now, and everything else is derived from them:
 *
 *   POND    200 x 200 m of water, its near edge at the waterline.
 *   SHORE    70 m along that near edge, 25 m deep. Walkable, and the only
 *            ground that carries rocks.
 *
 * The shore is a small bite out of one edge of the pond, which is the shape
 * docs/09 asks for: "the walkable area is one small coastal stretch — at most
 * 1/8 of the pond's shoreline". 70 m of a 200 m edge is a bit over that; the
 * pond's perimeter is 800 m, so it is closer to 1/11.
 *
 * Conventions, unchanged: metres, sea toward +Z, waterline at `WATERLINE_Z`.
 *
 * Why the profile has to know about the far edge
 * ----------------------------------------------
 * The shore ramp used to be `-(z - waterline) * slope` — monotonic, so the
 * ground fell away for ever seaward and the seabed clamp caught it at 2.5 m
 * down. Bound the water at 200 m and that becomes a hole: past the pond's far
 * edge the sand is still 2.5 m under the water level with no water on top of
 * it. So the ramp is expressed against the *nearest* water edge instead, which
 * gives a far bank rising out of the pond for free and leaves the near shore's
 * numbers untouched.
 */

import { WATERLINE_Z, FORESHORE_SLOPE, SEABED_DEPTH } from "./shoreRamp.js";

/** Pond extent, metres. Square, centred on x = 0, near edge at the waterline. */
export const POND_SIZE = 200;
export const POND_HALF_X = POND_SIZE / 2;
/** z of the far bank's waterline. The near one is `WATERLINE_Z`. */
export const POND_FAR_Z = WATERLINE_Z + POND_SIZE;

/** The walkable, rock-bearing strip. 70 m of shoreline, 25 m deep. */
export const SHORE_WIDTH = 70;
export const SHORE_DEPTH = 25;
export const SHORE_HALF_X = SHORE_WIDTH / 2;
/** Landward limit of the strip. */
export const SHORE_BACK_Z = WATERLINE_Z - SHORE_DEPTH;

/**
 * Metres of wading allowed past the waterline.
 *
 * Not part of the 25 m: the strip is measured from the water's edge landward,
 * and this is the bit you are allowed to stand *in*. Inherited from the old
 * `PLAY_RECT`, where it was the only thing that let you walk to the edge
 * without the clamp fighting you a step early.
 */
export const WADE_DEPTH = 2;

/**
 * No rocks within this many metres of the water.
 *
 * The waves work this band over; shingle ends up thrown further up the beach,
 * which is also why the density climbs landward rather than being uniform.
 */
export const ROCK_FREE_MARGIN = 5;

/** Seaward limit of rock placement. */
export const ROCK_EDGE_Z = WATERLINE_Z - ROCK_FREE_MARGIN;

/** Centre of the pond in z. x is centred on 0. */
export const POND_CENTER_Z = WATERLINE_Z + POND_SIZE / 2;

/**
 * Signed distance from the water's edge, in metres, positive on land.
 *
 * The plain signed distance to the pond's rectangle. Inside it this is negative
 * and reaches its minimum at the middle, so the same ramp that raises the beach
 * digs the basin; outside it rises on all four sides, which is what gives the
 * far and side banks.
 *
 * It has to be the distance to a *rectangle* and not to the near waterline,
 * because the pond is bounded in x as well: measured against a line, the ground
 * beside the pond would still be 2.5 m under water level with no water on it —
 * a trench running away on both sides.
 *
 * On the playable strip (|x| <= 35, z <= 0) the nearest point of the rectangle
 * is straight ahead, so this returns exactly `WATERLINE_Z - z` and the beach is
 * the beach it always was.
 *
 * @param {number} x @param {number} z world metres
 */
export function shoreDistance(x, z) {
    const qx = Math.abs(x) - POND_HALF_X;
    const qz = Math.abs(z - POND_CENTER_Z) - POND_SIZE / 2;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0));
    const inside = Math.min(Math.max(qx, qz), 0);
    return outside + inside;
}

/**
 * How far the ramp has to run before the seabed clamp takes over, metres.
 *
 * At the pond's half-width (100 m) a 0.035 slope would dig 3.5 m, past the
 * 2.5 m seabed — so the basin is flat-bottomed across its middle and the clamp
 * does the work, exactly as it did when the sea ran to the horizon. Stated
 * here so a change to either number is visibly a change to the pond's floor.
 */
export const RAMP_REACH = SEABED_DEPTH / FORESHORE_SLOPE;

/** True if (x, z) is inside the walkable strip (wading included). */
export function inShore(x, z) {
    return x >= -SHORE_HALF_X && x <= SHORE_HALF_X
        && z >= SHORE_BACK_Z && z <= WATERLINE_Z + WADE_DEPTH;
}

/** True if (x, z) may carry a rock. */
export function inRockField(x, z) {
    return x >= -SHORE_HALF_X && x <= SHORE_HALF_X
        && z >= SHORE_BACK_Z && z <= ROCK_EDGE_Z;
}
