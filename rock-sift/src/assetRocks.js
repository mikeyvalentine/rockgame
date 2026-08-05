// Rock archetypes loaded from GLB.
//
// The source files group many rocks into one file, so this flattens the scene
// graph, bakes each rock's world transform into its vertices, re-centres it on
// its own bounding box, and rescales it to a plausible real-world size. The
// result is interchangeable with the procedural archetypes in rocks.js.

import { ImportMeshAsync, Mesh, PhysicsShapeConvexHull, VertexBuffer, VertexData } from "@babylonjs/core";
import { skipRating } from "./rocks.js";
import { mulberry32 } from "./noise.js";

const ROCK_DENSITY = 2650;

/** Real-world longest-axis size (metres) per source mesh name. */
const SIZE_HINTS = [
  [/^RiverRock_01/i, 0.072],
  [/^RiverRock_02/i, 0.065],
  [/^RiverRock_03/i, 0.058],
  [/^RiverRock_04/i, 0.050],
  [/^SmallRiverRock/i, 0.036],
];

function sizeFor(name, rng) {
  for (const [re, s] of SIZE_HINTS) if (re.test(name)) return s * (0.82 + rng() * 0.36);
  return 0.055 * (0.8 + rng() * 0.4);
}

function signedVolume(positions, indices) {
  let v = 0;
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f] * 3, b = indices[f + 1] * 3, c = indices[f + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/**
 * Force outward-facing winding, matching what MeshBuilder produces.
 *
 * Reasoning from the import transform does not survive contact with real files:
 * the glTF loader mirrors Z on its __root__ *and* flips the material's side
 * orientation to compensate, so correcting for one of those double-negates the
 * other and the rock renders inside out. Signed volume is a direct measurement
 * of which way the triangles face, so it can't get this wrong. Babylon's own
 * primitives come out negative, so that is the target.
 */
function orientOutward(positions, indices) {
  if (signedVolume(positions, indices) > 0) {
    for (let f = 0; f < indices.length; f += 3) {
      const t = indices[f + 1];
      indices[f + 1] = indices[f + 2];
      indices[f + 2] = t;
    }
  }
}

/** World-space copy of a loaded mesh's geometry, recentred and rescaled. */
function normalise(src, targetWorldSize) {
  const world = src.computeWorldMatrix(true);
  const pos = Array.from(src.getVerticesData(VertexBuffer.PositionKind));
  const nrm = src.getVerticesData(VertexBuffer.NormalKind);
  const uv = src.getVerticesData(VertexBuffer.UVKind);
  const idx = Array.from(src.getIndices());

  const m = world.m;
  const out = new Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  orientOutward(out, idx);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < out.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (out[i + k] < min[k]) min[k] = out[i + k];
      if (out[i + k] > max[k]) max[k] = out[i + k];
    }
  }
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const k = targetWorldSize / Math.max(...span);
  for (let i = 0; i < out.length; i += 3) {
    for (let c = 0; c < 3; c++) out[i + c] = (out[i + c] - (min[c] + max[c]) * 0.5) * k;
  }

  const vd = new VertexData();
  vd.positions = out;
  vd.indices = idx;
  if (uv) vd.uvs = Array.from(uv);
  // Always re-derive: the winding may have been reversed above, and the imported
  // normals were authored for the original transform.
  const n = [];
  VertexData.ComputeNormals(out, idx, n);
  vd.normals = n;
  void nrm;
  return { vertexData: vd, realSpan: span.map((s) => (s * k)) };
}

/**
 * @param {string} url            GLB in /public
 * @param {object} opts           { unitScale, include, seed }
 * @returns archetypes shaped like createRockArchetypes()'s output
 */
export async function loadRockArchetypes(scene, url, { unitScale = 1, include = null, seed = 77, pluginExtension } = {}) {
  const rng = mulberry32(seed);
  const result = await ImportMeshAsync(url, scene, pluginExtension ? { pluginExtension } : undefined);
  const archetypes = [];

  for (const src of result.meshes) {
    if (!src.getTotalVertices || src.getTotalVertices() === 0) continue;
    if (include && !include.test(src.name)) continue;

    const targetReal = sizeFor(src.name, rng);
    const { vertexData, realSpan } = normalise(src, targetReal * unitScale);

    const mesh = new Mesh(`glb_${src.name}`, scene);
    vertexData.applyToMesh(mesh, false);
    mesh.material = src.material;
    mesh.receiveShadows = true;
    if (mesh.material) {
      // The geometry is now wound like Babylon's own primitives, so the loader's
      // compensating side-orientation flip has to come off. `null` means "defer
      // to the mesh", and a Mesh built from VertexData defaults to the same
      // counter-clockwise convention MeshBuilder uses.
      //
      // Pinning it to ClockWise here — which is what the loader sets to undo its
      // own Z mirror — culls the front faces of every rock instead of the back
      // ones. That is mostly invisible, because the inside of a closed shell
      // still shades like a rock; it shows up as stones you can see through from
      // certain angles. tools/winding-check.mjs asserts this against a Babylon
      // primitive, which is the only reference that cannot itself be wrong.
      mesh.material.sideOrientation = null;
      mesh.material.backFaceCulling = true;
      mesh.material.twoSidedLighting = false;
      if ("environmentIntensity" in mesh.material) mesh.material.environmentIntensity = 0.85;
      if ("metallic" in mesh.material) mesh.material.metallic = 0;
    }

    const volumeReal = Math.abs(signedVolume(vertexData.positions, vertexData.indices)) / Math.pow(unitScale, 3);
    const sortedCm = realSpan.map((v) => (v / unitScale) * 100).sort((a, b) => b - a);
    const metrics = {
      family: "scanned",
      label: /^Small/i.test(src.name) ? "Small river stone" : "River stone",
      sortedCm,
      volumeReal,
      massGrams: volumeReal * ROCK_DENSITY * 1000,
      massKgWorld: volumeReal * ROCK_DENSITY,
    };
    metrics.rating = skipRating(metrics);

    const shape = new PhysicsShapeConvexHull(mesh, scene);
    shape.material = { friction: 0.62, restitution: 0.06 };

    archetypes.push({ mesh, shape, vertexData, material: mesh.material, metrics, family: "scanned" });
  }

  // The imported hierarchy (incl. __root__ and empty transform nodes) is no longer needed.
  for (const n of result.meshes) n.dispose(false, false);
  for (const n of result.transformNodes || []) n.dispose();

  return archetypes;
}
