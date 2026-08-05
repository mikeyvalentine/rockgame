// Does the shared icosphere face the same way as Babylon's own geometry?
//
//   node tools/winding-check.mjs
//
// Get this backwards and every rock renders as a hollow shell: the front faces
// are culled and you see the inside of the far wall, which reads as a crescent
// or a scooped-out bowl. It is unmistakable once you know it, and easy to
// mistake for a broken shape function — a radial r(direction) cannot produce a
// crescent, so a crescent is always a culling bug, never a geometry one.
//
// The convention is not worth reasoning about from first principles: it depends
// on the handedness of the scene and on what the material resolves its side
// orientation to. A sphere built by MeshBuilder is the one reference that
// cannot itself be wrong, so the icosphere is compared against that.
//
// Adapted from rock-sift's tools/winding-check.mjs, which does the same job for
// its imported GLB rocks.

import { Material, MeshBuilder, NullEngine, Scene, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { buildIcosphere } from "../src/forge/icosphere.js";

const signedVolume = (p, idx) => {
  let v = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3, b = idx[f + 1] * 3, c = idx[f + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
};

const orientationName = (v) =>
  v === null ? "null (defers to the mesh)"
    : v === Material.ClockWiseSideOrientation ? "CW"
    : v === Material.CounterClockWiseSideOrientation ? "CCW" : String(v);

const scene = new Scene(new NullEngine());

const ref = MeshBuilder.CreateSphere("ref", { diameter: 1 }, scene);
ref.material = new StandardMaterial("refMat", scene);
ref.computeWorldMatrix(true);
const refVol = signedVolume(ref.getVerticesData(VertexBuffer.PositionKind), ref.getIndices());
const refSign = Math.sign(refVol);
console.log(`\nreference (MeshBuilder sphere)`);
console.log(`  signed volume   ${refVol.toFixed(6)}  (${refSign > 0 ? "+" : "-"})`);
console.log(`  culls           ${orientationName(ref.material._getEffectiveOrientation(ref))}`);

console.log(`\nforge icosphere`);
let bad = 0;
for (let level = 1; level <= 3; level++) {
  const ico = buildIcosphere(level);
  const lvl = ico.levels[level];
  // Radius 0.5 so the numbers are directly comparable with the reference.
  const pos = new Float32Array(lvl.vertexCount * 3);
  for (let i = 0; i < lvl.vertexCount * 3; i++) pos[i] = ico.dirs[i] * 0.5;
  const vol = signedVolume(pos, lvl.indices);
  const ok = Math.sign(vol) === refSign;
  if (!ok) bad++;
  console.log(`  level ${level}         ${vol.toFixed(6)}  (${vol > 0 ? "+" : "-"})  ` +
    (ok ? "ok" : "INSIDE OUT — rocks will render as hollow shells"));
}

console.log(bad
  ? `\n${bad} level(s) disagree with Babylon's own geometry. Flip the winding in buildIcosphere.\n`
  : `\nThe icosphere faces the same way as Babylon's own geometry.\n`);
process.exit(bad ? 1 : 0);
