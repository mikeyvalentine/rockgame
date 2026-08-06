/**
 * The overlay's mask-paint brush — a debug instrument, not gameplay.
 *
 * Active only while the pointer is UNLOCKED (the overlay open is the natural
 * state) and a mode other than "off" is selected in the settings. While a mode
 * is active, clicking the canvas paints instead of capturing the pointer —
 * input.js checks the same setting and stands down.
 */

// Side-effect import: augments Scene with createPickingRay — same
// tree-shaking gap as the dig tool's getForwardRay.
import "@babylonjs/core/Culling/ray.js";

import { S } from "../core/settings.js";
import { input, worldToolsAllowed } from "../core/input.js";
import { marchHeightfield } from "./raymarch.js";

const CHANNEL = { "pebble+": 0, "pebble-": 0, "wet+": 1, "wet-": 1 };

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import("@babylonjs/core/scene").Scene} scene
 * @param {import("@babylonjs/core/Cameras/camera").Camera} camera
 * @param {(x:number, z:number) => number} heightAt
 * @param {import("../terrain/maskPaint.js").MaskPaint} maskPaint
 */
export function initMaskBrush(canvas, scene, camera, heightAt, maskPaint) {
    let painting = false;
    let lastStamp = 0;

    // `worldToolsAllowed` is false while sifting: the brush paints on UNLOCKED
    // clicks, and the crouch unlocks the pointer on purpose so the cursor can
    // work the bed. Without this, every click on a stone also painted the mask.
    const modeActive = () => worldToolsAllowed()
        && S.maskBrushMode && S.maskBrushMode !== "off";

    const paintAt = () => {
        // Throttled: a stamp uploads the mask texture, and 60/s of that is
        // waste for a debug brush.
        const now = performance.now();
        if (now - lastStamp < 45) return;
        lastStamp = now;

        const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, null, camera);
        const hit = marchHeightfield(ray, heightAt, 90);
        if (!hit) return;

        const mode = /** @type {string} */ (S.maskBrushMode);
        const sign = mode.endsWith("-") ? -1 : 1;
        maskPaint.stamp(
            hit.x, hit.z,
            S.maskBrushRadius,
            sign * S.maskBrushStrength,
            CHANNEL[mode] ?? 0
        );
    };

    canvas.addEventListener("pointerdown", (e) => {
        if (input.locked || !modeActive() || e.button !== 0) return;
        painting = true;
        paintAt();
    });
    window.addEventListener("pointermove", () => {
        if (painting && !input.locked && modeActive()) paintAt();
    });
    window.addEventListener("pointerup", () => {
        painting = false;
    });
}
