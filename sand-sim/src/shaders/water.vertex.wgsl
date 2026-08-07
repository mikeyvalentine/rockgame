// Ambient water surface — vertex stage.
//
// Displaces the plane by the ambient field's LONG octaves only (`fine = 0`):
// at this pond's quad size the two short octaves are sub-quad and would alias
// into crawling geometry, so they live in the fragment normal instead, exactly
// as babylon-water splits them. Passes world position and the projective
// coordinate the fragment samples the planar reflection with.

#include<ambientWater>

attribute position: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform time: f32;
uniform windDir: vec2f;
uniform windStrength: f32;
uniform waveScale: f32;

varying vWorld: vec3f;
varying vClip: vec4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    // Ambient is sampled at the UNDISPLACED world xz, so the pattern is anchored
    // to the world rather than sliding with its own output.
    let flatW = uniforms.world * vec4f(vertexInputs.position, 1.0);
    var p = vertexInputs.position;
    p.y += ambientField(flatW.xz, 0.0, 0.0, uniforms.windDir,
                        uniforms.windStrength, uniforms.waveScale, uniforms.time).x;

    let wp = uniforms.world * vec4f(p, 1.0);
    let clip = uniforms.viewProjection * wp;
    vertexOutputs.vWorld = wp.xyz;
    vertexOutputs.vClip = clip;
    vertexOutputs.position = clip;
}
