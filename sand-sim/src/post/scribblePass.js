/**
 * Scribble/pastel pass — the WGSL twin of the labs' shared GLSL post-process
 * (rockgame/shared/scribble-fx.js; original in babylon-water's index.html).
 *
 * Slots AFTER the PostChain: appended to the camera once the chain exists, so
 * Babylon re-targets sharpen into this pass's input and this pass writes the
 * swapchain. That is the right place for it — the pastel quantisation works on
 * display-encoded values, and the chain's composite/sharpen stages are exactly
 * the display transform. It follows the chain's own toggling rule too: always
 * attached, a uniform early-out when disabled, because detaching a pass
 * reshuffles which texture every other pass renders into mid-frame.
 *
 * Depth comes from the scene's own DepthPass (linear view metres, sky cleared
 * to 9000 — see depthPass.js), not Babylon's DepthRenderer, which cannot see
 * this scene's GPU-displaced geometry. The sky mask is therefore a fixed
 * far-threshold test rather than the GLSL version's normalized skyDepth dial.
 */

import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";

const SHADER = /* wgsl */ `
// See rockgame/shared/scribble-fx.js for the annotated GLSL original.
varying vUV: vec2f;

var textureSampler: texture_2d<f32>;
var textureSamplerSampler: sampler;
var depthTex: texture_2d<f32>;
var depthTexSampler: sampler;
var flowTex: texture_2d<f32>;
var flowTexSampler: sampler;
var grainTex: texture_2d<f32>;
var grainTexSampler: sampler;

uniform enabled: f32;
uniform bleed: f32;
uniform warpAmount: f32;
uniform paperScale: f32;
uniform grainAmount: f32;
uniform levels: f32;
uniform satAmount: f32;
uniform strokeAmount: f32;
uniform strokeFreq: f32;
uniform strokeAngle: f32;
uniform ignoreSky: f32;

const LUMA: vec3f = vec3f(0.299, 0.587, 0.114);
// Must agree with POST_FAR in postCommon.wgsl / DEPTH_FAR in depthPass.js:
// the prepass clears to 9000, so "past half of that" is background.
const SKY_FAR: f32 = 4500.0;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let uv0 = input.vUV;
    let raw = textureSampleLevel(textureSampler, textureSamplerSampler, uv0, 0.0);
    var color = raw.rgb;

    if (uniforms.enabled > 0.5) {
        var uv = uv0;
        if (uniforms.warpAmount > 0.0) {
            let wv = (textureSampleLevel(flowTex, flowTexSampler, uv0 * 3.0, 0.0).rg - vec2f(0.5)) * 2.0;
            uv += wv * uniforms.warpAmount;
        }
        color = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0).rgb;
        if (uniforms.bleed > 0.0) {
            let bv = (textureSampleLevel(flowTex, flowTexSampler, uv0 * 5.0 + vec2f(0.37), 0.0).rg - vec2f(0.5)) * 2.0;
            color = textureSampleLevel(textureSampler, textureSamplerSampler, uv + bv * uniforms.bleed, 0.0).rgb;
        }

        // Quantise VALUE, keep hue.
        let lum = dot(color, LUMA);
        let q = floor(lum * uniforms.levels + 0.5) / uniforms.levels;
        color *= q / max(lum, 1e-4);

        // Chalky.
        let lum2 = dot(color, LUMA);
        color = mix(vec3f(lum2), color, uniforms.satAmount);

        // Anisotropic pigment strokes.
        let sd = vec2f(cos(uniforms.strokeAngle), sin(uniforms.strokeAngle));
        let sp = vec2f(dot(uv0, sd), dot(uv0, vec2f(-sd.y, sd.x)));
        let stroke = textureSampleLevel(flowTex, flowTexSampler,
            vec2f(sp.x * uniforms.strokeFreq * 0.12, sp.y * uniforms.strokeFreq), 0.0).r;
        color *= mix(1.0, 0.55 + 0.9 * stroke, uniforms.strokeAmount);

        // Screen-locked paper tooth + warm wash.
        let paper = textureSampleLevel(grainTex, grainTexSampler, uv0 * uniforms.paperScale, 0.0).r;
        color *= mix(1.0, paper, uniforms.grainAmount);
        color = mix(color, color * vec3f(1.06, 1.0, 0.90), 0.5);

        // Hand the sky back as photography.
        var styled = 1.0;
        if (uniforms.ignoreSky > 0.5) {
            let z = textureSampleLevel(depthTex, depthTexSampler, uv0, 0.0).r;
            styled = 1.0 - step(SKY_FAR, z);
        }
        color = mix(raw.rgb, color, styled);
    }

    fragmentOutputs.color = vec4f(color, raw.a);
}
`;

/** Seamless tileable value noise — same lattice construction as the GLSL side. */
function makeNoise(scene, cells, smooth, name) {
    const S = 256;
    const t = new DynamicTexture(name, { width: S, height: S }, scene, false);
    const ctx = t.getContext();
    const img = ctx.createImageData(S, S);
    const lat = new Float32Array(cells * cells);
    // AUDIT #A6: seeded (was Math.random) so the paper grain is identical
    // every session and across every lab page - share cards stay pixel-
    // reproducible. Seed folds in `cells` so flow and grain differ.
    let _s = (0x9e3779b9 ^ (cells * 2654435761)) >>> 0;
    const _rand = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < lat.length; i++) lat[i] = _rand();
    const wrap = (v) => ((v % cells) + cells) % cells;
    const at = (x, y) => lat[wrap(y) * cells + wrap(x)];
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const fx = (x / S) * cells, fy = (y / S) * cells;
            const x0 = Math.floor(fx), y0 = Math.floor(fy);
            let v;
            if (smooth) {
                let tx = fx - x0, ty = fy - y0;
                tx = tx * tx * (3 - 2 * tx);
                ty = ty * ty * (3 - 2 * ty);
                const a = at(x0, y0), b = at(x0 + 1, y0);
                const c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
                v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
            } else {
                v = at(x0, y0);
            }
            const o = (y * S + x) * 4;
            const b8 = Math.max(0, Math.min(255, v * 255)) | 0;
            img.data[o] = img.data[o + 1] = img.data[o + 2] = b8;
            img.data[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    t.update(false);
    t.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    t.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    return t;
}

let registered = false;

/**
 * @param scene
 * @param camera   attach target — call AFTER the PostChain is constructed
 * @param depthRtt the DepthPass render target (linear view metres in r)
 */
export function createScribblePass(scene, camera, depthRtt) {
    if (!registered) {
        registered = true;
        ShaderStore.ShadersStoreWGSL["sandScribblePixelShader"] = SHADER;
    }

    // Defaults are the user's dialled-in universal look (2026-08-04) — keep in
    // step with SCRIBBLE_PARAMS in rockgame/shared/scribble-dials.js.
    const params = {
        enabled: false,
        bleed: 0.0, warp: 0.0,
        levels: 30, satAmount: 1.02,
        strokeAmount: 0.02, strokeFreq: 10, strokeAngle: 0.5,
        paperScale: 37.25, grain: 0.14,
        ignoreSky: true,
    };

    const flow = makeNoise(scene, 16, true, "scribbleFlow");
    const grain = makeNoise(scene, 256, false, "scribbleGrain");

    const pp = new PostProcess("sandScribble", "sandScribble", {
        uniforms: ["enabled", "bleed", "warpAmount", "paperScale", "grainAmount",
            "levels", "satAmount", "strokeAmount", "strokeFreq", "strokeAngle",
            "ignoreSky"],
        samplers: ["depthTex", "flowTex", "grainTex"],
        size: 1.0,
        camera,
        samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        engine: scene.getEngine(),
        reusable: false,
        textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
        shaderLanguage: ShaderLanguage.WGSL,
    });

    pp.onApply = (e) => {
        e.setFloat("enabled", params.enabled ? 1 : 0);
        e.setFloat("bleed", params.bleed);
        e.setFloat("warpAmount", params.warp);
        e.setFloat("paperScale", params.paperScale);
        e.setFloat("grainAmount", params.grain);
        e.setFloat("levels", params.levels);
        e.setFloat("satAmount", params.satAmount);
        e.setFloat("strokeAmount", params.strokeAmount);
        e.setFloat("strokeFreq", params.strokeFreq);
        e.setFloat("strokeAngle", params.strokeAngle);
        e.setFloat("ignoreSky", params.ignoreSky ? 1 : 0);
        e.setTexture("depthTex", depthRtt);
        e.setTexture("flowTex", flow);
        e.setTexture("grainTex", grain);
    };

    return {
        params,
        pp,
        set(k, v) { params[k] = v; },
    };
}
