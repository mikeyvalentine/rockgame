// What would it cost to ship a pre-settled bed instead of simulating one?
//
//   node tools/bake-bench.mjs [stoneCount]
//
// The bed is fully determined once it has settled. Nothing about it varies at
// runtime, so simulating the pour on the player's machine is paying, every
// launch, for an answer that never changes. This measures the three numbers that
// decide whether baking it is worth doing:
//
//   pour        what settling costs today
//   rebuild     what placing stones at stored transforms costs instead
//   drift       whether a bed rebuilt from stored transforms actually stays put,
//               or twitches as the solver resolves it — the thing that would
//               make baking useless even if it were fast
//
// It also reports the file size the stored bed would need.

import fs from "node:fs";
import {
  HavokPlugin, NullEngine, PhysicsBody, PhysicsMotionType, Quaternion, Scene, Vector3,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";

import { buildGroundCollider } from "../src/environment.js";
import { createForgeArchetypes } from "../src/forgeRocks.js";
import { boundingRadius, pourAndSettle } from "../src/field.js";
import {
  BED_RADIUS, GRAVITY, MAX_SPEED, MAX_SPIN, PHYSICS_SUBSTEP_MS, ROCK_COUNT, U,
  ARCHETYPE_COUNT, ROCK_SEED,
} from "../src/config.js";

const COUNT = Number(process.argv[2]) || ROCK_COUNT;
const DT = PHYSICS_SUBSTEP_MS / 1000;
const DRIFT_STEPS = 240; // two seconds

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const havok = await HavokPhysics({ wasmBinary });

const engine = new NullEngine();
const scene = new Scene(engine);
const plugin = new HavokPlugin(true, havok);
scene.enablePhysics(new Vector3(0, GRAVITY, 0), plugin);
plugin.setVelocityLimits(MAX_SPEED, MAX_SPIN);
scene.getPhysicsEngine().setSubTimeStep(PHYSICS_SUBSTEP_MS);
const physics = scene.getPhysicsEngine();

buildGroundCollider(scene, { U, bedRadius: BED_RADIUS });

// --- archetypes: paid once however the bed arrives -------------------------
let t = Date.now();
const archetypes = createForgeArchetypes(scene, { unitScale: U, count: ARCHETYPE_COUNT, seed: ROCK_SEED });
for (const a of archetypes) a.radius = boundingRadius(a.vertexData.positions);
const archMs = Date.now() - t;

// --- pour: what we do today -------------------------------------------------
t = Date.now();
const rocks = await pourAndSettle(scene, archetypes, { count: COUNT, seed: 5150 });
const pourMs = Date.now() - t;

// --- capture: what a baked file would hold ----------------------------------
const baked = rocks.map((r) => ({
  arch: archetypes.indexOf(r.arch),
  p: r.node.position.clone(),
  q: (r.node.rotationQuaternion ?? Quaternion.Identity()).clone(),
}));

// --- rebuild: drop every body and recreate it from the stored transforms ----
for (const r of rocks) r.body.dispose();

t = Date.now();
for (const [i, r] of rocks.entries()) {
  const b = baked[i];
  r.node.position.copyFrom(b.p);
  r.node.rotationQuaternion = b.q.clone();
  const body = new PhysicsBody(r.node, PhysicsMotionType.DYNAMIC, true /* start asleep */, scene);
  body.shape = r.arch.shape;
  body.setMassProperties({ mass: r.arch.metrics.massKgWorld });
  body.setLinearDamping(0.2);
  body.setAngularDamping(0.4);
  r.body = body;
}
const rebuildMs = Date.now() - t;

// --- drift: does the rebuilt bed hold still? --------------------------------
const before = rocks.map((r) => r.node.position.clone());
for (let i = 0; i < DRIFT_STEPS; i++) physics._step(DT);

let maxDrift = 0, movedStones = 0;
for (const [i, r] of rocks.entries()) {
  const d = Vector3.Distance(before[i], r.node.position) / U * 1000; // mm
  if (d > 1) movedStones++;
  maxDrift = Math.max(maxDrift, d);
}

// --- what the file would weigh ----------------------------------------------
// Full precision: archetype byte + 3 floats + 4 floats.
const rawBytes = rocks.length * (1 + 7 * 4);
// Quantised: the bed fits in a 2 m cube, so 16 bits an axis is 0.03 mm, and a
// quaternion stores as smallest-three in 32 bits with no visible error.
const packedBytes = rocks.length * (1 + 3 * 2 + 4);

const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
console.log(`bed: ${rocks.length} stones, ${archetypes.length} archetypes\n`);
console.log(`archetypes (GLB + convex hulls) ${String(archMs).padStart(7)} ms   paid either way`);
console.log(`pour + settle                   ${String(pourMs).padStart(7)} ms   <- what baking removes`);
console.log(`rebuild from stored transforms  ${String(rebuildMs).padStart(7)} ms   <- what replaces it`);
console.log(`\nspeedup on the bed itself: ${(pourMs / Math.max(1, rebuildMs)).toFixed(0)}x`);
console.log(`\ndrift after ${(DRIFT_STEPS * DT).toFixed(1)}s: max ${maxDrift.toFixed(2)} mm, ` +
  `${movedStones} of ${rocks.length} stones moved more than 1 mm`);
console.log(maxDrift < 5
  ? "  -> a rebuilt bed holds its shape; baking is viable."
  : "  -> the rebuilt bed resettles visibly; stored transforms are not enough on their own.");
console.log(`\nfile size: ${kb(rawBytes)} raw, ${kb(packedBytes)} quantised`);
console.log(`  at 5000 stones: ${kb(5000 * (1 + 3 * 2 + 4))} quantised`);
