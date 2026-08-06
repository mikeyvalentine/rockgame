/**
 * The stones on the shore — where every one of them is.
 *
 * This replaces the four sifting spots. Instead of 620 stones poured into each
 * of four beds with bare sand between them, the whole 70 x 25 m strip carries
 * rocks, thinning to nothing at the water's edge. Any stone the player can see
 * is a stone in this field, which is what makes "inspect anything" possible at
 * all: there is no longer a privileged patch to walk to.
 *
 * Not physics
 * -----------
 * The beds were snapshots of a Havok pour — 620 rigid bodies dropped on flat
 * ground and left to settle, baked to a file. That buys stones resting against
 * each other in ways nothing procedural gets for free, and it costs a level
 * pad under every bed (`shared/siftPad.js`), a bed format, a bake step, and a
 * simulation nobody watches.
 *
 * A shore's worth of that is not affordable and not wanted. Here a stone is
 * placed, not dropped: rejected if it would overlap a neighbour, sunk into the
 * sand by a fraction of its own size, and tilted to the ground it sits on.
 * "Settled" is a property of the output rather than something simulated to
 * reach. The cost is that stones never lean on one another — which is a real
 * loss of texture, and the reason the dense sift beds may come back later as
 * an overlay on top of this rather than as a replacement for it.
 *
 * Determinism
 * -----------
 * Rule 4 in CLAUDE.md. Same seed, same stones, everywhere — so the field can be
 * regenerated on any client instead of shipped, and so a check can assert
 * things about it. The RNG is `mulberry32` walked in one fixed order; nothing
 * here reads `Math.random`, the clock, or the player's position.
 *
 * Units are metres.
 */

import { mulberry32 } from "../rock-forge/src/forge/rng.js";
import {
    SHORE_HALF_X, SHORE_BACK_Z, SHORE_DEPTH, ROCK_FREE_MARGIN, ROCK_EDGE_Z,
} from "./worldBounds.js";
import { WATERLINE_Z } from "./shoreRamp.js";

/** Default seed for the shore field. Distinct from the forge's `ROCK_SEED`. */
export const SCATTER_SEED = 20260806;

/**
 * Stones per square metre at the back of the strip, where the field is densest.
 *
 * A "decide in engine" number in the CLAUDE.md sense — how covered the beach
 * looks is a judgement made by standing on it, and it trades directly against
 * the triangle budget, so it is set by measuring rather than by arithmetic.
 *
 * What the arithmetic does say: the quadratic ramp averages a third of the
 * peak, so 54/m^2 over the 1,400 m^2 that carries anything is about 21,000
 * stones, covering roughly 14% of the ground at a 6 cm mean across.
 *
 * Set by looking. At a third of this the beach reads as sprinkled rather than
 * stony; at double it the back of the strip runs together into an even carpet
 * and the ramp away from the water stops being the thing you notice.
 *
 * The ceiling is structural, not a matter of taste: one candidate per grid
 * cell means the field cannot exceed `1 / cell^2`, about 290/m^2.
 */
export const PEAK_DENSITY = 54;

/**
 * How the density climbs away from the water.
 *
 * Zero inside `ROCK_FREE_MARGIN` — the waves work that band over and throw the
 * shingle further up the beach. Past it the density rises with the square of
 * how far you are up the strip, so the thinning near the water is gradual and
 * the back half carries most of the stones. Squared rather than linear because
 * a linear ramp still leaves an obvious line where the field starts.
 *
 * @param {number} z world metres
 * @returns {number} stones per square metre
 */
export function densityAt(z) {
    const d = WATERLINE_Z - z;               // metres landward of the water
    if (d <= ROCK_FREE_MARGIN) return 0;
    if (d >= SHORE_DEPTH) return PEAK_DENSITY;
    const t = (d - ROCK_FREE_MARGIN) / (SHORE_DEPTH - ROCK_FREE_MARGIN);
    return PEAK_DENSITY * t * t;
}

/**
 * Minimum gap between two stones' edges, metres.
 *
 * Non-zero on purpose. Stones placed edge-to-edge would be legal — they are not
 * overlapping — but a field with contacts in it looks piled, and nothing here
 * simulates a pile, so they would be contacts that carry no weight. Keeping a
 * few millimetres between them makes the field read as scattered.
 */
export const MIN_GAP = 0.012;

/**
 * How deep a stone sits in the sand, as a fraction of its size.
 *
 * A stone resting on sand is not tangent to it: it has pressed a dish and sits
 * in it. This is the same displacement the deformation buffer draws as a dent,
 * so the two have to agree or a stone hovers over its own mark.
 */
export const SINK_FRACTION = 0.22;

/**
 * Generate the field.
 *
 * Dart-throwing over a jittered grid, which is Poisson-disk sampling with the
 * expensive part removed: one candidate per cell rather than an active list, so
 * the pass is a single ordered sweep and therefore trivially deterministic. The
 * cell is sized to the largest stone, and a neighbourhood of 3x3 cells is
 * enough to catch every possible conflict.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {number} [opts.density]  multiplier on `densityAt`
 * @param {(x:number,z:number)=>number} [opts.heightAt]  ground height, metres.
 *   Defaults to a flat beach — the caller passes the terrain's own sampler.
 * @param {Array<{sizeMetres:number}>} opts.cast  the archetype cast; an index
 *   into it is stored per stone rather than a mesh, so this module stays free
 *   of Babylon and of the forge's bake.
 * @returns {Array<{x:number,z:number,y:number,yaw:number,tilt:number,
 *                  archetype:number,radius:number}>}
 */
export function scatterShore(opts = {}) {
    const {
        seed = SCATTER_SEED,
        density = 1,
        heightAt = () => 0,
        cast = [],
    } = opts;
    if (!cast.length) return [];

    const rng = mulberry32(seed);

    // Half-extents, so "radius" below means what it says.
    const radii = cast.map((c) => (c.sizeMetres ?? 0.06) * 0.5);
    const maxRadius = Math.max(...radii);

    // The cell is a stone's RADIUS, not its diameter, and the conflict search
    // below widens to compensate.
    //
    // Sizing the cell to the largest possible pair (2 * maxRadius + gap) would
    // be the obvious choice and it caps the field at one stone per cell — about
    // 73/m^2, close enough to the densities that look right that the back of
    // the beach saturates into an even carpet and the density ramp flattens out
    // exactly where it should be strongest. Halving the cell lifts the ceiling
    // four-fold; searching +/-2 cells instead of +/-1 covers 5 cells across,
    // which still contains every pair that could touch.
    const cell = maxRadius + MIN_GAP;
    const REACH = 2;

    const minX = -SHORE_HALF_X;
    const minZ = SHORE_BACK_Z;
    const cols = Math.ceil((SHORE_HALF_X * 2) / cell);
    const rows = Math.ceil((WATERLINE_Z - SHORE_BACK_Z) / cell);

    const out = [];
    /** Accepted stones per cell — the grid IS the spatial index. */
    const grid = new Array(cols * rows);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            // One candidate per cell. Its position is jittered inside the cell,
            // so the field has no grid in it even though it was built on one.
            const x = minX + (c + rng()) * cell;
            const z = minZ + (r + rng()) * cell;
            const pick = rng();
            const spin = rng();
            const lean = rng();

            // Accept-or-not by density. `cell * cell` stones per cell would be
            // one every cell; scale that by how many the density asks for.
            const want = densityAt(z) * density * cell * cell;
            if (pick >= want) continue;

            // Which stone. Uses the same draw so the archetype and the accept
            // test cannot desynchronise if the density changes.
            const archetype = Math.min(
                cast.length - 1, (pick / Math.max(want, 1e-9) * cast.length) | 0
            );
            const radius = radii[archetype];

            // The grid is ceil()'d, so its last row and column overhang the
            // strip. Reject on the stone's whole footprint rather than its
            // centre — a stone half over the edge of the field is a stone
            // sticking out of the world.
            if (x - radius < minX || x + radius > SHORE_HALF_X) continue;
            if (z - radius < minZ || z + radius > ROCK_EDGE_Z) continue;

            if (overlaps(grid, cols, rows, cell, minX, minZ, x, z, radius, REACH)) continue;

            const idx = r * cols + c;
            (grid[idx] ??= []).push({ x, z, radius });

            out.push({
                x, z,
                y: heightAt(x, z) - radius * SINK_FRACTION,
                yaw: spin * Math.PI * 2,
                // A few degrees of lean, so the field is not a carpet of stones
                // all lying dead flat.
                tilt: (lean - 0.5) * 0.35,
                archetype,
                radius,
            });
        }
    }
    return out;
}

/** True if a stone of `radius` at (x, z) would touch anything already placed. */
function overlaps(grid, cols, rows, cell, minX, minZ, x, z, radius, reach) {
    const c0 = Math.floor((x - minX) / cell);
    const r0 = Math.floor((z - minZ) / cell);
    for (let r = r0 - reach; r <= r0 + reach; r++) {
        if (r < 0 || r >= rows) continue;
        for (let c = c0 - reach; c <= c0 + reach; c++) {
            if (c < 0 || c >= cols) continue;
            const bucket = grid[r * cols + c];
            if (!bucket) continue;
            for (const o of bucket) {
                const need = radius + o.radius + MIN_GAP;
                const dx = x - o.x;
                const dz = z - o.z;
                if (dx * dx + dz * dz < need * need) return true;
            }
        }
    }
    return false;
}
