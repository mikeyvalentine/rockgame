/**
 * The imprint layers, connected — one per spot, and the terrain reads them.
 *
 * `shared/spotImprint.js` had the maths and no consumer for a while, which is
 * indistinguishable from working unless you go looking. This is the consumer.
 *
 * Two things press the sand:
 *
 *   1. **The bed, at placement.** 540 stones have been resting there; the sand
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
 * What this does NOT yet do is change what the sand LOOKS like: the drawn
 * surface comes from the height bake on WebGPU and a displaced grid on WebGL,
 * and neither reads these layers. So a divot is currently something you stand
 * in rather than something you see. That is the next piece, and it is shader
 * work on both renderers rather than more of this.
 */

import { SpotImprint, bakeBedImprint, BED_PRESS } from "../../../shared/spotImprint.js";
import { SIFT_SPOTS } from "../../../shared/pileField.js";
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
    constructor(terrain, beds) {
        this.terrain = terrain;
        this.layers = new Map();

        for (const spot of SIFT_SPOTS) {
            const layer = new SpotImprint(spot);
            this.layers.set(spot.id, layer);

            // The bed's own imprint, from the transforms this spot was placed
            // with. A scattered spot has no baked bed; its stones each press
            // where they landed instead, which `pressScatter` does.
            const entry = beds?.bedForSpot?.get(spot.id);
            if (entry && spot.style !== "scattered") {
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
            layer.press(r.node.position.x, r.node.position.z, radius, radius * IMPACT_PRESS);
            pressed++;
        }
        return pressed;
    }

    /** Stones strewn on open sand each press where they came to rest. */
    pressScatter(spotId, stones) {
        const layer = this.layers.get(spotId);
        if (!layer) return;
        for (const s of stones) {
            layer.press(s.x, s.z, s.radius, s.radius * BED_PRESS);
        }
    }

    /** For the overlay and the checks: how dug the beach is. */
    stats() {
        let deepest = 0;
        for (const layer of this.layers.values()) deepest = Math.max(deepest, layer.maxDepth());
        return { deepest, spots: this.layers.size };
    }
}
