/**
 * The shore's rocks, drawn.
 *
 * `shared/shoreScatter.js` decides where every stone is; this puts them on
 * screen. It is the four sifting beds' drawing code generalised from "four
 * patches of 620" to a hundred thousand across the whole strip, and it inherits
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
 *
 * Three levels of detail, and why the near one cannot be a tile
 * -------------------------------------------------------------
 * A thin instance cannot pick its own mesh, so a level of detail is a whole
 * mesh and the swap has to happen per group. The obvious build is three static
 * sets per tile, switched by the tile's distance. It does not work here, and
 * the reason is the density rather than anything about Babylon.
 *
 * The field runs about 140 stones per square metre at the back of the strip. A
 * level-2 stone is 320 triangles, so level 2 costs roughly 45,000 triangles per
 * square metre — which means the whole level-2 budget is about fifteen square
 * metres, a circle two metres across. No tile is that small, and a tiling fine
 * enough to be would have more meshes than stones.
 *
 * So the near ring is built from the player instead of from the grid:
 *
 *   NEAR   level 2, stones within `NEAR_RADIUS` of the walker. Rebuilt when
 *          they move `REBUILD_STEP`; about a thousand stones, and the only
 *          per-frame allocation in the file is avoiding it.
 *   MID    level 1, static per tile, out to `MID_DISTANCE`.
 *   FAR    level 0, static per tile, out to `DRAW_DISTANCE` — and carrying
 *          only every `FAR_STRIDE`-th stone, because past twenty metres the
 *          field is bound by how MANY stones there are rather than by how many
 *          triangles each one has. Dropping two in three there is invisible
 *          and saves more than any amount of simplifying would.
 *
 * The occupied tiles' MID meshes are switched off while the near set stands in
 * for them, so nothing is ever drawn twice — that is what `_rebuildNear` is
 * really for, and why it rebuilds the leftovers as well as the near stones.
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

import { createBedArchetypes, castSequence } from "./siftingBeds.js";
import { createBedMaterials } from "./rockMaterials.js";
import { scatterShore } from "../../../shared/shoreScatter.js";
import {
    SHORE_HALF_ARC, SHORE_WIDTH, SHORE_DEPTH, shorePoint,
} from "../../../shared/worldBounds.js";

/**
 * Icosphere levels for the three rings: near, mid, far.
 *
 * 320, 80 and 20 triangles. The beds draw at level 3 (1280) because the player
 * is crouched 30 cm away with their hand in them; nothing out here is ever
 * closer than a standing eye height.
 */
export const LOD_LEVELS = [2, 1, 0];

/**
 * Tile edge, metres. Culling granularity for the two static rings.
 *
 * Small, because a ring is only as tight as the tiles it is made of: a tile is
 * either wholly in a ring or wholly out, so the effective radius is the
 * nominal one plus half a tile's diagonal. At 10 m that slack was 7 m and the
 * mid ring reached most of the beach. The cost is mesh count — 60 tiles x 40
 * archetypes x 2 static rings — which is about 5,000 meshes and a quarter of a
 * millisecond of culling, against the megabytes of triangles it saves.
 */
export const TILE = 6;

/**
 * Radius of the level-2 set, metres. A budget, not a taste.
 *
 * The near set is one mesh per archetype covering a circle around the walker,
 * so it cannot be frustum-culled — the half of it behind you is submitted
 * every frame regardless. That makes its cost the full circle: at 140 stones
 * per square metre and 320 triangles each, 2 m is 560k triangles and 3.5 m is
 * 1.7M. Measured at 3.5 it was the second largest thing on screen.
 */
export const NEAR_RADIUS = 2.0;

/** How far the walker moves before the near set is rebuilt, metres. */
export const REBUILD_STEP = 0.75;

/** Tile distance out to which the level-1 ring draws, metres. */
export const MID_DISTANCE = 10;

/**
 * Metres past which a tile is switched off entirely.
 *
 * Frustum culling drops the tiles behind you; this drops the ones in front and
 * far away, which on a 70 m beach is most of them. It is not a fade — a tile
 * of 6 cm pebbles at 45 m is a few pixels of noise, and popping is only visible
 * when there is something to see popping.
 */
export const DRAW_DISTANCE = 40;

/**
 * One stone in this many survives into the far ring.
 *
 * The honest name for this is "we stop drawing most of the beach". It is
 * legitimate because at twenty metres a 6 cm pebble is under two pixels and the
 * field reads as texture rather than as stones — but it IS a lie about how many
 * rocks there are, so it is stated here and logged at build rather than buried.
 */
export const FAR_STRIDE = 4;

const _rot = new Quaternion();
const _pos = new Vector3();
const _one = new Vector3(1, 1, 1);

/** Compose one stone's world matrix into `out` at `offset`. */
function writeMatrix(s, out, offset) {
    _pos.set(s.x, s.y, s.z);
    Quaternion.RotationYawPitchRollToRef(s.yaw, s.tilt, s.tilt * 0.6, _rot);
    const m = Matrix.Compose(_one, _rot, _pos);
    for (let i = 0; i < 16; i++) out[offset + i] = m.m[i];
}

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

    // One archetype set per level. Each call reseeds its own jitter RNG from
    // `opts.seed`, so a stone's tint is the same at every level — which it has
    // to be, or a pebble changes colour as you walk up to it.
    // `?lod=` collapses all three rings to one level, for judging the ringed
    // field against a flat one.
    const levels = opts.lod == null
        ? LOD_LEVELS
        : [opts.lod, opts.lod, opts.lod];
    const [nearArch, midArch, farArch] = levels.map(
        (lod) => createBedArchetypes(scene, { ...opts, lod }, byFamily, photo)
    );
    const archCount = nearArch.length;

    const field = scatterShore({
        seed: opts.seed,
        density: opts.density,
        cast: castSequence(opts),
        heightAt: (x, z) => terrain.heightAt(x, z),
    });

    // Tiled in (arc, depth), like the scatter itself. Tiling in x/z would cut
    // the curved strip into wedges of wildly different population.
    const cols = Math.ceil(SHORE_WIDTH / TILE);
    const rows = Math.ceil(SHORE_DEPTH / TILE);

    /** tile -> archetype -> stones. Kept, because the near set re-reads it. */
    const byTile = new Map();
    for (const s of field) {
        const c = Math.min(cols - 1, Math.floor((s.arc + SHORE_HALF_ARC) / TILE));
        const r = Math.min(rows - 1, Math.floor(s.depth / TILE));
        const tile = r * cols + c;
        let arches = byTile.get(tile);
        if (!arches) byTile.set(tile, (arches = new Map()));
        let list = arches.get(s.archetype);
        if (!list) arches.set(s.archetype, (list = []));
        list.push(s);
    }

    const group = opts.renderingGroupId ?? 0;
    function makeMesh(arch, name, count) {
        const mesh = new Mesh(name, scene);
        arch.vertexData.applyToMesh(mesh, false);
        mesh.material = arch.material;
        // Thin instances cannot be picked individually, so nothing here is
        // pickable. Inspecting a stone means waking it into a real instance,
        // the way the crouch wakes a bed — not yet wired.
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.renderingGroupId = group;
        mesh.setEnabled(false);
        return mesh;
    }

    // ---- the two static rings ----------------------------------------------
    const midMeshes = new Map();   // tile -> Mesh[]
    const farMeshes = new Map();
    let stones = 0;
    let farStones = 0;

    for (const [tile, arches] of byTile) {
        const mid = [];
        const far = [];
        for (const [archetype, list] of arches) {
            stones += list.length;

            const midBuf = new Float32Array(list.length * 16);
            list.forEach((s, i) => writeMatrix(s, midBuf, i * 16));
            const m = makeMesh(midArch[archetype], `rockMid_${archetype}#${tile}`);
            m.thinInstanceSetBuffer("matrix", midBuf, 16, true);
            m.thinInstanceRefreshBoundingInfo(true);
            m.freezeWorldMatrix();
            mid.push(m);

            const kept = list.filter((_, i) => i % FAR_STRIDE === 0);
            if (!kept.length) continue;
            farStones += kept.length;
            const farBuf = new Float32Array(kept.length * 16);
            kept.forEach((s, i) => writeMatrix(s, farBuf, i * 16));
            const f = makeMesh(farArch[archetype], `rockFar_${archetype}#${tile}`);
            f.thinInstanceSetBuffer("matrix", farBuf, 16, true);
            f.thinInstanceRefreshBoundingInfo(true);
            f.freezeWorldMatrix();
            far.push(f);
        }
        midMeshes.set(tile, mid);
        farMeshes.set(tile, far);
    }

    // ---- the near set, rebuilt as the walker moves --------------------------
    //
    // One mesh per archetype, sized once to the worst case the radius can hold
    // and then refilled in place. `thinInstanceCount` is what varies, so no
    // buffer is ever reallocated after this.
    const nearCap = Math.max(
        64,
        Math.ceil(Math.PI * NEAR_RADIUS * NEAR_RADIUS * 250 / archCount)
    );
    const nearMeshes = [];
    const nearBufs = [];
    for (let a = 0; a < archCount; a++) {
        const buf = new Float32Array(nearCap * 16);
        const m = makeMesh(nearArch[a], `rockNear_${a}`);
        m.thinInstanceSetBuffer("matrix", buf, 16, false);
        // Its bounds change on every rebuild and it is never bigger than
        // NEAR_RADIUS across, so refreshing them each time to let Babylon cull
        // it would cost more than the cull could ever return.
        m.alwaysSelectAsActiveMesh = true;
        nearBufs.push(buf);
        nearMeshes.push(m);
    }

    // Tile centres in WORLD space. Mapped through `shorePoint` because a tile's
    // middle in (arc, depth) is not its middle in x/z once the shore bends.
    const tileCenters = new Map();
    for (const tile of byTile.keys()) {
        const c = tile % cols;
        const r = (tile - c) / cols;
        tileCenters.set(tile, shorePoint(
            -SHORE_HALF_ARC + (c + 0.5) * TILE, (r + 0.5) * TILE
        ));
    }

    /** Tiles whose MID meshes are suppressed because the near set covers them. */
    let occupied = new Set();
    let lastX = Infinity;
    let lastZ = Infinity;
    /** Per tile: which ring is showing, so `setEnabled` is only called on change. */
    const ring = new Map();

    function rebuildNear(x, z) {
        const counts = new Array(archCount).fill(0);
        const nextOccupied = new Set();
        const r2 = NEAR_RADIUS * NEAR_RADIUS;

        // Only the tiles the radius can actually reach. At 3.5 m into 10 m
        // tiles that is between one and four of them.
        for (const [tile, c] of tileCenters) {
            const half = TILE * 0.5 + NEAR_RADIUS;
            if (Math.abs(c.x - x) > half + TILE || Math.abs(c.z - z) > half + TILE) continue;
            const arches = byTile.get(tile);
            if (!arches) continue;
            let touched = false;
            for (const [archetype, list] of arches) {
                for (const s of list) {
                    const dx = s.x - x;
                    const dz = s.z - z;
                    if (dx * dx + dz * dz > r2) continue;
                    const n = counts[archetype];
                    if (n >= nearCap) continue;   // budget, not correctness
                    writeMatrix(s, nearBufs[archetype], n * 16);
                    counts[archetype] = n + 1;
                    touched = true;
                }
            }
            if (touched) nextOccupied.add(tile);
        }

        for (let a = 0; a < archCount; a++) {
            const m = nearMeshes[a];
            if (counts[a] === 0) { m.setEnabled(false); continue; }
            m.thinInstanceCount = counts[a];
            m.thinInstanceBufferUpdated("matrix");
            m.setEnabled(true);
        }

        // A tile the near set has taken over must stop drawing its MID copy, or
        // every stone inside the radius is drawn twice — once detailed, once
        // not, z-fighting with itself.
        //
        // Only the stones within the radius are duplicated, not the whole tile,
        // so suppressing the tile outright loses the rest of it. That is the
        // trade taken here: at 3.5 m the near set covers the ground the eye is
        // actually on, and the tile beyond it is still drawn by the FAR ring.
        for (const tile of occupied) {
            if (!nextOccupied.has(tile)) ring.delete(tile);
        }
        occupied = nextOccupied;
    }

    function show(tile, want) {
        if (ring.get(tile) === want) return;
        ring.set(tile, want);
        for (const m of midMeshes.get(tile) ?? []) m.setEnabled(want === "mid");
        for (const m of farMeshes.get(tile) ?? []) m.setEnabled(want === "far");
    }

    const built = {
        stones,
        farStones,
        meshes: [...midMeshes.values(), ...farMeshes.values()]
            .reduce((n, l) => n + l.length, 0) + nearMeshes.length,
        tiles: cols * rows,
        nearCap,

        /**
         * Pick each tile's ring, and refresh the near set. Call once a frame
         * with the walker's position.
         */
        update(x, z) {
            if ((x - lastX) ** 2 + (z - lastZ) ** 2 >= REBUILD_STEP * REBUILD_STEP) {
                lastX = x;
                lastZ = z;
                rebuildNear(x, z);
            }
            // Half a tile of slack, so a tile whose centre is out of range but
            // whose near corner is not stays on.
            const slack = TILE * 0.71;
            for (const [tile, c] of tileCenters) {
                const d = Math.hypot(c.x - x, c.z - z);
                if (d > DRAW_DISTANCE + slack) show(tile, "off");
                else if (d > MID_DISTANCE + slack) show(tile, "far");
                else if (occupied.has(tile)) show(tile, "far");
                else show(tile, "mid");
            }
        },

        setEnabled(on) {
            for (const list of midMeshes.values()) for (const m of list) m.setEnabled(on);
            for (const list of farMeshes.values()) for (const m of list) m.setEnabled(on);
            for (const m of nearMeshes) m.setEnabled(on);
            if (!on) ring.clear();
        },
        dispose() {
            for (const list of midMeshes.values()) for (const m of list) m.dispose();
            for (const list of farMeshes.values()) for (const m of list) m.dispose();
            for (const m of nearMeshes) m.dispose();
        },
    };

    // Loud, because the quiet version of this failure is a beach that looks
    // exactly like a beach with no rocks on it.
    const uploaded = [...midMeshes.values()].flat()
        .reduce((n, m) => n + (m.thinInstanceCount ?? 0), 0);
    if (uploaded !== stones) {
        throw new Error(
            `shore rocks: placed ${stones} stones but the mid ring reports ` +
            `${uploaded} thin instances. If it is 0 or undefined, Babylon's ` +
            `thin-instance augmentation was tree-shaken out.`
        );
    }

    return built;
}
