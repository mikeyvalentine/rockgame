// The sift world: everything from the physics up, in one scene, with no engine
// and no render loop of its own.
//
// This used to be the body of main.js's `boot()`. It moved out because there
// are two hosts now. rock-sift's own page builds an engine and drives it as
// the whole app; sand-sim builds this alongside its beach and renders it
// instead while the player is crouched — docs/09's LOD swap, where the beach
// pauses and the bed wakes.
//
// The split is exactly at the engine. The world owns its scene, its physics and
// its own before-render work; the host owns the canvas, the loop, resize, and
// any dial panels. That keeps `main.js` what its header always claimed it was —
// a composition root and nothing else — and means sand-sim runs *this* sift
// mode rather than a second copy of it.
//
// Everything below is the original code, moved rather than rewritten.

import "@babylonjs/loaders/glTF";
import {
  ArcRotateCamera, Color3, HavokPlugin, Scene, StandardMaterial, Vector3,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";

import { buildEnvironment, shoreHeight } from "./environment.js";
import { createExamineStage } from "./examine.js";
import { createSiftHand } from "./hand.js";
import { createInteraction } from "./interaction.js";
import { applyLook } from "./look.js";
import { createForgeArchetypes } from "./forgeRocks.js";
import { fetchBakedBed } from "./bed.js";
import { SPOTS, createShore } from "./shore.js";
import { loadBucket } from "./bucket.js";
import {
  boundingRadius, parkArchetypeSources, pourAndSettle, scatterGravel,
} from "./field.js";
import {
  ARCHETYPE_COUNT, BED_RADIUS, GRAVITY, MAX_FRAME_MS, MAX_SPEED, MAX_SPIN,
  PHYSICS_SUBSTEP_MS, ROCK_COUNT, ROCK_SEED, U,
} from "./config.js";

export const SHORE_HINT = "<strong>Click</strong> a ring to crouch down and sift there";
export const SIFT_HINT =
  "<strong>Drag</strong> to part the stones · <strong>Drag from a stone</strong> to carry it · " +
  "<strong>Click</strong> one to examine it · <strong>Esc</strong> to stand up";

/** A HUD that does nothing, for hosts that have their own (or want none). */
export const nullHud = {
  setStatus() {}, setHint() {}, setKept() {}, setDepth() {}, hideLoading() {},
};

/**
 * Build the sift world.
 *
 * @param engine          the host's Babylon engine
 * @param opts.hud        anything with the createHud() shape; defaults to silent
 * @param opts.enterSpotIndex  index of a spot to crouch at immediately, skipping
 *                        the standing framing — sand-sim passes one, because its
 *                        player has already chosen a spot by walking to it. An
 *                        index rather than an id: the two labs keep different
 *                        spot lists, and matching them by position is the only
 *                        thing that stays true when either list changes.
 * @param opts.onLeave    called when the player stands up out of the last spot;
 *                        sand-sim closes the session here and resumes the beach
 */
export async function createSiftWorld(engine, opts = {}) {
  const hud = opts.hud ?? nullHud;

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

  hud.setStatus("generating stones");
  const archetypes = createForgeArchetypes(scene, {
    unitScale: U, count: ARCHETYPE_COUNT, seed: ROCK_SEED,
  });
  if (!archetypes.length) throw new Error("the forge produced no usable stones");
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
  const beds = await loadBeds(scene, archetypes, SPOTS.length, hud);

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
  hud.setStatus("warming shaders");
  await examine.prewarm(archetypes);

  const interaction = createInteraction(scene, {
    camera, hand, examine, hud,
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
      env.focusShadows(spot?.origin ?? null, spot ? 1.1 : 4.5);
      if (!spot) hud.setKept(0);
      // Standing up out of the last spot is the host's cue to take the player
      // back wherever they came from. rock-sift's own page ignores it and
      // simply shows the shore again.
      if (mode !== "sift") opts.onLeave?.();
    },
  });
  hud.setHint(SHORE_HINT);

  // Standing back, the pointer belongs to the markers; crouched, it belongs to
  // the bed. They never both want it.
  const pointerObserver = scene.onPointerObservable.add((info) => {
    if (shore.active || shore.isMoving) return;
    if (info.type === 4) shore.hover(shore.spotAt(scene.pointerX, scene.pointerY));
    if (info.type === 2) {
      const spot = shore.spotAt(scene.pointerX, scene.pointerY);
      if (spot) shore.enter(spot);
    }
  });

  // Escape pressed mid-transition used to do nothing at all: `shore.leave()`
  // returns early while a tween is running, so the press was swallowed and the
  // player had to notice and press again. The window is not small — the
  // transition is 1.1 s of tween time, and the dt clamp below stretches that to
  // four seconds or more on a slow frame rate. So the intent is remembered and
  // acted on when the camera settles.
  let wantsLeave = false;

  const onKeyDown = (e) => {
    // Escape backs out one level at a time: put the stone down first, stand up
    // second. interaction.js owns the first of those.
    if (e.key !== "Escape" || !shore.active || examine.isBusy) return;
    wantsLeave = true;
  };
  window.addEventListener("keydown", onKeyDown);

  function leaveIfWanted() {
    if (!wantsLeave || shore.isMoving || !shore.active || examine.isBusy) return;
    wantsLeave = false;
    // Disabled here rather than left to the frame loop. Physics runs inside
    // scene.render(), ahead of onBeforeRender, so a frame's worth of substeps
    // would drive a carried stone whose body had already been disposed.
    interaction.setEnabled(false);
    shore.leave();
  }

  // --- per-frame ------------------------------------------------------------
  let frame = 0;
  const beforeRender = scene.onBeforeRenderObservable.add(() => {
    frame++;
    const dt = Math.min(0.05, engine.getDeltaTime() / 1000);
    shore.update(dt);
    examine.update(dt);
    // Sifting is only live once the camera has finished moving in — dragging the
    // bed around while the view is still travelling reads as the scene fighting
    // you.
    interaction.setEnabled(shore.active !== null && !shore.isMoving);
    leaveIfWanted();

    if (bucket && shore.active && frame % 10 === 0) {
      hud.setKept(bucket.count(shore.active.rocks));
    }
  });

  await scene.whenReadyAsync();
  hud.setDepth(interaction.dig);
  hud.hideLoading();

  // Crouch straight in, for a host whose player has already chosen a spot by
  // walking to it. Done after whenReadyAsync so the transition never starts
  // against a scene that is still compiling.
  if (opts.enterSpotIndex !== undefined && opts.enterSpotIndex !== null) {
    const spot = shore.spots[opts.enterSpotIndex % shore.spots.length];
    if (spot) shore.enter(spot);
  }

  return {
    scene, camera, shore, examine, interaction, hand, look, env, archetypes,
    get rocks() { return shore.active?.rocks ?? []; },

    /**
     * Give everything back. The scene owns the meshes, materials and bodies, so
     * disposing it covers those; the physics plugin and the window listener are
     * the two things it does not reach.
     */
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      scene.onBeforeRenderObservable.remove(beforeRender);
      scene.onPointerObservable.remove(pointerObserver);
      interaction.setEnabled(false);
      scene.disablePhysicsEngine();
      scene.dispose();
      plugin.dispose?.();
    },
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
async function loadBeds(scene, archetypes, count, hud) {
  const beds = [];
  for (let i = 0; i < count; i++) {
    try {
      // Spread the picks so neighbouring spots get different beds.
      const bed = await fetchBakedBed("/assets/beds/shore.json", (i + 0.5) / count, {
        expectSource: `forge:${ROCK_SEED}:${ARCHETYPE_COUNT}`,
      });
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

  console.warn("No usable baked bed — pouring one, which is slow. Run `npm run bake`.");
  const { captureBed } = await import("./bed.js");
  const rocks = await pourAndSettle(scene, archetypes, {
    count: ROCK_COUNT,
    seed: 5150,
    onProgress: async (frac, label) => {
      hud.setStatus(`${label} — ${Math.round(frac * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
    },
  });
  const bed = captureBed(rocks, archetypes);
  for (const r of rocks) { r.body.dispose(); r.node.dispose(); }
  return [bed];
}
