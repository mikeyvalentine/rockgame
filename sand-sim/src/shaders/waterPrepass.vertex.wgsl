// The water quad's slice of the camera-space depth prepass.
//
// Without this, water pixels carry the *cleared* prepass depth (9000 m — sky),
// and everything screen-space misclassifies them: TAA reprojects the plane
// against sky parallax and smears it, depth of field blurs it as horizon, the
// shafts treat it as unoccluded air. Two triangles through the shared prepass
// fragment stage fix all four at once.
//
// The spec mask is written 0: the env-map reflection on the PBR water is the
// intended look, and inviting SSR onto a huge plane is a cost with no visual
// upside here.

attribute position: vec3f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let wp = uniforms.world * vec4f(vertexInputs.position, 1.0);
    let clip = uniforms.viewProjection * wp;
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 0.0;
    vertexOutputs.position = clip;
}
