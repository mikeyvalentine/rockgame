/**
 * The shingle piles — sifting spots expressed as terrain.
 *
 * This is the join between the sand sim and rock-sift. A sifting spot is not a
 * prop dropped on the beach: it is a *mound baked into the shore*, and the
 * stones rock-sift draws are what that mound is made of.
 *
 * Why the height bake and not the deformation field
 * -------------------------------------------------
 * `sand-sim/src/terrain/deformation.js` is the obvious home and is the wrong
 * one. It covers 80 m centred on the player, addressed toroidally, and it
 * relaxes — it exists for footprints and surf wake, marks that should fade.
 * Piles are permanent terrain: written there they would smooth away, and vanish
 * the moment the player walked off the window.
 *
 * The height bake is the right place, and it is only *one* place, because
 * `heightfield.heightCPU` is a readback of the bake rather than an independent
 * computation. Adding a mound term to the bake therefore buys both halves at
 * once: the terrain renders the pile, and `terrain.heightAt()` returns pile
 * height, so the walker climbs it with no character-controller work at all.
 *
 * Twinning
 * --------
 * The beach profile keeps a WGSL bake and a hand-written JS twin
 * (`shoreProfileJS`) in structural agreement. Piles go further: the WGSL is
 * *generated from these constants* by `pileFieldWGSL()`, so the two cannot
 * drift even in principle. Both renderers read the same numbers — the WebGPU
 * path through the generated include, the WebGL path through `pileHeightJS`.
 *
 * The flat crown is a correctness requirement, not styling
 * -------------------------------------------------------
 * rock-sift bakes its bed by pouring stones onto *flat* ground
 * (`rock-sift/src/config.js`: "the ground is flat and the pile is allowed to
 * find its own angle of repose"). A baked bed restored onto a domed or noisy
 * crown would have stones floating on the high side and buried on the low one.
 * So every mound is flat to within the micro-relief's own amplitude across
 * `CROWN_RADIUS`, which is set clear of rock-sift's `BED_RADIUS`, and the
 * mound suppresses micro relief under itself in the same proportion as it
 * rises. The bed sits on ground as flat as the ground it was poured on.
 *
 * Units are metres, sand-sim's convention. rock-sift models at 4x
 * (`config.js` `U`); converting is the caller's job at the spawn site, not
 * this module's.
 */

/**
 * Mound radius, metres — where the pile meets open sand.
 *
 * Sized against the terrain, not the bed: the height bake is 0.25 m/texel and
 * the CPU mirror the walker grounds on is 0.5 m/texel, then reconstructed with
 * a bicubic B-spline that smooths further. A mound the size of the 0.42 m sift
 * bed would survive neither. 2.4 m spans ~5 mirror texels, which is the point
 * at which the pile the player walks up is recognisably the pile they see.
 * `tools/pile-field-check.mjs` asserts this against the real resampling.
 */
import { FORESHORE_SLOPE } from "./shoreRamp.js";

export const PILE_RADIUS = 2.4;

/** Flat crown radius, metres. Comfortably clear of rock-sift's BED_RADIUS (0.42). */
export const CROWN_RADIUS = 0.9;

/**
 * Mound height, metres. A shingle bank thrown up by the waves, not a hill:
 * 0.30 m over the 1.5 m of falloff is an ~11° face, walkable without the
 * controller needing a slope rule.
 */
export const PILE_HEIGHT = 0.3;

/**
 * The sifting spots.
 *
 * Placed along the shingle band (`PEBBLE_BAND_CENTER_Z`, where waves actually
 * dump shingle) inside the walkable rect, spread far enough apart that walking
 * between them is a decision. Each keeps clear of the waterline by more than
 * its own radius so the mounds never disturb the profile's y=0 crossing.
 *
 * `variant` indexes `public/assets/beds/shore.json`'s baked variants, so the
 * four spots are four different arrangements of the same 540 stones rather
 * than one arrangement repeated.
 */
export const SIFT_SPOTS = [
    { id: "shore-w", x: -27.0, z: -7.2, variant: 0 },
    { id: "shore-c", x: -9.5, z: -4.6, variant: 1 },
    { id: "shore-e", x: 11.5, z: -8.4, variant: 2 },
    { id: "shore-f", x: 28.0, z: -5.1, variant: 3 },
];

/**
 * Radial falloff, 1 on the crown → 0 at the rim.
 *
 * Smoothstep on the *annulus* rather than the whole disc: a plain
 * `smoothstep(radius, 0, d)` peaks at a point, which is a dome, and a dome is
 * exactly what the bed cannot be poured onto. Remapping so the inner
 * CROWN_RADIUS is saturated gives a genuinely flat top with C1 joins at both
 * the crown edge and the rim — no lighting crease at either.
 */
function falloff(d) {
    if (d <= CROWN_RADIUS) return 1;
    if (d >= PILE_RADIUS) return 0;
    const t = (d - CROWN_RADIUS) / (PILE_RADIUS - CROWN_RADIUS);
    const s = 1 - t;
    return s * s * (3 - 2 * s);
}

/**
 * The pile that wins at a world point, and by how much.
 *
 * Combined with `max` rather than a sum: overlapping piles must not stack into
 * a mound taller than either, and coverage doubles as the micro-relief damping
 * factor, which has to stay bounded. The winning spot comes back too, because
 * the levelling term below needs to know which crown it is standing on.
 * @param {number} x @param {number} z world metres
 */
function dominant(x, z) {
    let cov = 0;
    let spot = null;
    for (const s of SIFT_SPOTS) {
        const dx = x - s.x;
        const dz = z - s.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= PILE_RADIUS) continue;
        const c = falloff(d);
        if (c > cov) { cov = c; spot = s; }
    }
    return { cov, spot };
}

/** Pile coverage at a world point, 0…1. @param {number} x @param {number} z */
export function pileCoverage(x, z) {
    return dominant(x, z).cov;
}

/**
 * Metres of pile above the bare shore profile — the mound, plus the levelling
 * that makes its crown horizontal.
 *
 * The crown has to be *level*, not merely smooth. Flattening the micro relief
 * was only half the job: the beach itself rises at `FORESHORE_SLOPE`, which
 * across a 1.4 m bed is 48 mm of tilt — and rock-sift's stones are 40 to 100 mm
 * across, so a bed poured on flat ground and laid on that slope floats its
 * seaward edge by half a stone. Cancelling the ramp inside the pile makes the
 * crown a true horizontal plateau at `bare(spot) + PILE_HEIGHT`.
 *
 * Levelling also keeps the crouch honest: when the player drops into a spot,
 * rock-sift simulates that bed on flat ground under vertical gravity. A crown
 * that is level is the one that does not pop at the transition.
 *
 * Exact rather than approximate, because at every spot the profile is still in
 * its linear stretch — the seabed clamp and the berm relax are both inactive
 * between z = -4 and z = -9, which `sand-sim/tools/pile-field-check.mjs`
 * asserts rather than assumes.
 */
export function pileLift(x, z) {
    const { cov, spot } = dominant(x, z);
    if (!cov) return 0;
    return cov * (PILE_HEIGHT + (z - spot.z) * FORESHORE_SLOPE);
}

/** Metres of pile above the bare shore profile. @param {number} x @param {number} z */
export function pileHeightJS(x, z) {
    return pileLift(x, z);
}

/**
 * Shingle mask for the aux bake's B channel, 0…1.
 *
 * Ramped off coverage rather than reusing it directly, so the stone shading
 * reaches the rim instead of fading out halfway down the face — a real shingle
 * bank is stone all the way to where it meets the sand. This feeds the same
 * voronoi cobble path the pebble band was built for, which is what stops the
 * distant pile reading as a smooth sand lump next to the stones rock-sift
 * draws on top of it.
 */
export function pileMaskJS(x, z) {
    const c = pileCoverage(x, z);
    if (c <= 0.02) return 0;
    const t = Math.min(1, (c - 0.02) / (0.5 - 0.02));
    return t * t * (3 - 2 * t);
}

/**
 * The spot the player is standing in, or null.
 *
 * The proximity test for the crouch prompt (slice 3). Uses the crown rather
 * than the rim: standing on the face of the bank is not standing at the bed.
 * @param {number} x @param {number} z
 */
export function spotAt(x, z, reach = CROWN_RADIUS + 0.6) {
    let best = null;
    let bestD = Infinity;
    for (const s of SIFT_SPOTS) {
        const dx = x - s.x;
        const dz = z - s.z;
        const d = Math.sqrt(dx * dx + dz * dz);
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
 * The pile field as a WGSL include, generated from the constants above.
 *
 * Unrolled to one `max` per spot, with the spot positions inlined as literals.
 * That is deliberate: no uniform array to bind and keep in sync, no runtime
 * indexing of a const array (whose materialisation rules are the kind of thing
 * that fails as a shader which silently never becomes ready), and the bake
 * reads a handful of constants the compiler folds. Four spots do not need a
 * loop.
 *
 * Structurally identical to `falloff`/`pileCoverage` above, line for line.
 */
export function pileFieldWGSL() {
    const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
    const terms = SIFT_SPOTS.map((s) => `    {
        let c = pileFalloff(distance(p, vec2f(${f(s.x)}, ${f(s.z)})));
        if (c > best.x) { best = vec2f(c, c * (PILE_HEIGHT + (p.y - (${f(s.z)})) * FORESHORE_SLOPE)); }
    }`).join("\n");

    return `// GENERATED from shared/pileField.js by pileFieldWGSL(). Do not edit.
const PILE_RADIUS: f32 = ${f(PILE_RADIUS)};
const CROWN_RADIUS: f32 = ${f(CROWN_RADIUS)};
const PILE_HEIGHT: f32 = ${f(PILE_HEIGHT)};
const FORESHORE_SLOPE: f32 = ${f(FORESHORE_SLOPE)};

fn pileFalloff(d: f32) -> f32 {
    let t = clamp((d - CROWN_RADIUS) / (PILE_RADIUS - CROWN_RADIUS), 0.0, 1.0);
    return smoothstep(0.0, 1.0, 1.0 - t);
}

/// The pile that wins here: x = coverage 0..1, y = metres of lift.
/// Winner-takes-all rather than a sum, so overlapping piles cannot stack; the
/// lift carries the crown levelling, which needs the winning spot's own z.
fn pileDominant(p: vec2f) -> vec2f {
    var best = vec2f(0.0, 0.0);
${terms}
    return best;
}

/// Coverage alone — also the micro-relief damping factor.
fn pileCoverage(p: vec2f) -> f32 {
    return pileDominant(p).x;
}

/// Metres of pile above the bare shore profile, crown levelled.
fn pileHeight(p: vec2f) -> f32 {
    return pileDominant(p).y;
}

/// Shingle mask for the aux bake — stone all the way to the rim.
fn pileMask(p: vec2f) -> f32 {
    return smoothstep(0.02, 0.5, pileCoverage(p));
}
`;
}
