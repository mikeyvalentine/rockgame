// The shore profile's structural promises — pure math over beachParams.js.
//
// The WGSL bake mirrors shoreProfileJS structurally; these assertions pin the
// *shared parameters*' behaviour, which both implementations inherit.

import {
    shoreProfileJS, clampToPlayRect,
    WATERLINE_Z, WATER_LEVEL_Y, FORESHORE_SLOPE, SEABED_DEPTH,
    BERM_HEIGHT, DUNE_AMP, DUNE_BASE, PLAY_RECT, SPAWN, MICRO_AMP,
    POND_FAR_Z, POND_RADIUS, SHORE_HALF_ARC, SHORE_DEPTH,
} from "../src/terrain/beachParams.js";
import {
    shoreDistance, shoreArc, shorePoint, clampToShore, inShore,
    POND_CENTER_Z, WADE_DEPTH,
} from "../../shared/worldBounds.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

// The waterline crossing: the profile passes through the water level at the
// waterline, within the micro-relief's own amplitude.
//
// Sampled along the shoreline itself, which is a circle. It used to walk
// z = WATERLINE_Z for 120 m of x — the waterline when the pond was a
// rectangle, and 16 m up the beach at the ends of that walk now.
let worst = 0;
for (let a = -60; a <= 60; a += 7) {
    const p = shorePoint(a, 0);
    worst = Math.max(worst, Math.abs(shoreProfileJS(p.x, p.z) - WATER_LEVEL_Y));
}
check("profile crosses y=0 at the waterline", worst < MICRO_AMP * 3 + 0.05,
    "worst " + worst.toFixed(3) + " m");

// Foreshore gradient: walking straight out from the water, the mean slope
// tracks the parameter. Measured along the depth axis rather than along z, so
// it is the same 15 m of beach everywhere on the curve.
let drop = 0;
const N = 9;
for (let i = 0; i < N; i++) {
    const arc = -32 + i * 8;
    const far = shorePoint(arc, 20);
    const near = shorePoint(arc, 5);
    drop += shoreProfileJS(far.x, far.z) - shoreProfileJS(near.x, near.z);
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
for (let x = -POND_RADIUS; x <= POND_RADIUS; x += 8) {
    for (let z = WATERLINE_Z; z <= POND_FAR_Z; z += 8) {
        if (shoreDistance(x, z) > -2) continue;   // only inside the water
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
// Round, so "every edge" means every bearing.
{
    let worstEdge = 0;
    for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const atEdge = shoreProfileJS(
            Math.sin(a) * POND_RADIUS, POND_CENTER_Z - Math.cos(a) * POND_RADIUS
        );
        worstEdge = Math.max(worstEdge, Math.abs(atEdge));
    }
    check("the bank meets the water at y=0 all the way round", worstEdge < 0.25,
        worstEdge.toFixed(3));
}
{
    // 20 m beyond the far edge the bank should be well clear of the water.
    const inland = shoreProfileJS(0, POND_FAR_Z + 20);
    check("far bank keeps rising", inland > 20 * FORESHORE_SLOPE * 0.6,
        inland.toFixed(3));
}

// ---- the strip is a rectangle in (arc, depth) ------------------------------
//
// Which is the whole point of having those coordinates: the strip has to be
// 70 x 25 m everywhere on a curved shore, and an axis-aligned box would run
// 25 m deep in the middle and 31 m at the ends.
{
    let worstArc = 0;
    let worstDepth = 0;
    for (let a = -SHORE_HALF_ARC; a <= SHORE_HALF_ARC; a += 5) {
        for (let d = 0; d <= SHORE_DEPTH; d += 5) {
            const p = shorePoint(a, d);
            worstArc = Math.max(worstArc, Math.abs(shoreArc(p.x, p.z) - a));
            worstDepth = Math.max(worstDepth, Math.abs(shoreDistance(p.x, p.z) - d));
        }
    }
    check("shorePoint and shoreArc/shoreDistance are inverses",
        worstArc < 1e-9 && worstDepth < 1e-9,
        worstArc.toExponential(2) + " / " + worstDepth.toExponential(2));

    // Depth is measured straight out from the water, so it is the same 25 m at
    // the ends of the strip as in the middle — even though the ends are 6 m
    // further out in z.
    const mid = shorePoint(0, SHORE_DEPTH);
    const end = shorePoint(SHORE_HALF_ARC, SHORE_DEPTH);
    check("the strip is the same depth at its ends as in its middle",
        Math.abs(shoreDistance(mid.x, mid.z) - shoreDistance(end.x, end.z)) < 1e-9);
    check("the shore bows away at the ends",
        shorePoint(SHORE_HALF_ARC, 0).z - shorePoint(0, 0).z > 5,
        (shorePoint(SHORE_HALF_ARC, 0).z - shorePoint(0, 0).z).toFixed(2) + " m of bow");
}

// ---- the clamp follows the curve -------------------------------------------
{
    const outside = [
        { x: 0, z: -60 }, { x: 90, z: -5 }, { x: -90, z: -5 },
        { x: 0, z: 40 }, { x: 60, z: -40 },
    ];
    let allIn = true;
    for (const v of outside) {
        clampToShore(v);
        if (!inShore(v.x, v.z)) allIn = false;
    }
    check("the clamp lands every outside point back in the strip", allIn);

    // And leaves the inside alone.
    const inside = shorePoint(12, 9);
    const before = { ...inside };
    clampToShore(inside);
    check("the clamp leaves the interior untouched",
        inside.x === before.x && inside.z === before.z);

    // Wading is allowed, drowning is not.
    check("you may wade", inShore(0, WADE_DEPTH * 0.5));
    check("you may not swim", !inShore(0, WADE_DEPTH + 1));
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
