// The sifting pads' structural promises — pure math over shared/siftPad.js and
// beachParams.js. No Babylon, no GPU.
//
// Three things are being pinned here, and the middle one is the one that
// matters.
//
// 1. A pad is NOT terrain the player can see. There used to be a 30 cm mound at
//    each spot and this file measured that it survived the resampling; the
//    mound is gone, so what is measured now is the opposite — that the shore
//    over a spot is at the height it would have been anyway.
//
// 2. The sand the bed lands on is LEVEL — measured through the same resampling
//    the walker's grounding actually goes through, not through the analytic
//    profile. rock-sift bakes its bed on flat ground under vertical gravity, so
//    ground that is not level means stones floating on one side of the bed and
//    buried on the other. Un-levelled, the beach's own 2 degree foreshore ramp
//    puts 39 mm of tilt across the bed, and the smallest stone is 40 mm.
//
// 3. The levelling correction is bounded, and cannot become a pit. It is signed
//    now — it lifts the seaward half of a pad and lowers the landward half — so
//    "never digs" is no longer true and "never digs MORE than the ramp it is
//    cancelling" is what replaces it.

import {
    SIFT_SPOTS, PAD_HALF_X, PAD_HALF_Z, PAD_FEATHER,
    padCoverage, padLevel, spotAt, siftPadWGSL,
} from "../../shared/siftPad.js";
import { POOL_HALF_X, POOL_HALF_Z } from "../../rock-sift/src/config.js";
import { shorePoint, shoreArc, shoreDistance } from "../../shared/worldBounds.js";
import {
    shoreProfileJS, WORLD_SIZE, HEIGHT_RES, MICRO_AMP,
    PLAY_RECT, SPAWN, WATERLINE_Z, FORESHORE_SLOPE, SEABED_DEPTH, BERM_HEIGHT,
} from "../src/terrain/beachParams.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

/** Furthest a pad reaches from its spot, on each axis. */
const REACH_X = PAD_HALF_X + PAD_FEATHER;
const REACH_Z = PAD_HALF_Z + PAD_FEATHER;

// ---------------------------------------------------------------------------
// A faithful stand-in for heightfield.js's CPU mirror.
// ---------------------------------------------------------------------------

const ORIGIN = -WORLD_SIZE / 2;
const BAKE_TEXEL = WORLD_SIZE / HEIGHT_RES;
const MIRROR_RES = HEIGHT_RES / 2;

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
    if (s.x - REACH_X < PLAY_RECT.minX || s.x + REACH_X > PLAY_RECT.maxX ||
        s.z - REACH_Z < PLAY_RECT.minZ || s.z + REACH_Z > PLAY_RECT.maxZ) {
        placementFail += s.id + " leaves the play rect; ";
    }
}
check("every spot sits wholly inside the walkable rect", placementFail === "", placementFail);

// Clear of the waterline: a pad reaching z=0 would break the profile's "crosses
// y=0 at the waterline" promise, which the water quad depends on.
let nearest = Infinity;
for (const s of SIFT_SPOTS) nearest = Math.min(nearest, Math.abs(s.z - WATERLINE_Z));
check("pads clear the waterline", nearest > REACH_Z + 0.5,
    "closest spot " + nearest.toFixed(1) + " m, reach " + REACH_Z.toFixed(2));

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
check("spots do not overlap", minSep > Math.hypot(REACH_X, REACH_Z) * 2,
    "closest pair " + minSep.toFixed(1) + " m");

// Each variant used once — four arrangements, not one repeated.
const variants = new Set(SIFT_SPOTS.map((s) => s.variant));
check("one bed variant per spot", variants.size === SIFT_SPOTS.length,
    variants.size + " distinct across " + SIFT_SPOTS.length + " spots");

// The spawn is not standing in a bed.
check("spawn is not on a pad", padCoverage(SPAWN.x, SPAWN.z) === 0);

// The pad's flat region has to contain the bed it was sized for, with margin
// for the stones a sweep pushes past the edge. This is the number that ties
// shared/siftPad.js to rock-sift/src/config.js; nothing else does.
check("the flat region covers the poured bed",
    PAD_HALF_X > POOL_HALF_X + 0.2 && PAD_HALF_Z > POOL_HALF_Z + 0.2,
    `pad ${PAD_HALF_X}x${PAD_HALF_Z} vs pool ${POOL_HALF_X}x${POOL_HALF_Z}`);

// ---------------------------------------------------------------------------
// The field itself
// ---------------------------------------------------------------------------

check("coverage saturates over the flat region",
    padCoverage(SIFT_SPOTS[0].x, SIFT_SPOTS[0].z) === 1 &&
    padCoverage(SIFT_SPOTS[0].x + PAD_HALF_X, SIFT_SPOTS[0].z + PAD_HALF_Z) === 1);
// Approaches zero rather than hitting it: the falloff is C1 at the edge, which
// is the point — a hard cut would crease the lighting where pad meets sand.
check("coverage reaches zero at the feather's edge",
    padCoverage(SIFT_SPOTS[0].x + REACH_X, SIFT_SPOTS[0].z) < 1e-6);
check("coverage is zero on open beach", padCoverage(0, -25) === 0);
check("levelling is zero on open beach", padLevel(0, -25) === 0);

// The falloff is monotonic on both axes — no ring or dip in the blend.
let mono = true;
for (let d = 0; d <= REACH_X + 0.5; d += 0.02) {
    if (padCoverage(SIFT_SPOTS[0].x + d + 0.02, SIFT_SPOTS[0].z) >
        padCoverage(SIFT_SPOTS[0].x + d, SIFT_SPOTS[0].z) + 1e-12) mono = false;
}
for (let d = 0; d <= REACH_Z + 0.5; d += 0.02) {
    if (padCoverage(SIFT_SPOTS[0].x, SIFT_SPOTS[0].z + d + 0.02) >
        padCoverage(SIFT_SPOTS[0].x, SIFT_SPOTS[0].z + d) + 1e-12) mono = false;
}
check("falloff is monotonic on both axes", mono);

// The crouch proximity test fires at the bed and nowhere else.
check("spotAt finds the spot you stand at",
    spotAt(SIFT_SPOTS[2].x, SIFT_SPOTS[2].z)?.id === SIFT_SPOTS[2].id);
check("spotAt is silent on the open beach", spotAt(0, -25) === null);
check("spotAt is silent out on the feather",
    spotAt(SIFT_SPOTS[2].x + REACH_X, SIFT_SPOTS[2].z) === null);

// ---------------------------------------------------------------------------
// The pad through the grounding path
// ---------------------------------------------------------------------------

const spot = SIFT_SPOTS[0];
// 12 m along the shore, at the same distance from the water. NOT at the same
// z: the shore is curved, so equal z is not equal depth, and 12 m of x at this
// spot is 2.3 m of extra beach — 8 cm of ramp, which is most of the tolerance
// below and read as the mound coming back.
const away = shorePoint(shoreArc(spot.x, spot.z) + 12, shoreDistance(spot.x, spot.z));

const hPad = groundedHeightAt(spot.x, spot.z);
const hAway = groundedHeightAt(away.x, away.z);

// Compared at equal depth, so the foreshore ramp cancels and what is left would be
// the pad, if the pad had any height. It does not: this is the check that the
// mound is gone, and the tolerance is the micro relief the open beach carries
// either way.
check("the shore does NOT rise over a pad", Math.abs(hPad - hAway) < MICRO_AMP,
    "pad " + hPad.toFixed(3) + " vs open beach " + hAway.toFixed(3) + " m");

// Grounding is the bake, not a second opinion: what the walker stands on has
// to be what the terrain draws, within the reconstruction's own smoothing.
check("grounding tracks the baked profile",
    Math.abs(hPad - shoreProfileJS(spot.x, spot.z, 1)) < 0.02,
    "grounded " + hPad.toFixed(3) + " vs profile " + shoreProfileJS(spot.x, spot.z, 1).toFixed(3));
check("the shore is undisturbed away from a pad",
    Math.abs(hAway - shoreProfileJS(away.x, away.z, 1)) < 0.02,
    (hAway - shoreProfileJS(away.x, away.z, 1)).toFixed(4) + " m");

// Two different surfaces, two different promises, and conflating them is how
// the ramp bug survived the first pass.
//
// The stones rest against the surface the terrain DRAWS — the bake, sampled
// bicubically at 0.25 m by the clipmap, which is the analytic profile to well
// under a millimetre. That one has to be dead level, because a bed poured flat
// and laid on a slope floats its seaward edge by half a stone.
let levelMin = Infinity;
let levelMax = -Infinity;
for (let dx = -POOL_HALF_X; dx <= POOL_HALF_X; dx += 0.05) {
    for (let dz = -POOL_HALF_Z; dz <= POOL_HALF_Z; dz += 0.05) {
        const h = shoreProfileJS(spot.x + dx, spot.z + dz, 1);
        levelMin = Math.min(levelMin, h);
        levelMax = Math.max(levelMax, h);
    }
}
check("the drawn sand is level under the bed", levelMax - levelMin < 0.001,
    "relief " + ((levelMax - levelMin) * 1000).toFixed(3) + " mm across the bed");

// The walker grounds on the 0.5 m CPU mirror instead, whose B-spline drags the
// surrounding ramp a little way into the pad. That residual is the character's
// business, not the stones' — it only has to stay inside the micro relief the
// open beach carries anyway, or the pad would read as a step underfoot.
let padMin = Infinity;
let padMax = -Infinity;
for (let dx = -PAD_HALF_X; dx <= PAD_HALF_X; dx += 0.1) {
    for (let dz = -PAD_HALF_Z; dz <= PAD_HALF_Z; dz += 0.1) {
        const h = groundedHeightAt(spot.x + dx, spot.z + dz);
        padMin = Math.min(padMin, h);
        padMax = Math.max(padMax, h);
    }
}
check("grounding over the pad stays within micro relief",
    padMax - padMin < MICRO_AMP,
    "relief " + ((padMax - padMin) * 1000).toFixed(1) + " mm through the mirror");

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

// The correction cannot exceed the ramp it exists to cancel. It is signed, so
// there is a bound in each direction, and both are the same number: no pad may
// dig a pit or raise a bank, only flatten what the beach was already doing.
const bound = REACH_Z * FORESHORE_SLOPE + 1e-9;
let worst = 0;
for (const s of SIFT_SPOTS) {
    for (let dz = -REACH_Z; dz <= REACH_Z; dz += 0.05) {
        for (let dx = -REACH_X; dx <= REACH_X; dx += 0.05) {
            worst = Math.max(worst, Math.abs(padLevel(s.x + dx, s.z + dz)));
        }
    }
}
check("levelling never exceeds the ramp it cancels", worst <= bound,
    "worst " + (worst * 1000).toFixed(1) + " mm against a bound of " + (bound * 1000).toFixed(1) + " mm");

// The pad is walkable — the controller has no slope rule, and the blend must
// not make one.
let maxSlope = 0;
for (let d = -REACH_X - 1; d <= REACH_X + 1; d += 0.05) {
    const e = WORLD_SIZE / MIRROR_RES;
    const g = (groundedHeightAt(spot.x + d + e, spot.z) - groundedHeightAt(spot.x + d - e, spot.z)) / (2 * e);
    maxSlope = Math.max(maxSlope, Math.abs(g));
}
check("the pad is walkable", maxSlope < 0.45,
    "steepest " + ((Math.atan(maxSlope) * 180) / Math.PI).toFixed(1) + "°");

// ---------------------------------------------------------------------------
// The generated WGSL
// ---------------------------------------------------------------------------

const wgsl = siftPadWGSL();
const terms = [...wgsl.matchAll(/let c = padFalloff\(p - vec2f\(([-\d.]+), ([-\d.]+)\)\);/g)];
check("one WGSL term per spot", terms.length === SIFT_SPOTS.length,
    terms.length + " terms for " + SIFT_SPOTS.length + " spots");

let coordFail = "";
for (const [i, m] of terms.entries()) {
    if (Number(m[1]) !== SIFT_SPOTS[i].x || Number(m[2]) !== SIFT_SPOTS[i].z) {
        coordFail += SIFT_SPOTS[i].id + " ";
    }
}
check("WGSL spot coordinates match the JS", coordFail === "", coordFail);

for (const [name, value] of [
    ["PAD_HALF_X", PAD_HALF_X], ["PAD_HALF_Z", PAD_HALF_Z],
    ["PAD_FEATHER", PAD_FEATHER], ["FORESHORE_SLOPE", FORESHORE_SLOPE],
]) {
    const m = wgsl.match(new RegExp("const " + name + ": f32 = ([-\\d.]+);"));
    check("WGSL " + name + " matches the JS", m !== null && Number(m[1]) === value,
        m ? m[1] : "not emitted");
}

// The entry points the bakes call. `padMask` is deliberately absent: the beach
// is sand everywhere, so nothing shades a spot as shingle any more.
for (const fn of ["padFalloff", "padCoverage", "padLevel", "padDominant"]) {
    check("WGSL exposes " + fn + "()", wgsl.includes("fn " + fn + "("));
}
check("no shingle mask survives", !wgsl.includes("padMask"));

// Every literal in the generated source is a WGSL float, not a bare integer:
// `vec2f(28, -5.1)` is a type error, and the shader would simply never become
// ready.
const bad = [...wgsl.matchAll(/vec2f\(([^)]*)\)/g)]
    .flatMap((m) => m[1].split(",").map((s) => s.trim()))
    .filter((s) => /^-?\d+$/.test(s));
check("generated literals are floats", bad.length === 0, bad.join(", "));

process.exit(failures ? 1 : 0);
