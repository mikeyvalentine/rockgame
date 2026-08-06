/**
 * The stones on the sifting pads.
 *
 * Every sifting spot gets its baked bed drawn on the sand. This is the
 * *scenery* half: no Havok, no bodies, nothing pickable. The physics bed
 * wakes when the player crouches (slice 3), which is the whole point of the
 * rock-field LOD in docs/09 — simulated particles at standing distance, full
 * physics objects only where the player's hands are.
 *
 * Nothing here imports rock-sift.
 * ------------------------------
 * That began as a hard constraint — rock-sift was on `@babylonjs/core` 8.56
 * against sand-sim's 9.18, and two Babylon majors in one page means two Scene
 * registries and two sets of class identities, failing silently. Both are on
 * 9.18 now, and the boundary is still worth keeping: it means drawing scenery
 * pulls in no physics engine. So it stays drawn at things that carry no engine:
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
 * Why the sand under a bed has to be level
 * ----------------------------------------
 * A bed is a snapshot of stones poured onto flat ground. It is placed by adding
 * the sand height at the spot to every stone's baked y. If that patch of sand
 * carried the beach's 2 degree foreshore ramp or its micro relief, stones would
 * float on the high side and sink on the low one — which is why
 * `shared/siftPad.js` levels it, and `tools/sift-pad-check.mjs` measures that it
 * stayed level through the resampling. The pad adds no HEIGHT; it is not a
 * mound, and there is nothing to climb.
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
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";

import { bakeLibrary, buildDetailMesh } from "../../../rock-forge/src/forge/bake.js";
import { ARCHETYPES } from "../../../rock-forge/src/forge/archetypes.js";
import { mulberry32 } from "../../../rock-forge/src/forge/rng.js";
import { decodeBed } from "../../../shared/bedFormat.js";
import { SIFT_SPOTS } from "../../../shared/siftPad.js";
import { createBedMaterials, tintFor, tintColours } from "./rockMaterials.js";

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
 * The cast, as a sequence — the single place the RNG is walked.
 *
 * The draw order matters and is not incidental: rock-sift advances its RNG once
 * per *accepted* shape, skipping any whose archetype params are missing, and
 * the size it draws decides the stone's scale. Reproducing that exactly is what
 * makes these the same forty stones rather than forty stones with the same
 * names.
 *
 * It is a function rather than two copies of the loop because the meshes and
 * the collision hulls are both built from it, in different modules, and a cast
 * that drifted between them would pair a stone's silhouette with another
 * stone's collider — wrong in a way nothing would report.
 */
export function castSequence({ count = ARCHETYPE_COUNT, seed = ROCK_SEED } = {}) {
    const lib = bakeLibrary({ count, seed });
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const out = [];
    for (const shape of lib.shapes) {
        const params = ARCHETYPES[shape.archetype];
        if (!params) continue; // skip BEFORE drawing — rock-sift does the same
        const [lo, hi] = shape.sizeRange ?? [0.04, 0.09];
        const sizeMetres = lo + (hi - lo) * rng();
        out.push({ name: `forge_${shape.archetype}_${shape.index}`, shape, params, sizeMetres });
    }
    return out;
}

/**
 * Generate the archetype meshes, in metres.
 *
 * @param materials  family name -> PBRMaterial, from `createBedMaterials`
 * @param photo      whether those materials carry photographed surfaces, which
 *                   decides how the per-stone tint is normalised
 */
export function createBedArchetypes(scene, opts = {}, materials = {}, photo = false) {
    const archetypes = [];
    // One extra walk of the RNG, for the per-stone brightness jitter. Kept
    // separate from `castSequence`'s so adding it cannot shift the cast.
    const jrng = mulberry32((opts.seed ?? ROCK_SEED) ^ 0x5bf03635);

    for (const { name, shape, params, sizeMetres } of castSequence(opts)) {
        const jitter = 0.86 + jrng() * 0.28;
        const detail = buildDetailMesh(shape, params, SCENERY_LOD, sizeMetres);
        const positions = Float32Array.from(detail.positions);
        const indices = Array.from(detail.indices);
        const normals = [];
        VertexData.ComputeNormals(positions, indices, normals);

        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;

        // The stone's own colour rides in the vertex buffer rather than in a
        // material, which is what lets forty stones share seven materials —
        // see scene/rockMaterials.js. PBR folds vColor into surfaceAlbedo
        // before the forge plugin's fragment hook runs, so this is exactly the
        // per-instance tint the forge lab passes in `rockInst.yzw`.
        vertexData.colors = Array.from(tintColours(positions, tintFor(shape, jitter, photo)));

        const material = materials[shape.archetype] ?? Object.values(materials)[0];

        // A parked source mesh, for the one spot that is awake at a time.
        //
        // The scenery draws through thin instances, which cannot be picked
        // individually — and the sweep works by picking the stone under the
        // pointer. So a woken bed uses `createInstance` off this: pickable,
        // carries `metadata.rock`, and is what rock-sift's own interaction
        // expects.
        //
        // Parked below the world rather than disabled, because disabling a
        // source disables its instances with it — rock-sift's
        // `parkArchetypeSources` exists for the same reason.
        const mesh = new Mesh(name, scene);
        vertexData.applyToMesh(mesh, false);
        mesh.material = material;
        mesh.isPickable = false;
        mesh.position.set(0, -50, 0);

        // Farthest vertex from the origin. The sweep reads it to find the top
        // of the pile near the hand.
        let radius = 0;
        for (let i = 0; i < positions.length; i += 3) {
            radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
        }

        archetypes.push({ name, mesh, vertexData, material, radius, family: shape.archetype, sizeMetres });
    }

    return archetypes;
}

/**
 * Fetch the manifest and every variant it lists.
 *
 * All of them, not one: a shore has several spots and each takes a different
 * variant, so the player does not walk past the same stones four times.
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
 * @param baseY      sand height at that spot, metres
 * @param names      archetype names, in the order the caller will index them
 * Returns the buffers plus, for every stone in bed order, which archetype
 * buffer it landed in and at which slot. The crouch needs that mapping to write
 * live body transforms back into the same instances, so a woken bed keeps
 * drawing through the very same forty draw calls it drew as scenery.
 *
 * @returns {{buffers: Map<string, Float32Array>, slots: Array<{name: string, slot: number}>}}
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
    const slots = new Array(bed.count);

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
        slots[i] = { name, slot: at };
        cursor.set(name, at + 1);
    }

    return { buffers, slots };
}

/**
 * Draw every spot's bed on its pad.
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
        console.warn("[sand-sim] no baked beds found — the spots will be bare sand");
        return null;
    }

    // The forge's materials and their photographed surfaces. An await, and the
    // reason this whole function is one: it belongs behind the loading screen
    // with Havok and the hulls, not in front of the player.
    const { byFamily, photo, notes } = await createBedMaterials(scene);
    if (notes.length) console.info("[sand-sim] rock surfaces:", notes.join("; "));

    const archetypes = createBedArchetypes(scene, opts, byFamily, photo);
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
    // Kept per spot so the crouch can hide exactly one bed's scenery and put
    // bodies in its place — the LOD swap, which needs to touch one spot and
    // leave the other three alone.
    const perSpotMeshes = new Map(SIFT_SPOTS.map((s) => [s.id, []]));
    // Per spot: which archetype mesh and which instance slot each stone lives
    // in, so a woken body can write straight back into its own instance.
    const meshForSpot = new Map(SIFT_SPOTS.map((s) => [s.id, new Map()]));
    const slotsForSpot = new Map();
    const bedForSpot = new Map();
    let stones = 0;

    for (const spot of SIFT_SPOTS) {
        // A COPY of the variant, not the variant itself. Standing up writes the
        // arrangement the player left back into this object, and `%` means two
        // spots can land on the same variant — sharing it would have one spot's
        // digging silently rewrite another's bed.
        const src = loaded.beds[spot.variant % loaded.beds.length];
        const bed = {
            ...src,
            archIndex: Uint8Array.from(src.archIndex),
            positions: Float32Array.from(src.positions),
            quaternions: Float32Array.from(src.quaternions),
        };
        const baseY = terrain.heightAt(spot.x, spot.z);
        bedForSpot.set(spot.id, { bed, baseY });
        const { buffers, slots } = bedInstanceMatrices(bed, spot, baseY, names);
        slotsForSpot.set(spot.id, slots);

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
            // NOT a static buffer: while this spot is crouched at, the live
            // body transforms are written straight back into `buf` every frame
            // and re-uploaded. Static would pin it and the stones would never
            // appear to move.
            mesh.thinInstanceSetBuffer("matrix", buf, 16, false);
            mesh.thinInstanceRefreshBoundingInfo(true);
            mesh.freezeWorldMatrix();
            // The buffer is kept on the mesh so the crouch can write into the
            // array it already owns, rather than reaching into Babylon's
            // private instance storage.
            mesh.metadata = { spotId: spot.id, archetype: name, matrixBuffer: buf };
            meshForSpot.get(spot.id).set(name, mesh);
            drawnMeshes.push(mesh);
            perSpotMeshes.get(spot.id).push(mesh);
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

        // The handles the crouch needs. Scenery and bodies are the same bed in
        // two states, and only one spot is ever in the body state.
        archetypeList: archetypes,
        bedForSpot,
        meshForSpot,
        slotsForSpot,
        /** Show or hide one spot's scenery, leaving the other spots alone. */
        setSceneryEnabled(spotId, on) {
            for (const m of perSpotMeshes.get(spotId) ?? []) m.setEnabled(on);
        },
    };
}
