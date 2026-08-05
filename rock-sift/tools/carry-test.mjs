// How violently does lifting one stone disturb the ones around it?
//
//   node tools/carry-test.mjs [fps] [stoneCount]
//
// Pulling a stone out of a bank should shoulder its neighbours aside, not fire
// them. The number that matters is the peak speed reached by any stone OTHER
// than the one being carried: a neighbour that is nudged moves at a few cm/s, a
// neighbour that is popped moves at metres per second.
//
// Reported separately for while the stone is in hand and for after it is let go.
// Only the first is the complaint — a stone dropped onto a bank is *meant* to
// knock things about, and judging both together hides which one is misbehaving.
//
// A kinematic carry cannot pass this by construction. An animated body has
// infinite mass, so every contact is resolved by moving the other stone at
// whatever speed closes the penetration — no amount of weight on the neighbours
// changes that. This exists to keep the force-driven carry honest.

import fs from "node:fs";
import { HavokPlugin, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";

import { buildGroundCollider } from "../src/environment.js";
import { loadRockArchetypes } from "../src/assetRocks.js";
import { boundingRadius, pourAndSettle } from "../src/field.js";
import { createCarrier } from "../src/carry.js";
import {
  BED_RADIUS, CARRY, GRAVITY, MAX_FRAME_MS, MAX_SPEED, MAX_SPIN, PHYSICS_SUBSTEP_MS, ROCK_COUNT, U,
} from "../src/config.js";

const FPS = Number(process.argv[2]) || 60;
const COUNT = Number(process.argv[3]) || ROCK_COUNT;
const FRAME_MS = 1000 / FPS;
const LIFT_FRAMES = Math.round(0.8 * FPS);
const DRAG_FRAMES = Math.round(1.6 * FPS);
const SETTLE_FRAMES = Math.round(1.0 * FPS);

// A neighbour moving faster than this has been fired, not nudged. A stone
// rolling off a pile under gravity tops out well below it.
const NUDGE_LIMIT = 0.6; // m/s

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const havok = await HavokPhysics({ wasmBinary });

const engine = new NullEngine();
const scene = new Scene(engine);
const plugin = new HavokPlugin(true, havok);
scene.enablePhysics(new Vector3(0, GRAVITY, 0), plugin);
plugin.setVelocityLimits(MAX_SPEED, MAX_SPIN);
scene.getPhysicsEngine().setSubTimeStep(PHYSICS_SUBSTEP_MS);
Scene.MaxDeltaTime = MAX_FRAME_MS;

buildGroundCollider(scene, { U, bedRadius: BED_RADIUS });

const glb = fs.readFileSync(new URL("../public/assets/river_rocks.glb", import.meta.url));
const archetypes = await loadRockArchetypes(
  scene, `data:;base64,${glb.toString("base64")}`, { unitScale: U, seed: 99, pluginExtension: ".glb" }
);
for (const a of archetypes) a.radius = boundingRadius(a.vertexData.positions);

const rocks = await pourAndSettle(scene, archetypes, { count: COUNT, seed: 5150 });

const carrier = createCarrier(scene);
scene.onBeforePhysicsObservable.add(() => carrier.advance(PHYSICS_SUBSTEP_MS / 1000));

const v = new Vector3();
/** Fastest stone that is not the one in hand, in m/s. */
function loudestNeighbour() {
  let worst = 0;
  for (const rock of rocks) {
    if (rock === carrier.rock) continue;
    rock.body.getLinearVelocityToRef(v);
    worst = Math.max(worst, v.length() / U);
  }
  return worst;
}

const frame = () => {
  scene._advancePhysicsEngineStep(FRAME_MS);
  return loudestNeighbour();
};

// Three stones, chosen for how buried they are: the most hemmed-in one in the
// middle of the bank, one at the edge, and the deepest one under the pile.
const centre = [...rocks].sort((a, b) =>
  Math.hypot(a.node.position.x, a.node.position.z) - Math.hypot(b.node.position.x, b.node.position.z))[0];
const edge = [...rocks].sort((a, b) =>
  Math.hypot(b.node.position.x, b.node.position.z) - Math.hypot(a.node.position.x, a.node.position.z))[0];
const buried = [...rocks].sort((a, b) => a.node.position.y - b.node.position.y)[0];

console.log(`bed: ${rocks.length} stones, driving at ${FPS} fps`);
console.log(`carry: stiffness ${CARRY.stiffness}, damping ${CARRY.damping}, max accel ${CARRY.maxAccel}` +
  ` (gravity ${Math.abs(GRAVITY).toFixed(1)})\n`);
console.log("stone       depth   while carried   after release   verdict");

let worst = 0;
for (const [name, rock] of [["centre", centre], ["edge", edge], ["buried", buried]]) {
  // Let anything left over from the previous pull die down first.
  for (let f = 0; f < SETTLE_FRAMES; f++) frame();

  const depth = rock.node.position.y / U * 100;
  carrier.pick(rock);

  let peak = 0;
  for (let f = 0; f < LIFT_FRAMES; f++) peak = Math.max(peak, frame());
  // Then drag it across the bank, which is where it ploughs through the rest.
  const from = rock.node.position.clone();
  for (let f = 0; f < DRAG_FRAMES; f++) {
    const k = f / (DRAG_FRAMES - 1);
    carrier.aim(new Vector3(from.x + (0.3 * U - from.x) * k, 0, from.z + (0.1 * U - from.z) * k));
    peak = Math.max(peak, frame());
  }
  carrier.release();
  let after = 0;
  for (let f = 0; f < SETTLE_FRAMES; f++) after = Math.max(after, frame());

  worst = Math.max(worst, peak);
  console.log(
    `${name.padEnd(10)}${depth.toFixed(1).padStart(6)} cm` +
    `${peak.toFixed(2).padStart(13)} m/s${after.toFixed(2).padStart(13)} m/s   ` +
    `${peak <= NUDGE_LIMIT ? "nudged" : "POPPED"}`
  );
}

console.log(`\nworst neighbour: ${worst.toFixed(2)} m/s   (limit ${NUDGE_LIMIT})`);
console.log(worst <= NUDGE_LIMIT
  ? "OK — lifting a stone shoulders its neighbours aside."
  : "FAIL — neighbours are being fired, not nudged.");
process.exit(worst <= NUDGE_LIMIT ? 0 : 1);
