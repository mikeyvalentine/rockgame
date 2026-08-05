// Headless check of the *interaction*, not just the bed.
//
//   node tools/sift-test.mjs [fps] [stoneCount]
//
// The bed settling quietly says nothing about what happens once you sweep a hand
// through it, and that is where this scene came apart: stones launched into the
// air, ground into each other, and shot off the shore the moment you dragged.
//
// This drives src/hand.js exactly as main.js drives it, through a fake render
// loop that reproduces Babylon's own ordering inside scene.render():
//
//     _advancePhysicsEngineStep()   <- onBeforePhysics + solver, once per substep
//     onBeforeRenderObservable
//     onAfterRenderObservable
//
// Getting that order right is the whole point. Stepping the physics engine
// directly — which is what the settle test does — hides an entire class of bug:
// anything depending on a flag flipped back in onAfterRender behaves completely
// differently when no frame is ever rendered.
//
// Driving the original code through this harness at 30 fps with 320 stones gave
// peak stone speeds of 49.7 m/s, 142 stones airborne and 83 driven under the
// sand. The same run against the current code peaks at 2.0 m/s with none
// airborne and none under the sand.
//
// The numbers that matter:
//   peak speed   a stone in a bed of pebbles has no business exceeding MAX_SPEED
//   airborne     stones well above the pile were fired, not swept
//   ejected      stones far outside the bed have been shovelled off the shore
//   under sand   stones that tunnelled through the terrain

import fs from "node:fs";
import { HavokPlugin, NullEngine, PhysicsMotionType, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";

import { buildGroundCollider, shoreHeight } from "../src/environment.js";
import { createForgeArchetypes } from "../src/forgeRocks.js";
import { boundingRadius, pileTopOf, pourAndSettle } from "../src/field.js";
import { createSiftHand } from "../src/hand.js";
import {
  BED_RADIUS, GRAVITY, MAX_FRAME_MS, MAX_SPEED, MAX_SPIN, PHYSICS_SUBSTEP_MS, ROCK_COUNT, U,
  ARCHETYPE_COUNT, ROCK_SEED,
} from "../src/config.js";

const FPS = Number(process.argv[2]) || 60;
const COUNT = Number(process.argv[3]) || ROCK_COUNT;
const FRAME_MS = 1000 / FPS;
const STROKE_FRAMES = Math.round(1.6 * FPS);
const SETTLE_FRAMES = Math.round(1.0 * FPS);

// Straight drags across the bed at four dig depths, in metres.
const STROKES = [
  { dig: 0.045, from: [-0.18, -0.06], to: [0.18, 0.06] },
  { dig: 0.010, from: [0.16, -0.14], to: [-0.16, 0.14] },
  { dig: 0.100, from: [0.0, -0.19], to: [0.0, 0.19] },
  { dig: 0.030, from: [-0.15, 0.15], to: [0.15, -0.15] },
];

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const havok = await HavokPhysics({ wasmBinary });

const engine = new NullEngine();
const scene = new Scene(engine);
const plugin = new HavokPlugin(true, havok);
scene.enablePhysics(new Vector3(0, GRAVITY, 0), plugin);
plugin.setVelocityLimits(MAX_SPEED, MAX_SPIN);
scene.getPhysicsEngine().setSubTimeStep(PHYSICS_SUBSTEP_MS);

buildGroundCollider(scene, { U, bedRadius: BED_RADIUS });

const archetypes = createForgeArchetypes(scene, { unitScale: U, count: ARCHETYPE_COUNT, seed: ROCK_SEED });
for (const a of archetypes) a.radius = boundingRadius(a.vertexData.positions);

const rocks = await pourAndSettle(scene, archetypes, { count: COUNT, seed: 5150 });
const restingTop = pileTopOf(rocks);
console.log(`bed: ${rocks.length} stones from ${archetypes.length} archetypes, pile top ${cm(restingTop)} cm`);
console.log(`driving at ${FPS} fps, ${PHYSICS_SUBSTEP_MS.toFixed(2)} ms substeps\n`);

const hand = createSiftHand(scene);
let digY = 0;
// Exactly as main.js registers it: once per physics substep, not once per frame.
scene.onBeforePhysicsObservable.add(() => hand.advance(PHYSICS_SUBSTEP_MS / 1000, digY));

let peakSpeed = 0, peakSpin = 0, worstAirborne = 0, worstEjected = 0, everUnder = 0;
const v = new Vector3();

for (const [i, stroke] of STROKES.entries()) {
  digY = stroke.dig * U;
  const from = new Vector3(stroke.from[0] * U, digY, stroke.from[1] * U);
  const to = new Vector3(stroke.to[0] * U, digY, stroke.to[1] * U);

  hand.grab(from);
  let strokePeak = 0;
  for (let f = 0; f < STROKE_FRAMES; f++) {
    hand.aim(Vector3.Lerp(from, to, f / (STROKE_FRAMES - 1))); // as a pointer drag would
    strokePeak = Math.max(strokePeak, frame());
  }
  hand.release();
  for (let f = 0; f < SETTLE_FRAMES; f++) frame();

  const { airborne, ejected, under } = census();
  worstAirborne = Math.max(worstAirborne, airborne);
  worstEjected = Math.max(worstEjected, ejected);
  everUnder = Math.max(everUnder, under);
  console.log(
    `stroke ${i + 1}  dig ${(stroke.dig * 100).toFixed(1).padStart(5)} cm   ` +
    `peak ${(strokePeak / U).toFixed(2).padStart(6)} m/s   ` +
    `airborne ${String(airborne).padStart(3)}   ejected ${String(ejected).padStart(3)}   under sand ${under}`
  );
}

console.log(`\npeak stone speed : ${(peakSpeed / U).toFixed(2)} m/s   (solver limit ${(MAX_SPEED / U).toFixed(1)})`);
console.log(`peak stone spin  : ${peakSpin.toFixed(1)} rad/s  (solver limit ${MAX_SPIN})`);
console.log(`worst airborne   : ${worstAirborne}   <- stones >5 cm clear of the resting pile after a stroke`);
console.log(`worst ejected    : ${worstEjected}`);
console.log(`ever under sand  : ${everUnder}   <- must be 0`);

const bad = everUnder > 0 || worstAirborne > 4 || worstEjected > 8 || peakSpeed > MAX_SPEED * 1.05;
console.log(bad ? "\nFAIL — the sift is still throwing the bed around." : "\nOK — the bed stays put under the hand.");
process.exit(bad ? 1 : 0);

/** One rendered frame, in Babylon's order. */
function frame() {
  scene._advancePhysicsEngineStep(Math.min(FRAME_MS, MAX_FRAME_MS));
  const fastest = sample();
  scene.onBeforeRenderObservable.notifyObservers(scene);
  scene.onAfterRenderObservable.notifyObservers(scene);
  return fastest;
}

function sample() {
  let fastest = 0;
  for (const r of rocks) {
    if (r.body.getMotionType() !== PhysicsMotionType.DYNAMIC) continue;
    r.body.getLinearVelocityToRef(v);
    fastest = Math.max(fastest, v.length());
    r.body.getAngularVelocityToRef(v);
    peakSpin = Math.max(peakSpin, v.length());
  }
  peakSpeed = Math.max(peakSpeed, fastest);
  return fastest;
}

function census() {
  let airborne = 0, ejected = 0, under = 0;
  for (const r of rocks) {
    const p = r.node.position;
    if (p.y > restingTop + 0.05 * U) airborne++;
    if (Math.hypot(p.x, p.z) > BED_RADIUS * 1.5 * U) ejected++;
    if (p.y + r.arch.radius * 0.5 < shoreHeight(p.x, p.z, U, BED_RADIUS)) under++;
  }
  return { airborne, ejected, under };
}

function cm(u) {
  return ((u / U) * 100).toFixed(1);
}
