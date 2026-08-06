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

import { SpotImprint, bakeBedImprint } from "../../../shared/spotImprint.js";
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

/**
 * Brushes drawn per frame while replaying a bed's dents.
 *
 * The field takes 96 a frame and shares that budget with footfalls and the surf
 * wake, so a bed cannot have all of it: a boot that fails to print because a bed
 * was being redrawn is a worse trade than a bed that finishes arriving a fifth
 * of a second later. At 56 a frame a 620-stone bed lands in 11 frames.
 */
const REPLAY_BUDGET = 56;

/**
 * How wide a resting stone's dent is drawn, as a multiple of its radius.
 *
 * The field is 2048 texels over 80 m — 3.9 cm each — and a bed stone is about
 * 6 cm across, so a stone gets two or three texels. That is the honest limit,
 * and it is the right one: what a bed of pebbles does to sand is not a field of
 * individual craters, it is a surface that has been worked over. Wider than the
 * stone by a little so neighbouring dents join up rather than aliasing into
 * isolated dots.
 */
const REST_BRUSH = 1.8;

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
        this.beds = beds;
        this.layers = new Map();
        /** Presses waiting to be drawn, newest bed first. See `drain`. */
        this._queue = [];
        this._radiusOf = new Map(
            (beds?.archetypeList ?? []).map((a) => [a.name, a.radius])
        );

        for (const spot of SIFT_SPOTS) {
            const layer = new SpotImprint(spot);
            this.layers.set(spot.id, layer);
            // The bed's own imprint, from the transforms this spot was placed
            // with. Every stone in a single-layer bed is touching the sand, so
            // unlike the old four-deep heap this is very nearly all of them.
            this._bakeSpot(spot);
        }
    }

    /**
     * Press one spot's current arrangement into its layer, and return it.
     *
     * Re-runnable, and re-run on every replay rather than cached from load:
     * `SiftPhysics.sleep` writes the arrangement the player left back into the
     * bed, so a bed that has been dug through has different stones in different
     * places. Pressing is idempotent — the layer combines with `max` — so
     * repeating it deepens nothing; it only adds where stones have moved to,
     * which is exactly right, because where they moved FROM should stay dug.
     */
    _bakeSpot(spot) {
        const entry = this.beds?.bedForSpot?.get(spot.id);
        const layer = this.layers.get(spot.id);
        if (!entry || !layer) return [];
        return bakeBedImprint(layer, entry.bed, (n) => this._radiusOf.get(n) ?? 0.05, {
            unitScale: U, baseY: entry.baseY, spot,
        });
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
        // Both live paths drain: this one runs every frame while crouched, and
        // `tick` runs every frame while walking. Between them the queue is
        // always being spent.
        this.drain();
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
     * Redraw a spot's remembered dents into the deformation field — one brush
     * per stone.
     *
     * The field relaxes and is anchored to the player, so by the time someone
     * walks back to a bed they dug yesterday it has forgotten every hole. This
     * is what makes the memory visible again.
     *
     * Per stone, and that is the whole point of this version. The first one
     * resampled the imprint grid at 25 cm and drew 35 blobs 37 cm across, which
     * is the SHAPE of the excavation — a soft bed-sized dip — and not what was
     * asked for. Every rock displaces the sand it is sitting in, the way a boot
     * does, so every rock gets its own brush.
     *
     * Queued rather than drawn, because 620 stones is six times the field's
     * whole per-frame brush budget. `drain` spends it over the next handful of
     * frames; the bed is arriving during a 1.1 s crouch, or while the player is
     * still walking towards it, so nothing waits on it.
     */
    restamp(spotId) {
        if (!this.deform) return 0;
        const spot = SIFT_SPOTS.find((s) => s.id === spotId);
        if (!spot) return 0;

        const presses = this._bakeSpot(spot);
        // Replaces rather than appends: a queue with two copies of the same bed
        // in it draws the same brushes twice and starves whatever is behind it.
        this._queue = presses;
        return presses.length;
    }

    /**
     * Draw a slice of the queued replay. Called every frame, cheap when empty.
     *
     * Shallow and wide, like a footfall: the berm is a fraction of the depth
     * because displaced sand has to go somewhere, and a rock that has settled
     * has pushed a little up around itself.
     */
    drain() {
        if (!this._queue.length || !this.deform) return 0;
        const n = Math.min(REPLAY_BUDGET, this._queue.length);
        for (let i = 0; i < n; i++) {
            const p = this._queue[i];
            this.deform.brush(
                p.x, p.z, p.radius * REST_BRUSH, p.depth, p.depth * 0.45, 0.25, 0, 0, 1, 0.85
            );
        }
        this._queue = this._queue.slice(n);
        return n;
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
        this.drain();
        this._since = (this._since ?? 1e9) + dt;
        if (this._since < 1.5) return 0;
        // Never re-enqueue over a replay still in flight. `restamp` REPLACES the
        // queue, so on a machine slow enough that draining a bed takes longer
        // than the tick interval, the tail of every bed would be thrown away and
        // re-queued forever — the far half of the bed would never once be drawn.
        // At 60 fps the queue is empty in a fifth of a second and this never
        // fires; it is here for the machine where that is not true.
        if (this._queue.length) return 0;

        let near = null;
        let bestD = radius;
        for (const spot of SIFT_SPOTS) {
            const d = Math.hypot(x - spot.x, z - spot.z);
            if (d < bestD) { bestD = d; near = spot; }
        }
        if (!near) return 0;

        this._since = 0;
        return this.restamp(near.id);
    }

    /** For the overlay and the checks: how dug the beach is. */
    stats() {
        let deepest = 0;
        for (const layer of this.layers.values()) deepest = Math.max(deepest, layer.maxDepth());
        return { deepest, spots: this.layers.size };
    }
}
