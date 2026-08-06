// The shore profile's structural promises — pure math over beachParams.js.
//
// The WGSL bake mirrors shoreProfileJS structurally; these assertions pin the
// *shared parameters*' behaviour, which both implementations inherit.

import {
    shoreProfileJS, clampToPlayRect,
    WATERLINE_Z, WATER_LEVEL_Y, FORESHORE_SLOPE, SEABED_DEPTH,
    BERM_HEIGHT, DUNE_AMP, DUNE_BASE, PLAY_RECT, SPAWN, MICRO_AMP,
    POND_FAR_Z, POND_HALF_X, SHORE_HALF_X, SHORE_BACK_Z,
} from "../src/terrain/beachParams.js";
import { shoreDistance, POND_CENTER_Z } from "../../shared/worldBounds.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

// The waterline crossing: the profile passes through the water level at the
// waterline, within the micro-relief's own amplitude.
let worst = 0;
for (let x = -60; x <= 60; x += 7) {
    worst = Math.max(worst, Math.abs(shoreProfileJS(x, WATERLINE_Z) - WATER_LEVEL_Y));
}
check("profile crosses y=0 at the waterline", worst < MICRO_AMP * 3 + 0.05,
    "worst " + worst.toFixed(3) + " m");

// Foreshore gradient: over the open beach the mean slope tracks the parameter.
let drop = 0;
const N = 9;
for (let i = 0; i < N; i++) {
    const x = -40 + i * 10;
    drop += shoreProfileJS(x, -20) - shoreProfileJS(x, -5);
}
drop /= N;
const expected = 15 * FORESHORE_SLOPE;
check("foreshore slope ≈ parameter", Math.abs(drop - expected) < 0.25,
    "mean drop " + drop.toFixed(3) + " vs " + expected.toFixed(3));

// The pond's floor never falls past -SEABED_DEPTH, and reaches it in the
// middle.
//
// It is a bowl, not a pan: the ramp is measured from the nearest edge, so the
// seabed clamp only bites where you are more than SEABED_DEPTH/FORESHORE_SLOPE
// (71 m) from every side. In a 200 m pond that is a disc around the centre. A
// bowl is what a pond is, so this is the shape to assert rather than a defect
// to flatten out.
//
// The old version of this check sampled z = 220 — open sea when the water ran
// to the horizon, dry land on the far bank now. It caught the change to a
// bounded world on the first run.
let pondMin = Infinity;
for (let x = -POND_HALF_X + 2; x <= POND_HALF_X - 2; x += 8) {
    for (let z = WATERLINE_Z + 2; z <= POND_FAR_Z - 2; z += 8) {
        pondMin = Math.min(pondMin, shoreProfileJS(x, z));
    }
}
check("pond never falls past the seabed depth", pondMin > -SEABED_DEPTH - 0.4,
    "deepest " + pondMin.toFixed(2));
const middle = shoreProfileJS(0, POND_CENTER_Z);
check("pond reaches the seabed depth in the middle",
    Math.abs(middle + SEABED_DEPTH) < 0.4, middle.toFixed(2));

// The pond is closed. Every edge of it has to come back up to the water level
// and keep going, or the quad ends over a 2.5 m trench.
for (const [name, x, z] of [
    ["far", 0, POND_FAR_Z], ["left", -POND_HALF_X, POND_CENTER_Z],
    ["right", POND_HALF_X, POND_CENTER_Z],
]) {
    const atEdge = shoreProfileJS(x, z);
    check(`${name} bank meets the water at y=0`, Math.abs(atEdge) < 0.25,
        atEdge.toFixed(3));
}
{
    // 20 m beyond the far edge the bank should be well clear of the water.
    const inland = shoreProfileJS(0, POND_FAR_Z + 20);
    check("far bank keeps rising", inland > 20 * FORESHORE_SLOPE * 0.6,
        inland.toFixed(3));
}

// And the strip the player walks is unchanged by any of it: measured against
// the near waterline, the ramp is the same function it always was.
{
    let worst = 0;
    for (let x = -SHORE_HALF_X; x <= SHORE_HALF_X; x += 7) {
        for (let z = SHORE_BACK_Z; z <= 0; z += 5) {
            worst = Math.max(worst, Math.abs(
                shoreDistance(x, z) - (WATERLINE_Z - z)
            ));
        }
    }
    check("shore strip measures straight to the near waterline", worst < 1e-9,
        worst.toExponential(2));
}

// Dunes exist landward, and stay bounded.
let duneMax = -Infinity;
for (let x = -80; x <= 80; x += 8) {
    duneMax = Math.max(duneMax, shoreProfileJS(x, -160));
}
check("dune backdrop rises", duneMax > BERM_HEIGHT * 0.6, "max " + duneMax.toFixed(2));
check("dune backdrop bounded", duneMax < BERM_HEIGHT + DUNE_BASE + DUNE_AMP + 1.2,
    "max " + duneMax.toFixed(2));

// The whole walkable rect is sane ground.
let rectMin = Infinity;
let rectMax = -Infinity;
for (let x = PLAY_RECT.minX; x <= PLAY_RECT.maxX; x += 9) {
    for (let z = PLAY_RECT.minZ; z <= PLAY_RECT.maxZ; z += 6) {
        const h = shoreProfileJS(x, z);
        rectMin = Math.min(rectMin, h);
        rectMax = Math.max(rectMax, h);
    }
}
check("play rect above wading floor", rectMin > -0.6, "min " + rectMin.toFixed(2));
check("play rect below berm ceiling", rectMax < BERM_HEIGHT + 1.0, "max " + rectMax.toFixed(2));

// The spawn stands on dry-ish sand inside the rect.
const hs = shoreProfileJS(SPAWN.x, SPAWN.z);
check("spawn on dry sand", hs > 0 && hs < BERM_HEIGHT, "h " + hs.toFixed(2));

// The clamp actually clamps, and leaves interior points alone.
const v = { x: PLAY_RECT.maxX + 50, z: PLAY_RECT.minZ - 50 };
clampToPlayRect(v);
check("clamp pins corners", v.x === PLAY_RECT.maxX && v.z === PLAY_RECT.minZ);
const w = { x: 0, z: -10 };
clampToPlayRect(w);
check("clamp leaves interior", w.x === 0 && w.z === -10);

process.exit(failures ? 1 : 0);
