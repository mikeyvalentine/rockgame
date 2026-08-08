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

/** Default seed for the shore field. Distinct from the forge's `ROCK_SEED`. */
export const SCATTER_SEED = 20260806;

/**
 * Stones per square metre at the back of the strip, where the field is densest.
 *
 * A "decide in engine" number in the CLAUDE.md sense — how covered the beach
 * looks is a judgement made by standing on it, and it trades directly against
 * the triangle budget, so it is set by measuring rather than by arithmetic.
 *
 * This is what is ASKED for, per attempt, not what lands — most candidates are
 * rejected against a neighbour, and the harder the field is pushed the more of
 * them are. At 160 the back of the strip settles around 145 stones/m^2, and the
 * field is about 120,000 stones.
 *
 * The ceiling is geometric and it is not far above that. Stones of this size
 * mix jam at roughly 41% of the ground covered, around 170/m^2 — pushing the
 * multiplier past 8 buys single-digit percentages for linearly more work, and
 * past 16 the field gets slightly *worse* as the big stones crowd out the small
 * ones that were filling the gaps.
 */
export const PEAK_DENSITY = 160;

/** A hair of clear sand right at the water, metres of HEIGHT above it. */
export const ROCK_FREE_RISE = 0.03;

/** Rocks fade out by this HEIGHT above the water, metres — the shingle band. */
export const BEACH_TOP_RISE = 1.5;

/**
 * How dense the shingle is at a given HEIGHT above the waterline.
 *
 * A shingle beach is heaviest right at the water and thins as it climbs, so the
 * density peaks just above the wet edge and falls to nothing by BEACH_TOP_RISE —
 * which keeps the rocks a low band hugging the shore rather than carpeting the
 * whole clearing up to the trees. Driven by height (from the authored terrain),
 * not distance, so it follows the real slope of the beach automatically.
 *
 * @param {number} above metres of terrain height above the waterline
 * @returns {number} stones per square metre asked for
 */
export function densityAt(above) {
    if (above < ROCK_FREE_RISE || above > BEACH_TOP_RISE) return 0;
    const t = (above - ROCK_FREE_RISE) / (BEACH_TOP_RISE - ROCK_FREE_RISE);
    // Full near the water (t=0), squared fade to zero at the top.
    const f = 1 - t;
    return PEAK_DENSITY * f * f;
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
 * Candidates thrown per grid cell.
 *
 * One was the obvious choice and it is what caps the field. Single-shot dart
 * throwing jams at about a third of what the ground will actually hold: the
 * first stone in a cell blocks the cell, so every gap a stone leaves beside
 * itself is a gap nothing ever tries to fill. Throwing several and keeping
 * whichever survive lets the small stones settle into the spaces the big ones
 * left, which is both denser and how a shingle beach is actually graded.
 *
 * Six, because the returns fall off hard — the seventh candidate lands in an
 * occupied cell almost every time — and every one of them is paid for whether
 * it is accepted or not.
 */
export const ATTEMPTS = 6;

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
 * Placed across the sandy CLEARING the world infers around the spawn (see
 * `worldEnv.clearing`): a candidate is kept only where the clearing says there
 * is reachable sand, so rocks never land in the water or in the trees, and the
 * density is by terrain HEIGHT above the water — a shingle band hugging the
 * shore, thinning out before the treeline. Working in world x/z over the
 * clearing's own bounding box; the arc-strip model it replaced is gone with the
 * placeholder pond.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {number} [opts.density]  multiplier on `densityAt`
 * @param {(x:number,z:number)=>number} [opts.heightAt]  ground height, metres
 * @param {number} [opts.waterLevel]  y of the waterline
 * @param {{contains:(x:number,z:number)=>boolean, origin:{x:number,z:number},
 *          cell:number, res:number}} opts.clearing  the reachable sand mask
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
        waterLevel = 0,
        clearing = null,
        cast = [],
    } = opts;
    if (!cast.length || !clearing) return [];

    const rng = mulberry32(seed);

    // Half-extents, so "radius" below means what it says.
    const radii = cast.map((c) => (c.sizeMetres ?? 0.06) * 0.5);
    const maxRadius = Math.max(...radii);

    // The cell is a stone's RADIUS, not its diameter; the conflict search below
    // widens by +/-2 cells to compensate. (See the long note in git history —
    // halving the cell lifts the density ceiling four-fold.)
    const cell = maxRadius + MIN_GAP;
    const REACH = 2;

    // Grid over the clearing's own world bounding box, in x/z. No arc/depth: the
    // field is a patch of real sand now, not a rectangle in a curved strip.
    const originX = clearing.origin.x;
    const originZ = clearing.origin.z;
    const span = clearing.res * clearing.cell;
    const cols = Math.ceil(span / cell);
    const rows = Math.ceil(span / cell);

    const out = [];
    /** Accepted stones per cell — the grid IS the spatial index. */
    const grid = new Array(cols * rows);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            // Several candidates per cell, each jittered inside it, so the
            // field has no grid in it even though it was built on one.
            const x = originX + (c + rng()) * cell;
            const z = originZ + (r + rng()) * cell;
            const pick = rng();
            const spin = rng();
            const lean = rng();

            // Only on reachable sand — the clearing already excludes water and
            // the treeline, so this is the whole boundary test.
            if (!clearing.contains(x, z)) continue;

            const above = heightAt(x, z) - waterLevel;
            const want = densityAt(above) * density * cell * cell;
            if (pick >= want) continue;

            // Which stone. Uses the same draw so the archetype and the accept
            // test cannot desynchronise if the density changes.
            const archetype = Math.min(
                cast.length - 1, (pick / Math.max(want, 1e-9) * cast.length) | 0
            );
            const radius = radii[archetype];

            if (overlaps(grid, cols, rows, cell, originX, originZ, x, z, radius, REACH)) continue;

            const gc = Math.floor((x - originX) / cell);
            const gr = Math.floor((z - originZ) / cell);
            (grid[gr * cols + gc] ??= []).push({ x, z, radius });

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
    }
    return out;
}

/** True if a stone of `radius` at world (x, z) would touch anything placed. */
function overlaps(grid, cols, rows, cell, originX, originZ, x, z, radius, reach) {
    const c0 = Math.floor((x - originX) / cell);
    const r0 = Math.floor((z - originZ) / cell);
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
