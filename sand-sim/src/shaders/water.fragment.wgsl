// Ambient water surface — fragment stage.
//
// The look is babylon-water's, with ONE deliberate change for the world: the
// reflection source is a PLANAR MIRROR of the scene (the trees, the shore, the
// sky drawn into a render target from the mirrored camera) rather than the
// lab's sky cubemap — the world has a forest to reflect and the lab does not.
// Everything else is the lab's composition: per-pixel analytic normal at full
// octave detail, a Nyquist-honest roughness recovered from the octaves too fine
// to resolve (spent here as a blurred mip of the reflection), a tight+broad sun
// lobe that trades sharpness for footprint, and the cubic F0=0.25 Fresnel.

#include<ambientWater>

uniform cameraPosition: vec3f;
uniform sunDir: vec3f;
uniform tint: vec3f;
uniform time: f32;
uniform windDir: vec2f;
uniform windStrength: f32;
uniform waveScale: f32;
uniform detailScale: f32;
uniform blurGain: f32;
uniform distortion: f32;

// Shore contour, from the pond's own geometry (shared/worldBounds + shoreRamp):
// how the water finds its edge without a terrain lookup. pondCenter/pondRadius
// give a signed distance to the waterline; foreshoreSlope turns that into an
// approximate depth, the same ramp the ground is built on, so the water ends
// exactly where the sand emerges.
uniform pondCenter: vec2f;
uniform pondRadius: f32;
uniform foreshoreSlope: f32;
uniform seabedDepth: f32;

// Terrain-driven shore: when useTerrainDepth is on, depth comes from the baked
// ground height under each pixel, so the waterline follows the real (irregular)
// shore instead of the circle SDF below.
uniform useTerrainDepth: f32;
uniform terrainOrigin: vec2f;
uniform terrainSize: f32;
uniform waterLevelY: f32;

var reflectionTex: texture_2d<f32>;
var reflectionTexSampler: sampler;
var terrainHeightTex: texture_2d<f32>;
var terrainHeightTexSampler: sampler;

// The shore band widths, in metres of depth.
const SHALLOW_FADE: f32 = 0.12;  // water fades to nothing over this depth
const SHALLOW_TINT: f32 = 0.6;   // shallows read lighter within this depth
const FOAM_BAND: f32 = 0.05;     // foam sits within this depth of the edge

varying vWorld: vec3f;
varying vClip: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let wp = fragmentInputs.vWorld;

    // How much world lies under one pixel. Grows toward the horizon at a low
    // shore view — a distant pixel spans many wave cycles — which is exactly
    // what point-sampling the normal there turns into sparkle.
    let fw = fwidth(wp.xz);
    let fpTrue = max(fw.x, fw.y);
    let fp = fpTrue / max(uniforms.detailScale, 0.01);

    let amb = ambientField(wp.xz, 1.0, fp, uniforms.windDir,
                           uniforms.windStrength, uniforms.waveScale, uniforms.time);
    let slope = amb.yz * SLOPE_GAIN;
    let N = normalize(vec3f(-slope.x, 1.0, -slope.y));

    let incoming = normalize(wp - uniforms.cameraPosition);
    let R = reflect(incoming, N);

    // Projective sample of the mirror, perturbed by the surface slope so the
    // reflection ripples. WebGPU's framebuffer V is top-left, so flip it.
    var uv = fragmentInputs.vClip.xy / fragmentInputs.vClip.w * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;
    uv += N.xz * uniforms.distortion;

    // Roughness recovered from unresolved octaves, spent on a blurred mip: a
    // rough surface reflects a cone of directions, and the mip is the average
    // over it, so the normal keeps full detail without the reflection tearing.
    var lod = 0.0;
    if (uniforms.blurGain > 0.0) {
        let lostVar = ambientLostVariance(fpTrue, uniforms.windDir,
                                          uniforms.windStrength, uniforms.waveScale)
                      * SLOPE_GAIN * SLOPE_GAIN;
        lod = clamp(log2(1.0 + lostVar * uniforms.blurGain), 0.0, 7.0);
    }
    var refl = textureSampleLevel(reflectionTex, reflectionTexSampler,
                                  clamp(uv, vec2f(0.0), vec2f(1.0)), lod).rgb;

    // Tight lobe up close; as it fades with footprint a broad one takes over,
    // so distance reads as a rougher, spread highlight rather than crawling
    // white speckle.
    let sunDot = max(0.0, dot(uniforms.sunDir, R));
    let keep = detailWeight(0.30, fpTrue);
    let sharp = pow(sunDot, 5000.0) * keep;
    let broad = pow(sunDot, 60.0) * (1.0 - keep) * 0.12;
    refl += vec3f(sharp + broad) * vec3f(10.0, 8.0, 6.0);

    // Cubic F0=0.25 Fresnel — never near-black head-on, mirror at grazing.
    let fresnel = mix(0.25, 1.0, pow(1.0 - dot(N, -incoming), 3.0));
    let body = refl * uniforms.tint;
    var color = mix(body, refl, fresnel);

    // ---- shore ---------------------------------------------------------------
    // Water depth here. With a baked terrain it is the real gap between the
    // water level and the authored ground (so the shore follows the mesh, not a
    // circle); otherwise the circle SDF ramped by the foreshore slope. The
    // ambient wave height rides on top, so the shore line and foam breathe.
    var depth: f32;
    if (uniforms.useTerrainDepth > 0.5) {
        let tuv = (wp.xz - uniforms.terrainOrigin) / uniforms.terrainSize;
        let th = textureSampleLevel(terrainHeightTex, terrainHeightTexSampler,
                                    clamp(tuv, vec2f(0.0), vec2f(1.0)), 0.0).r;
        depth = clamp((uniforms.waterLevelY - th) - amb.x, -2.0, uniforms.seabedDepth);
    } else {
        let shoreDist = length(wp.xz - uniforms.pondCenter) - uniforms.pondRadius;
        depth = clamp((-shoreDist) * uniforms.foreshoreSlope - amb.x, 0.0, uniforms.seabedDepth);
    }

    // Shallows lift toward a lighter, greener colour before the edge.
    color = mix(vec3f(0.16, 0.30, 0.32), color, smoothstep(0.0, SHALLOW_TINT, depth));

    // A foam lip right at the waterline — on the WATER side only. depth < 0 is
    // land (the disc overshoots the basin to cover its irregular edge); foam
    // must be zero there or the whole disc paints white over the beach.
    var foam = 0.0;
    if (depth > 0.0) { foam = 1.0 - smoothstep(0.0, FOAM_BAND, depth); }
    color = mix(color, vec3f(0.92, 0.96, 1.0), foam * 0.8);

    // Fade the surface out over the last few centimetres of depth so it ends on
    // the shore contour with no rim; keep the foam lip opaque as it does.
    let alpha = max(smoothstep(0.0, SHALLOW_FADE, depth), foam);
    fragmentOutputs.color = vec4f(color, alpha);
}
