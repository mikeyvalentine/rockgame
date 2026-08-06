// Derives everything the sand material needs to know about the macro landform
// that isn't the height itself, by differentiating the *baked* height texture
// rather than the analytic function.
//
// Differentiating the bake (instead of re-evaluating the profile) guarantees
// the normals describe the exact surface the vertex shader displaces to. If the
// two were derived independently, lighting would disagree with silhouette.
//
// Output channels:
//   R,G  dH/dx, dH/dz in metres per metre
//   B    pebble band, 0 = open sand, 1 = packed shingle (was SNOWFLOW's rock
//        mask — the freed channel the plan earmarked). World-anchored, unlike
//        anything in the toroidal deformation buffer.
//   A    exposure: 1 on scoured crests, 0 in sheltered hollows

#include<snowNoise>

varying vUV: vec2f;

var heightTex: texture_2d<f32>;
var heightTexSampler: sampler;

uniform texelWorld: f32; // world metres per height texel
uniform invHeightRes: f32;
uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform pebbleBandCenter: f32;
uniform pebbleBandWidth: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv = input.vUV;
    let t = uniforms.invHeightRes;
    let d = uniforms.texelWorld;

    let hL = textureSample(heightTex, heightTexSampler, uv - vec2f(t, 0.0));
    let hR = textureSample(heightTex, heightTexSampler, uv + vec2f(t, 0.0));
    let hD = textureSample(heightTex, heightTexSampler, uv - vec2f(0.0, t));
    let hU = textureSample(heightTex, heightTexSampler, uv + vec2f(0.0, t));
    let hC = textureSample(heightTex, heightTexSampler, uv);

    // Central difference — second-order accurate, and symmetric so flat ground
    // produces exactly zero slope instead of a bias.
    let dHdx = (hR.x - hL.x) / (2.0 * d);
    let dHdz = (hU.x - hD.x) / (2.0 * d);

    // --- exposure ----------------------------------------------------------
    // Wide-stencil Laplacian: positive on convex crests (wind-scoured), negative
    // in hollows (where loose drift collects). Feeds the wind-ridge cross-fade.
    let w = t * 6.0;
    let wd = d * 6.0;
    let lL = textureSample(heightTex, heightTexSampler, uv - vec2f(w, 0.0)).x;
    let lR = textureSample(heightTex, heightTexSampler, uv + vec2f(w, 0.0)).x;
    let lD = textureSample(heightTex, heightTexSampler, uv - vec2f(0.0, w)).x;
    let lU = textureSample(heightTex, heightTexSampler, uv + vec2f(0.0, w)).x;
    let lap = (lL + lR + lD + lU - 4.0 * hC.x) / (wd * wd);
    let exposure = clamp(0.5 - lap * 2.2, 0.0, 1.0);

    // --- pebble band --------------------------------------------------------
    // The beach is sand everywhere, by request. Nothing bakes into this channel
    // at all — not the shore band, and not the sifting spots either.
    //
    // The spots used to shade as shingle here, on the reasoning that a mound of
    // stones should read as stone from standing distance. There is no mound any
    // more, and the stones themselves are what is drawn on the pad, so a cobble
    // texture under them is a rocky patch of beach with rocks on it. The
    // overlay's mask brush still paints patches at runtime.
    //
    // (The band uniforms remain bound; unused is fine.)
    let band = 0.0;

    fragmentOutputs.color = vec4f(dHdx, dHdz, band, exposure);
}
