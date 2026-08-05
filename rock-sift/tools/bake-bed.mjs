// Pour beds once, here, so the game never pours one.
//
//   node tools/bake-bed.mjs [name] [variants] [stoneCount]
//   npm run bake
//
// Writes public/assets/beds/<name>-<n>.bed plus a <name>.json manifest listing
// them. The runtime picks one, so not every player gets the same beach; pass a
// value derived from the save to fetchBakedBed and a given save keeps its own.
//
// Re-run this whenever anything that shapes the bed changes: the source model,
// the stone count, BED/POOL radius, gravity, the settle constants. A bed baked
// against a different model fails loudly on load rather than silently mapping
// stones to the wrong shapes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HavokPlugin, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";

import { buildGroundCollider } from "../src/environment.js";
import { loadRockArchetypes } from "../src/assetRocks.js";
import { boundingRadius, pourAndSettle } from "../src/field.js";
import { decodeBed, encodeBed } from "../src/bed.js";
import {
  BED_RADIUS, GRAVITY, MAX_SPEED, MAX_SPIN, PHYSICS_SUBSTEP_MS, ROCK_COUNT, U,
} from "../src/config.js";

const NAME = process.argv[2] || "shore";
const VARIANTS = Number(process.argv[3]) || 4;
const COUNT = Number(process.argv[4]) || ROCK_COUNT;

const outDir = fileURLToPath(new URL("../../public/assets/beds/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const havok = await HavokPhysics({ wasmBinary });
const glb = fs.readFileSync(new URL("../../public/assets/river_rocks.glb", import.meta.url));

/** A fresh world per variant: a bed must not inherit the previous one's state. */
async function bake(seed) {
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

  const started = Date.now();
  const rocks = await pourAndSettle(scene, archetypes, {
    count: COUNT, seed,
    // Far stricter than a runtime pour: 1 mm/s, and as long as it takes.
    restSpeed: 0.001, finalSteps: 6000,
  });
  const ms = Date.now() - started;

  // What the bed is actually doing at the moment it is captured. Anything above
  // a millimetre a second here will show up as the restored bed shuffling.
  const vel = new Vector3();
  let fastest = 0;
  for (const r of rocks) {
    r.body.getLinearVelocityToRef(vel);
    fastest = Math.max(fastest, vel.length() / U);
  }

  const buffer = encodeBed(rocks, archetypes);

  // Decode straight back and check the round trip, so a corrupt bed is caught
  // here rather than as stones in the wrong places on someone's machine.
  const back = decodeBed(buffer);
  let worst = 0;
  for (const [i, r] of rocks.entries()) {
    worst = Math.max(worst, Math.hypot(
      back.positions[i * 3] - r.node.position.x,
      back.positions[i * 3 + 1] - r.node.position.y,
      back.positions[i * 3 + 2] - r.node.position.z
    ));
  }

  const spread = rocks.reduce((m, r) => Math.max(m, Math.hypot(r.node.position.x, r.node.position.z)), 0);
  scene.dispose();
  engine.dispose();
  return {
    buffer, ms, stones: rocks.length, errorMm: (worst / U) * 1000,
    spreadCm: (spread / U) * 100, restMmS: fastest * 1000,
  };
}

console.log(`baking ${VARIANTS} variants of "${NAME}", ${COUNT} stones each\n`);
console.log("variant   stones    poured   round-trip error   at rest   spread     size");

const variants = [];
let totalMs = 0;
for (let i = 0; i < VARIANTS; i++) {
  const seed = 5150 + i * 7919; // arbitrary, but fixed: re-baking gives the same beds
  const { buffer, ms, stones, errorMm, spreadCm, restMmS } = await bake(seed);
  const file = `${NAME}-${i}.bed`;
  fs.writeFileSync(path.join(outDir, file), Buffer.from(buffer));
  variants.push(file);
  totalMs += ms;
  console.log(
    `${String(i).padEnd(9)}${String(stones).padStart(6)}${(ms / 1000).toFixed(1).padStart(10)}s` +
    `${errorMm.toFixed(3).padStart(15)} mm${restMmS.toFixed(2).padStart(7)} mm/s` +
    `${spreadCm.toFixed(0).padStart(8)} cm` +
    `${(buffer.byteLength / 1024).toFixed(1).padStart(9)} KB`
  );
}

fs.writeFileSync(path.join(outDir, `${NAME}.json`), JSON.stringify({
  name: NAME,
  stones: COUNT,
  variants,
  // Recorded so a bed can be told at a glance whether it matches the current
  // world constants. Anything here changing means it needs re-baking.
  world: { U, gravity: GRAVITY, bedRadius: BED_RADIUS, source: "river_rocks.glb" },
  bakedWith: `bake-bed.mjs ${NAME} ${VARIANTS} ${COUNT}`,
}, null, 2) + "\n");

console.log(`\nwrote ${variants.length} beds + manifest to public/assets/beds/`);
console.log(`total bake time ${(totalMs / 1000).toFixed(1)}s — paid here, once, instead of on every launch`);
