// Just enough world to judge the rocks in: a sky, an IBL, one sun, and sand.
// Deliberately thin — the point of the lab is the geometry, and anything that
// flatters it here would be lying to you.

import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine,
  HemisphericLight, MeshBuilder, PBRMaterial, Scene,
  ShadowDepthWrapper, ShadowGenerator, Vector3,
} from "@babylonjs/core";
import { createEnvironment } from "./scribbleEnv.js";

export function createEngine(canvas) {
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: false,
    stencil: false,
    antialias: true,
    powerPreference: "high-performance",
  });
  if (engine.webGLVersion < 2) {
    throw new Error(
      "rock-forge needs WebGL 2: the shape texture is a half-float sampled in the vertex shader, " +
      "which WebGL 1 does not guarantee."
    );
  }
  return engine;
}

export function createScene(engine) {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.62, 0.68, 0.74, 1);
  scene.ambientColor = new Color3(0.3, 0.32, 0.34);

  const camera = new ArcRotateCamera("cam", -Math.PI / 2.4, 1.15, 0.55, Vector3.Zero(), scene);
  camera.attachControl(engine.getRenderingCanvas(), true);
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 3000;
  camera.minZ = 0.01;
  camera.maxZ = 60;
  camera.lowerRadiusLimit = 0.04;
  camera.upperRadiusLimit = 30;

  // The 4k autumn field, the same sky the water sim uses, through the same
  // environment rig: HDRI cube + PBR skybox + ACES tone mapping, ported from
  // babylon-water/portable/scribble-env.js (see scribbleEnv.js for the port
  // notes). ACES is a correctness fix, not a style choice — without it the
  // sun region of a linear HDR sky clips to flat white — so it is on
  // unconditionally.
  //
  // [Look] below is the water sim's own live tuning, handed over directly:
  // exposure 1.00, warmth 28.00, warmth hue 30.00 — and `saturation: 6` next
  // to it, which is not in that tuning dump because the water sim's own panel
  // never exposed a slider for it either; its ColorCurves.globalSaturation is
  // hardcoded to 6 in its source, so this matches the value actually running
  // there rather than the value it happens to expose. (`tint r/g/b` from the
  // same dump is the water body's own colour and has no counterpart here —
  // there is no water surface in this scene.) An earlier version of this file
  // deliberately zeroed the grade, reasoning that a geometry lab should not
  // flatter itself — overridden now that the exact tuning was supplied
  // explicitly. Still adjustable from the panel either way.
  //
  // Resolution here is the *cube* the equirect is resampled into, not the
  // source — 256 is the useful ceiling for this scene: rocks are rough
  // dielectrics, so their IBL specular is a wide blurry lobe that gains
  // nothing from more, and the detail that actually shows is in the skybox
  // behind the field. skyboxBlur softens the 256-cube skybox enough to hide
  // its own resolution without blurring the reflections rocks pick up from it.
  const envSetup = createEnvironment(scene, camera, {
    hdr: "/assets/sky/autumn_field_puresky_4k.hdr",
    cubeSize: 256,
    skyboxSize: 100,
    skyboxBlur: 0.18,
    exposure: 1.0,
    warmth: 28,
    warmthHue: 30,
    saturation: 6,
  });
  scene.environmentIntensity = 1.0;

  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.25;
  hemi.groundColor = new Color3(0.32, 0.29, 0.24);

  const sun = new DirectionalLight("sun", new Vector3(-0.45, -0.82, 0.35), scene);
  sun.position = new Vector3(3, 6, -2.5);
  sun.intensity = 2.6;

  return { scene, camera, sun, envSetup };
}

export function createGround(scene, radius = 12) {
  const ground = MeshBuilder.CreateDisc("ground", { radius, tessellation: 96 }, scene);
  ground.rotation.x = Math.PI / 2;
  ground.receiveShadows = true;
  ground.isPickable = false;

  const mat = new PBRMaterial("sand", scene);
  mat.albedoColor = new Color3(0.50, 0.45, 0.37);
  mat.metallic = 0;
  mat.roughness = 0.92;
  mat.environmentIntensity = 0.8;
  // A disc is single-sided and which way it ends up facing after the rotation
  // depends on the handedness convention. Not culling it costs nothing here and
  // removes the chance of an invisible floor.
  mat.backFaceCulling = false;
  mat.twoSidedLighting = true;
  ground.material = mat;
  return ground;
}

/**
 * Shadows for GPU-displaced geometry.
 *
 * A shadow map is rendered with its own depth shader, which knows nothing about
 * the material plugin — so without this every rock would cast the shadow of an
 * undisplaced unit sphere. ShadowDepthWrapper exists for exactly this case: it
 * reuses the base material's vertex shader to compute the depth, so the shadow
 * comes from the displaced position.
 *
 * Wrapped in a try/catch and reported back, because a shadow map that fails to
 * compile should cost you shadows, not the whole scene.
 */
export function createShadows(scene, sun, materials, { size = 2048 } = {}) {
  const gen = new ShadowGenerator(size, sun);
  gen.useExponentialShadowMap = false;
  gen.usePercentageCloserFiltering = true;
  gen.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  gen.bias = 0.0015;
  gen.normalBias = 0.006;
  // Include alpha-blended meshes in the shadow map. Sea glass runs in the
  // blend pass for its rim translucency, and with this false the generator
  // skips blended meshes entirely — so every piece of sea glass floated on a
  // shadowless patch of sand while the opaque stone beside it grounded
  // normally. A frosted chip is effectively solid (rim opacity ~0.75, body
  // 1.0), so a full shadow is the right answer, not a fainter one.
  gen.transparencyShadow = true;

  const failures = [];
  for (const [name, mat] of Object.entries(materials)) {
    try {
      mat.shadowDepthWrapper = new ShadowDepthWrapper(mat, scene);
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  }
  return { generator: gen, failures };
}
