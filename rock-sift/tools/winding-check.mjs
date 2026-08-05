// Are the imported rocks facing the same way as Babylon's own geometry?
//
//   node tools/winding-check.mjs
//
// Two things have to agree for a closed mesh to render solid, and getting either
// one backwards produces a rock you can see through from some angles:
//
//   winding           which way the triangles are wound, measured as the sign of
//                     the signed volume — positive is inside-out
//   side orientation  which winding Babylon then culls, resolved from the
//                     material if it sets one and from the mesh otherwise
//
// Reasoning about these from the import transform does not survive contact with
// real files: the glTF loader mirrors Z on its __root__ *and* flips the side
// orientation to compensate, so correcting for one double-negates the other. A
// Babylon primitive is the one reference that cannot itself be wrong, so both
// values are compared against a sphere built by MeshBuilder.

import fs from "node:fs";
import {
  HavokPlugin, Material, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3, VertexBuffer,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import "@babylonjs/loaders/glTF/index.js";
import { loadRockArchetypes } from "../src/assetRocks.js";

const signedVolume = (p, idx) => {
  let v = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f]*3, b = idx[f+1]*3, c = idx[f+2]*3;
    v += (p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1]) - p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c]) + p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;
  }
  return v;
};
const orientationName = (v) =>
  v === null ? "null" : v === Material.ClockWiseSideOrientation ? "CW" :
  v === Material.CounterClockWiseSideOrientation ? "CCW" : String(v);

const wasmBinary = fs.readFileSync(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url));
const scene = new Scene(new NullEngine());
scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, await HavokPhysics({ wasmBinary })));

const ref = MeshBuilder.CreateSphere("ref", { diameter: 1 }, scene);
ref.material = new StandardMaterial("refMat", scene);
ref.computeWorldMatrix(true);
const refSign = Math.sign(signedVolume(ref.getVerticesData(VertexBuffer.PositionKind), ref.getIndices()));
const refOrientation = ref.material._getEffectiveOrientation(ref);
console.log(`reference (MeshBuilder sphere): winding ${refSign > 0 ? "+" : "-"}, culls ${orientationName(refOrientation)}\n`);

const glb = fs.readFileSync(new URL("../public/assets/river_rocks.glb", import.meta.url));
const archetypes = await loadRockArchetypes(
  scene, `data:;base64,${glb.toString("base64")}`, { unitScale: 4, seed: 99, pluginExtension: ".glb" }
);

let bad = 0;
console.log("name".padEnd(24) + "winding   culls   verdict");
for (const a of archetypes) {
  a.mesh.computeWorldMatrix(true);
  const sign = Math.sign(signedVolume(a.vertexData.positions, a.vertexData.indices));
  const orientation = a.mesh.material._getEffectiveOrientation(a.mesh);
  const ok = sign === refSign && orientation === refOrientation;
  if (!ok) bad++;
  console.log(
    a.mesh.name.replace("glb_", "").slice(0, 22).padEnd(24) +
    (sign > 0 ? "+" : "-").padEnd(10) + orientationName(orientation).padEnd(8) +
    (ok ? "ok" : sign !== refSign ? "INSIDE OUT" : "CULLED THE WRONG WAY — see-through from some angles")
  );
}

console.log(bad
  ? `\n${bad} of ${archetypes.length} rocks disagree with Babylon's own geometry.`
  : `\nAll ${archetypes.length} rocks face the same way as Babylon's own geometry.`);
process.exit(bad ? 1 : 0);
