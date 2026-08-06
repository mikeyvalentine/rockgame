/**
 * First-person rig.
 *
 * SNOWFLOW's third-person spring arm is gone — the sand lab walks the beach in
 * first person. The camera sits at eye height over the controller's position,
 * driven by pointer-lock mouse look. Deliberately no extra smoothing layer: the
 * controller's own ground snap is already eased, and smoothing an FPS camera on
 * top of that reads as swimming.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { input } from "./input.js";

/**
 * ±83°. Steeper than the old third-person clamp on purpose: standing on a beach
 * you look down at your own dig and nearly straight up at the sky — but never
 * the full ±90°, so the flat-forward basis can't degenerate.
 */
const PITCH_LIMIT = 1.45;

export class FpsRig {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {HTMLCanvasElement} canvas
     */
    constructor(scene, canvas) {
        const cam = new UniversalCamera("cam", new Vector3(0, 2, 0), scene);
        cam.minZ = 0.12;
        cam.maxZ = 4200;
        cam.fov = 1.02; // ~58° vertical — constant, see `fov` below
        cam.inertia = 0;
        cam.rotation.set(0, 0, 0);
        // No attachControl — this rig drives the transform itself.

        this.camera = cam;
        this.scene = scene;

        this.yaw = 2.4;
        this.pitch = 0.06; // slightly down: the sand is the subject

        /** Eye height above the controller's ground-snapped position, metres. */
        this.eyeHeight = 1.62;

        /**
         * Metres to the "subject", for depth of field. First person has no
         * spring arm to measure, so this is a fixed conversational distance the
         * post chain eases its focal plane toward.
         */
        this.distance = 3.0;

        /**
         * Constant in v1. The post chain writes TAA jitter into the projection
         * matrix and freezes it every frame; a speed-driven FOV would have to
         * join that unfreeze/refreeze dance for a flourish first person does
         * not need.
         */
        this.fov = 1.02;

        /**
         * Optional gate on where the view may point, `(pose) => void`, mutating
         * `{yaw, pitch}` in place. Null while walking; the crouch installs one
         * so a knelt player leans rather than turns — see scene/crouch.js.
         */
        this.lookFilter = null;

        /** Camera basis, republished every frame for anything that aims. */
        this.forward = new Vector3(0, 0, 1);
        this.right = new Vector3(1, 0, 0);
        this.up = new Vector3(0, 1, 0);
    }

    /**
     * @param {number} dt seconds
     * @param {Vector3} feetPos controller world position (feet, ground-snapped)
     */
    update(dt, feetPos) {
        const pose = {
            yaw: this.yaw + input.lookX,
            pitch: Scalar.Clamp(this.pitch + input.lookY, -PITCH_LIMIT, PITCH_LIMIT),
        };
        this.lookFilter?.(pose);
        this.yaw = pose.yaw;
        this.pitch = pose.pitch;

        const cp = Math.cos(this.pitch);
        this.forward.set(
            Math.sin(this.yaw) * cp,
            -Math.sin(this.pitch),
            Math.cos(this.yaw) * cp
        );
        this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        Vector3.CrossToRef(this.right, this.forward, this.up);
        this.up.normalize();

        const cam = this.camera;
        cam.position.set(feetPos.x, feetPos.y + this.eyeHeight, feetPos.z);
        cam.fov = this.fov;
        cam.rotation.set(this.pitch, this.yaw, 0);
    }

    /** Flat camera-space forward on the XZ plane, for movement. Writes to `out`. */
    getFlatForward(out) {
        out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        return out;
    }

    getFlatRight(out) {
        out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        return out;
    }
}

// ------------------------------------------------------------------ helpers

/** Framerate-independent exponential approach. */
export function expDamp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}
