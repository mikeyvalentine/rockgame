// Measures the gap Havok leaves between touching bodies.
//
//   node tools/margin-test.mjs [worldScale]
//
// Havok inflates every convex shape by a fixed collision radius, expressed in
// world units. If that radius is a large fraction of a stone's size, stones rest
// visibly apart — they look like they are colliding in mid air. The only lever
// from Babylon is the scale the scene is modelled at, so this drops one rock of
// each archetype onto flat static ground and reports how far above it they stop.

import fs from "node:fs";
import {
  HavokPlugin, NullEngine, PhysicsBody, PhysicsMotionType, PhysicsShapeBox,
  Quaternion, Scene, Vector3,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";
import { loadRockArchetypes } from "../src/assetRocks.js";

const U = Number(process.argv[2]) || 4;
const GRAVITY = -9.81 * U;

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const havok = await HavokPhysics({ wasmBinary });

const engine = new NullEngine();
const scene = new Scene(engine);
scene.enablePhysics(new Vector3(0, GRAVITY, 0), new HavokPlugin(true, havok));
const physics = scene.getPhysicsEngine();

// Flat static ground with its top face exactly at y = 0.
const floor = new Vector3(0, -U * 0.5, 0);
const floorNode = new (await import("@babylonjs/core")).Mesh("floor", scene);
floorNode.position.copyFrom(floor);
const floorBody = new PhysicsBody(floorNode, PhysicsMotionType.STATIC, false, scene);
floorBody.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(U * 20, U, U * 20), scene);

const glb = fs.readFileSync(new URL("../public/assets/river_rocks.glb", import.meta.url));
const archetypes = await loadRockArchetypes(
  scene, `data:;base64,${glb.toString("base64")}`, { unitScale: U, seed: 99, pluginExtension: ".glb" }
);

const rocks = [];
archetypes.forEach((arch, i) => {
  const node = arch.mesh;
  node.position.set((i - 4) * U * 0.4, U * 0.25, 0);
  node.rotationQuaternion = Quaternion.Identity();
  const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
  body.shape = arch.shape;
  body.setMassProperties({ mass: arch.metrics.massKgWorld });
  body.setLinearDamping(0.2);
  body.setAngularDamping(0.4);
  rocks.push({ node, body, arch });
});

for (let i = 0; i < 240 * 4; i++) physics._step(1 / 240);

console.log(`world scale U = ${U}  (1 metre = ${U} world units)\n`);
console.log("archetype        size(cm)  gap(units)   gap(mm)   gap as % of stone");
let worst = 0;
for (const r of rocks) {
  // Lowest point of the actual mesh, in world space.
  const m = r.node.computeWorldMatrix(true).m;
  const p = r.arch.vertexData.positions;
  let lowest = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const y = m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13];
    if (y < lowest) lowest = y;
  }
  const sizeUnits = Math.max(...r.arch.metrics.sortedCm) / 100 * U;
  const pct = (lowest / sizeUnits) * 100;
  worst = Math.max(worst, pct);
  console.log(
    `${r.arch.mesh.name.replace("glb_", "").slice(0, 10).padEnd(10)} ${r.arch.metrics.sortedCm[0].toFixed(1).padStart(12)}` +
    `${lowest.toFixed(4).padStart(12)}${((lowest / U) * 1000).toFixed(1).padStart(10)}` +
    `${pct.toFixed(1).padStart(16)}%`
  );
}
console.log(`\nworst gap: ${worst.toFixed(1)}% of the stone's longest axis`);
console.log(worst > 4 ? "  -> visible floating. Model the scene larger." : "  -> below the visible threshold.");
