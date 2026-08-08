// While sifting, nothing but the stones may touch the sand.
//
// The rule used to be two implicit facts that happened to add up: the dig tool
// checked `input.locked`, and the apps happened to skip `dig.update()` while
// knelt. Neither said what the rule WAS, so a tool added later inherited
// neither — and between them they missed the mask brush entirely, which paints
// on *unlocked* clicks, which is exactly the state the crouch puts the pointer
// in on purpose.
//
// So the rule lives in one place now (`allowWorldTools`), and this pins it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { input, allowWorldTools, worldToolsAllowed } from "../src/core/input.js";

let failures = 0;
const check = (n, ok, d) => { console.log((ok ? "ok   " : "FAIL ") + n + (ok || !d ? "" : " — " + d)); if (!ok) failures++; };
const read = (rel) => readFileSync(fileURLToPath(new URL("../src/" + rel, import.meta.url)), "utf8");

// ---- the switch itself ------------------------------------------------------
check("world tools are on by default", worldToolsAllowed() === true);

// A dig stroke already in progress must not survive the transition. Holding the
// button while crouching is the ordinary way to reach this.
input.dig = true;
allowWorldTools(false);
check("sifting turns world tools off", worldToolsAllowed() === false);
check("a held dig button is dropped, not merely ignored", input.dig === false,
    "a stroke begun before the crouch would otherwise carry into it");

input.dig = true;
check("dig cannot be re-armed while sifting",
    // `mousedown` is the only thing that sets it, and it checks the flag; this
    // asserts the flag is what that check reads, not that assignment is blocked.
    read("core/input.js").includes("if (!input.locked || !worldTools) return;"));

allowWorldTools(true);
check("standing up turns them back on", worldToolsAllowed() === true);
input.dig = false;

// ---- every consumer actually asks -------------------------------------------
check("the dig tool checks it", read("tools/dig.js").includes("worldToolsAllowed()"));
check("the mask brush checks it", read("tools/maskBrush.js").includes("worldToolsAllowed()"));

// ---- both renderers wire it to the crouch -----------------------------------
for (const app of ["app/webglApp.js", "app/webgpuApp.js"]) {
    const src = read(app);
    check(app + " turns world tools off when the crouch takes the cursor",
        src.includes("allowWorldTools(false)") && src.includes("allowPointerLock(false)"));
    check(app + " turns them back on when it gives the cursor back",
        src.includes("allowWorldTools(true)") && src.includes("allowPointerLock(true)"));
}

// ---- and the walker's own contact stays gated -------------------------------
// Footfalls are the other thing that presses sand. They are off because the
// walker is frozen, which is a different mechanism and stays that way — but if
// the gate ever moved, the beach would print boots while nobody is walking.
for (const app of ["app/webglApp.js", "app/webgpuApp.js"]) {
    const src = read(app);
    const gate = src.slice(src.indexOf("if (!knelt) {"), src.indexOf("if (!knelt) {") + 1200);
    check(app + " keeps footfall contact behind the knelt gate",
        gate.includes("contact.update(dt)") || gate.includes("contact) contact.update(dt)"));
}

process.exit(failures ? 1 : 0);
