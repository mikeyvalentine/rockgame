// -----------------------------------------------------------------------------
// The snow material.
//
// Normals arrive from four independent sources and have to be combined in the
// right order or the surface stops holding together:
//
//   macro     baked landform gradient        tens of metres → ~1 m
//   fine      analytic sastrugi and ripples  ~2 m → ~10 cm
//   detail    tiled generated grain map      ~10 cm → ~5 mm
//   deform    the terrain state buffer       whatever the player carved
//
// Macro and fine and deform are all *heightfield gradients* in world space, so
// they add as slopes before ever becoming a normal. Only the detail map is a
// tangent-space normal, and it is folded in last with reoriented normal mapping.
// Adding normals instead of slopes is the classic way to lose the landform under
// the detail.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowShading>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vHeightUV: vec2f;
varying vViewDist: f32;
varying vSpacing: f32;

// ------------------------------------------------------------------ textures
var auxTex: texture_2d<f32>;
var auxTexSampler: sampler;
var detailTex: texture_2d<f32>;
var detailTexSampler: sampler;
var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;
var deformTex: texture_2d<f32>;
var deformTexSampler: sampler;
var maskTex: texture_2d<f32>;
var maskTexSampler: sampler;

// ------------------------------------------------------------------ uniforms
uniform cameraPos: vec3f;
uniform sunDir: vec3f;
/// Direct solar irradiance at the ground, already atmospherically extinguished
/// and in the same units the sky LUT stores radiance in.
uniform sunRadiance: vec3f;

uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
/// Per cascade: (depth range in metres, ortho width in metres, unused, unused).
uniform cascadeParams: array<vec4f, 3>;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform windAngle: f32;
uniform sastrugiAmp: f32;
uniform detailStrength: f32;
uniform glintIntensity: f32;
uniform glintGrazing: f32;
uniform sssStrength: f32;
uniform sssRadius: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

uniform worldOrigin: vec2f;
uniform worldSize: f32;

uniform deformCenter: vec2f;
uniform deformSize: f32;
uniform deformTexel: f32;
uniform deformDepthScale: f32;

uniform ambientIntensity: f32;
uniform debugMode: f32;
uniform screenSize: vec2f;

// Sand palette + the analytic shore-wetness band. See looks/sandTone.js —
// these are set once at material creation from the shared module.
uniform sandDry: vec3f;
uniform sandWet: vec3f;
uniform waterlineZ: f32;
uniform wetNear: f32;
uniform wetFar: f32;

// The world-anchored paint mask (terrain/maskPaint.js): R pebble add/erase
// about 0.5, G wetness override about 0.5. Never in the toroidal deform
// buffer — it would smear when the window scrolls.
uniform maskOrigin: vec2f;
uniform maskSize: f32;
uniform pebbleTint: vec3f;

// The cascade projection and PCSS selection live in a shared include, because
// the character material has to run the byte-identical lookup — the Y-flip
// convention and the receiver-plane gradient are exactly the sort of thing that
// two copies would quietly disagree about.
#include<snowShadowLookup>

// -----------------------------------------------------------------------------

/// Diagnostic: how far the depth map and the receiver disagree, in metres.
///
/// Projects exactly as `sampleCascadeTex` does — same normal offset, same
/// cascade selection — but takes the single centre tap and returns
/// (stored - receiver) scaled to world metres. Near zero means the two passes
/// are describing the same surface and any remaining artefact is a bias or
/// filter question. Hundreds of metres means they are not, and no amount of
/// bias tuning is going to help.
fn shadowMapDelta(world: vec3f, geoN: vec3f, viewDist: f32) -> f32 {
    let sp = uniforms.cascadeSplits;
    var m = uniforms.cascadeMatrices[2];
    var params = uniforms.cascadeParams[2];
    var idx = 2;
    if (viewDist < sp.x) { m = uniforms.cascadeMatrices[0]; params = uniforms.cascadeParams[0]; idx = 0; }
    else if (viewDist < sp.y) { m = uniforms.cascadeMatrices[1]; params = uniforms.cascadeParams[1]; idx = 1; }

    let lf = -uniforms.sunDir;
    let lr = normalize(cross(vec3f(0.0, 1.0, 0.0), lf));
    let nl3 = vec3f(dot(geoN, lr), dot(geoN, cross(lf, lr)), dot(geoN, lf));
    let sinL = sqrt(clamp(1.0 - nl3.z * nl3.z, 0.0, 1.0));
    let biased = world + geoN * (params.y * uniforms.shadowTexel * 1.5 * max(sinL, 0.2));

    let clip = m * vec4f(biased, 1.0);
    let ndc = clip.xyz / clip.w;
    // 1e9 flags "this point is not inside the cascade at all".
    if (any(abs(ndc.xy) > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return 1e9; }

    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 + ndc.y * 0.5);
    var d = 0.0;
    if (idx == 0) { d = textureSampleLevel(cascade0, cascade0Sampler, uv, 0.0).r; }
    else if (idx == 1) { d = textureSampleLevel(cascade1, cascade1Sampler, uv, 0.0).r; }
    else { d = textureSampleLevel(cascade2, cascade2Sampler, uv, 0.0).r; }

    return (d - ndc.z) * params.x;
}

/// Unpack a two-channel tangent-space normal.
fn unpackN(rg: vec2f) -> vec3f {
    let xy = rg * 2.0 - 1.0;
    return vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

/// Triplanar detail-normal fetch. Snow on a steep rock face has no sensible
/// planar projection, and stretching the grain up a 60-degree slope is instantly
/// legible as a smear.
///
/// Gradients are passed in rather than taken here: every call site sits behind a
/// footprint test, and WGSL forbids implicit-derivative sampling under
/// non-uniform control flow. Explicit gradients keep full mip filtering — which
/// this absolutely needs, since the whole point of the fade-in is anti-aliasing.
fn detailNormal(
    world: vec3f, N: vec3f, scale: f32, blendSteep: f32,
    ddxW: vec3f, ddyW: vec3f
) -> vec3f {
    var n = unpackN(textureSampleGrad(
        detailTex, detailTexSampler, world.xz * scale,
        ddxW.xz * scale, ddyW.xz * scale
    ).xy);

    if (blendSteep > 0.01) {
        let a = unpackN(textureSampleGrad(
            detailTex, detailTexSampler, world.xy * scale,
            ddxW.xy * scale, ddyW.xy * scale
        ).xy);
        let b = unpackN(textureSampleGrad(
            detailTex, detailTexSampler, world.zy * scale,
            ddxW.zy * scale, ddyW.zy * scale
        ).xy);
        let w = abs(N);
        let sum = w.x + w.y + w.z;
        n = normalize(mix(n, (a * w.z + b * w.x + n * w.y) / sum, blendSteep));
    }
    return n;
}

/// Voronoi cobbles for the pebble band. Returns (offset to the nearest stone
/// centre .xy, edge distance F2−F1 .z, per-stone hash .w).
fn cobble(p: vec2f) -> vec4f {
    let g = floor(p);
    let f = fract(p);
    var f1 = 8.0;
    var f2 = 8.0;
    var off = vec2f(0.0);
    var id = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let n = vec2f(f32(dx), f32(dy));
            let h = hash22(g + n);
            let c = n + 0.5 + (h - 0.5) * 0.75 - f;
            let d = dot(c, c);
            if (d < f1) {
                f2 = f1;
                f1 = d;
                off = c;
                id = h.x;
            } else if (d < f2) {
                f2 = d;
            }
        }
    }
    return vec4f(off, sqrt(f2) - sqrt(f1), id);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let viewDist = input.vViewDist;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // World-space size of this pixel — drives every filtering decision below.
    // Taken once here, in uniform control flow, and threaded down to the texture
    // fetches that sit behind footprint tests.
    let ddxW = dpdx(world);
    let ddyW = dpdy(world);
    let footprint = max(length(vec2f(length(ddxW.xz), length(ddyW.xz))), 1e-4);

    // The *narrow* axis of that footprint, which is a very different number.
    //
    // At grazing incidence a pixel's world footprint is a long thin sliver: one
    // axis blows up while the other stays small. `footprint` above averages the
    // two, so simply tilting the camera down towards the horizon inflates it by
    // an order of magnitude — and anything keyed off it fades out, even though
    // the surface is no further away and is still perfectly resolvable across the
    // sliver's short axis. For the natural detail layers that trade is fine and
    // deliberate. For carved snow it is not: it means the trail changes shape
    // when you move the camera and not the player, which reads as a bug because
    // it is one. This is the same reasoning anisotropic texture filtering runs on.
    let footprintMin = max(min(length(ddxW.xz), length(ddyW.xz)), 1e-4);

    // A facet-proof twin of `footprintMin`, for anything sampled on CARVED
    // geometry. Screen derivatives of world position are constant per
    // triangle, so on a displaced crater wall every triangle reports a
    // different footprint and anything keyed off it — the deformation-normal
    // blur width, above all — shades as flat plates that appear and vanish
    // with view angle. Distance-based instead: view distance interpolates
    // continuously across triangle edges. (1.12 ≈ 2·tan(fov/2) at the rig's
    // fixed 1.02 rad FOV.)
    let fpSmooth = min(
        footprintMin,
        input.vViewDist * (1.12 / max(uniforms.screenSize.y, 1.0))
    );

    // ---------------------------------------------------------------- slopes
    let aux = textureSampleLevel(auxTex, auxTexSampler, input.vHeightUV, 0.0);
    var grad = aux.xy;
    let rockMask = aux.z; // the baked pebble band
    let exposure = aux.w;

    // Paint-mask controls, sampled once in uniform flow. Clamp addressing +
    // neutral-filled texture means "outside the painted region" reads 0.5.
    let maskCtl = textureSampleLevel(
        maskTex, maskTexSampler,
        clamp((world.xz - uniforms.maskOrigin) / uniforms.maskSize,
              vec2f(0.0), vec2f(1.0)),
        0.0
    );

    let fine = terrainFineFiltered(
        world.xz, uniforms.windAngle, exposure, uniforms.sastrugiAmp, footprint
    );
    grad += fine.yz;

    // ------------------------------------------------------------ deformation
    // Depression, displaced berm mass and compression, written by feet, the
    // surf wake and every spell. Read here so lighting responds to carved snow
    // exactly as it does to natural relief.
    var compression = 0.0;
    var iceAmount = 0.0;
    var deformDepth = 0.0;
    var deformBerm = 0.0;

    let dWeight = deformFalloff(world.xz, uniforms.deformCenter, uniforms.deformSize);
    if (dWeight > 0.001) {
        let dUV = deformUV(world.xz, uniforms.deformSize);
        let c = textureSampleLevel(deformTex, deformTexSampler, dUV, 0.0);

        // Gradient of (berm - depression), by central difference.
        //
        // The step *widens with the pixel* rather than being fixed at two texels
        // behind a distance fade. Two texels differenced at 30 m is a normal
        // sampled far below the pixel's own footprint, so it aliases. Fading it
        // out fixes the aliasing but stops the trail existing about fifteen
        // metres out, and a run should be visible from across the field.
        //
        // Widening the baseline is the better answer: it is the low-pass filter
        // the fade was standing in for. The difference stays bounded while the
        // divisor grows, so the gradient rolls off smoothly with distance instead
        // of being switched off, and the trail survives as a tonal line long
        // after it has stopped being a shape.
        //
        // Keyed to the narrow footprint axis, so the width tracks how far away the
        // snow is and not how obliquely it is being looked at.
        let step = max(uniforms.deformTexel * 2.0, fpSmooth * 1.4);
        let eUV = step / uniforms.deformSize;

        let dxA = textureSampleLevel(deformTex, deformTexSampler, dUV + vec2f(eUV, 0.0), 0.0);
        let dxB = textureSampleLevel(deformTex, deformTexSampler, dUV - vec2f(eUV, 0.0), 0.0);
        let dzA = textureSampleLevel(deformTex, deformTexSampler, dUV + vec2f(0.0, eUV), 0.0);
        let dzB = textureSampleLevel(deformTex, deformTexSampler, dUV - vec2f(0.0, eUV), 0.0);
        let sx = (dxA.g - dxA.r) - (dxB.g - dxB.r);
        let sz = (dzA.g - dzA.r) - (dzB.g - dzB.r);

        // The four neighbours are already fetched, so blending them into the
        // state channels once the pixel is wider than a texel costs nothing and
        // stops a distant trail breaking into a dotted line.
        let wide = clamp(fpSmooth / (uniforms.deformTexel * 4.0), 0.0, 1.0) * 0.8;
        let df = mix(c, (c + dxA + dxB + dzA + dzB) * 0.2, wide);

        deformDepth = df.r * dWeight;
        deformBerm = df.g * dWeight;
        compression = clamp(df.b, 0.0, 1.0) * dWeight;
        iceAmount = clamp(df.a, 0.0, 1.0) * dWeight;

        grad += vec2f(sx, sz) / (2.0 * step) * uniforms.deformDepthScale * dWeight;
    }

    var N = normalFromGradient(grad);

    // The surface the *depth pass* rendered: macro landform, the analytic fine
    // layer and carved snow, but nothing finer. The shading normal below picks up
    // three tiled grain scales on top of this, and biasing the shadow lookup
    // against that would describe a surface orders of magnitude higher in
    // frequency than the one in the depth map — the offset would point off in a
    // different direction on every pixel and reintroduce the noise it exists to
    // remove.
    let geoN = N;

    // ---------------------------------------------------------- detail normals
    // Three tiling scales, each faded by footprint so the finest only exists
    // when it is actually resolvable, and cross-faded so no scale ever pops in.
    // Engages earlier than the snow original (0.55→0.9): crater walls sit in
    // the 35-60° band where the planar xz projection stretches the grain into
    // stripes, and the triplanar blend is exactly the cure.
    let steep = smoothstep(0.35, 0.75, 1.0 - N.y);
    if (uniforms.detailStrength > 0.001) {
        var acc = vec3f(0.0, 0.0, 1.0);

        let f0 = 1.0 - smoothstep(0.004, 0.02, footprint);
        if (f0 > 0.001) {
            let d = detailNormal(world, N, 7.5, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3f(0.0, 0.0, 1.0), d, f0));
        }
        let f1 = 1.0 - smoothstep(0.02, 0.12, footprint);
        if (f1 > 0.001) {
            let d = detailNormal(world, N, 1.7, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3f(0.0, 0.0, 1.0), d, f1 * 0.85));
        }
        let f2 = 1.0 - smoothstep(0.1, 0.7, footprint);
        if (f2 > 0.001) {
            let d = detailNormal(world, N, 0.31, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3f(0.0, 0.0, 1.0), d, f2 * 0.6));
        }

        // Lift the tangent-space result onto the geometric normal.
        let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(N.y) > 0.99);
        let T = normalize(cross(up, N));
        let B = cross(N, T);
        let s = uniforms.detailStrength * mix(1.0, 0.45, compression);
        N = normalize(N + (T * acc.x + B * acc.y) * s);
    }

    let cavity = textureSampleGrad(
        detailTex, detailTexSampler, world.xz * 1.7,
        ddxW.xz * 1.7, ddyW.xz * 1.7
    ).z;

    // ------------------------------------------------------------- material
    // Sand. Dry is a pale cool grey-beige; wet darkens hard and tightens the
    // specular — the wet band at the waterline is what anchors the shoreline
    // visually against clipmap ring morphs.
    var albedo = uniforms.sandDry;
    var roughness = 0.72;
    var f0 = vec3f(0.022);
    var thickness = 0.5; // sand transmits far less than snow ever did

    // Trodden sand: packed, slightly darker, tighter specular.
    albedo = mix(albedo, uniforms.sandDry * 0.8, compression * 0.85);
    roughness = mix(roughness, 0.5, compression);
    thickness = mix(thickness, 0.2, compression);

    // Wetness. Two sources sharing one response: the analytic shore band (the
    // waterline is a known world line, so this costs a smoothstep), and the
    // dynamic A channel the dig tool writes (`iceAmount` is that channel,
    // repurposed — see deformSim.fragment.wgsl).
    let tide = noise2(vec2f(world.x * 0.045, world.z * 0.02)) * 1.8;
    let shoreWet = 1.0 - smoothstep(
        uniforms.wetNear, uniforms.wetFar,
        -(world.z - uniforms.waterlineZ) + tide
    );
    let wet = max(
        max(shoreWet, iceAmount),
        clamp((maskCtl.y - 0.5) * 2.0, 0.0, 1.0)
    );
    albedo = mix(albedo, uniforms.sandWet, wet * 0.9);
    roughness = mix(roughness, 0.30, wet);
    f0 = mix(f0, vec3f(0.035), wet);
    thickness = mix(thickness, 0.1, wet);

    // ------------------------------------------------------------- pebbles
    // The material split the whole lab exists for: same deformation sim
    // underneath, different skin. Static band from the aux bake + the overlay
    // brush's painted add/erase. Cobbles are procedural voronoi domes, faded
    // by pixel footprint so they can't alias at distance — past the fade the
    // band survives as tint.
    // The deadband matters: the neutral paint mask stores 128/255, which is
    // 0.004 above 0.5 — without subtracting it, every texel on the beach
    // carries a trace of pebble and the cobble pattern leaks everywhere.
    let pebble = clamp(rockMask + (maskCtl.x - 0.5) * 2.0 - 0.012, 0.0, 1.0);
    var pebbleAO = 1.0;
    if (pebble > 0.02) {
        let pc = cobble(world.xz * 13.3); // ~7.5 cm stones
        let tintVar = 0.78 + 0.5 * pc.w;
        var stoneCol = uniforms.pebbleTint * tintVar;
        // Slight hue spread — a real shingle bank is not one grey.
        stoneCol *= vec3f(1.0 + (pc.w - 0.5) * 0.16, 1.0, 1.0 - (pc.w - 0.5) * 0.12);
        albedo = mix(albedo, stoneCol * mix(1.0, 0.55, wet), pebble * 0.9);
        roughness = mix(roughness, mix(0.6, 0.22, wet), pebble * 0.8);
        thickness = mix(thickness, 0.05, pebble);

        let detail = (1.0 - smoothstep(0.015, 0.12, footprint)) * pebble;
        if (detail > 0.001) {
            // Dome each stone and shade the crevices between them.
            let domeN = normalize(vec3f(-pc.x, 0.9, -pc.y));
            N = normalize(mix(N, normalize(N + domeN * 0.8), detail * 0.75));
            pebbleAO = 1.0 - smoothstep(0.22, 0.02, pc.z) * 0.55 * detail;
        }
    }
    // Downstream compatibility: pebbles behave like SNOWFLOW's exposed rock
    // did — no subsurface, tight wrap, no quartz sparkle.
    let rockExposed = pebble;

    // --- carved-sand surface state -----------------------------------------
    // Freshly displaced mass is loose, DRY sand: thrown grains drain and dry as
    // they fly, so a berm reads brighter than the (possibly damp) bed it landed
    // on, and rougher. This is also why a dig hole's rim stays pale while its
    // floor darkens with the wetness the dig writes into the A channel.
    if (deformBerm > 0.002) {
        let loose = clamp(deformBerm * 5.0, 0.0, 1.0);
        albedo = mix(albedo, uniforms.sandDry * 1.06, loose * 0.6);
        roughness = mix(roughness, 0.82, loose * 0.6);
        thickness = mix(thickness, 0.6, loose * 0.5);
        // Granulated surface: clumps of thrown sand, not a smooth pile.
        let chunk = noise2(world.xz * 34.0) * 0.5 + 0.5;
        albedo *= 1.0 - loose * 0.08 * chunk;
    }

    // Micro-occlusion in the grain crevices, and stronger in carved edges. See
    // the note where this is applied, at the bottom: it scales the whole
    // radiance, not the ambient, and it carries a blue shift with it.
    //
    // Analytic only, deliberately. A snow field is the worst possible content
    // for a screen-space occlusion pass: an open, smooth, high-albedo surface
    // viewed at grazing angles, so the estimator has almost no real occluders to
    // find and what it returns is dominated by its own view-dependent bias — a
    // broad, soft darkening keyed to distance from the camera, which slides
    // across the ground when the camera moves and nothing else does.
    var ao = mix(1.0, cavity, 0.35 * (1.0 - smoothstep(0.02, 0.25, footprint)))
           * (1.0 - clamp(deformDepth * 1.9, 0.0, 1.0) * 0.38);
    ao *= pebbleAO;

    // ------------------------------------------------------------- lighting
    let NdotL = dot(N, L);
    let NdotV = clamp(dot(N, V), 1e-4, 1.0);

    // Stable per-pixel rotation for the shadow filter. IGN over pixel coords is
    // exactly the noise TAA is built to resolve.
    let pix = input.position.xy;
    let noiseRot = ign(pix) * 6.28318530718;

    var shadow = 1.0;
    if (NdotL > -0.35) {
        shadow = sunShadow(world, geoN, viewDist, noiseRot);
    }

    let sunRadiance = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // --- direct diffuse, wrapped -------------------------------------------
    // Snow's mean free path is millimetres, so light wraps well past the
    // geometric terminator. This is why snow shadow edges are soft even where
    // the shadow map is pin sharp.
    // Sand wraps far less than snow — grains are opaque, the mean free path is
    // sub-millimetre. What softness remains comes from micro-shadowing.
    let wrapAmount = mix(0.35, 0.12, max(compression, rockExposed));
    let diff = wrapDiffuse(NdotL, wrapAmount);
    var direct = albedo * INV_PI * sunRadiance * diff * shadow;

    // --- subsurface --------------------------------------------------------
    let sss = snowSubsurface(
        N, L, V, sunRadiance, thickness,
        uniforms.sssStrength * (1.0 - rockExposed), uniforms.sssRadius
    );
    // Only partly shadowed: scattered light arrives through the snow, so a
    // shadowed drift lip still glows. Killing this with the shadow term is what
    // makes shadowed snow go flat and grey.
    direct += sss * albedo * mix(0.42, 1.0, shadow);

    // --- direct specular ---------------------------------------------------
    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let NdotH = clamp(dot(N, H), 0.0, 1.0);
        let VdotH = clamp(dot(V, H), 0.0, 1.0);
        let D = distributionGGX(NdotH, roughness);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        let F = fresnelSchlick(VdotH, f0);
        direct += sunRadiance * D * Vis * F * NdotL * shadow;
    }

    // --- ambient -----------------------------------------------------------
    // Sky irradiance from SH. Strongly blue by construction, which is the other
    // half of the warm-light / cool-shadow split that sells snow.
    var irradiance = shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;

    // Snow bounces onto itself: a huge, bright, near-white surround. Without a
    // bounce term the troughs go far too dark for a material with 0.85 albedo.
    let bounceUp = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    irradiance += shIrradiance(vec3f(0.0, 1.0, 0.0), uniforms.shR)
                * uniforms.ambientIntensity * 0.28 * bounceUp * albedo;

    var ambient = albedo * INV_PI * irradiance;

    // Ambient specular from the sky, at a roughness-selected mip.
    let R = reflect(-V, N);
    let mip = sqrt(roughness) * 6.0;
    let skyRefl = textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(R), mip).rgb;
    let Fr = fresnelSchlickRough(NdotV, f0, roughness);
    // Wet sand carries a visible sky sheen at grazing angles; dry sand barely.
    ambient += skyRefl * Fr * uniforms.ambientIntensity * mix(1.0, 1.8, wet);

    var color = direct + ambient;

    // --- glints ------------------------------------------------------------
    // Last, and added as radiance rather than modulated into the BRDF, because
    // a glint is a specular highlight from a crystal facet that the shading
    // normal does not represent.
    if (uniforms.glintIntensity > 0.001 && rockExposed < 0.5) {
        let g = snowGlints(
            world.xz, N, V, L, footprint,
            uniforms.glintIntensity, uniforms.glintGrazing
        );
        // Quartz sparkle. Wet grains stop glinting — water fills the facets.
        color += sunRadiance * g * shadow * (1.0 - wet * 0.75) * 0.55;
    }

    // ---- occlusion, applied last and to everything -------------------------
    //
    // Two rules, the same two the surf wake's fragment shader carries. Both are
    // about hue rather than brightness.
    //
    //  1. It scales the *finished radiance*, not the ambient. The textbook says
    //     occlusion darkens ambient and leaves direct light alone, and in this
    //     scene that is actively wrong: the ambient is where all the blue lives —
    //     the sky is strongly blue-shifted by construction — and the sun is a
    //     13-degree beam at roughly 17:13:6. Attenuating one and not the other
    //     does not darken a surface, it re-weights a cool source against a warm
    //     one. A trench floor at 40% ambient and 100% sun is not a dark trench,
    //     it is a *brown* trench, and it lands there because AgX stops rolling
    //     saturation off half a stop below its shoulder.
    //
    //  2. Wherever it does darken, it goes blue in proportion. Light reaching
    //     into a hollow in snow has scattered through snow to get there, and snow
    //     absorbs red over any appreciable path — which is why a real snow cave
    //     is blue and not grey. The tint is the same `deepTint` the subsurface
    //     term uses, and tying it to the darkening rather than to `deformDepth`
    //     means the two can never drift apart.
    // Sand hollows go warm-dark, not snow-cave blue: light reaching into a
    // sand crevice has bounced off warm grains, not scattered through ice.
    let caveTint = mix(vec3f(1.0), vec3f(0.88, 0.83, 0.74), (1.0 - ao) * 0.9);
    color *= ao * caveTint;

    // ------------------------------------------------------- aerial perspective
    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sunRadiance,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    // ------------------------------------------------------------------ debug
    if (uniforms.debugMode > 0.5) {
        if (uniforms.debugMode < 1.5) {
            // Depression and berm are metres and berms are the shallower of the
            // two, so both are scaled to fill the range rather than shown raw —
            // otherwise the channel that matters most reads as black.
            color = vec3f(deformDepth * 2.5, deformBerm * 5.0, compression * 0.6);
        } else if (uniforms.debugMode < 2.5) {
            color = N * 0.5 + 0.5;
        } else if (uniforms.debugMode < 3.5) {
            color = vec3f(viewDist / 400.0);
        } else if (uniforms.debugMode > 4.5 && uniforms.debugMode < 5.5) {
            // Pixel footprint, log-scaled: green ~1 cm, yellow ~10 cm, red ~1 m.
            // Every detail fade in this shader is keyed off this value, so being
            // able to see it directly turns "why is there no detail here" from a
            // guess into a reading.
            let lf = log2(footprint);
            color = vec3f(
                clamp((lf + 3.3) / 3.3, 0.0, 1.0),
                clamp(1.0 - abs(lf + 4.6) / 2.0, 0.0, 1.0),
                clamp(-(lf + 5.0) / 2.0, 0.0, 1.0)
            );
        } else if (uniforms.debugMode > 5.5 && uniforms.debugMode < 6.5) {
            // Fine + detail normal only, with the macro landform removed, so
            // the high-frequency content can be judged on its own.
            let fineN = normalFromGradient(fine.yz);
            color = fineN * 0.5 + 0.5;
        } else if (uniforms.debugMode > 6.5 && uniforms.debugMode < 7.5) {
            // The sun visibility term on its own — cast shadow only, with no
            // N.L, no albedo, no ambient and no fog. This is the one view that
            // separates "this surface faces away from the sun" from "something
            // is occluding it", which are the two completely different causes of
            // a dark frame and are otherwise indistinguishable by eye.
            //
            // Red where the surface is back-lit (NdotL < 0), because there the
            // shadow term is not what is making it dark and reading the grey
            // value would be misleading.
            color = select(vec3f(shadow), vec3f(0.35, 0.06, 0.06), NdotL <= 0.0);
        } else if (uniforms.debugMode > 7.5 && uniforms.debugMode < 8.5) {
            // Lambert term alone, same framing as the shadow view above: this is
            // the *other* half of why a pixel is dark.
            color = vec3f(max(NdotL, 0.0));
        } else if (uniforms.debugMode > 9.5) {
            // Albedo alone, before a single lighting term touches it. The one
            // view that separates "this surface is lit badly" from "this surface
            // is the wrong colour", which are otherwise indistinguishable — and
            // on carved snow specifically, where four independent channels
            // (compression, ice, displaced mass, rock) all write here, it is the
            // only way to see which of them is talking.
            color = albedo;
        } else if (uniforms.debugMode > 8.5) {
            // Depth-map agreement, in metres.
            //   blue    = point falls outside every cascade box
            //   grey    = map and receiver agree within 0.5 m
            //   red     = map claims an occluder in front, brighter with distance
            //   green   = map sits behind the receiver (should be impossible on
            //             a closed heightfield, so it means the projection is off)
            let dz = shadowMapDelta(world, geoN, viewDist);
            if (dz > 1e8) {
                color = vec3f(0.0, 0.15, 0.6);
            } else {
                let mag = clamp(abs(dz) / 12.0, 0.0, 1.0);
                let agree = 1.0 - smoothstep(0.0, 0.5, abs(dz));
                color = vec3f(agree * 0.45)
                      + select(vec3f(0.0, mag, 0.0), vec3f(mag, 0.0, 0.0), dz < 0.0);
            }
        } else {
            let c = vec3f(f32(viewDist < uniforms.cascadeSplits.x),
                          f32(viewDist < uniforms.cascadeSplits.y),
                          f32(viewDist < uniforms.cascadeSplits.z));
            color = color * 0.6 + c * 0.25;
        }
    }

    fragmentOutputs.color = vec4f(color, 1.0);
}
