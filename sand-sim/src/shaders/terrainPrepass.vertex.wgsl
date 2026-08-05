// Depth-prepass vertex shader for the terrain.
//
// Byte-for-byte the same clipmap placement, the same fine layer and the same
// band-limited deformation as snow.vertex.wgsl and terrainDepth.vertex.wgsl,
// from the same includes. If this pass placed a vertex anywhere else, every
// screen-space effect downstream would be integrating against a surface that is
// not the one on screen — and the symptom of that is an ambient-occlusion halo
// that follows the camera, which reads as a rendering bug rather than as a
// mismatch.

#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowClipmap>

attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform lodCenter: vec2f;

uniform baseSpacing: f32;
uniform gridHalfN: f32;

uniform worldOrigin: vec2f;
uniform worldSize: f32;
uniform heightRes: f32;

uniform windAngle: f32;
uniform sastrugiAmp: f32;

uniform deformCenter: vec2f;
uniform deformSize: f32;
uniform deformDepthScale: f32;

uniform waterlineZ: f32;
uniform wetNear: f32;
uniform wetFar: f32;

var heightTex: texture_2d<f32>;
var heightTexSampler: sampler;
var auxTex: texture_2d<f32>;
var auxTexSampler: sampler;
var deformTex: texture_2d<f32>;
var deformTexSampler: sampler;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let grid = vec2f(vertexInputs.position.x, vertexInputs.position.z);
    let level = vertexInputs.position.y;

    let cv = placeClipmapVertex(
        grid, level, uniforms.lodCenter,
        uniforms.baseSpacing, uniforms.gridHalfN
    );

    let worldXZ = cv.worldXZ;
    let hUV = worldToHeightUV(worldXZ, uniforms.worldOrigin, uniforms.worldSize);

    var h = sampleHeightBicubic(heightTex, heightTexSampler, hUV, uniforms.heightRes);

    let auxS = textureSampleLevel(auxTex, auxTexSampler, hUV, 0.0);
    let exposure = auxS.a;
    if (cv.spacing < 0.42) {
        let fade = 1.0 - smoothstep(0.16, 0.42, cv.spacing);
        h += terrainFine(worldXZ, uniforms.windAngle, exposure, uniforms.sastrugiAmp).x * fade;
    }

    // Same gate, same fade, same filter width as the beauty pass. See the long
    // note in snow.vertex.wgsl.
    var mask = 0.0;
    if (cv.spacing < 1.0) {
        let dfade = 1.0 - smoothstep(0.5, 1.0, cv.spacing);
        // Pebble damping — must match snow.vertex.wgsl exactly.
        h += deformHeight(
            deformTex, deformTexSampler, worldXZ,
            uniforms.deformCenter, uniforms.deformSize, uniforms.deformDepthScale,
            cv.spacing
        ) * dfade * (1.0 - 0.7 * auxS.z);
    }

    // The wetness channel, read straight rather than through `deformHeight`'s
    // binomial: this feeds a reflection gate, not a displacement.
    let dWeight = deformFalloff(worldXZ, uniforms.deformCenter, uniforms.deformSize);
    if (dWeight > 0.001) {
        let s = textureSampleLevel(
            deformTex, deformTexSampler, deformUV(worldXZ, uniforms.deformSize), 0.0
        );
        mask = clamp(s.a, 0.0, 1.0) * dWeight;
    }

    // The analytic shore band joins the dynamic channel, then the whole mask is
    // scaled to a *sheen*: prepass G gates SSR, and wet sand is a soft grazing
    // mirror, not SNOWFLOW's ice. Same formula as the beauty pass.
    let tide = noise2(vec2f(worldXZ.x * 0.045, worldXZ.y * 0.02)) * 1.8;
    let shoreWet = 1.0 - smoothstep(
        uniforms.wetNear, uniforms.wetFar,
        -(worldXZ.y - uniforms.waterlineZ) + tide
    );
    mask = max(mask, shoreWet) * 0.35;

    let clip = uniforms.viewProjection * vec4f(worldXZ.x, h, worldXZ.y, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = mask;
    vertexOutputs.position = clip;
}
