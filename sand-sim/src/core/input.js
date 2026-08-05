/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock. The mouse buttons are deliberately unclaimed
 * for now — the dig tool takes LMB when it arrives (phase 8).
 */

import { S } from "./settings.js";

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    sprint: false, // shift
    dig: false,    // LMB held while locked — the dig tool reads this

    locked: false,
};

const keys = Object.create(null);

const LOOK_SCALE = 0.0022;

/** @type {(() => void)|null} */
let onToggleOverlay = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onToggleOverlay?: () => void }} [hooks]
 */
export function initInput(canvas, hooks) {
    onToggleOverlay = hooks?.onToggleOverlay ?? null;

    canvas.addEventListener("click", () => {
        if (input.locked) return;
        // While the mask brush is armed, an unlocked click paints (see
        // tools/maskBrush.js) — don't steal it into pointer lock.
        if (S.maskBrushMode && S.maskBrushMode !== "off") return;
        canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused.
            for (const k in keys) keys[k] = false;
            input.dig = false;
        }
    });

    document.addEventListener("mousedown", (e) => {
        if (!input.locked) return;
        if (e.button === 0) input.dig = true;
    });

    document.addEventListener("mouseup", (e) => {
        if (e.button === 0) input.dig = false;
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("keydown", (e) => {
        // Overlay toggle works whether or not the pointer is locked.
        if (e.code === "F1" || e.code === "Backquote") {
            e.preventDefault();
            onToggleOverlay?.();
            return;
        }
        if (e.repeat) return;
        keys[e.code] = true;
    });

    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;
    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
        input.dig = false;
    });
}

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = 0;
    let z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    // Clamp to a unit disc so diagonals aren't faster.
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    input.moveX = x;
    input.moveZ = z;
    input.moving = len > 0.001;
    input.sprint = !!(keys.ShiftLeft || keys.ShiftRight);
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
}

export function isDown(code) {
    return !!keys[code];
}
