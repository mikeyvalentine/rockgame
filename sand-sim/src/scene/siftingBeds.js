/**
 * The stones on the shingle piles — integration slice 2.
 *
 * Every sifting spot gets its baked bed drawn on the crown of its mound. This
 * is the *scenery* half: no Havok, no bodies, nothing pickable. The physics bed
 * wakes when the player crouches (slice 3), which is the whole point of the
 * rock-field LOD in docs/09 — simulated particles at standing distance, full
 * physics objects only where the player's hands are.
 *
 * Nothing here imports rock-sift.
 * ------------------------------
 * rock-sift is on `@babylonjs/core` 8.56 and sand-sim on 9.18. Two Babylon
 * majors in one page means two Scene registries and two sets of class
 * identities, and the failures are the silent kind. So the boundary is drawn at
 * things that carry no engine:
 *
 *   - the stone geometry comes from `rock-forge/src/forge/*`, which is pure JS
 *     and hands back plain position/index arrays;
 *   - the bed file is decoded by `shared/bedFormat.js`, DataView and nothing
 *     else.
 *
 * sand-sim then builds the meshes with its own Babylon. The cast is identical
 * because the forge is deterministic, not because anything was copied — same
 * seed, same count, same draw order gives the same forty stones, and the bed's
 * stored names are the proof (`tools/bed-load-check.mjs` resolves every one).
 *
 * Units
 * -----
 * rock-sift models the beach at 4x real size so stones stay clear of Havok's
 * collision margins, and scales gravity to match. Its beds are therefore in
 * quarter-metres. sand-sim is in metres. Everything read out of a bed is
 * divided by `U` exactly once, here.
 *
 * Why the crown had to be flat
 * ----------------------------
 * A bed is a snapshot of stones poured onto flat ground. It is placed by adding
 * the crown height to every stone's baked y. If the crown were domed or carried
 * the beach's micro relief, stones would float on the high side and sink on the
 * low one — which is why `shared/pileField.js` flattens it and
 * `tools/pile-field-check.mjs` measures that it stayed flat through the
 * resampling.
 */

// Explicit .js: this module is also loaded by the headless checks under plain
// node, which (unlike vite) does not resolve extensionless deep imports. Same
// reason as render/sandDeformPlugin.js.
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
// Side-effect import: `thinInstanceSetBuffer` and friends are an augmentation
// of Mesh, not part of it, and the tree-shaken ES6 build drops them unless the
// module is pulled in by hand. Without it every call below is a no-op on
// `undefined`, nothing throws, and the beach is simply empty — the same shape
// of trap as the `engine.dynamicTexture.js` import in both app modules.
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";

import { bakeLibrary, buildDetailMesh } from "../../../rock-forge/src/forge/bake.js";
import { ARCHETYPES } from "../../../rock-forge/src/forge/archetypes.js";
import { mulberry32 } from "../../../rock-forge/src/forge/rng.js";
import { decodeBed } from "../../../shared/bedFormat.js";
import { SIFT_SPOTS } from "../../../shared/pileField.js";

/**
 * rock-sift's cast, as constants. These are not free parameters: the baked beds
 * store the names these produce, so changing any of them means every bed
 * resolves to nothing. They mirror `rock-sift/src/config.js`.
 */
export const ROCK_SEED = 99;
export const ARCHETYPE_COUNT = 40;
export const U = 4;

/**
 * Icosphere level for the scenery stones.
 *
 * rock-sift draws at level 3 (1280 triangles) because the player is crouched
 * 30 cm away with their hand in the bed. Out here a stone is 6 cm across at
 * two metres and more, so level 2 — 320 triangles — is four times cheaper for
 * a silhouette nobody can tell apart. This is docs/09's rock-field LOD in its
 * cheapest form: the detailed bed is what the crouch swaps in.
 *
 * Measured, all four beds built: level 3 submitted 2,764,800 triangles against
 * a 131k beach. Level 2 plus the per-spot split below brings the worst case to
 * roughly 173k with one spot in view, and nothing at all when none is.
 */
const SCENERY_LOD = 2;

/**
 * Generate the archetype meshes, in metres.
 *
 * The draw order matters and is not incidental: rock-sift advances its RNG
 * once per *accepted* shape, skipping any whose archetype params are missing,
 * and the size it draws decides the stone's scale. Reproducing the sequence
 * exactly is what makes these the same forty stones rather than forty stones
 * with the same names.
 */
export function createBedArchetypes(scene, { count = ARCHETYPE_COUNT, seed = ROCK_SEED } = {}) {
    const lib = bakeLibrary({ count, seed });
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const archetypes = [];

    for (const shape of lib.shapes) {
        const params = ARCHETYPES[shape.archetype];
        if (!params) continue; // skip BEFORE drawing — rock-sift does the same

        const [lo, hi] = shape.sizeRange ?? [0.04, 0.09];
        const sizeMetres = lo + (hi - lo) * rng();

        const detail = buildDetailMesh(shape, params, SCENERY_LOD, sizeMetres);
        const positions = Float32Array.from(detail.positions);
        const indices = Array.from(detail.indices);
        const normals = [];
        VertexData.ComputeNormals(positions, indices, normals);

        const name = `forge_${shape.archetype}_${shape.index}`;
        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;

        const material = new PBRMaterial(`${name}_mat`, scene);
        const [r, g, b] = shape.colour;
        material.albedoColor = new Color3(r, g, b);
        material.roughness = shape.roughness ?? 0.7;
        material.metallic = 0;
        material.environmentIntensity = 0.85;
        material.backFaceCulling = true;
        material.twoSidedLighting = false;
        // Built with Babylon's own winding, so no compensating flip — the same
        // reasoning as rock-sift/src/forgeRocks.js, and its winding-check.
        material.sideOrientation = null;

        // Geometry as data, not as a mesh. Each (archetype, spot) gets its own
        // Mesh built from this below — see the note there on why they cannot
        // share one.
        archetypes.push({ name, vertexData, material, family: shape.archetype, sizeMetres });
    }

    return archetypes;
}

/**
 * Fetch the manifest and every variant it lists.
 *
 * All of them, not one: a shore has several spots and each takes a different
 * variant, so the player does not walk past the same 540 stones four times.
 * Which spot gets which is fixed in `SIFT_SPOTS`, so the beach is the same
 * every load — no `Math.random`, for the same reason `fetchBakedBed` had its
 * random default taken away (docs/04).
 */
export async function fetchBedVariants(manifestUrl = "/assets/beds/shore.json") {
    const res = await fetch(manifestUrl);
    if (!res.ok) return null;
    const manifest = await res.json();
    if (!manifest.variants?.length) return null;

    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
    const beds = [];
    for (const file of manifest.variants) {
        const r = await fetch(base + file);
        if (!r.ok) return null;
        beds.push({ ...decodeBed(await r.arrayBuffer()), variant: file });
    }
    return { manifest, beds };
}

/**
 * Turn a decoded bed into per-archetype thin-instance matrices, in world metres.
 *
 * Thin instances rather than `createInstance` per stone: 2160 stones across
 * four spots would otherwise be 2160 scene nodes for scenery nobody can touch.
 * This is one buffer and one draw call per archetype — forty, for the lot.
 *
 * Pure, and free of Babylon's scene: `tools/bed-load-check.mjs` runs it under
 * plain node to check every stone lands where it should.
 *
 * @param bed        decoded bed, in rock-sift world units
 * @param origin     {x, z} spot centre, metres
 * @param baseY      crown height at that spot, metres
 * @param names      archetype names, in the order the caller will index them
 * @returns Map of archetype name -> Float32Array of 16-float matrices
 */
export function bedInstanceMatrices(bed, origin, baseY, names) {
    const missing = bed.names.filter((n) => !names.includes(n));
    if (missing.length) {
        // Loud, for the same reason rock-sift's resolveArchetypes is loud: a bed
        // baked against a different cast otherwise fails hundreds of stones
        // later with nothing to say why.
        throw new Error(
            `bed "${bed.variant ?? "?"}" references stones not in the generated cast: ` +
            `${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}. ` +
            `The forge's seed or count has changed since this bed was baked — re-bake it.`
        );
    }

    const counts = new Map(names.map((n) => [n, 0]));
    for (let i = 0; i < bed.count; i++) counts.set(bed.names[bed.archIndex[i]],
        counts.get(bed.names[bed.archIndex[i]]) + 1);

    const buffers = new Map();
    const cursor = new Map();
    for (const [n, c] of counts) {
        if (c === 0) continue;
        buffers.set(n, new Float32Array(c * 16));
        cursor.set(n, 0);
    }

    const m = new Matrix();
    const scale = Vector3.One();
    const pos = new Vector3();
    const rot = new Quaternion();

    for (let i = 0; i < bed.count; i++) {
        const name = bed.names[bed.archIndex[i]];
        pos.set(
            bed.positions[i * 3] / U + origin.x,
            bed.positions[i * 3 + 1] / U + baseY,
            bed.positions[i * 3 + 2] / U + origin.z
        );
        rot.set(
            bed.quaternions[i * 4], bed.quaternions[i * 4 + 1],
            bed.quaternions[i * 4 + 2], bed.quaternions[i * 4 + 3]
        );
        Matrix.ComposeToRef(scale, rot, pos, m);
        const at = cursor.get(name);
        m.copyToArray(buffers.get(name), at * 16);
        cursor.set(name, at + 1);
    }

    return buffers;
}

/**
 * Draw every spot's bed on its pile.
 *
 * @param scene
 * @param terrain   anything with `heightAt(x, z)` — both renderers qualify
 * @returns {Promise<{spots:number, stones:number, archetypes:number}|null>}
 *          null when there is nothing baked to load, which is not an error:
 *          the beach is still walkable, it just has no stones on it.
 */
export async function buildSiftingBeds(scene, terrain, opts = {}) {
    const loaded = await fetchBedVariants(opts.manifestUrl);
    if (!loaded) {
        console.warn("[sand-sim] no baked beds found — piles will be bare sand");
        return null;
    }

    const archetypes = createBedArchetypes(scene, opts);
    const names = archetypes.map((a) => a.name);
    const byName = new Map(archetypes.map((a) => [a.name, a]));

    // One mesh per (archetype, spot), NOT one per archetype.
    //
    // Merging the four spots into one buffer per archetype looks cheaper — 40
    // meshes instead of 160 — and is much more expensive, because Babylon
    // frustum-tests a thin-instanced mesh by the bounding box of all its
    // instances. Merged, every archetype's box spans 55 m of beach, so nothing
    // ever culls and all four beds are submitted from anywhere on the shore.
    // Measured: 2,764,800 triangles standing at the spawn with no bed in
    // sight. Split per spot, each box is about 2 m across and the spots you
    // are not looking at cost nothing.
    const drawnMeshes = [];
    let stones = 0;

    for (const spot of SIFT_SPOTS) {
        const bed = loaded.beds[spot.variant % loaded.beds.length];
        const baseY = terrain.heightAt(spot.x, spot.z);
        const buffers = bedInstanceMatrices(bed, spot, baseY, names);

        for (const [name, buf] of buffers) {
            const arch = byName.get(name);

            // Its own Mesh AND its own geometry, per spot. Not `clone()`:
            // `thinInstanceSetBuffer` stores the matrix buffer on the
            // *Geometry*, which clones share, so four spots writing one
            // archetype leaves a single buffer holding whichever spot went
            // last. The giveaway is nasty — every mesh reports the right
            // `thinInstanceCount` and the right bounding box, passes culling
            // where its stones ought to be, and then draws another spot's
            // stones somewhere off screen. Three of the four beds are simply
            // invisible, with nothing anywhere saying so.
            //
            // The duplication is cheap at this size: 160 copies of a 320-tri
            // pebble is well under a megabyte. The material is still shared.
            const mesh = new Mesh(`${name}@${spot.id}`, scene);
            arch.vertexData.applyToMesh(mesh, false);
            mesh.material = arch.material;
            mesh.isPickable = false;
            mesh.receiveShadows = true;
            mesh.thinInstanceSetBuffer("matrix", buf, 16, true);
            mesh.thinInstanceRefreshBoundingInfo(true);
            mesh.freezeWorldMatrix();
            drawnMeshes.push(mesh);
            stones += buf.length / 16;
        }
    }

    // The materials are deliberately NOT frozen: freezing pins a material to
    // the effect it has already compiled, and these need the thin-instanced
    // variant. The meshes are static, and their world matrices are frozen
    // above, which is where the per-frame cost actually was.

    // Loud, because the quiet version of this failure is a beach that looks
    // exactly like a beach with no beds on it — which is what it did until the
    // thin-instance side-effect import went in above.
    const uploaded = drawnMeshes.reduce((n, m) => n + (m.thinInstanceCount ?? 0), 0);
    if (uploaded !== stones) {
        throw new Error(
            `sifting beds: built ${stones} stones but the meshes report ${uploaded} ` +
            `thin instances. If it is 0 or undefined, Babylon's thin-instance ` +
            `augmentation was tree-shaken out — check the side-effect import.`
        );
    }

    return {
        spots: SIFT_SPOTS.length,
        stones,
        archetypes: archetypes.length,
        meshes: drawnMeshes.length,
    };
}
