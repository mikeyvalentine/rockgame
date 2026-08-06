/**
 * The sand a bed is pressed into — permanent, world-anchored, one layer per spot.
 *
 * Two things want this and they turn out to be the same thing:
 *
 *   1. A bed of 540 stones has been sitting there. The sand under it should
 *      already be dented, not pristine — and every stone's resting position is
 *      in the bed file, so the imprint is derivable rather than authored.
 *   2. A stone thrown aside while sifting should leave a hole that STAYS. Dig a
 *      bed out and walk away, and the pits you made should still be there.
 *
 * Why not the DeformationField
 * ----------------------------
 * For exactly the reason the piles could not live there either. It covers 80 m
 * centred on the player, addressed toroidally, and it *relaxes* — it is built
 * for footprints and surf wake, marks that should fade. A divot written there
 * softens away and then vanishes outright the moment the player walks 80 m off.
 * Resolution is not the problem: at 3.9 cm texels it is already stone-scale.
 * Persistence is.
 *
 * So this is a small fixed grid per spot, anchored in world space, that never
 * relaxes and never scrolls. Four of them is a rounding error — 256² of R32F is
 * 256 KB, against the deformation field's 2048² of RGBA16F.
 *
 * Not circular
 * ------------
 * The extent is a rectangle with its own half-width and half-depth rather than
 * a radius, because the stones are meant to spread along the beach later
 * instead of sitting in a disc. A strip is then a wider extent, not a new
 * concept — and nothing here asks how far a point is from a centre.
 *
 * Units are metres, and depth is positive-down: `depthAt` returns how far the
 * sand has been pressed BELOW the surface it would otherwise have.
 */

/** Texels across each axis of a spot's layer. 256 over 4 m is 1.6 cm. */
export const IMPRINT_RES = 256;

/**
 * Half-extent of a spot's layer, metres. Covers the bed and a margin for the
 * stones a sweep pushes past its edge.
 */
export const IMPRINT_HALF = 2.0;

/**
 * How deep a resting stone presses the sand, as a fraction of its own radius.
 *
 * A pebble on dry sand settles a little way in and stops; it does not sink to
 * its own diameter. A third of the radius reads as "resting in" rather than
 * "resting on" without the bed appearing to drown.
 */
export const BED_PRESS = 0.34;

/** Beyond this many stone radii a stone presses nothing. Keeps the stamp local. */
const PRESS_REACH = 1.35;

export class SpotImprint {
    /**
     * @param {{x: number, z: number}} spot centre, world metres
     */
    constructor(spot, { res = IMPRINT_RES, half = IMPRINT_HALF } = {}) {
        this.spot = spot;
        this.res = res;
        this.half = half;
        this.texel = (half * 2) / res;
        /** Depth below the nominal surface, metres, positive-down. */
        this.depth = new Float32Array(res * res);
    }

    /** Grid index for a world point, or -1 if it falls outside this spot. */
    indexAt(x, z) {
        const gx = Math.floor((x - this.spot.x + this.half) / this.texel);
        const gz = Math.floor((z - this.spot.z + this.half) / this.texel);
        if (gx < 0 || gz < 0 || gx >= this.res || gz >= this.res) return -1;
        return gz * this.res + gx;
    }

    /** Depth at a world point, metres. Zero outside the layer. */
    depthAt(x, z) {
        const i = this.indexAt(x, z);
        return i < 0 ? 0 : this.depth[i];
    }

    /**
     * Press a stone into the sand.
     *
     * `max`, not `+=`: two stones resting in the same dip make one dip, not one
     * twice as deep. That also makes the bed imprint order-independent, which
     * is what lets it be baked from the bed file and get the same answer every
     * load.
     *
     * The profile is a smooth dome rather than a disc so the rim has no step —
     * a hard edge here reads as a stamped cookie-cutter hole rather than sand.
     */
    press(x, z, radius, depth) {
        const reach = radius * PRESS_REACH;
        const g0x = Math.floor((x - reach - this.spot.x + this.half) / this.texel);
        const g1x = Math.ceil((x + reach - this.spot.x + this.half) / this.texel);
        const g0z = Math.floor((z - reach - this.spot.z + this.half) / this.texel);
        const g1z = Math.ceil((z + reach - this.spot.z + this.half) / this.texel);

        for (let gz = Math.max(0, g0z); gz <= Math.min(this.res - 1, g1z); gz++) {
            const wz = this.spot.z - this.half + (gz + 0.5) * this.texel;
            for (let gx = Math.max(0, g0x); gx <= Math.min(this.res - 1, g1x); gx++) {
                const wx = this.spot.x - this.half + (gx + 0.5) * this.texel;
                const d = Math.hypot(wx - x, wz - z);
                if (d >= reach) continue;
                const t = 1 - d / reach;
                const falloff = t * t * (3 - 2 * t);
                const i = gz * this.res + gx;
                const v = depth * falloff;
                if (v > this.depth[i]) this.depth[i] = v;
            }
        }
    }

    /** Deepest point in the layer, metres. */
    maxDepth() {
        let m = 0;
        for (let i = 0; i < this.depth.length; i++) if (this.depth[i] > m) m = this.depth[i];
        return m;
    }

    /** Fraction of the layer that has been pressed at all. */
    coverage() {
        let n = 0;
        for (let i = 0; i < this.depth.length; i++) if (this.depth[i] > 0) n++;
        return n / this.depth.length;
    }
}

/**
 * The imprint a resting bed has already made.
 *
 * Derived, not authored: the bed file holds every stone's resting position, so
 * the sand it has been sitting in is a function of the bed rather than
 * something to hand-place. Deterministic for a given bed, which matters because
 * the beach has to look the same every load.
 *
 * @param imprint   a SpotImprint for this spot
 * @param bed       a decoded bed
 * @param radiusOf  stone name -> radius in metres
 * @param opts.unitScale  world units per metre in the bed file (rock-sift's U)
 * @param opts.baseY      crown height; stones far above it are resting ON the
 *                        pile rather than in the sand, and press nothing
 */
export function bakeBedImprint(imprint, bed, radiusOf, { unitScale = 4, baseY = 0, spot } = {}) {
    const at = spot ?? imprint.spot;
    let pressed = 0;

    for (let i = 0; i < bed.count; i++) {
        const name = bed.names[bed.archIndex[i]];
        const radius = radiusOf(name);
        if (!(radius > 0)) continue;

        const x = bed.positions[i * 3] / unitScale + at.x;
        const y = bed.positions[i * 3 + 1] / unitScale + baseY;
        const z = bed.positions[i * 3 + 2] / unitScale + at.z;

        // Only the layer actually touching the sand leaves a mark. A stone
        // sitting on three others is holding up the pile, not denting the
        // beach, and pressing for all 540 would flatten the whole crown.
        if (y - baseY > radius * 1.6) continue;

        imprint.press(x, z, radius, radius * BED_PRESS);
        pressed++;
    }
    return pressed;
}
