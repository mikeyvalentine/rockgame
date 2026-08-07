/**
 * Registers every WGSL source into Babylon's shader store.
 *
 * Shared libraries go in as `#include<...>` fragments so the height bake and the
 * runtime sand material compile literally the same text — the terrain would pull
 * apart at the seams if they ever drifted. Whole shaders go in under the names
 * Babylon expects: `<name>VertexShader` and `<name>PixelShader`.
 *
 * Import this once, before any material is constructed.
 */

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";

import noiseLib from "./lib/noise.wgsl?raw";
import terrainLib from "./lib/terrain.wgsl?raw";
import shadingLib from "./lib/shading.wgsl?raw";
import shadowLookupLib from "./lib/shadowLookup.wgsl?raw";
import atmosphereLib from "./lib/atmosphere.wgsl?raw";
import clipmapLib from "./lib/clipmap.wgsl?raw";
import deformLib from "./lib/deform.wgsl?raw";
import spellLightsLib from "./lib/spellLights.wgsl?raw";
import postCommonLib from "./lib/postCommon.wgsl?raw";

import { siftPadWGSL } from "../../../shared/siftPad.js";
import { ambientGLSL, ambientWGSL } from "../../../shared/ambientWaterShader.js";

import heightBakeFrag from "./heightBake.fragment.wgsl?raw";
import auxBakeFrag from "./auxBake.fragment.wgsl?raw";
import detailBakeFrag from "./detailBake.fragment.wgsl?raw";
import deformSimFrag from "./deformSim.fragment.wgsl?raw";

import snowVert from "./snow.vertex.wgsl?raw";
import snowFrag from "./snow.fragment.wgsl?raw";
import depthVert from "./terrainDepth.vertex.wgsl?raw";
import depthFrag from "./terrainDepth.fragment.wgsl?raw";
import skyVert from "./sky.vertex.wgsl?raw";
import hdriSkyFrag from "./hdriSky.fragment.wgsl?raw";
import sprayVert from "./spray.vertex.wgsl?raw";
import sprayFrag from "./spray.fragment.wgsl?raw";

import prepassFrag from "./prepass.fragment.wgsl?raw";
import terrainPrepassVert from "./terrainPrepass.vertex.wgsl?raw";
import waterPrepassVert from "./waterPrepass.vertex.wgsl?raw";

import waterVert from "./water.vertex.wgsl?raw";
import waterFrag from "./water.fragment.wgsl?raw";

/**
 * The one include with no file behind it: the sifting pads are generated from
 * `shared/siftPad.js`, so the bake and the JS grounding twin cannot disagree
 * about where the beach is levelled. Generated once, at module load.
 */
const padLib = siftPadWGSL();

/**
 * The ambient wave field, generated from `shared/ambientWater.js`'s OCTAVES so
 * the water the world renders, the water the lab renders, and the water the
 * solver planes on cannot describe three different ponds. Same no-file include
 * scheme as `siftPad`.
 */
const ambientWaterLib = ambientWGSL();

const INCLUDES = {
    snowNoise: noiseLib,
    snowTerrain: terrainLib,
    snowShading: shadingLib,
    snowShadowLookup: shadowLookupLib,
    snowAtmosphere: atmosphereLib,
    snowClipmap: clipmapLib,
    snowDeform: deformLib,
    // Kept until phase 5: snow.fragment.wgsl still declares the (now always
    // empty) spell-light pool; stripping it means editing that 28 KB shader,
    // which happens once, in the sand restyle.
    snowSpellLights: spellLightsLib,
    snowPostCommon: postCommonLib,
    siftPad: padLib,
    ambientWater: ambientWaterLib,
};

const SHADERS = {
    heightBakePixelShader: heightBakeFrag,
    auxBakePixelShader: auxBakeFrag,
    detailBakePixelShader: detailBakeFrag,
    deformSimPixelShader: deformSimFrag,

    snowVertexShader: snowVert,
    snowPixelShader: snowFrag,

    terrainDepthVertexShader: depthVert,
    terrainDepthPixelShader: depthFrag,

    skyVertexShader: skyVert,
    hdriSkyPixelShader: hdriSkyFrag,

    sprayVertexShader: sprayVert,
    sprayPixelShader: sprayFrag,

    // The camera-space depth prepass. One fragment stage shared by everything
    // that has nothing to discard.
    prepassPixelShader: prepassFrag,
    terrainPrepassVertexShader: terrainPrepassVert,
    waterPrepassVertexShader: waterPrepassVert,

    waterVertexShader: waterVert,
    waterPixelShader: waterFrag,
};

let registered = false;

export function registerShaders() {
    if (registered) return;
    registered = true;

    for (const name in INCLUDES) {
        ShaderStore.IncludesShadersStoreWGSL[name] = INCLUDES[name];
    }
    for (const name in SHADERS) {
        ShaderStore.ShadersStoreWGSL[name] = SHADERS[name];
    }
}

// --------------------------------------------------------------------- WebGL2

/**
 * GLSL twins for the fallback renderer — only what the reduced pipeline
 * actually needs; the WGSL set above never runs on WebGL. Grows with the
 * phase-4/5 ports (heightBake, deformSim). Classic GLSL forms (`varying`,
 * `texture2D`, `gl_FragColor`) on purpose: Babylon's shader processor migrates
 * them for WebGL2.
 */

const GL_SKY_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float skyScale;
varying vec3 vDir;
void main() {
    vec3 world = position * skyScale + cameraPosition;
    vDir = position;
    vec4 clip = viewProjection * vec4(world, 1.0);
    // Force to the far plane, as the WGSL twin does.
    clip.z = clip.w * 0.999999;
    gl_Position = clip;
}
`;

const GL_HDRI_SKY_FRAGMENT = `
precision highp float;
varying vec3 vDir;
uniform sampler2D skyLUT;
uniform float envIntensity;
void main() {
    vec3 d = normalize(vDir);
    // dirToLatLong, byte-compatible with lib/atmosphere.wgsl.
    vec2 uv = vec2(atan(d.x, d.z) * 0.15915494309 + 0.5,
                   acos(clamp(d.y, -1.0, 1.0)) * 0.31830988618);
    gl_FragColor = vec4(texture2D(skyLUT, uv).rgb * envIntensity, 1.0);
}
`;

/**
 * GLSL port of deformSim.fragment.wgsl — same four jobs (scroll, relax, splat,
 * clamp), same channels, same brush encoding, reduced only in its noise (a
 * cheap value noise stands in for the WGSL gradient noise; it feeds rim wobble
 * and berm grain, where the difference is invisible). WebGL2-only: texelFetch.
 */
const GL_DEFORM_SIM_FRAGMENT = `
precision highp float;
varying vec2 vUV;

uniform sampler2D prevTex;
uniform sampler2D brushTex;

uniform vec2 center;
uniform vec2 prevCenter;
uniform float size;
uniform float res;
uniform float dt;
uniform float brushCount;
uniform float refillRate;
uniform float maxDepth;
uniform float maxBerm;
uniform float windAngle;

float hashn(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hashn(i);
    float b = hashn(i + vec2(1.0, 0.0));
    float c = hashn(i + vec2(0.0, 1.0));
    float d = hashn(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

vec2 texelWorld(vec2 uv, vec2 centre, float sz) {
    vec2 base = uv * sz;
    return base + sz * floor((centre - base) / sz + 0.5);
}

void main() {
    vec2 uv = vUV;
    vec2 world = texelWorld(uv, center, size);

    float dep = 0.0;
    float berm = 0.0;
    float comp = 0.0;
    float wetC = 0.0;

    bvec2 inside = lessThanEqual(abs(world - prevCenter), vec2(size * 0.5));
    if (all(inside)) {
        float t = 1.0 / res;
        vec4 c = texture2D(prevTex, uv);
        vec4 xl = texture2D(prevTex, uv - vec2(t, 0.0));
        vec4 xr = texture2D(prevTex, uv + vec2(t, 0.0));
        vec4 zd = texture2D(prevTex, uv - vec2(0.0, t));
        vec4 zu = texture2D(prevTex, uv + vec2(0.0, t));

        dep = c.r; berm = c.g; comp = c.b; wetC = c.a;

        float k = clamp(refillRate * dt, 0.0, 1.0);
        float wetK = 1.5 - 1.2 * clamp(wetC, 0.0, 1.0);
        float kDep = min(0.22, 0.004 * k * wetK);
        float kBerm = min(0.22, 0.012 * k * wetK);
        dep += ((xl.r + xr.r + zd.r + zu.r) - 4.0 * dep) * kDep;
        berm += ((xl.g + xr.g + zd.g + zu.g) - 4.0 * berm) * kBerm;

        vec2 wdir = vec2(sin(windAngle), cos(windAngle));
        vec4 uw = texture2D(prevTex, uv - wdir * (t * 1.6));
        float kAdv = min(0.2, 0.002 * k) * (1.0 - clamp(wetC, 0.0, 1.0) * 0.85);
        dep = mix(dep, uw.r, kAdv * 0.6);
        berm = mix(berm, uw.g, kAdv);

        float slump = min(berm, dep) * min(0.6, 0.006 * refillRate * dt);
        dep -= slump;
        berm -= slump;

        float r = refillRate;
        dep *= exp(-dt * r / 4000.0);
        berm *= exp(-dt * r / 2500.0);
        comp *= exp(-dt * r / 3000.0);
        wetC *= exp(-dt * r / 600.0);
    }

    int n = int(brushCount);
    for (int i = 0; i < 96; i++) {
        if (i >= n) { break; }
        vec4 a = texelFetch(brushTex, ivec2(i, 0), 0);
        vec4 b = texelFetch(brushTex, ivec2(i, 1), 0);
        vec4 cc = texelFetch(brushTex, ivec2(i, 2), 0);

        float radius = a.z;
        if (radius <= 0.0) { continue; }

        vec2 p = world - a.xy;
        p -= size * floor(p / size + 0.5);

        float reach = radius * max(a.w, 1.0) * 1.6;
        if (abs(p.x) > reach || abs(p.y) > reach) { continue; }

        vec2 q = vec2(
            (p.x * b.x + p.y * b.y) / (radius * a.w),
            (-p.x * b.y + p.y * b.x) / radius
        );
        float d = length(q);
        if (d > 1.55) { continue; }

        // atan(0, 0) is UNDEFINED in GLSL, and (0, 0) is exactly the texel at a
        // brush's centre — the one texel every brush is guaranteed to write.
        // A NaN there propagates wob -> dn -> core -> dep, and clamp() of a NaN
        // is implementation-defined, so the deepest point of every mark is the
        // least predictable one. The rim wobble is a cosmetic angular term; at
        // d = 0 there is no angle to speak of, so any fixed value is correct.
        float ang = (d > 1e-6) ? atan(q.y, q.x) : 0.0;
        // And keep the divisor away from zero: wob is 1 +/- 0.22 by construction,
        // but a bad edge or seed would make d / wob a second NaN source.
        float wob = max(1.0 + cc.z * 0.22 * vnoise2(vec2(cos(ang), sin(ang)) * 2.7 + cc.w), 0.05);
        float dn = d / wob;

        float core = 1.0 - smoothstep(0.42, 1.0, dn);
        float ringD = (dn - 1.04) * 3.4;
        float ring = exp(-ringD * ringD);
        float grain = 0.72 + 0.56 * (vnoise2(q * 7.5 + cc.w * 3.1) * 0.5 + 0.5);

        dep += b.z * core;
        berm += b.w * ring * grain;
        comp += cc.x * core;
        wetC = max(wetC, cc.y * core);
    }

    dep = clamp(dep, 0.0, maxDepth);
    berm = clamp(berm, 0.0, maxBerm);
    comp = clamp(comp, 0.0, 1.0);
    wetC = clamp(wetC, 0.0, 1.0);

    gl_FragColor = vec4(dep, berm, comp, wetC);
}
`;

/**
 * GLSL twin of water.vertex.wgsl. The ambient field is prepended from the same
 * `shared/ambientWater.js` OCTAVES as the WGSL include, so the fallback and the
 * primary renderer displace by identical waves.
 */
const GL_WATER_VERTEX = `precision highp float;
` + ambientGLSL() + `
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
uniform float time;
uniform vec2 windDir;
uniform float windStrength;
uniform float waveScale;
varying vec3 vWorld;
varying vec4 vClip;
void main(void) {
    vec4 flatW = world * vec4(position, 1.0);
    vec3 p = position;
    p.y += ambientField(flatW.xz, 0.0, 0.0, windDir, windStrength, waveScale, time).x;
    vec4 wp = world * vec4(p, 1.0);
    vClip = viewProjection * wp;
    vWorld = wp.xyz;
    gl_Position = vClip;
}
`;

/**
 * GLSL twin of water.fragment.wgsl — same composition (analytic normal, planar
 * mirror, recovered roughness, sun lobe, cubic Fresnel). No V-flip on the
 * projective sample: a WebGL render target is bottom-up already, which is the
 * one thing that differs from the WGSL twin.
 */
const GL_WATER_FRAGMENT = `precision highp float;
` + ambientGLSL() + `
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 tint;
uniform float time;
uniform vec2 windDir;
uniform float windStrength;
uniform float waveScale;
uniform float detailScale;
uniform float blurGain;
uniform float distortion;
uniform sampler2D reflectionTex;
varying vec3 vWorld;
varying vec4 vClip;
void main(void) {
    vec2 fw = fwidth(vWorld.xz);
    float fpTrue = max(fw.x, fw.y);
    float fp = fpTrue / max(detailScale, 0.01);

    vec3 amb = ambientField(vWorld.xz, 1.0, fp, windDir, windStrength, waveScale, time);
    vec2 slope = amb.yz * SLOPE_GAIN;
    vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

    vec3 incoming = normalize(vWorld - cameraPosition);
    vec3 R = reflect(incoming, N);

    vec2 uv = vClip.xy / vClip.w * 0.5 + 0.5;
    uv += N.xz * distortion;

    float lod = 0.0;
    if (blurGain > 0.0) {
        float lostVar = ambientLostVariance(fpTrue, windDir, windStrength, waveScale)
                        * SLOPE_GAIN * SLOPE_GAIN;
        lod = clamp(log2(1.0 + lostVar * blurGain), 0.0, 7.0);
    }
    vec3 refl = textureLod(reflectionTex, clamp(uv, 0.0, 1.0), lod).rgb;

    float sunDot = max(0.0, dot(sunDir, R));
    float keep = detailWeight(0.30, fpTrue);
    float sharp = pow(sunDot, 5000.0) * keep;
    float broad = pow(sunDot, 60.0) * (1.0 - keep) * 0.12;
    refl += vec3(sharp + broad) * vec3(10.0, 8.0, 6.0);

    float fresnel = mix(0.25, 1.0, pow(1.0 - dot(N, -incoming), 3.0));
    vec3 body = refl * tint;
    gl_FragColor = vec4(mix(body, refl, fresnel), 1.0);
}
`;

let registeredGL = false;

export function registerShadersGL() {
    if (registeredGL) return;
    registeredGL = true;

    ShaderStore.ShadersStore["skyVertexShader"] = GL_SKY_VERTEX;
    ShaderStore.ShadersStore["hdriSkyPixelShader"] = GL_HDRI_SKY_FRAGMENT;
    ShaderStore.ShadersStore["deformSimPixelShader"] = GL_DEFORM_SIM_FRAGMENT;
    ShaderStore.ShadersStore["waterVertexShader"] = GL_WATER_VERTEX;
    ShaderStore.ShadersStore["waterPixelShader"] = GL_WATER_FRAGMENT;
}
