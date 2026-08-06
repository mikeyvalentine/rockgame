// The sifting piles' structural promises — pure math over shared/pileField.js
// and beachParams.js. No Babylon, no GPU.
//
// Two things are being pinned here, and the second is the one that matters.
//
// 1. The pile is terrain: the shore rises over a spot and is undisturbed away
//    from it, so `terrain.heightAt()` walks the player up the bank for free.
//
// 2. The crown the bed lands on is FLAT — measured through the same resampling
//    the walker's grounding actually goes through, not through the analytic
//    profile. `heightfield.heightCPU` is a 0.5 m/texel box-downsample of the
//    0.25 m bake, reconstructed with a bicubic B-spline. A mound can be flat
//    analytically and still arrive at the character as a bump. rock-sift bakes
//    its bed on flat ground, so a crown that is not flat means stones floating
//    on one side of the bed and buried on the other.

import {
    SIFT_SPOTS, PILE_RADIUS, CROWN_RADIUS, PILE_HEIGHT,
    pileCoverage, pileHeightJS, pileLift, pileMaskJS, spotAt, pileFieldWGSL,
} from "../../shared/pileField.js";
import {
    shoreProfileJS, WORLD_SIZE, HEIGHT_RES, MICRO_AMP,
    PLAY_RECT, SPAWN, WATERLINE_Z, FORESHORE_SLOPE, SEABED_DEPTH, BERM_HEIGHT,
} from "../src/terrain/beachParams.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// A faithful stand-in for heightfield.js's CPU mirror.
// ---------------------------------------------------------------------------

const ORIGIN = -WORLD_SIZE / 2;
const BAKE_TEXEL = WORLD_SIZE / HEIGHT_RES;
const MIRROR_RES = HEIGHT_RES / 2;
const MIRROR_TEXEL = WORLD_SIZE / MIRROR_RES;

/** One bake texel, at its own centre — what heightBake writes. */
function bakeAt(i, j) {
    return shoreProfileJS(ORIGIN + (i + 0.5) * BAKE_TEXEL, ORIGIN + (j + 0.5) * BAKE_TEXEL, 1);
}

/** One mirror cell: the 2x2 box average `_readback` takes. */
function mirrorAt(mx, mz) {
    const x = Math.min(Math.max(mx, 0), MIRROR_RES - 1);
    const z = Math.min(Math.max(mz, 0), MIRROR_RES - 1);
    const i = x * 2;
    const j = z * 2;
    return (bakeAt(i, j) + bakeAt(i + 1, j) + bakeAt(i, j + 1) + bakeAt(i + 1, j + 1)) * 0.25;
}

function bsplineWeights(t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return [
        (1 - 3 * t + 3 * t2 - t3) / 6,
        (4 - 6 * t2 + 3 * t3) / 6,
        (1 + 3 * t + 3 * t2 - 3 * t3) / 6,
        t3 / 6,
    ];
}

/** heightfield.heightAt, evaluated lazily against the mirror above. */
function groundedHeightAt(x, z) {
    const fx = ((x - ORIGIN) / WORLD_SIZE) * MIRROR_RES - 0.5;
    const fz = ((z - ORIGIN) / WORLD_SIZE) * MIRROR_RES - 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const wx = bsplineWeights(fx - ix);
    const wz = bsplineWeights(fz - iz);

    let sum = 0;
    for (let j = 0; j < 4; j++) {
        let rowSum = 0;
        for (let i = 0; i < 4; i++) rowSum += mirrorAt(ix - 1 + i, iz - 1 + j) * wx[i];
        sum += rowSum * wz[j];
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

let placementFail = "";
for (const s of SIFT_SPOTS) {
    if (s.x - PILE_RADIUS < PLAY_RECT.minX || s.x + PILE_RADIUS > PLAY_RECT.maxX ||
        s.z - PILE_RADIUS < PLAY_RECT.minZ || s.z + PILE_RADIUS > PLAY_RECT.maxZ) {
        placementFail += s.id + " leaves the play rect; ";
    }
}
check("every spot sits wholly inside the walkable rect", placementFail === "", placementFail);

// Clear of the waterline: a mound reaching z=0 would break the profile's
// "crosses y=0 at the waterline" promise, which the water quad depends on.
let nearest = Infinity;
for (const s of SIFT_SPOTS) nearest = Math.min(nearest, Math.abs(s.z - WATERLINE_Z));
check("piles clear the waterline", nearest > PILE_RADIUS + 0.5,
    "closest spot " + nearest.toFixed(1) + " m, radius " + PILE_RADIUS);

// Non-overlapping, so `max` combining never has to arbitrate and each spot is
// a distinct destination.
let minSep = Infinity;
for (let a = 0; a < SIFT_SPOTS.length; a++) {
    for (let b = a + 1; b < SIFT_SPOTS.length; b++) {
        const dx = SIFT_SPOTS[a].x - SIFT_SPOTS[b].x;
        const dz = SIFT_SPOTS[a].z - SIFT_SPOTS[b].z;
        minSep = Math.min(minSep, Math.hypot(dx, dz));
    }
}
check("spots do not overlap", minSep > PILE_RADIUS * 2,
    "closest pair " + minSep.toFixed(1) + " m");

// Each variant used once — four arrangements, not one repeated.
const variants = new Set(SIFT_SPOTS.map((s) => s.variant));
check("one bed variant per spot", variants.size === SIFT_SPOTS.length,
    variants.size + " distinct across " + SIFT_SPOTS.length + " spots");

// The spawn is not standing in a bed.
check("spawn is not inside a pile", pileCoverage(SPAWN.x, SPAWN.z) === 0);

// ---------------------------------------------------------------------------
// The field itself
// ---------------------------------------------------------------------------

check("coverage saturates on the crown", pileCoverage(SIFT_SPOTS[0].x, SIFT_SPOTS[0].z) === 1);
// Approaches zero rather than hitting it: the falloff is C1 at the rim, which
// is the point — a hard cut would crease the lighting where bank meets sand.
check("coverage reaches zero at the rim",
    pileCoverage(SIFT_SPOTS[0].x + PILE_RADIUS, SIFT_SPOTS[0].z) < 1e-6);
check("coverage is zero on open beach", pileHeightJS(0, -25) === 0);
check("mask is stone on the crown", pileMaskJS(SIFT_SPOTS[1].x, SIFT_SPOTS[1].z) === 1);
check("mask is sand off the pile", pileMaskJS(0, -25) === 0);

// The falloff is monotonic — no ring or dip in the face.
let mono = true;
for (let d = 0; d <= PILE_RADIUS + 0.5; d += 0.02) {
    const a = pileCoverage(SIFT_SPOTS[0].x + d, SIFT_SPOTS[0].z);
    const b = pileCoverage(SIFT_SPOTS[0].x + d + 0.02, SIFT_SPOTS[0].z);
    if (b > a + 1e-12) mono = false;
}
check("falloff is monotonic", mono);

// The crouch proximity test fires on the crown and nowhere else.
check("spotAt finds the spot you stand on",
    spotAt(SIFT_SPOTS[2].x, SIFT_SPOTS[2].z)?.id === SIFT_SPOTS[2].id);
check("spotAt is silent on the open beach", spotAt(0, -25) === null);
check("spotAt is silent at the rim",
    spotAt(SIFT_SPOTS[2].x + PILE_RADIUS, SIFT_SPOTS[2].z) === null);

// ---------------------------------------------------------------------------
// The pile as terrain, through the grounding path
// ---------------------------------------------------------------------------

const spot = SIFT_SPOTS[0];
const away = { x: spot.x + 12, z: spot.z };

const hCrown = groundedHeightAt(spot.x, spot.z);
const hAway = groundedHeightAt(away.x, away.z);

// Compared at equal z, so the foreshore ramp cancels and what is left is the
// pile plus the micro relief the open beach carries either way.
check("the shore rises over a pile", hCrown - hAway > PILE_HEIGHT - MICRO_AMP,
    "crown " + hCrown.toFixed(3) + " vs open beach " + hAway.toFixed(3) + " m");

// Grounding is the bake, not a second opinion: what the walker stands on has
// to be what the terrain draws, within the reconstruction's own smoothing.
check("grounding tracks the baked profile",
    Math.abs(hCrown - shoreProfileJS(spot.x, spot.z, 1)) < 0.02,
    "grounded " + hCrown.toFixed(3) + " vs profile " + shoreProfileJS(spot.x, spot.z, 1).toFixed(3));
check("the shore is undisturbed away from a pile",
    Math.abs(hAway - shoreProfileJS(away.x, away.z, 1)) < 0.02,
    (hAway - shoreProfileJS(away.x, away.z, 1)).toFixed(4) + " m");

// The crown is flat where the bed lands. Measured across the full bed
// footprint, through the resampling, against the micro relief the surrounding
// beach carries anyway — the bed may not sit on worse ground than open sand.
let crownMin = Infinity;
let crownMax = -Infinity;
for (let dx = -CROWN_RADIUS; dx <= CROWN_RADIUS; dx += 0.1) {
    for (let dz = -CROWN_RADIUS; dz <= CROWN_RADIUS; dz += 0.1) {
        if (Math.hypot(dx, dz) > CROWN_RADIUS) continue;
        const h = groundedHeightAt(spot.x + dx, spot.z + dz);
        crownMin = Math.min(crownMin, h);
        crownMax = Math.max(crownMax, h);
    }
}
// Two different surfaces, two different promises, and conflating them is how
// the ramp bug survived the first pass.
//
// The stones rest against the surface the terrain DRAWS — the bake, sampled
// bicubically at 0.25 m by the clipmap, which is the analytic profile to well
// under a millimetre. That one has to be dead level, because a bed poured flat
// and laid on a slope floats its seaward edge by half a stone. Un-levelled it
// measured 48 mm; rock-sift's smallest stone is 40 mm.
let levelMin = Infinity;
let levelMax = -Infinity;
for (let dx = -CROWN_RADIUS; dx <= CROWN_RADIUS; dx += 0.05) {
    for (let dz = -CROWN_RADIUS; dz <= CROWN_RADIUS; dz += 0.05) {
        if (Math.hypot(dx, dz) > CROWN_RADIUS) continue;
        const h = shoreProfileJS(spot.x + dx, spot.z + dz, 1);
        levelMin = Math.min(levelMin, h);
        levelMax = Math.max(levelMax, h);
    }
}
check("the drawn crown is level under the bed", levelMax - levelMin < 0.001,
    "relief " + ((levelMax - levelMin) * 1000).toFixed(3) + " mm across the crown");

// The walker grounds on the 0.5 m CPU mirror instead, whose B-spline drags the
// sloping face a little way into the crown. That residual is the character's
// business, not the stones' — it only has to stay inside the micro relief the
// open beach carries anyway, or the crown would read as a bump underfoot.
check("grounding over the crown stays within micro relief",
    crownMax - crownMin < MICRO_AMP,
    "relief " + ((crownMax - crownMin) * 1000).toFixed(1) + " mm through the mirror");

// The levelling is only exact while the profile is still in its linear
// stretch. If a spot is ever moved deep enough for the seabed clamp or high
// enough for the berm relax to bite, the ramp is no longer a straight line and
// cancelling it with a constant slope silently stops working.
for (const s of SIFT_SPOTS) {
    const bare = -(s.z - WATERLINE_Z) * FORESHORE_SLOPE;
    check("spot " + s.id + " sits in the profile's linear stretch",
        bare > -SEABED_DEPTH + 1.0 && bare < BERM_HEIGHT - 0.5,
        "bare height " + bare.toFixed(3) + " m");
}

// Levelling must never dig: the ramp correction is bounded by the mound.
let minLift = Infinity;
for (const s of SIFT_SPOTS) {
    for (let dz = -PILE_RADIUS; dz <= PILE_RADIUS; dz += 0.05) {
        for (let dx = -PILE_RADIUS; dx <= PILE_RADIUS; dx += 0.05) {
            if (Math.hypot(dx, dz) >= PILE_RADIUS) continue;
            minLift = Math.min(minLift, pileLift(s.x + dx, s.z + dz));
        }
    }
}
check("the pile never digs a hole", minLift >= 0,
    "lowest lift " + (minLift * 1000).toFixed(1) + " mm");

// The mound survives the mirror. A pile only a texel or two across would be
// box-filtered and B-spline-smoothed into nothing, and the player would walk
// through the bank they can see. What is measured is the loss: how much of the
// analytic rise the 0.5 m mirror gives back.
const risen = groundedHeightAt(spot.x, spot.z) - groundedHeightAt(away.x, away.z);
const analytic = shoreProfileJS(spot.x, spot.z, 1) - shoreProfileJS(away.x, away.z, 1);
check("the mound survives the 0.5 m CPU mirror", risen > analytic * 0.9,
    "mirror keeps " + ((risen / analytic) * 100).toFixed(0) + "% of " +
    (analytic * 1000).toFixed(0) + " mm");

// The face is walkable — the controller has no slope rule, so the geometry has
// to be the thing that keeps it climbable.
let maxSlope = 0;
for (let d = 0; d <= PILE_RADIUS + 1; d += 0.05) {
    const e = MIRROR_TEXEL;
    const g = (groundedHeightAt(spot.x + d + e, spot.z) - groundedHeightAt(spot.x + d - e, spot.z)) / (2 * e);
    maxSlope = Math.max(maxSlope, Math.abs(g));
}
check("the bank face is walkable", maxSlope < 0.45,
    "steepest " + ((Math.atan(maxSlope) * 180) / Math.PI).toFixed(1) + "°");

// ---------------------------------------------------------------------------
// The generated WGSL
// ---------------------------------------------------------------------------

const wgsl = pileFieldWGSL();
const terms = [...wgsl.matchAll(/let c = pileFalloff\(distance\(p, vec2f\(([-\d.]+), ([-\d.]+)\)\)\);/g)];
check("one WGSL term per spot", terms.length === SIFT_SPOTS.length,
    terms.length + " terms for " + SIFT_SPOTS.length + " spots");

let coordFail = "";
for (const [i, m] of terms.entries()) {
    if (Number(m[1]) !== SIFT_SPOTS[i].x || Number(m[2]) !== SIFT_SPOTS[i].z) {
        coordFail += SIFT_SPOTS[i].id + " ";
    }
}
check("WGSL spot coordinates match the JS", coordFail === "", coordFail);

for (const [name, value] of [["PILE_RADIUS", PILE_RADIUS], ["CROWN_RADIUS", CROWN_RADIUS], ["PILE_HEIGHT", PILE_HEIGHT]]) {
    const m = wgsl.match(new RegExp("const " + name + ": f32 = ([-\\d.]+);"));
    check("WGSL " + name + " matches the JS", m !== null && Number(m[1]) === value,
        m ? m[1] : "not emitted");
}

// The three entry points the bakes call, and nothing shadowing a Babylon
// include's names.
for (const fn of ["pileFalloff", "pileCoverage", "pileHeight", "pileMask"]) {
    check("WGSL exposes " + fn + "()", wgsl.includes("fn " + fn + "("));
}

// Every literal in the generated source is a WGSL float, not a bare integer:
// `vec2f(28, -5.1)` is a type error, and the shader would simply never become
// ready.
const bad = [...wgsl.matchAll(/vec2f\(([^)]*)\)/g)]
    .flatMap((m) => m[1].split(",").map((s) => s.trim()))
    .filter((s) => /^-?\d+$/.test(s));
check("generated literals are floats", bad.length === 0, bad.join(", "));

process.exit(failures ? 1 : 0);
