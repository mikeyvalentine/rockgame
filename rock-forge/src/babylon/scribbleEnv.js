// Ported from ../../../babylon-water/portable/scribble-env.js.
//
// The source file is a UMD-style script that expects a global `BABYLON` (a
// `<script src="babylon.js">` tag) and attaches itself as `window.ScribbleFX`.
// rock-forge builds with Vite against the `@babylonjs/core` npm package, so
// this is the same code translated to that import style — the logic, the
// shader, and the comments explaining *why* are carried over unchanged; only
// the module boundary is different. One capability was added on the way over
// (see `skyboxBlur` below), called out where it happens.
//
// Two pieces that have to ship together, because the second depends on the
// first: the scribble pass paints with ordinary low-range colours (near-black
// ink, a paper wash), and applying those to the linear HDR values an HDRI-lit
// scene produces would be meaningless. `createEnvironment` installs the
// tone-mapping pipeline that puts the image in the space those numbers assume,
// and the scribble pass attaches AFTER it.
//
// ORDER MATTERS. Call createEnvironment first. Babylon runs a camera's
// post-processes in attachment order, so creating the scribble pass afterwards
// is what places it after tone mapping. Reverse them and the ink turns to mud.
//
// COST
//   The scribble pass adds a full depth pre-pass over the scene plus one
//   fullscreen pass. Both are created lazily on first enable() and torn down
//   on disable(), so nothing is paid while it is off.
//
// NO OUTLINES, deliberately — the depth-edge darkening this pass once carried
// was removed rather than fixed. Babylon's depth renderer draws meshes with
// its own depth shader, so anything whose vertex shader displaces geometry —
// which in this project means every rock — leaves its UNDISPLACED unit-sphere
// silhouette in the depth map, up to a few times the visible stone. The edge
// detector traced that phantom shape as a dark halo floating outside every
// rock, and the proper fix (a matching custom depth material per rock
// material) buys back a feature the game does not want anyway. The depth
// pre-pass itself stays: the ignoreSky mask still reads it to hand the HDRI
// background back unstyled.

import {
  ColorCurves, DefaultRenderingPipeline, DynamicTexture, Effect,
  HDRCubeTexture, ImageProcessingConfiguration, PostProcess, Texture,
} from "@babylonjs/core";

// Babylon's shader processor rewrites the source it is handed and mishandles a
// line comment containing a semicolon: the comment marker is dropped and the
// tail of the sentence survives into the compiled GLSL as a syntax error. This
// is the same ShaderCodeCursor behaviour rockMaterial.js works around for its
// injected PBR snippets — here it applies to a full shader registered in
// Effect.ShadersStore, which goes through the same conversion pass. Stripping
// comments on the way to the compiler sidesteps it, and the comments stay here
// where they are useful.
//
// Also note: never put backticks inside a GLSL comment in this file. They
// close the template literal and break the whole script.
const glsl = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// -----------------------------------------------------------------------
// Environment: HDRI skybox + tone mapping + warmth grade
// -----------------------------------------------------------------------
export function createEnvironment(scene, camera, opts = {}) {
  const url = opts.hdr;
  if (!url) throw new Error("createEnvironment: opts.hdr is required");

  // An .hdr is LINEAR and high dynamic range: sky sits around 1-3 while the
  // sun region runs far above. Sampling it straight into an 8-bit target
  // clips every bright reflection to flat white, which is why the pipeline
  // below renders in HDR and tone-maps once at the end.
  const envTex = new HDRCubeTexture(url, scene, opts.cubeSize || 512);
  scene.environmentTexture = envTex;

  // PBR skybox rather than a hand-rolled StandardMaterial one: it consumes the
  // linear HDR cube correctly and leaves tone mapping to the post-process,
  // which is what keeps the sky and anything reflecting that same sky on ONE
  // curve. Two curves show up as a seam along the horizon.
  //
  // `skyboxBlur` is not in the original file — it hardcoded 0. rock-forge's
  // own environment setup already found it needed a touch of blur to hide a
  // 256-cube-resolution HDRI from showing through the skybox, so the option is
  // added here rather than losing that capability in the port.
  const skybox = scene.createDefaultSkybox(envTex, true, opts.skyboxSize || 1000, opts.skyboxBlur || 0);
  skybox.infiniteDistance = true;

  const pipeline = new DefaultRenderingPipeline(
    opts.pipelineName || "envGrade", true, scene, [camera]);
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = opts.exposure != null ? opts.exposure : 1.0;

  // Warmth as a global grade rather than a tint on any one material, so the
  // sky and everything lit by it shift together.
  const curves = new ColorCurves();
  curves.globalHue = opts.warmthHue != null ? opts.warmthHue : 30;
  curves.globalDensity = opts.warmth != null ? opts.warmth : 28;
  curves.globalSaturation = opts.saturation != null ? opts.saturation : 6;
  pipeline.imageProcessing.colorCurvesEnabled = true;
  pipeline.imageProcessing.colorCurves = curves;

  return {
    envTex, skybox, pipeline, curves,
    setExposure(v) { pipeline.imageProcessing.exposure = v; },
    setWarmth(density, hue) {
      curves.globalDensity = density;
      if (hue != null) curves.globalHue = hue;
    },
    dispose() {
      pipeline.dispose();
      skybox.dispose();
      envTex.dispose();
    },
  };
}

// -----------------------------------------------------------------------
// Seamless value noise
//
// The obvious approach — draw a small random canvas and let the browser scale
// it up — produces a texture whose left edge does not match its right.
// Sampled with WRAP at a few repeats, as the warp and bleed below do, every
// repeat boundary becomes a hard jump in the DISPLACEMENT, which slices the
// frame into offset rectangles; two repeat rates overlaid give a visible grid
// of them. Building it from a lattice indexed with modulo makes it genuinely
// tileable, so any repeat rate stays continuous.
// -----------------------------------------------------------------------
export function makeSeamlessNoise(scene, cells, smooth, name) {
  const S = 256;
  const t = new DynamicTexture(name, { width: S, height: S }, scene, false);
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
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}

// -----------------------------------------------------------------------
// Scribble / crayon post-process
// -----------------------------------------------------------------------
const FRAG_NAME = "scribbleFx";

Effect.ShadersStore[FRAG_NAME + "FragmentShader"] = glsl(`
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D depthSampler;
uniform sampler2D flowSampler;
uniform sampler2D grainSampler;
uniform vec2 texelSize;
uniform float bleed;
uniform float warpAmount;
uniform float paperScale;
uniform float grainAmount;
uniform float levels;        // value steps, the core pastel control
uniform float satAmount;     // 1 keeps scene saturation, lower is chalkier
uniform float strokeAmount;  // pigment stroke visibility
uniform float strokeFreq;    // stroke density across their direction
uniform float strokeAngle;   // stroke direction, radians
uniform float ignoreSky;     // 1 leaves the background untouched
uniform float skyDepth;      // depth at or beyond which a pixel is background

float depthAt(vec2 uv) { return texture2D(depthSampler, uv).r; }

void main(void) {
    // Kept untouched so the background can be handed back unstyled at the end.
    vec3 raw = texture2D(textureSampler, vUV).rgb;

    // Displacement defaults to OFF. Warping the image by a screen-space noise
    // is the shower-door artefact: the distortion is pinned to the screen while
    // the scene slides underneath, so surfaces appear to swim through a fixed
    // pane of rippled glass whenever the camera moves. Pastel does not need it,
    // so both terms survive only as optional extras.
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

    // --- the pastel move: quantise VALUE, keep hue -------------------------
    // Pigment laid by hand does not hold a smooth gradient. It goes down in
    // discrete layers, so tone steps while colour stays continuous. Quantising
    // luminance and rescaling the colour to match does that; quantising the
    // channels separately would swing the hue at every step.
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    float q = floor(lum * levels + 0.5) / levels;
    color *= q / max(lum, 1e-4);

    // Chalky rather than saturated: opaque pigment scatters and sits duller
    // than the light it depicts.
    float lum2 = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(lum2), color, satAmount);

    // --- pigment strokes ---------------------------------------------------
    // Sampled ANISOTROPICALLY: low frequency along the stroke direction, high
    // across it, which turns isotropic noise into streaks that read as a loaded
    // stick dragged over the surface.
    vec2 sd = vec2(cos(strokeAngle), sin(strokeAngle));
    vec2 sp = vec2(dot(vUV, sd), dot(vUV, vec2(-sd.y, sd.x)));
    float stroke = texture2D(flowSampler, vec2(sp.x * strokeFreq * 0.12,
                                               sp.y * strokeFreq)).r;
    color *= mix(1.0, 0.55 + 0.9 * stroke, strokeAmount);

    // Paper tooth stays SCREEN-locked, and that is correct: the paper is a
    // fixed sheet the scene is drawn onto, so it should not travel with the
    // geometry. Only displacement had to stop doing that.
    float paper = texture2D(grainSampler, vUV * paperScale).r;
    color *= mix(1.0, paper, grainAmount);
    color = mix(color, color * vec3(1.06, 1.0, 0.90), 0.5);

    // Hand the background back untouched. Babylon's depth renderer leaves sky
    // at exactly the far value while all real geometry sits well below it
    // (measured: sky 1.0, scene 0.001-0.30), so the depth buffer separates them
    // with no extra pass or stencil. Worth doing because a photographic sky put
    // through value quantisation and paper tooth stops reading as sky.
    float styled = 1.0;
    if (ignoreSky > 0.5) styled = 1.0 - step(skyDepth, depthAt(vUV));
    gl_FragColor = vec4(mix(raw, color, styled), 1.0);
}
`);

export function createScribble(scene, camera, engine, opts = {}) {
  const params = {
    // Colour bleed stays 0 — that was the camera-locked swimming. The paper
    // warp is a token amount, enough to break up straight edges without the
    // frame appearing to drift.
    bleed:        opts.bleed        != null ? opts.bleed        : 0.0,
    warp:         opts.warp         != null ? opts.warp         : 0.0,
    // Pastel. Defaults re-tuned 2026-08-04 to the user's universal look —
    // keep in step with shared/scribble-dials.js.
    levels:       opts.levels       != null ? opts.levels       : 30.0,
    satAmount:    opts.satAmount    != null ? opts.satAmount    : 1.02,
    strokeAmount: opts.strokeAmount != null ? opts.strokeAmount : 0.02,
    strokeFreq:   opts.strokeFreq   != null ? opts.strokeFreq   : 10.0,
    strokeAngle:  opts.strokeAngle  != null ? opts.strokeAngle  : 0.5,
    paperScale:   opts.paperScale   != null ? opts.paperScale   : 37.25,
    grain:        opts.grain        != null ? opts.grain        : 0.14,
    // Leave an HDRI/skybox background as photography. Quantising and texturing
    // a real sky reads as an error rather than as a medium.
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
        // 16 cells smooth for low-frequency flow, 256 hard for grain.
        flowTex = makeSeamlessNoise(scene, 16, true, "scribbleFxFlow");
        grainTex = makeSeamlessNoise(scene, 256, false, "scribbleFxGrain");
      }
      if (!depth) depth = scene.enableDepthRenderer(camera, false);
      if (!pp) {
        pp = new PostProcess("scribbleFx", FRAG_NAME,
          ["texelSize", "bleed", "warpAmount",
           "paperScale", "grainAmount", "levels", "satAmount",
           "strokeAmount", "strokeFreq", "strokeAngle",
           "ignoreSky", "skyDepth"],
          ["depthSampler", "flowSampler", "grainSampler"],
          1.0, camera);
        pp.onApply = (eff) => {
          eff.setTexture("depthSampler", depth.getDepthMap());
          eff.setTexture("flowSampler", flowTex);
          eff.setTexture("grainSampler", grainTex);
          eff.setFloat2("texelSize",
            1 / engine.getRenderWidth(), 1 / engine.getRenderHeight());
          eff.setFloat("bleed", params.bleed);
          eff.setFloat("warpAmount", params.warp);
          eff.setFloat("paperScale", params.paperScale);
          eff.setFloat("grainAmount", params.grain);
          eff.setFloat("levels", params.levels);
          eff.setFloat("satAmount", params.satAmount);
          eff.setFloat("strokeAmount", params.strokeAmount);
          eff.setFloat("strokeFreq", params.strokeFreq);
          eff.setFloat("strokeAngle", params.strokeAngle);
          // Gated on the depth renderer actually existing. Sky masking reads
          // the depth buffer, and if that is missing every pixel reports the
          // far value — which masks out the WHOLE frame and makes the pass
          // look silently dead rather than erroring. Fail to "style
          // everything" instead of to "style nothing".
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
