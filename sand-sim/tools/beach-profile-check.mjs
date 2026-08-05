// The shore profile's structural promises — pure math over beachParams.js.
//
// The WGSL bake mirrors shoreProfileJS structurally; these assertions pin the
// *shared parameters*' behaviour, which both implementations inherit.

import {
    shoreProfileJS, clampToPlayRect,
    WATERLINE_Z, WATER_LEVEL_Y, FORESHORE_SLOPE, SEABED_DEPTH,
    BERM_HEIGHT, DUNE_AMP, DUNE_BASE, PLAY_RECT, SPAWN, MICRO_AMP,
} from "../src/terrain/beachParams.js";

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

// The seabed flattens near -SEABED_DEPTH and never keeps falling.
let seaMin = Infinity;
let seaMax = -Infinity;
for (let x = -50; x <= 50; x += 10) {
    const h = shoreProfileJS(x, 220);
    seaMin = Math.min(seaMin, h);
    seaMax = Math.max(seaMax, h);
}
check("seabed floors out", seaMin > -SEABED_DEPTH - 0.4 && seaMax < -SEABED_DEPTH + 0.6,
    seaMin.toFixed(2) + " … " + seaMax.toFixed(2));

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
