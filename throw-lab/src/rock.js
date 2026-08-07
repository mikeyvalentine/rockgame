/**
 * One rock, borrowed from rock-forge.
 *
 * The forge's GEOMETRY side is pure JS (typed arrays, no Babylon), so we can
 * bake a single stone here and wrap it in a Babylon mesh without pulling the
 * forge's own renderer in. `bakeLibrary({count:1, only})` gives a shape carrying
 * the seed/unitScale/archetype that `buildDetailMesh` needs (the shape from
 * makeShape alone does NOT — it lacks those and bakes to NaN).
 *
 * The mesh is authored at the origin; the caller places it in the palm. Its
 * surface is what the procedural grip reads to curl the fingers, so it is a
 * real per-vertex mesh (642 v / 1280 t at level 3), not a proxy.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { ARCHETYPES } from "../../rock-forge/src/forge/archetypes.js";
import { bakeLibrary, buildDetailMesh } from "../../rock-forge/src/forge/bake.js";

/**
 * @param {import("@babylonjs/core/scene").Scene} scene
 * @param {{ name?: string, seed?: number, size?: number }} [opts]
 *   name = a rock archetype (slate/granite/flint/sandstone/basalt/chert/quartz)
 *   size = longest-axis size in metres (~0.06 = a 6 cm skipping stone)
 * @returns {{ mesh: Mesh, geometry: {positions:Float32Array, normals:Float32Array,
 *             indices:Uint32Array|Uint16Array, vertexCount:number} }}
 */
export function buildRock(scene, { name = "granite", seed = 7, size = 0.06 } = {}) {
    const lib = bakeLibrary({ count: 1, seed, lod0Level: 3, only: name });
    const shape = lib.shapes[0];
    const g = buildDetailMesh(shape, ARCHETYPES[shape.archetype], 3, size);

    const mesh = new Mesh("rock", scene);
    const vd = new VertexData();
    vd.positions = g.positions;
    vd.normals = g.normals;
    vd.indices = Array.from(g.indices);
    vd.applyToMesh(mesh, false);

    const mat = new PBRMaterial("rockMat", scene);
    mat.albedoColor = new Color3(0.34, 0.35, 0.37); // grey stone, reads against the pale hand
    mat.roughness = 0.92;
    mat.metallic = 0;
    mesh.material = mat;
    mesh.isPickable = true; // the grip will raycast against it

    return { mesh, geometry: g };
}
