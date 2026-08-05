// Does a stone dropped into the bucket stay in it?
//
//   node tools/bucket-test.mjs
//
// The bucket's collider is a static triangle mesh, which is the only shape that
// gives it an inside — a convex hull of a bucket is a solid lump you could only
// ever stack stones on top of. The risk with a trimesh is the opposite one: thin
// walls that a stone can squeeze through. This drops stones down the middle and
// checks they are still in there afterwards.
import fs from "node:fs";
import { HavokPlugin, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";
import { buildGroundCollider } from "../src/environment.js";
import { loadRockArchetypes } from "../src/assetRocks.js";
import { addRock, boundingRadius } from "../src/field.js";
import { loadBucket } from "../src/bucket.js";
import { BED_RADIUS, GRAVITY, PHYSICS_SUBSTEP_MS, U } from "../src/config.js";

const wasm = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const scene = new Scene(new NullEngine());
scene.enablePhysics(new Vector3(0, GRAVITY, 0), new HavokPlugin(true, await HavokPhysics({ wasmBinary: wasm })));
scene.getPhysicsEngine().setSubTimeStep(PHYSICS_SUBSTEP_MS);
buildGroundCollider(scene, { U, bedRadius: BED_RADIUS });

const bglb = fs.readFileSync(new URL("../public/assets/bucket_lowpoly.glb", import.meta.url));
const bucket = await loadBucket(scene, `data:;base64,${bglb.toString("base64")}`, { unitScale: U });
console.log(`rim ${(bucket.rimY / U * 100).toFixed(1)} cm, inner radius ${(bucket.radius / U * 100).toFixed(1)} cm`);
bucket.place(new Vector3(0, 0, 0));

const rglb = fs.readFileSync(new URL("../public/assets/river_rocks.glb", import.meta.url));
const arch = await loadRockArchetypes(scene, `data:;base64,${rglb.toString("base64")}`, { unitScale: U, seed: 99, pluginExtension: ".glb" });
for (const a of arch) a.radius = boundingRadius(a.vertexData.positions);

// Drop five stones straight down the middle from just over the rim.
const rocks = [];
for (let i = 0; i < 4; i++) {
  rocks.push(addRock(scene, arch[i % arch.length],
    new Vector3((i - 1.5) * 0.012 * U, bucket.rimY + 0.05 * U + i * 0.06 * U, 0),
    new (await import("@babylonjs/core")).Quaternion(0, 0, 0, 1), i));
}
for (let i = 0; i < 480; i++) scene.getPhysicsEngine()._step(PHYSICS_SUBSTEP_MS / 1000);

const inside = bucket.count(rocks);
const floor = Math.min(...rocks.map(r => r.node.position.y)) / U * 100;

// Do they actually come to REST, or fidget forever? A triangle-mesh bucket keeps
// its contents twitching indefinitely, because a convex hull resting across the
// internal edges of a triangle grid gets kicked by them. That is invisible in a
// "did they stay in" check and extremely visible on screen.
const v = new (await import("@babylonjs/core")).Vector3();
let fastest = 0;
for (const r of rocks) {
  r.body.getLinearVelocityToRef(v);
  fastest = Math.max(fastest, v.length() / U * 1000); // mm/s
}

// And are they where the bucket is? The collider used to be sized from the rim
// and applied all the way down, so in a cone the stones settled against a wall
// that was not there and stuck out through the side. A stone's centre should sit
// inside the interior profile at its own height.
let worstOut = 0;
for (const r of rocks) {
  const p = r.node.position;
  // Only below the rim. Above it there is no wall to poke through — a stone
  // heaped proud of the mouth is allowed to overhang, same as a real one.
  if (p.y >= bucket.rimY) continue;
  worstOut = Math.max(worstOut, (Math.hypot(p.x, p.z) - bucket.radiusAt(p.y)) / U * 100);
}

console.log(`after 4 s: ${inside} of ${rocks.length} in the bucket, lowest stone at ${floor.toFixed(1)} cm`);
console.log(`still moving: ${fastest.toFixed(1)} mm/s`);
console.log(`furthest centre outside the wall: ${worstOut.toFixed(1)} cm`);
const held = inside === rocks.length && floor > 0;
const still = fastest < 12;
const contained = worstOut < 1.0; // cm
console.log(held && still && contained
  ? "OK — the bucket holds them, they settle, and none poke through the wall."
  : !held ? "FAIL — stones fell through or missed."
  : !still ? "FAIL — stones are in the bucket but never stop moving."
  : "FAIL — stones are resting outside the bucket wall.");
process.exit(held && still && contained ? 0 : 1);
