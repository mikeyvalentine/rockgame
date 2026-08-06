/**
 * The imprint layers, connected — one per spot, and the terrain reads them.
 *
 * `shared/spotImprint.js` had the maths and no consumer for a while, which is
 * indistinguishable from working unless you go looking. This is the consumer.
 *
 * Two things press the sand:
 *
 *   1. **The bed, at placement.** Hundreds of stones have been resting there; the sand
 *      under them should already be dented. Every resting position is in the
 *      bed file, so this is derived rather than authored — no bake step, no
 *      asset, just a pass over the transforms the spot was placed with.
 *   2. **Stones while sifting.** A stone shoved aside or dropped leaves a hole,
 *      and unlike a footprint it STAYS. That is the whole reason this is not
 *      the deformation field, which relaxes and is anchored to the player.
 *
 * How the dent is felt
 * --------------------
 * By wrapping `terrain.heightAt`. The beach's own profile is unchanged; what
 * the rest of the app sees is that height minus whatever has been pressed into
 * it. That single hook is enough for everything that grounds on the terrain —
 * the walker, and stones spawned onto a bed that has already been dug.
 *
 * How the dent is SEEN
 * --------------------
 * Through the deformation field, exactly the way a footprint is. Its own header
 * settles this: "Everything that touches the snow writes here through `brush()`
 * — feet, the surf wake, every spell. That shared write path is what makes the
 * effects part of the snow rather than decals floating above it." A stone is
 * just another thing that touches the sand.
 *
 * An earlier version of this file claimed the divots could not be drawn without
 * new shader work on both renderers. That was wrong, and the mistake is worth
 * naming: "it must persist" was treated as ruling the deformation field out,
 * and the ruling-out quietly took visibility with it. They are two separate
 * requirements and they want two mechanisms —
 *
 *   the field    draws it, and forgets, because it relaxes and follows the player
 *   this layer   remembers it, and does not draw
 *
 * — so a divot is written to both, and re-stamped into the field when the
 * player comes back to a spot. Nothing about that needs a shader touched.
 */

import {
    SpotImprint, bakeBedImprint, IMPRINT_HALF,
} from "../../../shared/spotImprint.js";
import { SIFT_SPOTS } from "../../../shared/siftPad.js";
import { U } from "./siftingBeds.js";

/**
 * Speed below which a moving stone is settling rather than landing, m/s.
 *
 * Every stone in a dug bed is jostling slightly — rock-sift documents that a
 * dense pile of hulls never fully sleeps. Pressing on every contact would carve
 * the whole crown away over a minute of sifting, so only a stone actually
 * arriving somewhere counts.
 */
const IMPACT_SPEED = 0.35;

/** How deep an impact presses, against a resting stone's BED_PRESS. */
const IMPACT_PRESS = 0.6;

export class Imprints {
    /**
     * @param terrain  wrapped, not modified — see `heightAt` below
     * @param beds     the handle from `buildSiftingBeds`
     */
    constructor(terrain, beds, deform = null) {
        this.terrain = terrain;
        // The thing that draws marks. Optional: on a machine with no half-float
        // render targets the field is off (webglApp warns and carries on), and
        // the imprint should still be felt even when it cannot be seen.
        this.deform = deform;
        this.layers = new Map();

        for (const spot of SIFT_SPOTS) {
            const layer = new SpotImprint(spot);
            this.layers.set(spot.id, layer);

            // The bed's own imprint, from the transforms this spot was placed
            // with. Every stone in a single-layer bed is touching the sand, so
            // unlike the old four-deep heap this is very nearly all of them.
            const entry = beds?.bedForSpot?.get(spot.id);
            if (entry) {
                const radiusOf = new Map(
                    (beds.archetypeList ?? []).map((a) => [a.name, a.radius])
                );
                bakeBedImprint(layer, entry.bed, (n) => radiusOf.get(n) ?? 0.05, {
                    unitScale: U, baseY: entry.baseY, spot,
                });
            }
        }
    }

    /** Metres pressed into the sand at a point, across every spot. */
    depthAt(x, z) {
        let d = 0;
        for (const layer of this.layers.values()) d += layer.depthAt(x, z);
        return d;
    }

    /**
     * A terrain that has been dug.
     *
     * Returned as a wrapper rather than by patching the original, so the bare
     * shore profile stays available and nothing has to guess which it is
     * holding.
     */
    wrapTerrain() {
        const base = this.terrain;
        const self = this;
        return {
            ...base,
            heightAt: (x, z) => base.heightAt(x, z) - self.depthAt(x, z),
            normalAt: (x, z, out) => {
                // Differenced through the same wrapper, so a divot's walls tilt
                // the walker rather than being a hole it stands flat in.
                const e = 0.12;
                const hx = (base.heightAt(x + e, z) - self.depthAt(x + e, z))
                    - (base.heightAt(x - e, z) - self.depthAt(x - e, z));
                const hz = (base.heightAt(x, z + e) - self.depthAt(x, z + e))
                    - (base.heightAt(x, z - e) - self.depthAt(x, z - e));
                out.set(-hx / (2 * e), 1, -hz / (2 * e));
                out.normalize();
                return out;
            },
        };
    }

    /**
     * Press the sand where stones are landing. Called each frame while crouched.
     *
     * Only stones moving, and only those slowed to near rest — a stone still
     * travelling has not arrived yet, and a stone merely jostling in a pile is
     * not making a hole.
     */
    pressImpacts(awake) {
        if (!awake) return 0;
        const layer = this.layers.get(awake.spot.id);
        if (!layer) return 0;

        let pressed = 0;
        for (const r of awake.rocks) {
            const v = r.body.getLinearVelocity();
            const speed = Math.hypot(v.x, v.y, v.z);
            if (speed < 0.02 || speed > IMPACT_SPEED) continue;
            const radius = r.arch?.radius ?? 0.05;
            const depth = radius * IMPACT_PRESS;
            layer.press(r.node.position.x, r.node.position.z, radius, depth);
            // And drawn, the same way a boot is. The berm is half the depth,
            // as it is for a footfall: displaced sand has to go somewhere.
            this.deform?.brush(
                r.node.position.x, r.node.position.z,
                radius * 1.6, depth, depth * 0.5, 0.2, 0, 0, 1, 0.85
            );
            pressed++;
        }
        return pressed;
    }

    /**
     * Redraw a spot's remembered dents into the deformation field.
     *
     * The field relaxes and is anchored to the player, so by the time someone
     * walks back to a bed they dug yesterday it has forgotten every hole. This
     * is what makes the memory visible again: on crouching, the layer replays
     * itself as brushes.
     *
     * Sampled on a coarse grid rather than replayed stone by stone — the field
     * takes 96 brushes a frame and a dug bed can hold far more presses than
     * that, so what is redrawn is the SHAPE of the excavation rather than every
     * event that made it.
     */
    restamp(spotId, { step = 0.25, maxBrushes = 80 } = {}) {
        const layer = this.layers.get(spotId);
        if (!layer || !this.deform) return 0;
        const spot = SIFT_SPOTS.find((s) => s.id === spotId);
        if (!spot) return 0;

        const found = [];
        for (let dx = -IMPRINT_HALF; dx <= IMPRINT_HALF; dx += step) {
            for (let dz = -IMPRINT_HALF; dz <= IMPRINT_HALF; dz += step) {
                const d = layer.depthAt(spot.x + dx, spot.z + dz);
                if (d > 0.004) found.push({ x: spot.x + dx, z: spot.z + dz, d });
            }
        }
        // Deepest first, so if the bed is more dug than the budget allows it is
        // the real holes that survive the truncation rather than an arbitrary
        // corner of the grid.
        found.sort((a, b) => b.d - a.d);
        const drawn = found.slice(0, maxBrushes);
        for (const f of drawn) {
            this.deform.brush(f.x, f.z, step * 1.5, f.d, f.d * 0.4, 0.25, 0, 0, 1, 0.8);
        }
        return drawn.length;
    }

    /**
     * Keep the nearest spot's dents drawn while the player can see them.
     *
     * `restamp` on crouching is not enough on its own. The dents are most of
     * what makes a bed read as stones lying IN the sand rather than on it, and
     * the field relaxes — so a bed you are walking towards would smooth back to
     * flat sand before you reached it, and only dent once you knelt. Redrawn on
     * a slow tick instead, which the field's own relaxation absorbs.
     *
     * Deliberately cheap and deliberately rare: one spot, a fraction of a
     * frame's brush budget, once a second and a half. The budget is shared with
     * footfalls, and a boot that fails to print because a bed was being redrawn
     * is a worse trade than a dent that fades a little between redraws.
     */
    tick(dt, x, z, radius = 14) {
        this._since = (this._since ?? 1e9) + dt;
        if (this._since < 1.5) return 0;

        let near = null;
        let bestD = radius;
        for (const spot of SIFT_SPOTS) {
            const d = Math.hypot(x - spot.x, z - spot.z);
            if (d < bestD) { bestD = d; near = spot; }
        }
        if (!near) return 0;

        this._since = 0;
        return this.restamp(near.id, { maxBrushes: 48 });
    }

    /** For the overlay and the checks: how dug the beach is. */
    stats() {
        let deepest = 0;
        for (const layer of this.layers.values()) deepest = Math.max(deepest, layer.maxDepth());
        return { deepest, spots: this.layers.size };
    }
}
