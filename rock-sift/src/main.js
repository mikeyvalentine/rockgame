// Rocky shore — sift through the stones, pick one up, judge whether it'll skip.
//
// This file is the composition root and nothing else: start the engine, build
// the world, run it. The world itself — physics, shore, bed, hand, examine,
// interaction — is `world.js`, because sand-sim hosts the same thing when the
// player crouches at a pile on its beach. One sift mode, two hosts.
//
// What stays here is what belongs to a page rather than to a world: the canvas,
// the render loop, resize, the scribble dial panel, and the devtools handle.

import {
  ColorCurves, DynamicTexture, Effect, Engine, PostProcess, Texture,
} from "@babylonjs/core";

import { createSiftWorld } from "./world.js";
import { createHud } from "./ui.js";
import { RENDER_SCALE_CAP } from "./config.js";
import { createScribble } from "../../shared/scribble-fx.js";
import { attachScribblePanel, loadScribbleSettings } from "../../shared/scribble-dials.js";

const hud = createHud();

async function boot() {
  const canvas = document.getElementById("view");
  // AUDIT #1: antialias off — docs/11, the aliasing is the look, and MSAA is one of
  // the biggest costs simply removed. That stays.
  //
  // What did NOT stay is rendering at 1x CSS on every display. `adaptToDeviceRatio`
  // was dropped because it rendered at full devicePixelRatio — 4x the pixels on
  // Retina across four geometry passes — but the cure was worse than the disease: a
  // half-resolution buffer upscaled by the browser turns stones a few pixels across
  // into mush. Kept aliasing means crisp geometric edges, and crisp edges need real
  // pixels. RENDER_SCALE_CAP takes the device ratio up to a limit instead of taking
  // all of it or none.
  const engine = new Engine(canvas, false, { stencil: false });
  const renderScale = Math.min(window.devicePixelRatio || 1, RENDER_SCALE_CAP);
  engine.setHardwareScalingLevel(1 / renderScale);

  const world = await createSiftWorld(engine, { hud });
  const { scene, camera } = world;

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  // --- scribble dials (shared across the labs) ------------------------------
  // Created last so the pass attaches after applyLook's pipeline — the pastel
  // constants are LDR and belong after tone mapping. The dial panel persists
  // through a localhost cookie, so a value dialled in here carries to every
  // other lab page; only user-touched keys override this scene's own tuning
  // (LOOK.exposure stays 1.05 until the exposure dial is moved anywhere).
  const scribble = createScribble(scene, camera, engine, {},
    { PostProcess, DynamicTexture, Texture, Effect });
  const ip = scene.imageProcessingConfiguration;
  let gradeCurves = null;
  const ensureCurves = () => {
    if (gradeCurves) return gradeCurves;
    gradeCurves = new ColorCurves();
    ip.colorCurves = gradeCurves;
    ip.colorCurvesEnabled = true;
    return gradeCurves;
  };
  attachScribblePanel({
    get: (k) => {
      if (k === "on") return scribble.isOn ? 1 : 0;
      if (k === "exposure") return ip.exposure;
      if (k === "warmth") return gradeCurves?.globalDensity ?? 0;
      if (k === "warmthHue") return gradeCurves?.globalHue ?? 30;
      if (k === "envSaturation") return gradeCurves?.globalSaturation ?? 0;
      return scribble.params[k];
    },
    apply: (k, v) => {
      if (k === "on") scribble.enable(v > 0.5);
      else if (k === "exposure") ip.exposure = v;
      else if (k === "warmth") ensureCurves().globalDensity = v;
      else if (k === "warmthHue") ensureCurves().globalHue = v;
      else if (k === "envSaturation") ensureCurves().globalSaturation = v;
      else if (k === "ignoreSky") scribble.set("ignoreSky", v > 0.5);
      else scribble.set(k, v);
    },
  });
  // The game's look defaults ON unless the store says otherwise.
  if (!("on" in loadScribbleSettings())) scribble.enable(true);

  // Handy from the devtools console: window.game.scene, .rocks, .archetypes
  window.game = { engine, scribble, ...world };
}

boot().catch((err) => {
  console.error(err);
  hud.setStatus("Failed to start — see the console.");
});
