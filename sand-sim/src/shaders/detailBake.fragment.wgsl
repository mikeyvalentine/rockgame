// Bakes the tileable sand detail map used at three world scales by the sand
// material.
//
// SNOWFLOW baked packed spherical grains here — right for snow crystals,
// but on pale sand the dome lattice and its crevice darkening read as a
// honeycomb etched into the surface. Sand's close-range structure is the
// opposite: isotropic, unstructured, fine — a dust of grains far below the
// resolvable scale, carried as gentle multi-octave slope noise plus a
// near-Nyquist speckle that catches the sun as micro-glitter.
//
// Output channels (interface unchanged):
//   R,G  tangent-space normal XY (Z reconstructed in the shader)
//   B    cavity — deliberately mild; sand has no deep crevices to shade
//   A    height

varying vUV: vec2f;

uniform resolution: f32;
uniform grainScale: f32;

/// Periodic value noise: the lattice wraps at `period` cells, so every octave
/// tiles exactly and the three world-scale repeats in the material can never
/// show a seam.
fn hashP(id: vec2f, period: f32) -> f32 {
    let w = id - floor(id / period) * period;
    return fract(sin(dot(w, vec2f(127.1, 311.7))) * 43758.5453);
}

fn pnoise(p: vec2f, period: f32) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hashP(i, period);
    let b = hashP(i + vec2f(1.0, 0.0), period);
    let c = hashP(i + vec2f(0.0, 1.0), period);
    let d = hashP(i + vec2f(1.0, 1.0), period);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn sandHeight(uv: vec2f) -> f32 {
    var h = 0.0;
    // Octave periods are co-prime-ish so their beat pattern never reads as a
    // grid — the exact failure mode this rewrite exists to kill.
    h += (pnoise(uv * 31.0, 31.0) - 0.5) * 0.30;
    h += (pnoise(uv * 89.0 + vec2f(0.37, 0.11), 89.0) - 0.5) * 0.19;
    h += (pnoise(uv * 233.0 + vec2f(0.71, 0.53), 233.0) - 0.5) * 0.12;
    // The dust: near-Nyquist speckle. Individually invisible; in aggregate it
    // is what makes the surface shimmer slightly as the view moves.
    h += (pnoise(uv * 610.0 + vec2f(0.13, 0.87), 610.0) - 0.5) * 0.07;
    return h;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let e = 1.0 / uniforms.resolution;

    let h = sandHeight(uv);
    let hL = sandHeight(uv - vec2f(e, 0.0));
    let hR = sandHeight(uv + vec2f(e, 0.0));
    let hD = sandHeight(uv - vec2f(0.0, e));
    let hU = sandHeight(uv + vec2f(0.0, e));

    // Real slope (the /2e matters — see the note in the snow original), then
    // damped: sand grain should tilt normals by ~10-20°, not carve them.
    let dx = (hR - hL) / (2.0 * e);
    let dz = (hU - hD) / (2.0 * e);
    let k = uniforms.grainScale * 0.55;
    let n = normalize(vec3f(-dx * k, -dz * k, 1.0));

    // Mild cavity: barely-there tonal variation, no crevice network.
    let cav = clamp(0.88 + h * 0.35, 0.72, 1.0);

    fragmentOutputs.color = vec4f(n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, cav, h * 0.5 + 0.5);
}
