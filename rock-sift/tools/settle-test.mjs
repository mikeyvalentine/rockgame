// Headless physics check. Builds the same ground collider and the same bed the
// browser does, runs the pour, and reports where the stones actually ended up.
//
//   node tools/settle-test.mjs [rockCount]
//
// "under sand" is the number that matters: stones below the terrain have
// tunnelled through it, which is what makes the bed look half-buried. The ground
// is flat, so "outside" is not a failure — the pile is meant to spread — but a
// spread far past BED_RADIUS means the bed is thinner than it should look.

import fs from "node:fs";
import { createRequire } from "node:module";
import { NullEngine, Scene, Vector3, HavokPlugin } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js"; // Node needs the explicit path; Vite does not

import { buildGroundCollider, shoreHeight } from "../src/environment.js";
import { createForgeArchetypes } from "../src/forgeRocks.js";
import { boundingRadius, pourAndSettle } from "../src/field.js";
import { BED_RADIUS, GRAVITY, PHYSICS_SUBSTEP_MS, POOL_HALF_X, POOL_HALF_Z, ROCK_COUNT, U, ARCHETYPE_COUNT, ROCK_SEED } from "../src/config.js";

const count = Number(process.argv[2]) || ROCK_COUNT;
// Runtime steps at the frame delta, not the fine step used while settling. A bed
// that is stable at 1/240 can still come apart at 1/60, so both get tested.
const RUNTIME_DT = PHYSICS_SUBSTEP_MS / 1000;
const RUNTIME_SECONDS = 8;

// Resolved through Node, not a hard-coded `../node_modules`: the labs are npm
// workspaces, so dependencies hoist to the repo root. Where npm puts a package
// is npm's business, not a script's.
const wasmBinary = fs.readFileSync(createRequire(import.meta.url).resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"));
const havok = await HavokPhysics({ wasmBinary });

const engine = new NullEngine();
const scene = new Scene(engine);
scene.enablePhysics(new Vector3(0, GRAVITY, 0), new HavokPlugin(true, havok));

buildGroundCollider(scene, { U, bedRadius: BED_RADIUS });

// The scanned GLB is the only source of geometry, loaded exactly as the browser
// does it but via a base64 data URL, which is what Node's loader can reach.
const archetypes = createForgeArchetypes(scene, { unitScale: U, count: ARCHETYPE_COUNT, seed: ROCK_SEED });

for (const a of archetypes) a.radius = boundingRadius(a.vertexData.positions);

console.log(`archetypes: ${archetypes.length}`);
console.log(`  bounding radius: ${archetypes.map((a) => (a.radius / U * 100).toFixed(1)).join(", ")} cm`);
console.log(`  triangles each:  ${archetypes.map((a) => a.vertexData.indices.length / 3).join(", ")}`);

const t0 = Date.now();
const rocks = await pourAndSettle(scene, archetypes, { count, seed: 5150 });
const elapsed = Date.now() - t0;

report("after settling at 1/240");

// Now run the regime the browser actually uses: coarse steps at the frame rate.
for (let i = 0; i < RUNTIME_SECONDS / RUNTIME_DT; i++) scene.getPhysicsEngine()._step(RUNTIME_DT);
const bad = report(`after ${RUNTIME_SECONDS}s of runtime stepping at 1/${Math.round(1 / RUNTIME_DT)}`);

process.exit(bad ? 1 : 0);

function report(label) {
let under = 0, outside = 0, moving = 0, maxY = -Infinity, minY = Infinity;
const radii = [];
const v = new Vector3();
for (const r of rocks) {
  const p = r.node.position;
  const ground = shoreHeight(p.x, p.z, U, BED_RADIUS);
  if (p.y + r.arch.radius * 0.5 < ground) under++;
  const d = Math.hypot(p.x, p.z) / U;
  if (d > BED_RADIUS) outside++;
  radii.push(d);
  r.body.getLinearVelocityToRef(v);
  if (v.length() > 0.05 * U) moving++;
  maxY = Math.max(maxY, p.y);
  minY = Math.min(minY, p.y);
}
radii.sort((a, b) => a - b);

const cm = (u) => ((u / U) * 100).toFixed(1);
console.log(`\n== ${label}  (${rocks.length} stones, poured in ${elapsed} ms)`);
console.log(`  under the sand : ${under}   <- must be 0`);
console.log(`  outside the bed: ${outside} (expected bed radius ${BED_RADIUS * 100} cm)`);
console.log(`  still moving   : ${moving}   <- must be ~0`);
console.log(`  height range   : ${cm(minY)} .. ${cm(maxY)} cm   (flat sand at 0 cm)`);
console.log(`  spread p50/p90/max: ${(radii[radii.length >> 1] * 100).toFixed(1)} / ` +
  `${(radii[Math.floor(radii.length * 0.9)] * 100).toFixed(1)} / ` +
  `${(radii[radii.length - 1] * 100).toFixed(1)} cm  ` +
  `(poured within ${POOL_HALF_X * 100} x ${POOL_HALF_Z * 100} cm)`);
return under > 0 || moving > 3;
}
