// The ambient wave field as SHADER SOURCE — emitted, in both GLSL and WGSL,
// from the one octave table in ambientWater.js.
//
// Why a generator and not a hand-written shader: the wave field already exists
// three times (babylon-water's AMBIENT_GLSL, the CPU twin in ambientWater.js,
// and now the sand-sim world's surface on two renderers). Every copy is a place
// the pond can quietly become a different pond. siftPad.js solved the same
// problem the same way — generate the WGSL from the JS constants so the bake
// and its grounding twin cannot drift — and this follows it: OCTAVES is the
// single source, and `tools/water-shader-check` asserts the emitted code still
// carries those exact numbers.
//
// What it emits is the OPEN-water surface only: the four-octave ambient field
// and the lost-variance estimate, as pure functions that take wind as
// arguments (no uniform-block assumptions, so the same text drops into a WGSL
// ShaderMaterial and a GLSL one). The interaction/drop sim, the reflection
// source (sky cubemap in the lab, planar mirror in the world) and the fresnel
// composition are each the CONSUMER's business — they differ per renderer and
// per lab and are not part of the shared surface.
//
// Kept byte-faithful to AMBIENT_GLSL: deep-water dispersion c = sqrt(gL/2pi)
// per octave, amplitudes scaled by waveScale so steepness holds, the two short
// octaves gated by `fine` (0 in the vertex stage, 1 in the fragment), and
// Nyquist detailWeight fading a wave as its wavelength approaches the pixel
// footprint.

import { OCTAVES } from "./ambientWater.js";

/**
 * The whole-surface slope exaggeration, inherited from babylon-water. At
 * near-glass wind it is what makes the water read as water at all, so it is a
 * LOOK constant, not a tunable — see the long note at its use in index.html.
 */
export const SLOPE_GAIN = 64.0;

const TAU = "6.2831853";
const G = "9.81";

/** Which octaves are gated by `fine` — the two SHORT ones, as in the lab. */
const FINE_FROM = 2;

const f = (n) => {
    const s = String(n);
    return s.includes(".") || s.includes("e") ? s : s + ".0";
};

// ------------------------------------------------------------------- GLSL

/**
 * GLSL fragment defining `detailWeight`, `ambientWave`, `ambientField` and
 * `ambientLostVariance`, plus `#define SLOPE_GAIN`. Concatenate ahead of any
 * shader that calls them. Classic GLSL (no version pragma) — Babylon's
 * processor migrates it for WebGL2, exactly like registry.js's other twins.
 */
export function ambientGLSL() {
    let field = "";
    let lost = "";
    for (let i = 0; i < OCTAVES.length; i++) {
        const [L, amp, dir] = OCTAVES[i];
        const gate = i >= FINE_FROM ? " * fine" : "";
        const dl = Math.hypot(dir[0], dir[1]);
        const nx = f(dir[0] / dl), ny = f(dir[1] / dl);
        field +=
            `    { float L = ${f(L)} * S; float A = ${f(amp)} * W * S${gate} * detailWeight(L, fp);\n` +
            `      total += ambientWave(wp, rot * vec2(${nx}, ${ny}), L, A, t); }\n`;
        lost +=
            `    { float L = ${f(L)} * S; float k = ${TAU} / L; float sa = ${f(amp)} * W * S * k;\n` +
            `      v += 0.5 * sa * sa * (1.0 - detailWeight(L, fp)); }\n`;
    }
    return `
#define SLOPE_GAIN ${f(SLOPE_GAIN)}

float detailWeight(float L, float fp) {
    if (fp <= 0.0) return 1.0;
    return smoothstep(fp * 1.2, fp * 3.5, L);
}

// height in .x, world-space slope in .yz
vec3 ambientWave(vec2 wp, vec2 dir, float L, float A, float t) {
    float k = ${TAU} / L;
    float c = sqrt(${G} * L / ${TAU});
    float ph = k * dot(dir, wp) - k * c * t;
    return vec3(A * sin(ph), A * cos(ph) * k * dir.x, A * cos(ph) * k * dir.y);
}

// wp: world xz. fine: 0 vertex / 1 fragment. fp: pixel footprint, metres.
// windDir: unit heading (cos,sin). W: strength. S: waveScale. t: seconds.
vec3 ambientField(vec2 wp, float fine, float fp, vec2 windDir, float W, float S, float t) {
    vec2 w = normalize(windDir + vec2(1e-6, 0.0));
    mat2 rot = mat2(w.x, w.y, -w.y, w.x);
    vec3 total = vec3(0.0);
${field}    return total;
}

float ambientLostVariance(float fp, vec2 windDir, float W, float S) {
    float v = 0.0;
${lost}    return v;
}
`;
}

// ------------------------------------------------------------------- WGSL

/**
 * WGSL twin of the above, registered as the `ambientWater` include so a water
 * shader can `#include<ambientWater>`, matching registry.js's include scheme.
 * Same functions, same math, params passed rather than read from a uniform
 * block so the include makes no assumption about the material's layout.
 */
export function ambientWGSL() {
    let field = "";
    let lost = "";
    for (let i = 0; i < OCTAVES.length; i++) {
        const [L, amp, dir] = OCTAVES[i];
        const gate = i >= FINE_FROM ? " * fine" : "";
        const dl = Math.hypot(dir[0], dir[1]);
        const nx = f(dir[0] / dl), ny = f(dir[1] / dl);
        field +=
            `    { let L = ${f(L)} * S; let A = ${f(amp)} * W * S${gate} * detailWeight(L, fp);\n` +
            `      total += ambientWave(wp, rot * vec2f(${nx}, ${ny}), L, A, t); }\n`;
        lost +=
            `    { let L = ${f(L)} * S; let k = ${TAU} / L; let sa = ${f(amp)} * W * S * k;\n` +
            `      v += 0.5 * sa * sa * (1.0 - detailWeight(L, fp)); }\n`;
    }
    return `
const SLOPE_GAIN: f32 = ${f(SLOPE_GAIN)};

fn detailWeight(L: f32, fp: f32) -> f32 {
    if (fp <= 0.0) { return 1.0; }
    return smoothstep(fp * 1.2, fp * 3.5, L);
}

fn ambientWave(wp: vec2f, dir: vec2f, L: f32, A: f32, t: f32) -> vec3f {
    let k = ${TAU} / L;
    let c = sqrt(${G} * L / ${TAU});
    let ph = k * dot(dir, wp) - k * c * t;
    return vec3f(A * sin(ph), A * cos(ph) * k * dir.x, A * cos(ph) * k * dir.y);
}

fn ambientField(wp: vec2f, fine: f32, fp: f32, windDir: vec2f, W: f32, S: f32, t: f32) -> vec3f {
    let w = normalize(windDir + vec2f(1e-6, 0.0));
    let rot = mat2x2f(w.x, w.y, -w.y, w.x);
    var total = vec3f(0.0);
${field}    return total;
}

fn ambientLostVariance(fp: f32, windDir: vec2f, W: f32, S: f32) -> f32 {
    var v = 0.0;
${lost}    return v;
}
`;
}
