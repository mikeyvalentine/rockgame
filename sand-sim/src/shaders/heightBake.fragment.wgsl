// Bakes the beach into a two-channel float texture covering the whole field.
//
// Baked rather than evaluated live for one reason: the CPU needs the same
// heights for walker grounding and footfall placement, and reading back a GPU
// bake is the only way to guarantee the two never disagree.
//
// The profile mirrors `beachParams.js` `shoreProfileJS` structurally: foreshore
// ramp crossing y=0 exactly at the waterline, soft clamp into a flat seabed,
// berm relax on the upper beach, dune backdrop landward, micro relief on the
// flat. Sea is toward +Z.
//
// Edge conditioning: the ramp is x-uniform and the seabed/dune ends are flat by
// construction, so the clipmap's huge overhang past the texture (sampled via
// clamp addressing) continues each edge as a constant — no visible shelf.
//
// R = height (m). G = material mask channel (0 for now; the pebble band bakes
// here in phase 6).

#include<snowNoise>
#include<snowTerrain>
#include<siftPad>

varying vUV: vec2f;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform windAngle: f32;
uniform heightAmp: f32;

uniform waterlineZ: f32;
uniform pondRadius: f32;
uniform foreshoreSlope: f32;
uniform seabedDepth: f32;
uniform bermHeight: f32;
uniform bermRelax: f32;
uniform duneStart: f32;
uniform duneFade: f32;
uniform duneAmp: f32;
uniform duneBase: f32;
uniform microAmp: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let p = uniforms.worldOrigin + input.vUV * uniforms.worldSize;
    let z = p.y;

    // Foreshore ramp, from the water's edge — twin of `shoreDistance` in
    // shared/worldBounds.js: the signed distance to the pond's disc, positive
    // on land. One slope raises the beach, digs the basin and lifts the far
    // bank, so the water has something to end against on every side. The pond
    // is round, which is what curves the shoreline.
    let centre = vec2f(0.0, uniforms.waterlineZ + uniforms.pondRadius);
    let d = length(p - centre) - uniforms.pondRadius;
    var h = d * uniforms.foreshoreSlope;

    // Soft clamp into the flat seabed.
    let tSea = smoothstep(-uniforms.seabedDepth - 1.0, -uniforms.seabedDepth + 1.0, h);
    h = -uniforms.seabedDepth + (h + uniforms.seabedDepth) * tSea;

    // Berm: the upper beach relaxes toward flat.
    let tBerm = smoothstep(uniforms.bermHeight - 0.5, uniforms.bermHeight + 1.5, h);
    h = mix(h, uniforms.bermHeight + (h - uniforms.bermHeight) * uniforms.bermRelax, tBerm);

    // Dune backdrop, fading in landward of duneStart. Anisotropic about the
    // wind like the old dune field, just far smaller and pushed off the beach.
    let duneT = smoothstep(uniforms.duneStart, uniforms.duneStart - uniforms.duneFade, z);
    var relief = 0.0;
    if (duneT > 0.001) {
        let m1 = windMat(uniforms.windAngle, 1.6, 1.0, 38.0);
        let dune = fbmDamped(m1 * p, 4, 2.03, 0.5, 0.9);
        relief += (uniforms.duneBase + dune.x * uniforms.duneAmp) * duneT;
    }

    // Sifting pads — the sifting spots (shared/siftPad.js, generated into the
    // siftPad include). x is coverage, y is the levelling correction.
    //
    // No lift: a pad adds no height at all, it only makes the beach LEVEL where
    // the bed lies. rock-sift's bed is poured on flat ground under vertical
    // gravity, so the pad both damps micro relief in proportion to its coverage
    // and cancels the foreshore ramp under itself. Outside heightAmp on purpose
    // — the pads are where the player sifts, so this is a correctness term, not
    // a relief tunable.
    let pad = padDominant(p);

    // Micro relief on the open beach (fades out under the dunes, and under
    // the pads).
    let m2 = windMat(uniforms.windAngle, 1.2, 1.0, 21.0);
    let micro = fbmDamped(m2 * p + vec2f(7.3, -4.1), 3, 2.07, 0.5, 1.2);
    relief += micro.x * uniforms.microAmp * (1.0 - duneT * 0.7) * (1.0 - pad.x);

    h += relief * uniforms.heightAmp + pad.y;

    fragmentOutputs.color = vec4f(h, 0.0, 0.0, 1.0);
}
