/**
 * The sifting pads — sifting spots expressed as terrain.
 *
 * This is the join between the sand sim and rock-sift. A sifting spot is not a
 * prop dropped on the beach: it is a patch of shore the stones actually lie in.
 *
 * There used to be a mound here — a 30 cm shingle bank the player climbed, with
 * the bed on its crown. It is gone. A bank reads as level design, and the stones
 * are meant to be part of the beach rather than a heap placed on it, so what is
 * left is the part that was never about height: the pad is *level*, at the
 * beach's own height, and nothing else.
 *
 * Why levelling survived the mound
 * --------------------------------
 * rock-sift bakes its bed by pouring stones onto flat ground
 * (`rock-sift/src/config.js`: "the ground is flat and the pile is allowed to
 * find its own angle of repose"), and the crouch simulates that bed on a flat
 * static box under vertical gravity. The beach itself rises at
 * `FORESHORE_SLOPE` — across the bed's 1.1 m of depth that is 39 mm of tilt,
 * against stones 40 to 100 mm across. Laid on the raw ramp, a bed poured flat
 * floats its seaward edge by half a stone.
 *
 * So the pad cancels the ramp under itself and damps micro relief in the same
 * proportion, and adds no height at all. The correction is a couple of
 * centimetres blended over more than a metre — invisible on screen, and exactly
 * what keeps the stones sitting in the sand rather than hovering over it.
 *
 * Why the height bake and not the deformation field
 * -------------------------------------------------
 * `sand-sim/src/terrain/deformation.js` covers 80 m centred on the player,
 * addressed toroidally, and it relaxes — it exists for footprints and surf wake,
 * marks that should fade. A pad is permanent terrain: written there it would
 * smooth away, and vanish the moment the player walked off the window.
 *
 * The height bake is the right place, and it is only *one* place, because
 * `heightfield.heightCPU` is a readback of the bake rather than an independent
 * computation. Adding the pad to the bake therefore buys both halves at once:
 * the terrain renders it, and `terrain.heightAt()` returns pad height, so the
 * walker grounds on the same surface the stones do.
 *
 * The dents the stones themselves make are NOT here. They are per-stone,
 * they change while the player digs, and they have to persist — that is
 * `shared/spotImprint.js`, drawn through the deformation field the same way a
 * footprint is.
 *
 * Rectangular, not round
 * ----------------------
 * Half-extents rather than a radius, because the stones are meant to spread
 * along the beach later rather than sitting in a disc. A strip is then a wider
 * `PAD_HALF_X`, not a new concept — and the ramp correction only depends on z,
 * so widening along the shore costs nothing.
 *
 * Twinning
 * --------
 * The beach profile keeps a WGSL bake and a hand-written JS twin
 * (`shoreProfileJS`) in structural agreement. The pad goes further: the WGSL is
 * *generated from these constants* by `siftPadWGSL()`, so the two cannot drift
 * even in principle. Both renderers read the same numbers — the WebGPU path
 * through the generated include, the WebGL path through `padLevel`.
 *
 * Units are metres, sand-sim's convention.
 */

import { FORESHORE_SLOPE } from "./shoreRamp.js";

/**
 * The flat region, half-extents in metres.
 *
 * Sized off the bed rather than off the terrain, which is the reverse of how the
 * mound was sized. A mound had to be big enough to survive the height bake's
 * 0.25 m texels and the CPU mirror's 0.5 m ones or it was a bank the player
 * walked through; a pad only has to be *level*, and a levelling correction
 * survives resampling because it is smooth and tiny. So this is simply the bed's
 * own extent (`rock-sift/src/config.js` POOL_HALF_X / POOL_HALF_Z) plus a
 * comfortable margin for the stones a sweep pushes past the edge.
 */
export const PAD_HALF_X = 1.35;
export const PAD_HALF_Z = 0.90;

/** Metres of blend from the level pad out to the beach's own ramp. */
export const PAD_FEATHER = 1.30;

/**
 * The sifting spots.
 *
 * Placed along the shingle band (`PEBBLE_BAND_CENTER_Z`, where waves actually
 * dump shingle) inside the walkable rect, spread far enough apart that walking
 * between them is a decision. Each keeps clear of the waterline by more than its
 * own reach so the pads never disturb the profile's y=0 crossing.
 *
 * `variant` indexes `public/assets/beds/shore.json`'s baked variants, so the
 * four spots are four different arrangements of the same stones rather than one
 * arrangement repeated.
 */
export const SIFT_SPOTS = [
    { id: "shore-w", x: -27.0, z: -7.2, variant: 0 },
    { id: "shore-c", x: -9.5, z: -4.6, variant: 1 },
    { id: "shore-e", x: 11.5, z: -8.4, variant: 2 },
    { id: "shore-f", x: 28.0, z: -5.1, variant: 3 },
];

/**
 * Rounded-rectangle falloff, 1 inside the flat region → 0 at the feather's edge.
 *
 * The distance is taken to the *rectangle*, not to its centre, so the whole flat
 * region saturates rather than peaking at a point. Smoothstepped, so there is no
 * lighting crease where the pad meets the ramp.
 */
function falloff(dx, dz) {
    const qx = Math.max(Math.abs(dx) - PAD_HALF_X, 0);
    const qz = Math.max(Math.abs(dz) - PAD_HALF_Z, 0);
    const d = Math.hypot(qx, qz);
    if (d >= PAD_FEATHER) return 0;
    const s = 1 - d / PAD_FEATHER;
    return s * s * (3 - 2 * s);
}

/**
 * The pad that wins at a world point, and by how much.
 *
 * Combined with `max` rather than a sum: two overlapping pads must not level
 * twice, and coverage doubles as the micro-relief damping factor, which has to
 * stay bounded. The winning spot comes back too, because the correction needs to
 * know which pad's z it is being measured against.
 * @param {number} x @param {number} z world metres
 */
function dominant(x, z) {
    let cov = 0;
    let spot = null;
    for (const s of SIFT_SPOTS) {
        const c = falloff(x - s.x, z - s.z);
        if (c > cov) { cov = c; spot = s; }
    }
    return { cov, spot };
}

/** Pad coverage at a world point, 0…1. @param {number} x @param {number} z */
export function padCoverage(x, z) {
    return dominant(x, z).cov;
}

/**
 * Metres of correction on top of the bare shore profile — the levelling, and
 * nothing else.
 *
 * Signed, and small: it cancels the foreshore ramp inside the pad, so it is
 * positive seaward of the spot and negative landward of it, and zero at the spot
 * itself. The pad therefore sits at exactly the height the beach would have had
 * there, which is what "no mound" means.
 *
 * Exact rather than approximate, because at every spot the profile is still in
 * its linear stretch — the seabed clamp and the berm relax are both inactive
 * between z = -4 and z = -9, which `sand-sim/tools/sift-pad-check.mjs` asserts
 * rather than assumes.
 */
export function padLevel(x, z) {
    const { cov, spot } = dominant(x, z);
    if (!cov) return 0;
    return cov * (z - spot.z) * FORESHORE_SLOPE;
}

/**
 * The spot the player is standing at, or null.
 *
 * The proximity test for the crouch prompt. Uses the flat region plus a step,
 * rather than the whole feather: standing on the blend is not standing at the
 * bed.
 * @param {number} x @param {number} z
 */
export function spotAt(x, z, reach = 0.7) {
    let best = null;
    let bestD = Infinity;
    for (const s of SIFT_SPOTS) {
        const qx = Math.max(Math.abs(x - s.x) - PAD_HALF_X, 0);
        const qz = Math.max(Math.abs(z - s.z) - PAD_HALF_Z, 0);
        const d = Math.hypot(qx, qz);
        if (d < reach && d < bestD) {
            bestD = d;
            best = s;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// WGSL generation
// ---------------------------------------------------------------------------

/**
 * The pad field as a WGSL include, generated from the constants above.
 *
 * Unrolled to one `max` per spot, with the spot positions inlined as literals.
 * That is deliberate: no uniform array to bind and keep in sync, no runtime
 * indexing of a const array (whose materialisation rules are the kind of thing
 * that fails as a shader which silently never becomes ready), and the bake reads
 * a handful of constants the compiler folds. Four spots do not need a loop.
 *
 * Structurally identical to `falloff`/`padCoverage` above, line for line.
 */
export function siftPadWGSL() {
    const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
    const terms = SIFT_SPOTS.map((s) => `    {
        let c = padFalloff(p - vec2f(${f(s.x)}, ${f(s.z)}));
        if (c > best.x) { best = vec2f(c, c * (p.y - (${f(s.z)})) * FORESHORE_SLOPE); }
    }`).join("\n");

    return `// GENERATED from shared/siftPad.js by siftPadWGSL(). Do not edit.
const PAD_HALF_X: f32 = ${f(PAD_HALF_X)};
const PAD_HALF_Z: f32 = ${f(PAD_HALF_Z)};
const PAD_FEATHER: f32 = ${f(PAD_FEATHER)};
const FORESHORE_SLOPE: f32 = ${f(FORESHORE_SLOPE)};

fn padFalloff(d: vec2f) -> f32 {
    let q = max(abs(d) - vec2f(PAD_HALF_X, PAD_HALF_Z), vec2f(0.0, 0.0));
    let t = clamp(length(q) / PAD_FEATHER, 0.0, 1.0);
    return smoothstep(0.0, 1.0, 1.0 - t);
}

/// The pad that wins here: x = coverage 0..1, y = metres of levelling.
/// Winner-takes-all rather than a sum, so overlapping pads cannot level twice;
/// the correction carries the winning spot's own z.
fn padDominant(p: vec2f) -> vec2f {
    var best = vec2f(0.0, 0.0);
${terms}
    return best;
}

/// Coverage alone — also the micro-relief damping factor.
fn padCoverage(p: vec2f) -> f32 {
    return padDominant(p).x;
}

/// Metres of levelling on top of the bare shore profile. No lift: see the header.
fn padLevel(p: vec2f) -> f32 {
    return padDominant(p).y;
}
`;
}
