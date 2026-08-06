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

/**
 * Whether a click on the canvas should take pointer lock.
 *
 * Off while sifting. rock-sift drives everything from `scene.pointerX/Y`, so
 * the crouch hands the cursor back — and a click handler that immediately takes
 * it again would make the bed untouchable in a way that looks like the sifting
 * being broken rather than like a lock being re-grabbed. See scene/crouch.js.
 */
let pointerLockAllowed = true;

/**
 * True while the player is sifting a bed.
 *
 * The cursor belongs to the bed then, not to the world, so the world's tools
 * must not see it. Enforced HERE rather than at each tool, because "sifting"
 * and "not digging" were previously two separate implicit facts — the dig tool
 * checked `input.locked`, and the app happened to skip `dig.update()` while
 * knelt — and neither of them says what the rule is. A tool added later would
 * inherit neither.
 *
 * It also closes a hole those two gates did not: crouching RELEASES pointer
 * lock so the cursor can drive the sweep, and the mask brush paints on
 * *unlocked* clicks. Every click on a stone was a click on the mask brush too,
 * whenever it was armed.
 */
let worldTools = true;

/** @param {boolean} on */
export function allowPointerLock(on) { pointerLockAllowed = on; }

/**
 * Turn the world's cursor tools (dig, mask brush) off while sifting.
 * @param {boolean} on
 */
export function allowWorldTools(on) {
    worldTools = on;
    // Not just refused from now on — a button already held must not stay held
    // across the transition, or a dig stroke begun before the crouch carries
    // into it.
    if (!on) input.dig = false;
}

/** False while sifting — the dig tool and the mask brush both check this. */
export function worldToolsAllowed() { return worldTools; }

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
        if (input.locked || !pointerLockAllowed) return;
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
        if (!input.locked || !worldTools) return;
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
