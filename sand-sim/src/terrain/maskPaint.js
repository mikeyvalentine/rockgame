/**
 * The world-anchored material paint mask — the overlay's debug brush writes
 * here, the sand material reads it.
 *
 * Deliberately NOT a deformation-buffer channel: that buffer is toroidal and
 * scrolls with the player, so anything material-static stored there would
 * smear the moment the window moved. This is a plain world-rect texture over
 * the walkable zone.
 *
 * Channels, all about a 0.5 neutral:
 *   R  pebble add (>0.5) / erase (<0.5), on top of the baked band
 *   G  wetness override add
 *
 * CPU-backed DynamicTexture so it works identically on both renderers. This is
 * a debug instrument — per-stamp upload cost is accepted and throttled at the
 * brush, not here.
 */

import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";

/** World rect the mask covers: x ±64 m, z −72…+56 m — the play rect + band. */
export const MASK_ORIGIN = { x: -64, z: -72 };
export const MASK_SIZE = 128;
const RES = 1024; // 12.5 cm texels

export class MaskPaint {
    /** @param {import("@babylonjs/core/scene").Scene} scene */
    constructor(scene) {
        this.origin = new Vector2(MASK_ORIGIN.x, MASK_ORIGIN.z);
        this.size = MASK_SIZE;

        this.texture = new DynamicTexture("maskPaint", RES, scene, false);
        this.texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        this._ctx = this.texture.getContext();
        this._img = this._ctx.createImageData(RES, RES);
        const px = this._img.data;
        for (let i = 0; i < px.length; i += 4) {
            px[i] = 128;     // pebble neutral
            px[i + 1] = 128; // wetness neutral
            px[i + 2] = 0;
            px[i + 3] = 255;
        }
        this._ctx.putImageData(this._img, 0, 0);
        // invertY false: image row 0 is sample-space v=0, matching the shader's
        // (world - origin) / size mapping with no sign gymnastics.
        this.texture.update(false);
    }

    /**
     * Stamp a radial-gradient blot.
     * @param {number} wx @param {number} wz world metres
     * @param {number} radius metres
     * @param {number} strength signed, −1..1 (negative erases)
     * @param {0|1} channel 0 = pebble, 1 = wetness
     */
    stamp(wx, wz, radius, strength, channel) {
        const cx = ((wx - MASK_ORIGIN.x) / MASK_SIZE) * RES;
        const cz = ((wz - MASK_ORIGIN.z) / MASK_SIZE) * RES;
        const r = Math.max(1, (radius / MASK_SIZE) * RES);

        const x0 = Math.max(0, Math.floor(cx - r));
        const x1 = Math.min(RES - 1, Math.ceil(cx + r));
        const z0 = Math.max(0, Math.floor(cz - r));
        const z1 = Math.min(RES - 1, Math.ceil(cz + r));
        if (x1 < x0 || z1 < z0) return;

        const px = this._img.data;
        for (let z = z0; z <= z1; z++) {
            for (let x = x0; x <= x1; x++) {
                const dx = (x - cx) / r;
                const dz = (z - cz) / r;
                const d2 = dx * dx + dz * dz;
                if (d2 > 1) continue;
                const fall = (1 - d2) * (1 - d2); // smooth blot
                const i = (z * RES + x) * 4 + channel;
                px[i] = Math.max(0, Math.min(255, px[i] + strength * 255 * fall * 0.35));
            }
        }

        this._ctx.putImageData(
            this._img, 0, 0, x0, z0, x1 - x0 + 1, z1 - z0 + 1
        );
        this.texture.update(false);
    }
}
