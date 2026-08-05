// How Havok's cost scales with the number of stones.
//
//   node tools/physics-bench.mjs [count,count,...]
//
// The question this answers: how many stones can be *dynamic* before the solver
// stops fitting in a frame? That is the real ceiling on "more rocks" — the GPU
// side is a separate and much softer limit.
//
// Two regimes are measured, because they are wildly different:
//
//   at rest    the bed settled and untouched. If Havok is sleeping resting
//              islands properly this should be nearly free no matter how many
//              stones there are, and a physics tier scheme would be pointless.
//   sweeping   a hand dragged through the bed. Everything it touches wakes, and
//              this is the number that has to fit in a frame.
//
// Budget: at 60 fps with a 1/120 fixed step the engine runs 2 substeps a frame,
// inside a 16.7 ms budget shared with rendering. Physics wants to stay under
// about 6 ms/frame, so 3 ms per substep.
//
// Measured 2026-08-02, Node, this machine:
//
//   stones    at rest   nosync   inactive   static   sweeping   frame
//      270     1.78ms   1.45ms     0.16ms   0.01ms     1.86ms    3.7ms
//      540     4.63ms   3.97ms     0.31ms   0.01ms     4.84ms    9.7ms
//     1080     9.32ms   8.48ms     0.60ms   0.01ms     9.89ms   19.8ms
//
// What that says, and the reason this file exists:
//
//   - Havok does NOT sleep the bed. A settled untouched pile costs the same as
//     one being swept (4.63 vs 4.84). It fully simulates 540 motionless stones
//     120 times a second.
//   - That cost is the solver, not marshalling: switching transform sync off
//     recovers only ~15%.
//   - Deactivating resting bodies is worth 15x, making them static 460x. So
//     essentially the whole physics budget is stones doing nothing, and a tier
//     scheme is the dominant optimisation available — worth roughly 2000-3000
//     touchable stones at the frame cost 540 has today.
//   - At ROCK_COUNT 540 the simulation already eats 9.7 ms of a 16.7 ms frame
//     before anything is drawn.
//
// The catch, for whoever picks this up: ALWAYS_INACTIVE stops Havok waking a
// body on contact, which is exactly why it is cheap — so wake propagation has to
// be managed by hand (a radius around the sweep, grown to cover anything already
// moving). Prefer it to STATIC anyway: a static body has infinite mass, and
// freezing a load-bearing stone then waking it pops the pile. Before any of
// that, find out why simulation-controlled deactivation never fires; if the pile
// can be made to sleep on its own, the engine handles waking correctly and the
// hand-rolled version is unnecessary. tools/sift-test.mjs already measures the
// failure modes a tier scheme would cause.

import fs from "node:fs";
import { HavokPlugin, NullEngine, PhysicsActivationControl, PhysicsMotionType, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";

import { buildGroundCollider } from "../src/environment.js";
import { loadRockArchetypes } from "../src/assetRocks.js";
import { boundingRadius, pourAndSettle } from "../src/field.js";
import { createSiftHand } from "../src/hand.js";
import { BED_RADIUS, GRAVITY, PHYSICS_SUBSTEP_MS, U } from "../src/config.js";

const COUNTS = (process.argv[2] || "270,540,1080,2160").split(",").map(Number);
const DT = PHYSICS_SUBSTEP_MS / 1000;
const REST_STEPS = 240;
const SWEEP_SECONDS = 2.0;
const FRAME_BUDGET_MS = 6; // physics' share of a 60 fps frame

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const havok = await HavokPhysics({ wasmBinary });
const glb = fs.readFileSync(new URL("../public/assets/river_rocks.glb", import.meta.url));
const glbUrl = `data:;base64,${glb.toString("base64")}`;

/** Median is the honest statistic here — the mean is dragged by one-off spikes. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

async function bench(count) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, GRAVITY, 0), new HavokPlugin(true, havok));
  const physics = scene.getPhysicsEngine();
  buildGroundCollider(scene, { U, bedRadius: BED_RADIUS });

  const archetypes = await loadRockArchetypes(scene, glbUrl, { unitScale: U, seed: 99, pluginExtension: ".glb" });
  for (const a of archetypes) a.radius = boundingRadius(a.vertexData.positions);

  const poured = Date.now();
  const rocks = await pourAndSettle(scene, archetypes, { count, seed: 5150 });
  const pourMs = Date.now() - poured;

  // --- at rest --------------------------------------------------------------
  const rest = [];
  for (let i = 0; i < REST_STEPS; i++) {
    const t = performance.now();
    physics._step(DT);
    rest.push(performance.now() - t);
  }

  // --- at rest, transform sync switched off ---------------------------------
  // HavokPlugin.executeStep walks every body every substep and reads its
  // transform back out of WASM, whether or not the body is asleep. Sleeping
  // cannot remove that cost; only skipping the body can. Measuring with sync
  // off separates "the solver is working" from "we are paying to ask 540
  // motionless stones where they are, 120 times a second".
  for (const r of rocks) r.body.disableSync = true;
  const restNoSync = [];
  for (let i = 0; i < REST_STEPS; i++) {
    const t = performance.now();
    physics._step(DT);
    restNoSync.push(performance.now() - t);
  }
  for (const r of rocks) r.body.disableSync = false;

  // --- at rest, bodies forced inactive --------------------------------------
  // The floor: what a settled bed would cost if Havok were sleeping it, or if a
  // physics tier parked every resting stone. This is the whole prize.
  const plugin0 = scene.getPhysicsEngine().getPhysicsPlugin();
  for (const r of rocks) plugin0.setActivationControl(r.body, PhysicsActivationControl.ALWAYS_INACTIVE);
  const restInactive = [];
  for (let i = 0; i < REST_STEPS; i++) {
    const t = performance.now();
    physics._step(DT);
    restInactive.push(performance.now() - t);
  }

  // --- at rest, resting stones made static ----------------------------------
  // The other way to buy the same thing, and the one that definitely works:
  // take them out of the dynamic set entirely.
  for (const r of rocks) plugin0.setActivationControl(r.body, PhysicsActivationControl.SIMULATION_CONTROLLED);
  for (const r of rocks) r.body.setMotionType(PhysicsMotionType.STATIC);
  const restStatic = [];
  for (let i = 0; i < REST_STEPS; i++) {
    const t = performance.now();
    physics._step(DT);
    restStatic.push(performance.now() - t);
  }
  for (const r of rocks) r.body.setMotionType(PhysicsMotionType.DYNAMIC);

  // --- sweeping -------------------------------------------------------------
  const hand = createSiftHand(scene);
  const dig = 0.045 * U;
  scene.onBeforePhysicsObservable.add(() => hand.advance(DT, dig));

  const from = new Vector3(-0.18 * U, dig, -0.06 * U);
  const to = new Vector3(0.18 * U, dig, 0.06 * U);
  hand.grab(from);

  const sweep = [];
  const steps = Math.round(SWEEP_SECONDS / DT);
  for (let i = 0; i < steps; i++) {
    hand.aim(Vector3.Lerp(from, to, (i / (steps - 1)) % 1));
    const t = performance.now();
    scene._advancePhysicsEngineStep(DT * 1000);
    sweep.push(performance.now() - t);
  }
  hand.release();

  const result = {
    count: rocks.length,
    pourMs,
    rest: median(rest),
    restNoSync: median(restNoSync),
    restInactive: median(restInactive),
    restStatic: median(restStatic),
    sweep: median(sweep),
    sweepP95: [...sweep].sort((a, b) => a - b)[Math.floor(sweep.length * 0.95)],
  };
  scene.dispose();
  engine.dispose();
  return result;
}

console.log(`substep ${DT.toFixed(5)} s, 2 substeps per frame at 60 fps`);
console.log(`budget: ${(FRAME_BUDGET_MS / 2).toFixed(1)} ms per substep\n`);
console.log("stones    at rest   nosync   inactive   static   sweeping   frame   verdict");

for (const c of COUNTS) {
  const r = await bench(c);
  const frameMs = r.sweep * 2;
  const verdict = frameMs < FRAME_BUDGET_MS ? "fits"
    : frameMs < 16.7 ? "tight — physics eats the frame"
      : "over budget";
  console.log(
    `${String(r.count).padStart(6)}${r.rest.toFixed(2).padStart(9)}ms${r.restNoSync.toFixed(2).padStart(8)}ms` +
    `${r.restInactive.toFixed(2).padStart(10)}ms${r.restStatic.toFixed(2).padStart(8)}ms` +
    `${r.sweep.toFixed(2).padStart(10)}ms${frameMs.toFixed(1).padStart(8)}ms   ${verdict}`
  );
}

console.log(
  "\nIf 'at rest' stays flat as the count climbs, Havok is sleeping the bed and a\n" +
  "physics tier would buy nothing. If it climbs with the count, sleeping is not\n" +
  "happening and that is the first thing to fix — before any tiering."
);
