/**
 * The dig/scoop tool — hold LMB while pointer-locked and carve where you look.
 *
 * Every ~60 ms a stroke lands one brush: modest depression, small berm — the
 * brush's own rim term piles the spoil — plus a burst of persistent grains
 * flung back toward the digger (a scoop pulls, it doesn't push) and a short
 * dust puff. Stroke wetness ramps while you stay on one spot: a deepening
 * hole reaches damp sand, which the deformation buffer's A channel then
 * renders darker and holds crisper.
 *
 * Constants for the fling are the surf plume's ballistic population, mined
 * from SNOWFLOW's surfWake before it was deleted (1.6–4.8 m/s, drag ~1).
 */

// Side-effect import: augments Camera with getForwardRay (tree-shaken Babylon
// keeps ray support out of the core camera until this is pulled in).
import "@babylonjs/core/Culling/ray.js";

import { input } from "../core/input.js";
import { marchHeightfield } from "./raymarch.js";

const STROKE_MS = 60;
/** How far the dig reaches, metres — arm plus a scoop, not a telescope. */
const REACH = 3.0;

export class DigTool {
    /**
     * @param {import("@babylonjs/core/Cameras/camera").Camera} camera
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../vfx/particles.js").SprayField} spray
     * @param {import("../vfx/grains.js").GrainField} grains
     */
    constructor(camera, terrain, spray, grains) {
        this.camera = camera;
        this.terrain = terrain;
        this.spray = spray;
        this.grains = grains;

        this._last = 0;
        this._spotX = 1e9;
        this._spotZ = 1e9;
        this._spotWet = 0;
        this._spotStrokes = 0;
    }

    update() {
        if (!input.locked || !input.dig) return;
        const now = performance.now();
        if (now - this._last < STROKE_MS) return;
        this._last = now;

        const ray = this.camera.getForwardRay(REACH + 2);
        const hit = marchHeightfield(
            ray, (x, z) => this.terrain.heightAt(x, z), REACH
        );
        if (!hit) return;

        // Working one spot ramps wetness (deeper = damper) and widens the
        // crater; moving the aim resets both.
        const moved = Math.hypot(hit.x - this._spotX, hit.z - this._spotZ);
        if (moved < 0.5) {
            this._spotWet = Math.min(1, this._spotWet + 0.12);
            this._spotStrokes = Math.min(14, this._spotStrokes + 1);
        } else {
            this._spotWet = 0;
            this._spotStrokes = 0;
        }
        this._spotX = hit.x;
        this._spotZ = hit.z;

        // The crater widens as it deepens instead of boring a shaft. Real sand
        // cannot hold a narrow deep pit (angle of repose) — and neither can the
        // ring-0 lattice: a 16 cm hole driven half a metre down puts multiple
        // metres-per-metre of slope on 8.5 cm triangles, which is exactly the
        // faceted-pyramid artefact this replaces. Depth per stroke eases off as
        // the radius grows, so held digging moves sand outward, not downward.
        const radius = Math.min(0.32, 0.16 + this._spotStrokes * 0.013);
        const depth = 0.10 * (0.16 / radius);
        const elong = Math.max(1.05, 1.3 - this._spotStrokes * 0.02);
        const yaw = this.camera.rotation.y;
        this.terrain.deform.brush(
            hit.x, hit.z,
            radius,
            depth,
            0.05,           // berm (the rim term shapes it)
            0.10,           // packs slightly
            this._spotWet,  // exposed damp sand
            yaw, elong, 0.8
        );

        this._fling(hit);
    }

    /** Grains toward the digger + a dust puff. */
    _fling(hit) {
        const cam = this.camera.position;
        let bx = cam.x - hit.x;
        let bz = cam.z - hit.z;
        const bl = Math.hypot(bx, bz) || 1;
        bx /= bl;
        bz /= bl;

        const gr = this.grains;
        if (gr) {
            const n = 7 + ((Math.random() * 6) | 0);
            for (let k = 0; k < n; k++) {
                const rx = (Math.random() - 0.5) * 0.9;
                const rz = (Math.random() - 0.5) * 0.9;
                const throwV = 1.0 + Math.random() * 2.2; // surf-plume ballistic band
                gr.spawn(
                    hit.x + rx * 0.12, hit.y + 0.06, hit.z + rz * 0.12,
                    bx * throwV + rx * 0.9,
                    1.2 + Math.random() * 1.8,
                    bz * throwV + rz * 0.9,
                    0.012 + Math.random() * 0.013,
                    0.6 + Math.random()
                );
            }
        }

        const sp = this.spray;
        if (sp) {
            for (let k = 0; k < 8; k++) {
                const rx = (Math.random() - 0.5) * 0.5;
                const rz = (Math.random() - 0.5) * 0.5;
                sp.emit(
                    hit.x + rx * 0.2, hit.y + 0.08, hit.z + rz * 0.2,
                    bx * 0.7 + rx, 0.6 + Math.random() * 0.9, bz * 0.7 + rz,
                    0.022 + Math.random() * 0.028,
                    0.30 + Math.random() * 0.45, // curtain-population lifetime
                    0, 4.5                        // powder look, curtain drag
                );
            }
        }
    }
}
