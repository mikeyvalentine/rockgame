/**
 * Stones strewn along the beach, as an alternative to a pile — the other half
 * of an A/B you can walk between.
 *
 * A sifting spot is currently a baked bed: 540 stones poured into a heap and
 * settled offline. This is the other option under consideration — the same
 * stones dispersed over a stretch of sand, some sitting proud and some half
 * buried, to be spotted rather than excavated.
 *
 * It is deliberately NOT a second bed format. There is no pour, no settle, no
 * file: a scatter is a function of a seed, so it costs nothing to generate and
 * is identical every load. That is most of why the scattered option is cheaper
 * than it sounds — the whole bake-and-ship pipeline that a pile needs exists
 * because settling a heap is slow and never varies, and none of that applies to
 * stones that never touch each other.
 *
 * The two differ in more than looks, and the comparison is the point:
 *
 *   pile       dense contact, needs a flat level crown, needs a baked bed,
 *              micro-creeps because Havok never sleeps a heap, and is DUG
 *   scattered  no contact, sits on the terrain as it finds it, generated from
 *              a seed, sleeps immediately, and is SPOTTED
 *
 * Placement is rectangular — a stretch of shore, not a disc — because that is
 * the shape the idea is actually about.
 */

/** Deterministic and self-contained, so a scatter needs nothing but its seed. */
function mulberry32(a) {
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * How deep a stone sits, as a fraction of its own radius.
 *
 * Not a constant, because the whole visual idea is that some stones are lying
 * on the sand and others are part-swallowed by it. Skewed toward the shallow
 * end — a beach reads as stones ON sand with a few sinking, not a graveyard.
 */
function burialFor(rng) {
    const t = rng();
    return t * t * 1.15;
}

/**
 * Strew stones over a stretch of shore.
 *
 * @param opts.count      how many
 * @param opts.seed       deterministic; the same seed is the same beach
 * @param opts.halfWidth  metres along the shore (x)
 * @param opts.halfDepth  metres across it (z)
 * @param opts.names      archetype names to draw from
 * @param opts.radiusOf   name -> radius in metres
 * @param opts.heightAt   (x, z) -> ground height; each stone sits where it lands
 * @returns {Array<{name, x, y, z, yaw, tilt, burial, radius}>}
 */
export function scatterStones(spot, {
    count = 180, seed = 4242, halfWidth = 9, halfDepth = 2.2,
    names = [], radiusOf = () => 0.05, heightAt = () => 0,
} = {}) {
    const rng = mulberry32(seed);
    const out = [];
    if (!names.length) return out;

    for (let i = 0; i < count; i++) {
        const name = names[Math.floor(rng() * names.length) % names.length];
        const radius = radiusOf(name) || 0.05;

        // Uniform over the rectangle, then nudged by a second draw so the
        // spacing is not obviously grid-free-but-even. A real strandline is
        // clumpy; this is the cheapest gesture toward that.
        const clump = rng() < 0.35 ? 0.25 : 1;
        const x = spot.x + (rng() * 2 - 1) * halfWidth * clump;
        const z = spot.z + (rng() * 2 - 1) * halfDepth;

        const burial = burialFor(rng);
        // Sits where the sand is, whatever the sand is doing. This is the part
        // a pile cannot do: a baked bed is a rigid snapshot and needs flat
        // ground under all of it, while every stone here is placed on the
        // terrain it actually landed on.
        const y = heightAt(x, z) - burial * radius;

        out.push({
            name, x, y, z, radius, burial,
            yaw: rng() * Math.PI * 2,
            // A stone lying on sand is roughly flat-side-down. A little tilt,
            // not a tumble.
            tilt: (rng() * 2 - 1) * 0.45,
        });
    }
    return out;
}

/** Stones proud enough of the sand to be worth picking up. */
export const isExposed = (s) => s.burial < 0.5;
