// Are the baked beds in public/assets/beds actually usable?
//
//   node tools/bed-test.mjs
//
// Checks the shipped files rather than a bed made up on the spot, because the
// failure this guards against is a bed going stale: re-order the stones in the
// source GLB, or change the stone count or the world scale, and a bed baked
// beforehand no longer describes the world it will be loaded into.
//
// For each variant:
//   decodes    the file parses and its stone names match the loaded archetypes
//   spawns     every stone gets a body
//   holds      the restored bed does not move once the simulation runs
//
// "holds" is the one that matters. A bed can restore into perfectly plausible
// positions and still be wrong: if the stones are fractionally interpenetrating,
// the solver shoves them apart and the player watches the beach shuffle itself
// as they arrive.
//
// THIS CURRENTLY FAILS, and the reason is worth reading before "fixing" it.
//
// The bed never comes to rest. Baking settles it to a far stricter threshold
// than a runtime pour — 1 mm/s, over 25 simulated seconds — and it still never
// gets there: the variants were captured creeping at 3 to 40 mm/s. That is not
// a baking problem. A dense pile of convex hulls that Havok never puts to sleep
// keeps micro-creeping indefinitely, and the live build has always done it. All
// baking did was measure it. (settle-test misses it because its "still moving"
// threshold is 5 cm/s, well above the creep.)
//
// So a restored bed drifts as much as the bed it was copied from would have.
// Measured on shore-3, over two seconds:
//
//   restored dynamic   41.23 mm drift   1175 ms of physics
//   restored static     0.00 mm drift     16 ms of physics
//
// Restoring static fixes it completely and costs 73x less, which is also what
// the game wants anyway — stones only need to be dynamic where the player is
// actually reaching. That needs a wake mechanism, which is the physics-tiering
// work parked in tools/physics-bench.mjs. Until it exists this test is a
// standing statement of a real defect, and is deliberately kept out of
// `npm test` rather than being loosened until it passes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HavokPlugin, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";

import { buildGroundCollider } from "../src/environment.js";
import { loadRockArchetypes } from "../src/assetRocks.js";
import { boundingRadius } from "../src/field.js";
import { decodeBed, spawnBed } from "../src/bed.js";
import {
  BED_RADIUS, GRAVITY, MAX_SPEED, MAX_SPIN, PHYSICS_SUBSTEP_MS, U,
} from "../src/config.js";

const DT = PHYSICS_SUBSTEP_MS / 1000;
const HOLD_STEPS = 240;   // two seconds
const DRIFT_LIMIT_MM = 2; // a stone that moves further than this has resettled

const bedsDir = fileURLToPath(new URL("../../public/assets/beds/", import.meta.url));
const manifestPath = path.join(bedsDir, "shore.json");
if (!fs.existsSync(manifestPath)) {
  console.log("No baked beds found. Run `npm run bake`.");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const havok = await HavokPhysics({ wasmBinary });
const glb = fs.readFileSync(new URL("../../public/assets/river_rocks.glb", import.meta.url));

console.log(`manifest: ${manifest.variants.length} variants, ${manifest.stones} stones each`);
console.log(`world at bake time: U=${manifest.world.U}, gravity=${manifest.world.gravity.toFixed(2)},` +
  ` bedRadius=${manifest.world.bedRadius}`);
if (manifest.world.U !== U || Math.abs(manifest.world.gravity - GRAVITY) > 1e-6
  || manifest.world.bedRadius !== BED_RADIUS) {
  console.log("\nFAIL — the world constants have changed since these beds were baked. Re-bake.");
  process.exit(1);
}

console.log("\nvariant        stones   restore   max drift   verdict");

let failed = 0;
for (const file of manifest.variants) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const plugin = new HavokPlugin(true, havok);
  scene.enablePhysics(new Vector3(0, GRAVITY, 0), plugin);
  plugin.setVelocityLimits(MAX_SPEED, MAX_SPIN);
  scene.getPhysicsEngine().setSubTimeStep(PHYSICS_SUBSTEP_MS);
  buildGroundCollider(scene, { U, bedRadius: BED_RADIUS });

  const archetypes = await loadRockArchetypes(
    scene, `data:;base64,${glb.toString("base64")}`, { unitScale: U, seed: 99, pluginExtension: ".glb" }
  );
  for (const a of archetypes) a.radius = boundingRadius(a.vertexData.positions);

  const bytes = fs.readFileSync(path.join(bedsDir, file));
  const bed = decodeBed(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  const started = Date.now();
  const rocks = spawnBed(scene, archetypes, bed);
  const restoreMs = Date.now() - started;

  const before = rocks.map((r) => r.node.position.clone());
  const physics = scene.getPhysicsEngine();
  for (let i = 0; i < HOLD_STEPS; i++) physics._step(DT);

  let drift = 0;
  for (const [i, r] of rocks.entries()) {
    drift = Math.max(drift, (Vector3.Distance(before[i], r.node.position) / U) * 1000);
  }

  const ok = rocks.length === bed.count && drift <= DRIFT_LIMIT_MM;
  if (!ok) failed++;
  console.log(
    `${file.padEnd(15)}${String(rocks.length).padStart(6)}${String(restoreMs).padStart(9)} ms` +
    `${drift.toFixed(2).padStart(11)} mm   ${ok ? "holds" : "RESETTLES"}`
  );

  scene.dispose();
  engine.dispose();
}

console.log(failed
  ? `\nFAIL — ${failed} of ${manifest.variants.length} beds do not hold their shape.`
  : `\nOK — all ${manifest.variants.length} beds restore and hold still.`);
process.exit(failed ? 1 : 0);
