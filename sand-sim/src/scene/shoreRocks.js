/**
 * The shore's rocks, drawn.
 *
 * `shared/shoreScatter.js` decides where every stone is; this puts them on
 * screen. It is the four sifting beds' drawing code generalised from "four
 * patches of 620" to "eight thousand across the whole strip", and it inherits
 * that code's one hard-won rule about how to split the meshes up.
 *
 * Tiles, because Babylon culls by the whole buffer
 * ------------------------------------------------
 * A thin-instanced mesh is frustum-tested by the bounding box of *all* its
 * instances. One mesh per archetype would therefore give forty boxes each
 * spanning the full 70 m of beach, nothing would ever cull, and every stone on
 * the shore would be submitted from everywhere on it — the same trap the beds
 * hit, measured there at 2.7M triangles with nothing in sight.
 *
 * So the field is cut into tiles and the split is per (archetype, tile). Each
 * mesh's box is then one tile across, and the tiles behind you cost nothing.
 * The price is mesh count: tiles x archetypes, which is why the tiles are
 * metres across rather than centimetres.
 *
 * Geometry is copied per mesh, not cloned
 * ---------------------------------------
 * `thinInstanceSetBuffer` stores the matrix buffer on the *Geometry*, and
 * clones share geometry — so cloning would leave one buffer holding whichever
 * tile was built last. Every mesh would still report the right instance count
 * and the right bounding box, pass culling where its stones ought to be, and
 * draw another tile's stones somewhere else entirely. `siftingBeds.js` has the
 * long version of this note; it cost a day there.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
// Side-effect import: `thinInstanceSetBuffer` is an augmentation of Mesh and
// the tree-shaken build drops it unless the module is pulled in by hand.
// Without it every call below is a no-op on `undefined`, nothing throws, and
// the beach is simply empty.
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";

import { createBedArchetypes, castSequence, FIELD_LOD } from "./siftingBeds.js";
import { createBedMaterials } from "./rockMaterials.js";
import { scatterShore } from "../../../shared/shoreScatter.js";
import {
    SHORE_HALF_X, SHORE_BACK_Z, SHORE_WIDTH, SHORE_DEPTH,
} from "../../../shared/worldBounds.js";

/**
 * Tile edge, metres.
 *
 * The trade is culling against mesh count: 70 x 25 m at 12 m tiles is 6 x 3 =
 * 18 tiles, so up to 720 meshes for a 40-stone cast. Halving the tile would
 * quadruple that for a cull that is already tighter than the eye's useful
 * range on a beach this flat.
 */
export const TILE = 12;

/**
 * Metres past which a tile is switched off entirely.
 *
 * Frustum culling drops the tiles behind you; this drops the ones in front and
 * far away, which on a 70 m beach is most of them. It is not a fade — a tile
 * of 6 cm pebbles at 45 m is a few pixels of noise, and popping is only visible
 * when there is something to see popping.
 *
 * Measured in the horizontal plane. Vertically the beach is flat enough that
 * including y would only ever make the radius smaller for no reason.
 */
export const DRAW_DISTANCE = 45;

const _pos = new Vector3();
const _rot = new Quaternion();
const _scale = new Vector3(1, 1, 1);

/**
 * Build the field.
 *
 * @param scene
 * @param terrain  anything with `heightAt(x, z)` — the stones sit in the sand
 *                 the walker walks on, so this must be the same sampler.
 * @param opts     `seed`, `density`, `renderingGroupId`, `forgeMaterial`
 */
export async function buildShoreRocks(scene, terrain, opts = {}) {
    const { byFamily, photo, notes } = await createBedMaterials(scene, {
        forge: opts.forgeMaterial !== false,
    });
    if (notes.length) console.info("[sand-sim] rock surfaces:", notes.join("; "));

    // The same forty stones the beds use, at one icosphere level lower.
    const archetypes = createBedArchetypes(
        scene, { ...opts, lod: FIELD_LOD }, byFamily, photo
    );
    const cast = castSequence(opts);

    const field = scatterShore({
        seed: opts.seed,
        density: opts.density,
        cast,
        heightAt: (x, z) => terrain.heightAt(x, z),
    });

    const cols = Math.ceil(SHORE_WIDTH / TILE);
    const rows = Math.ceil(SHORE_DEPTH / TILE);

    // (tile, archetype) -> matrices, filled in one pass over the field.
    /** @type {Map<string, number[]>} */
    const groups = new Map();
    for (const s of field) {
        const c = Math.min(cols - 1, Math.floor((s.x + SHORE_HALF_X) / TILE));
        const r = Math.min(rows - 1, Math.floor((s.z - SHORE_BACK_Z) / TILE));
        const key = r * cols * archetypes.length + c * archetypes.length + s.archetype;

        let list = groups.get(key);
        if (!list) groups.set(key, (list = []));

        // Tilt is a lean away from vertical in a random direction; combined
        // with yaw it stops the field reading as a carpet of stones all lying
        // the same way up.
        _pos.set(s.x, s.y, s.z);
        Quaternion.RotationYawPitchRollToRef(s.yaw, s.tilt, s.tilt * 0.6, _rot);
        const m = Matrix.Compose(_scale, _rot, _pos);
        for (let i = 0; i < 16; i++) list.push(m.m[i]);
    }

    const meshes = [];
    /** Tile index -> its meshes, for the distance gate. */
    const byTile = new Map();
    let stones = 0;
    for (const [key, list] of groups) {
        const archetype = key % archetypes.length;
        const arch = archetypes[archetype];
        const tile = (key - archetype) / archetypes.length;

        const mesh = new Mesh(`${arch.name}#${tile}`, scene);
        arch.vertexData.applyToMesh(mesh, false);
        mesh.material = arch.material;
        // Thin instances cannot be picked individually, so nothing here is
        // pickable. Inspecting a stone means waking it into a real instance,
        // the way the crouch wakes a bed — not yet wired.
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.renderingGroupId = opts.renderingGroupId ?? 0;
        mesh.thinInstanceSetBuffer("matrix", new Float32Array(list), 16, true);
        mesh.thinInstanceRefreshBoundingInfo(true);
        mesh.freezeWorldMatrix();
        meshes.push(mesh);
        let bucket = byTile.get(tile);
        if (!bucket) byTile.set(tile, (bucket = []));
        bucket.push(mesh);
        stones += list.length / 16;
    }

    // Tile centres, so the gate is 18 distance tests a frame rather than 480.
    const tileCenters = new Map();
    for (const tile of byTile.keys()) {
        const c = tile % cols;
        const r = (tile - c) / cols;
        tileCenters.set(tile, {
            x: -SHORE_HALF_X + (c + 0.5) * TILE,
            z: SHORE_BACK_Z + (r + 0.5) * TILE,
        });
    }
    /** Last state per tile, so `setEnabled` is only called on a change. */
    const shown = new Map([...byTile.keys()].map((t) => [t, true]));

    // Loud, because the quiet version of this failure is a beach that looks
    // exactly like a beach with no rocks on it.
    const uploaded = meshes.reduce((n, m) => n + (m.thinInstanceCount ?? 0), 0);
    if (uploaded !== stones) {
        throw new Error(
            `shore rocks: placed ${stones} stones but the meshes report ` +
            `${uploaded} thin instances. If it is 0 or undefined, Babylon's ` +
            `thin-instance augmentation was tree-shaken out.`
        );
    }

    return {
        stones,
        meshes: meshes.length,
        tiles: cols * rows,
        archetypeList: archetypes,
        field,
        /**
         * Switch tiles on and off by distance. Call once a frame with the
         * camera or the walker's position; both are the same to within a step.
         */
        update(x, z) {
            // Half a tile of slack, so a tile whose centre is just out of range
            // but whose near corner is not stays on.
            const reach = DRAW_DISTANCE + TILE * 0.71;
            for (const [tile, c] of tileCenters) {
                const on = Math.hypot(c.x - x, c.z - z) <= reach;
                if (shown.get(tile) === on) continue;
                shown.set(tile, on);
                for (const m of byTile.get(tile)) m.setEnabled(on);
            }
        },
        setEnabled(on) { for (const m of meshes) m.setEnabled(on); },
        dispose() { for (const m of meshes) m.dispose(); },
    };
}
