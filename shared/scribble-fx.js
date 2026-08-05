// The scribble/pastel post-process, engine-injected so every lab can use it.
//
// This is the same pass as babylon-water's inline original and rock-forge's
// src/babylon/scribbleEnv.js port (read those for the full commentary on WHY
// each stage exists — the shader below carries only short markers). The one
// structural difference is dependency injection: instead of importing
// "@babylonjs/core" — which would pin this file to one copy of Babylon while
// the labs deliberately keep their own (8.x in rock-forge/rock-sift, 9.x in
// sand-sim, CDN global in babylon-water and the physics demo) — the caller
// hands in the four classes it already has:
//
//   import { PostProcess, DynamicTexture, Texture, Effect } from "@babylonjs/core";
//   const fx = createScribble(scene, camera, engine, opts,
//                             { PostProcess, DynamicTexture, Texture, Effect });
//   fx.enable(true);
//
// or, on a CDN page: createScribble(scene, camera, engine, opts, BABYLON).
//
// ORDER MATTERS: create this AFTER the tone-mapping pipeline is attached to
// the camera, so the pass lands after it — the ink colours below are LDR
// constants and mean nothing in linear HDR.

const FRAG_NAME = "rockgameScribble";

// Babylon's shader processor mishandles line comments containing semicolons —
// strip all comments before handing the source over. Never put backticks in a
// GLSL comment here.
const glsl = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const FRAGMENT = glsl(`
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D depthSampler;
uniform sampler2D flowSampler;
uniform sampler2D grainSampler;
uniform float bleed;
uniform float warpAmount;
uniform float paperScale;
uniform float grainAmount;
uniform float levels;
uniform float satAmount;
uniform float strokeAmount;
uniform float strokeFreq;
uniform float strokeAngle;
uniform float ignoreSky;
uniform float skyDepth;

float depthAt(vec2 uv) { return texture2D(depthSampler, uv).r; }

void main(void) {
    vec3 raw = texture2D(textureSampler, vUV).rgb;

    vec2 uv = vUV;
    if (warpAmount > 0.0) {
        vec2 wv = (texture2D(flowSampler, vUV * 3.0).rg - 0.5) * 2.0;
        uv += wv * warpAmount;
    }
    vec3 color = texture2D(textureSampler, uv).rgb;
    if (bleed > 0.0) {
        vec2 bv = (texture2D(flowSampler, vUV * 5.0 + 0.37).rg - 0.5) * 2.0;
        color = texture2D(textureSampler, uv + bv * bleed).rgb;
    }

    /* quantise VALUE, keep hue */
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    float q = floor(lum * levels + 0.5) / levels;
    color *= q / max(lum, 1e-4);

    /* chalky */
    float lum2 = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(lum2), color, satAmount);

    /* anisotropic pigment strokes */
    vec2 sd = vec2(cos(strokeAngle), sin(strokeAngle));
    vec2 sp = vec2(dot(vUV, sd), dot(vUV, vec2(-sd.y, sd.x)));
    float stroke = texture2D(flowSampler, vec2(sp.x * strokeFreq * 0.12,
                                               sp.y * strokeFreq)).r;
    color *= mix(1.0, 0.55 + 0.9 * stroke, strokeAmount);

    /* screen-locked paper tooth + warm wash */
    float paper = texture2D(grainSampler, vUV * paperScale).r;
    color *= mix(1.0, paper, grainAmount);
    color = mix(color, color * vec3(1.06, 1.0, 0.90), 0.5);

    /* hand the sky back as photography */
    float styled = 1.0;
    if (ignoreSky > 0.5) styled = 1.0 - step(skyDepth, depthAt(vUV));
    gl_FragColor = vec4(mix(raw, color, styled), 1.0);
}
`);

/** Seamless tileable value noise — lattice + modulo, so WRAP sampling at any
 *  repeat rate stays continuous (a scaled random canvas does not tile). */
export function makeSeamlessNoise(scene, cells, smooth, name, B) {
  const S = 256;
  const t = new B.DynamicTexture(name, { width: S, height: S }, scene, false);
  const ctx = t.getContext();
  const img = ctx.createImageData(S, S);
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
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
  t.wrapU = t.wrapV = B.Texture.WRAP_ADDRESSMODE;
  return t;
}

/**
 * @param B  { PostProcess, DynamicTexture, Texture, Effect } — the caller's own
 *           Babylon classes (or the BABYLON global itself).
 */
export function createScribble(scene, camera, engine, opts = {}, B) {
  if (!B || !B.PostProcess) throw new Error("createScribble: pass Babylon classes as the 5th argument");
  if (!B.Effect.ShadersStore[FRAG_NAME + "FragmentShader"]) {
    B.Effect.ShadersStore[FRAG_NAME + "FragmentShader"] = FRAGMENT;
  }

  const params = {
    bleed:        opts.bleed        != null ? opts.bleed        : 0.0,
    warp:         opts.warp         != null ? opts.warp         : 0.001,
    levels:       opts.levels       != null ? opts.levels       : 24.0,
    satAmount:    opts.satAmount    != null ? opts.satAmount    : 0.88,
    strokeAmount: opts.strokeAmount != null ? opts.strokeAmount : 0.26,
    strokeFreq:   opts.strokeFreq   != null ? opts.strokeFreq   : 104.0,
    strokeAngle:  opts.strokeAngle  != null ? opts.strokeAngle  : 0.6,
    paperScale:   opts.paperScale   != null ? opts.paperScale   : 19.25,
    grain:        opts.grain        != null ? opts.grain        : 0.42,
    ignoreSky:    opts.ignoreSky    != null ? opts.ignoreSky    : true,
    skyDepth:     opts.skyDepth     != null ? opts.skyDepth     : 0.999,
  };

  let pp = null, depth = null, flowTex = null, grainTex = null, on = false;

  function enable(v) {
    v = v !== false;
    if (v === on) return api;
    on = v;
    if (v) {
      if (!flowTex) {
        flowTex = makeSeamlessNoise(scene, 16, true, "scribbleFlow", B);
        grainTex = makeSeamlessNoise(scene, 256, false, "scribbleGrain", B);
      }
      if (!depth) depth = scene.enableDepthRenderer(camera, false);
      if (!pp) {
        pp = new B.PostProcess("rockgameScribble", FRAG_NAME,
          ["bleed", "warpAmount", "paperScale", "grainAmount", "levels",
           "satAmount", "strokeAmount", "strokeFreq", "strokeAngle",
           "ignoreSky", "skyDepth"],
          ["depthSampler", "flowSampler", "grainSampler"],
          1.0, camera);
        pp.onApply = (eff) => {
          eff.setTexture("depthSampler", depth.getDepthMap());
          eff.setTexture("flowSampler", flowTex);
          eff.setTexture("grainSampler", grainTex);
          eff.setFloat("bleed", params.bleed);
          eff.setFloat("warpAmount", params.warp);
          eff.setFloat("paperScale", params.paperScale);
          eff.setFloat("grainAmount", params.grain);
          eff.setFloat("levels", params.levels);
          eff.setFloat("satAmount", params.satAmount);
          eff.setFloat("strokeAmount", params.strokeAmount);
          eff.setFloat("strokeFreq", params.strokeFreq);
          eff.setFloat("strokeAngle", params.strokeAngle);
          // Fail to "style everything" rather than "style nothing" if the
          // depth renderer is missing — see scribbleEnv.js for the trap.
          eff.setFloat("ignoreSky", (params.ignoreSky && depth) ? 1 : 0);
          eff.setFloat("skyDepth", params.skyDepth);
        };
      }
    } else {
      if (pp) { pp.dispose(camera); pp = null; }
      if (depth && scene.disableDepthRenderer) {
        scene.disableDepthRenderer(camera);
        depth = null;
      }
    }
    return api;
  }

  const api = {
    params,
    enable,
    disable() { return enable(false); },
    get isOn() { return on; },
    set(k, v) { params[k] = v; return api; },
    dispose() {
      enable(false);
      if (flowTex) { flowTex.dispose(); flowTex = null; }
      if (grainTex) { grainTex.dispose(); grainTex = null; }
    },
  };
  return api;
}
