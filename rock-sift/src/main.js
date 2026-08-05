// Rocky shore — sift through the stones, pick one up, judge whether it'll skip.
//
// This file is the composition root and nothing else: start the engine, build
// the pieces, wire them together, run. The pieces are
//
//   environment.js  sky, light, ground, and the collider under it
//   assetRocks.js   stones, loaded from GLB into archetypes
//   field.js        laying the bed out and settling it
//   hand.js         the kinematic sweep
//   examine.js      lifting a stone to the camera and putting it back
//   interaction.js  pointer and keyboard
//   look.js         tone mapping and ambient occlusion
//   ui.js           the HUD

import "@babylonjs/loaders/glTF";
import {
  ArcRotateCamera, Color3, ColorCurves, DynamicTexture, Effect, Engine,
  HavokPlugin, PostProcess, Scene, StandardMaterial, Texture, Vector3,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";

import { buildEnvironment, shoreHeight } from "./environment.js";
import { createExamineStage } from "./examine.js";
import { createSiftHand } from "./hand.js";
import { createInteraction } from "./interaction.js";
import { applyLook } from "./look.js";
import { loadRockArchetypes } from "./assetRocks.js";
import { createHud } from "./ui.js";
import { fetchBakedBed } from "./bed.js";
import { SPOTS, createShore } from "./shore.js";
import { loadBucket } from "./bucket.js";
import {
  boundingRadius, parkArchetypeSources, pourAndSettle, scatterGravel,
} from "./field.js";
import {
  BED_RADIUS, GRAVITY, MAX_FRAME_MS, MAX_SPEED, MAX_SPIN, PHYSICS_SUBSTEP_MS, ROCK_COUNT, U,
} from "./config.js";
import { createScribble } from "../../shared/scribble-fx.js";
import { attachScribblePanel, loadScribbleSettings } from "../../shared/scribble-dials.js";

const hud = createHud();

const SHORE_HINT = "<strong>Click</strong> a ring to crouch down and sift there";
const SIFT_HINT = "<strong>Drag</strong> to part the stones · <strong>Drag from a stone</strong> to carry it · " +
  "<strong>Click</strong> one to examine it · <strong>Esc</strong> to stand up";

async function boot() {
  const canvas = document.getElementById("view");
  const engine = new Engine(canvas, true, { adaptToDeviceRatio: true, stencil: false });
  const scene = new Scene(engine);
  scene.ambientColor = new Color3(0.2, 0.22, 0.24);

  // --- physics --------------------------------------------------------------
  hud.setStatus("starting physics");
  const wasmBinary = await fetch(havokWasmUrl).then((r) => r.arrayBuffer());
  const plugin = new HavokPlugin(true, await HavokPhysics({ wasmBinary }));
  scene.enablePhysics(new Vector3(0, GRAVITY, 0), plugin);

  // Fixed-rate stepping. Without it Havok takes one step per rendered frame at
  // whatever the frame delta happened to be, so how well the bed behaves depends
  // on how fast the machine draws it — a 33 ms step lets a stone move further
  // than its own thickness, hulls end up overlapped, and the penetration
  // recovery has to shove them apart. tools/sift-test.mjs measures this: at
  // 30 fps with a full bed, unstepped, stones in the pile reach 99 rad/s of spin.
  // Capping the frame delta bounds the substeps per frame, so a hitch cannot
  // cascade into a spiral of ever-longer physics frames.
  Scene.MaxDeltaTime = MAX_FRAME_MS;
  scene.getPhysicsEngine().setSubTimeStep(PHYSICS_SUBSTEP_MS);
  // Clamp inside the solver rather than after the fact: a per-frame rescale in
  // the render loop only runs once the damage is done, and cannot see the
  // intermediate substeps at all.
  plugin.setVelocityLimits(MAX_SPEED, MAX_SPIN);

  // --- scene ----------------------------------------------------------------
  hud.setStatus("building the shore");
  const env = buildEnvironment(scene, { U, bedRadius: BED_RADIUS });
  const camera = buildCamera(scene);
  const look = applyLook(scene, camera, { U });

  // Every stone in the scene comes out of the scanned GLB. There is no
  // procedural fallback on purpose: the noise-displaced icospheres that used to
  // fill the bed did not read as real rock next to the scans, and mixing the two
  // made the scanned ones look worse rather than the generated ones look better.
  hud.setStatus("loading stones");
  const archetypes = await loadRockArchetypes(scene, "/assets/river_rocks.glb", { unitScale: U, seed: 99 });
  if (!archetypes.length) throw new Error("river_rocks.glb contained no usable meshes");
  for (const a of archetypes) {
    a.radius = boundingRadius(a.vertexData.positions);
    env.shadows.addShadowCaster(a.mesh, true);
  }
  parkArchetypeSources(archetypes);

  hud.setStatus("strewing the shore");
  for (const spot of SPOTS) {
    scatterGravel(scene, archetypes, {
      count: 700,
      innerRadius: BED_RADIUS * 1.45,
      outerRadius: 1.15,
      origin: { x: spot.x * U, z: spot.z * U },
      heightAt: (x, z) => shoreHeight(x, z, U, BED_RADIUS),
      seed: 4242 + SPOTS.indexOf(spot) * 101,
    });
  }

  hud.setStatus("laying the shore");
  const beds = await loadBeds(scene, archetypes, SPOTS.length);

  let bucket = null;
  try {
    bucket = await loadBucket(scene, "/assets/bucket_lowpoly.glb", { unitScale: U });
    if (bucket) for (const m of bucket.parts) env.shadows.addShadowCaster(m, true);
  } catch (err) {
    console.warn("Bucket unavailable:", err);
  }

  // --- interaction ----------------------------------------------------------
  const hand = createSiftHand(scene);
  const handMat = new StandardMaterial("handMat", scene);
  handMat.diffuseColor = Color3.Black();
  handMat.alpha = 0.35;
  hand.node.material = handMat;

  const examine = createExamineStage(scene, { camera });
  // Compile the inspect shaders now rather than on the first click.
  hud.setStatus("warming shaders");
  await examine.prewarm(archetypes);

  const interaction = createInteraction(scene, {
    camera, hand, examine, hud,
    // Read live: only the spot being sifted has bodies, and which one that is
    // changes as the player moves along the shore.
    getRocks: () => shore.active?.rocks ?? [],
    getOrigin: () => shore.active?.origin ?? null,
    getClearance: (x, z) => bucket?.clearanceAt(x, z) ?? 0,
    onToggleAO: () => look.toggleAO(),
    onRepour: () => shore.reshuffle(),
  });

  const shore = createShore(scene, camera, {
    archetypes, beds, bucket,
    onModeChange: (mode, spot) => {
      hud.setHint(mode === "sift" ? SIFT_HINT : SHORE_HINT);
      // Aim the shadow map at whatever is being looked at. Left to cover the
      // whole shore it spreads 2048 texels over ~12 m; over one spot that is
      // 2.2 m, so about five times the detail exactly where it is visible.
      env.focusShadows(spot?.origin ?? null, spot ? 1.1 : 4.5);
      if (!spot) hud.setKept(0);
    },
  });
  hud.setHint(SHORE_HINT);

  // Standing back, the pointer belongs to the markers; crouched, it belongs to
  // the bed. They never both want it.
  scene.onPointerObservable.add((info) => {
    if (shore.active || shore.isMoving) return;
    if (info.type === 4) shore.hover(shore.spotAt(scene.pointerX, scene.pointerY));
    if (info.type === 2) {
      const spot = shore.spotAt(scene.pointerX, scene.pointerY);
      if (spot) shore.enter(spot);
    }
  });

  window.addEventListener("keydown", (e) => {
    // Escape backs out one level at a time: put the stone down first, stand up
    // second. interaction.js owns the first of those.
    //
    // isBusy, not isActive: a stone on its way back down already reports
    // inactive, but its landing callback still holds the rock, and standing up
    // disposes the bed out from under it.
    if (e.key !== "Escape" || !shore.active || examine.isBusy) return;
    // Disabled here rather than left to the frame loop. Physics runs inside
    // scene.render(), ahead of onBeforeRender, so a frame's worth of substeps
    // would drive a carried stone whose body had already been disposed.
    interaction.setEnabled(false);
    shore.leave();
  });

  // --- frame loop -----------------------------------------------------------
  let frame = 0;
  scene.onBeforeRenderObservable.add(() => {
    frame++;
    const dt = Math.min(0.05, engine.getDeltaTime() / 1000);
    shore.update(dt);
    examine.update(dt);
    // Sifting is only live once the camera has finished moving in — dragging the
    // bed around while the view is still travelling reads as the scene fighting
    // you.
    interaction.setEnabled(shore.active !== null && !shore.isMoving);

    // Recounted rather than tracked, so a stone knocked back out of the bucket
    // needs no bookkeeping. Every tenth frame is ample for a number that only
    // changes when you put something in, and it keeps 540 distance checks out
    // of the other nine.
    if (bucket && shore.active && frame % 10 === 0) {
      hud.setKept(bucket.count(shore.active.rocks));
    }
  });

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  await scene.whenReadyAsync();
  hud.setDepth(interaction.dig);
  hud.hideLoading();

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

  // Handy from the devtools console: window.shore.scene, .rocks, .archetypes
  window.game = {
    engine, scene, camera, examine, hand, look, env, archetypes, shore, scribble,
    get rocks() { return shore.active?.rocks ?? []; },
  };
}

function buildCamera(scene) {
  // Pulled back from 0.68 m: the bed is a field ~80 cm across rather than a heap
  // 40 cm across, and the old framing cropped it.
  const camera = new ArcRotateCamera("main", -Math.PI / 2, 0.58, 1.05 * U, Vector3.Zero(), scene);
  // Depth precision is driven by the far/near ratio, and this scene is small. The
  // old 0.08 -> 1200 range was 15000:1, which leaves so little precision on a
  // 24-bit buffer that touching stones z-fight and appear to punch through each
  // other and the ground. 1000:1 is comfortable.
  camera.minZ = 0.04 * U;
  camera.maxZ = 40 * U;
  camera.fov = 0.78;
  scene.activeCamera = camera;
  return camera;
}

/**
 * Put a bed in the scene: a baked one if there is one, otherwise pour it here.
 *
 * Pouring is the fallback, not the plan. Settling 540 stones costs ~3.4 s and
 * scales superlinearly — over a minute at a few thousand — for a result that
 * never varies, so it is done once by `npm run bake` and shipped. Restoring one
 * costs ~28 ms. See tools/bake-bench.mjs.
 */
async function loadBeds(scene, archetypes, count) {
  const beds = [];
  for (let i = 0; i < count; i++) {
    try {
      // Spread the picks so neighbouring spots get different beds.
      const bed = await fetchBakedBed("/assets/beds/shore.json", (i + 0.5) / count);
      if (bed) {
        console.log(`spot ${i}: ${bed.variant}, ${bed.count} stones`);
        beds.push(bed);
        continue;
      }
    } catch (err) {
      console.warn("Baked bed could not be read:", err);
    }
    break;
  }
  if (beds.length) return beds;

  console.warn("No baked beds found — pouring one, which is slow. Run `npm run bake`.");
  const { captureBed } = await import("./bed.js");
  const rocks = await pour(scene, archetypes, 5150);
  const bed = captureBed(rocks, archetypes);
  for (const r of rocks) { r.body.dispose(); r.node.dispose(); }
  return [bed];
}

function pour(scene, archetypes, seed) {
  return pourAndSettle(scene, archetypes, {
    count: ROCK_COUNT,
    seed,
    onProgress: async (frac, label) => {
      hud.setStatus(`${label} — ${Math.round(frac * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
    },
  });
}

boot().catch((err) => {
  console.error(err);
  hud.setStatus("Failed to start — see the console.");
});
