/**
 * Where the walker meets the sand.
 *
 * Translates locomotion state into brushes on the terrain state buffer. This is
 * the only thing standing between the physics in `controller.js` and the marks
 * left on the field, and it is deliberately separate from both: the controller
 * should not know a deformation buffer exists, and the buffer should not know
 * what a foot is.
 *
 * Two writers (the surf groove went with the third-person character):
 *
 *   footfall   one splat per plant, frame-accurate with the gait event. A boot
 *              is longer than it is wide and oriented with the body, so the
 *              brush is elongated and yawed rather than round.
 *   body drag  a shallow continuous scuff under a walking character, so the
 *              trail is a trail and not a row of disconnected prints.
 *
 * There is no posed figure any more. The controller's own footfall events are
 * the source: SNOWFLOW's figure-less branch (`figure = null`) always existed
 * here, and first person simply makes it the only branch.
 *
 * Zero allocation: brushes are pushed straight into the field's staging array.
 */

/**
 * Boot geometry, metres. `WIDTH` is the short-axis radius, so the print is
 * ~13 cm across and ~23 cm long. (Was 0.10 — shrunk 1.5x by request; note the
 * print is now only ~3.5 deformation texels wide at the default 2048², so if
 * rim detail ever matters more, the deformResolution slider is the lever.)
 */
const BOOT_WIDTH = 0.067;
const BOOT_ELONG = 1.7;

export class SnowContact {
    /**
     * @param {import("./controller.js").CharacterController} character
     * @param {import("../terrain/deformation.js").DeformationField} field
     * @param {null} figure kept in the signature for symmetry with SNOWFLOW;
     *   always null here — there is no posed skeleton in first person
     * @param {import("../vfx/particles.js").SprayField} [spray]
     * @param {import("../vfx/grains.js").GrainField} [grains]
     */
    constructor(character, field, figure, spray, grains) {
        this.character = character;
        this.field = field;
        this.spray = spray || null;
        this.grains = grains || null;

        /** Distance travelled since the last continuous splat, metres. */
        this._prevX = character.position.x;
        this._prevZ = character.position.z;
    }

    /** @param {number} dt seconds */
    update(dt) {
        const ch = this.character;
        const f = this.field;

        const dx = ch.position.x - this._prevX;
        const dz = ch.position.z - this._prevZ;
        const moved = Math.hypot(dx, dz);
        this._prevX = ch.position.x;
        this._prevZ = ch.position.z;

        this._walk(dt, moved);

        // Footfalls, from the controller's gait events.
        if (ch.footfall && ch.stepping) {
            const px = ch.footPos.x;
            const pz = ch.footPos.z;

            // Recomputed here rather than read off the controller, so it cannot
            // be a frame stale relative to the plant it is describing.
            const impact = Math.min(1.3, 0.35 + ch.speed / 5.4);
            f.brush(
                px, pz,
                BOOT_WIDTH,
                // Depth: ~8-15 cm depending on how hard the foot lands —
                // halved by request from the snow-era 17-31 cm; beach sand
                // packs firmer than powder.
                0.085 + 0.07 * impact,
                // The berm is the whole point — but it halves with the depth,
                // because it *is* the depth: displaced mass has to balance.
                0.05 + 0.04 * impact,
                0.9,                    // compression: trodden ground is dense
                0,                      // A channel (wetness after phase 5)
                ch.facing,
                BOOT_ELONG,
                1.0                     // full rim roughness — boots tear edges
            );

            this._kick(px, ch.position.y, pz, impact);
            this._grains(px, ch.position.y, pz, impact);
        }
    }

    /**
     * The heavier grains flung alongside the dust. Unlike the spray these
     * persist: they land, roll downslope and deposit their mass back into the
     * heightfield (see vfx/grains.js).
     */
    _grains(x, y, z, impact) {
        const gr = this.grains;
        if (!gr) return;
        const ch = this.character;
        if (ch.speed < 0.4) return;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        const n = 2 + ((impact * 4) | 0);
        for (let k = 0; k < n; k++) {
            const rx = (Math.random() - 0.5) * 0.7;
            const rz = (Math.random() - 0.5) * 0.7;
            const back = 0.4 + Math.random() * 1.2 * impact;
            gr.spawn(
                x + rx * 0.1, y + 0.05, z + rz * 0.1,
                -fx * back + rx * 1.1 + ch.velocity.x * 0.3,
                0.8 + Math.random() * 1.4,
                -fz * back + rz * 1.1 + ch.velocity.z * 0.3,
                0.011 + Math.random() * 0.012,
                0.5 + Math.random() * 0.8
            );
        }
    }

    /**
     * Grains thrown by a boot landing.
     *
     * Fired from the same branch that stamps the print, so the grains leave the
     * ground on the exact frame the foot arrives — one event, rather than two
     * systems agreeing about when it happened.
     *
     * The kick goes up and *backward* relative to travel. A boot in loose
     * ground scoops: it enters forward, compresses, and throws the displaced
     * mass out behind the heel as the weight rolls over it.
     */
    _kick(x, y, z, impact) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        if (ch.speed < 0.4) return;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        // Many small grains rather than a few large ones. The size at which a
        // puff stops reading as powder and starts reading as a cotton ball is
        // somewhere around five centimetres, and it is a hard threshold.
        const n = 6 + ((impact * 14) | 0);

        for (let k = 0; k < n; k++) {
            const spread = 0.9;
            const rx = (Math.random() - 0.5) * spread;
            const rz = (Math.random() - 0.5) * spread;
            const up = 0.9 + Math.random() * 1.9;
            const back = 0.5 + Math.random() * 1.6 * impact;
            // A fifth of it is heavier stuff that flies further and falls faster.
            const clod = Math.random() < 0.22 ? 1 : 0;

            sp.emit(
                x + rx * 0.09, y + 0.03 + Math.random() * 0.05, z + rz * 0.09,
                -fx * back + rx * 1.3 + ch.velocity.x * 0.25,
                up * (clod ? 1.25 : 1.0),
                -fz * back + rz * 1.3 + ch.velocity.z * 0.25,
                clod ? 0.014 + Math.random() * 0.012 : 0.020 + Math.random() * 0.030,
                clod ? 0.55 + Math.random() * 0.35 : 0.55 + Math.random() * 0.60,
                clod
            );
        }
    }

    /**
     * Walking scuff. Very shallow, and only while actually moving — a standing
     * character should not slowly bore a hole.
     */
    _walk(dt, moved) {
        const ch = this.character;
        if (ch.speed < 0.25) return;

        // Scaled by distance travelled, not by dt, so the groove has the same
        // depth per metre at any speed or frame rate. A given patch of ground
        // sits under the brush for (2 * radius / moved) frames, so the depth it
        // ends up at is roughly rate * 2 * radius * profile — independent of
        // both speed and frame rate, which is the point.
        const k = Math.min(moved, 0.35);
        // Compression stays deliberately below saturation here. If the scuff
        // packed the whole path to 1.0, the boot prints stamped on top would
        // have nothing left to darken and the trail would read as one flat
        // ribbon instead of as a line of prints in a churned path.
        // Halved with the footfall depths — the scuff must stay shallower than
        // the prints it links or the trail reads as one ribbon again.
        this.field.brush(
            ch.position.x, ch.position.z,
            0.22,
            0.10 * k,
            0.11 * k,
            0.8 * k,
            0,
            ch.facing,
            1.5,
            0.85
        );
    }
}
