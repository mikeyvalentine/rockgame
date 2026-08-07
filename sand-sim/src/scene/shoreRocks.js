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
 * The field runs several hundred stones per square metre at the back of the
 * strip. A level-2 stone is 320 triangles, so level 2 costs tens of thousands
 * of triangles per square metre — the whole level-2 budget is a couple of
 * square metres, a circle a metre or two across. No tile is that small, and a
 * tiling fine enough to be would have more meshes than stones.
 *
 * So the near ring is built from the player instead of from the grid:
 *
 *   NEAR   level 2, stones within `NEAR_RADIUS` of the walker. Rebuilt when
 *          they move `REBUILD_STEP`; and the only per-frame allocation in the
 *          file is avoiding it.
 *   MID    level 1, per tile, out to `MID_DISTANCE`.
 *   FAR    level 0, per tile, the whole rest of the strip — but only the
 *          biggest stones (`FAR_FRACTION`), because a small pebble is sub-pixel
 *          by fifteen metres and the field there is bound by how MANY stones
 *          there are, not how detailed each is. There is no distance cutoff:
 *          the strip is small enough to draw whole, which is what removed the
 *          tile-edged holes the old 40 m cutoff left out in the field.
 *
 * Near and mid share their stones, so where they overlap one must give way. The
 * first version of this switched a whole tile off the moment the near circle
 * touched it — which left a visible ring of near-bare ground between the circle
 * and the tile edge, the tile beyond it drawn full while the tile under your
 * feet showed only its far-ring quarter. The fix is finer than a whole tile:
 * when the near set covers part of a tile, exactly the covered stones are
 * removed from that tile's MID buffer (`setMidRemainder`), so the near ring
 * draws them at level 2 and the mid ring draws the rest of the same tile at
 * level 1 — no stone twice, no bare ring. It is recomputed every rebuild
 * because the circle slides as you cross a tile, and undone (`setMidFull`) the
 * moment the near set leaves.
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
 * so it cannot be frustum-culled — the half of it behind you is submitted every
 * frame regardless. That makes its cost the full circle, and at the field's
 * ~three-times density that circle is expensive: 1.5 m is already 1.4M
 * triangles up close. Wider would be prettier and is not affordable.
 */
export const NEAR_RADIUS = 1.5;

/** How far the walker moves before the near set is rebuilt, metres. */
export const REBUILD_STEP = 0.75;

/** Tile distance out to which the level-1 ring draws, metres. */
export const MID_DISTANCE = 4;

/**
 * No distance cutoff.
 *
 * There used to be one at 40 m, and it is what made the beach end in squares:
 * the strip runs 70 m along the shore, so from one end its far corner is well
 * past 40 m, and those tiles were simply switched off — a hard tile-edged
 * boundary out in the field, blinking as the player moved and tiles crossed the
 * threshold. The strip is small enough to draw whole. What bounds the cost is
 * not distance now but SIZE: the far ring keeps only the big stones (see
 * `FAR_FRACTION`), and frustum culling still drops everything behind you.
 */
export const DRAW_DISTANCE = Infinity;

/**
 * Fraction of the field's stones the far ring keeps — the biggest ones.
 *
 * The far ring used to keep every fourth stone at random, which cut triangles
 * but left a visible density step at the mid boundary and a field that thinned
 * uniformly rather than by size. Keeping the largest stones instead is both
 * cheaper to justify and truer: a 3 cm pebble is sub-pixel by fifteen metres
 * and genuinely vanishes, while the big cobbles stay legible to the back of the
 * strip. So the far field is the same big stones the mid ring drew, minus the
 * grit — no step, no holes, no popping, just detail shedding with distance.
 *
 * 0.22 keeps the largest ~22% of stones. It is still a reduction the eye should
 * not catch, because what it drops is exactly what has gone too small to see.
 */
export const FAR_FRACTION = 0.22;

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

    // Which archetypes survive into the far ring: the largest, taken in
    // descending size until their stones account for `FAR_FRACTION` of the
    // field. Each archetype is one fixed size, so "the biggest stones" is a set
    // of archetypes, and the far ring is those drawn whole — no random stride,
    // no density step. See `FAR_FRACTION`.
    const perArch = new Map();   // archetype -> { radius, count }
    for (const s of field) {
        const e = perArch.get(s.archetype);
        if (e) e.count++;
        else perArch.set(s.archetype, { radius: s.radius, count: 1 });
    }
    const farKept = new Set();
    {
        const bySize = [...perArch.entries()].sort((a, b) => b[1].radius - a[1].radius);
        const budget = field.length * FAR_FRACTION;
        let acc = 0;
        for (const [archetype, e] of bySize) {
            if (acc >= budget) break;
            farKept.add(archetype);
            acc += e.count;
        }
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

    // ---- the static rings ---------------------------------------------------
    //
    // MID starts holding every stone in the tile. When the near set covers part
    // of a tile, those stones are punched OUT of its mid buffer for as long as
    // it is covered (see `setMidRemainder`), so the near ring draws them at
    // level 2 and the mid ring draws the rest of the tile at level 1, with no
    // stone drawn twice and no hole where the near circle ends. That is why the
    // mid buffers are not static — they are rewritten as the walker moves.
    const midByTile = new Map();   // tile -> [{ mesh, buf, list }]
    const farMeshes = new Map();
    let stones = 0;
    let farStones = 0;

    for (const [tile, arches] of byTile) {
        const mid = [];
        const far = [];
        for (const [archetype, list] of arches) {
            stones += list.length;

            const buf = new Float32Array(list.length * 16);
            list.forEach((s, i) => writeMatrix(s, buf, i * 16));
            const m = makeMesh(midArch[archetype], `rockMid_${archetype}#${tile}`);
            m.thinInstanceSetBuffer("matrix", buf, 16, false);
            m.thinInstanceRefreshBoundingInfo(true);
            m.freezeWorldMatrix();
            mid.push({ mesh: m, buf, list });

            if (!farKept.has(archetype)) continue;   // too small to read at range
            const kept = list;
            farStones += kept.length;
            const farBuf = new Float32Array(kept.length * 16);
            kept.forEach((s, i) => writeMatrix(s, farBuf, i * 16));
            const f = makeMesh(farArch[archetype], `rockFar_${archetype}#${tile}`);
            f.thinInstanceSetBuffer("matrix", farBuf, 16, true);
            f.thinInstanceRefreshBoundingInfo(true);
            f.freezeWorldMatrix();
            far.push(f);
        }
        midByTile.set(tile, mid);
        farMeshes.set(tile, far);
    }

    // ---- the near set, rebuilt as the walker moves --------------------------
    //
    // One mesh per archetype, sized once to the worst case the radius can hold
    // and then refilled in place. `thinInstanceCount` is what varies, so no
    // buffer is ever reallocated after this.
    // Generous, because a near stone that overflows the cap now VANISHES: it is
    // punched out of its tile's mid buffer (it is inside the radius) but has no
    // slot in the near set, so it is drawn nowhere. The 600/m^2 ceiling against
    // a field that peaks near 140 is more than four times the mean, which no
    // single archetype's share of a 2 m circle can realistically reach.
    const nearCap = Math.max(
        96,
        Math.ceil(Math.PI * NEAR_RADIUS * NEAR_RADIUS * 600 / archCount)
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

    /** Tiles the near set currently covers, whose MID has near stones removed. */
    let occupied = new Set();
    let lastX = Infinity;
    let lastZ = Infinity;
    /** Per tile: which ring is showing, so `setEnabled` is only called on change. */
    const ring = new Map();
    const r2 = NEAR_RADIUS * NEAR_RADIUS;

    /** Rewrite a covered tile's MID to only the stones OUTSIDE the near radius. */
    function setMidRemainder(tile, x, z) {
        for (const info of midByTile.get(tile) ?? []) {
            let n = 0;
            for (const s of info.list) {
                const dx = s.x - x;
                const dz = s.z - z;
                if (dx * dx + dz * dz <= r2) continue;   // the near set draws it
                writeMatrix(s, info.buf, n * 16);
                n++;
            }
            info.mesh.thinInstanceCount = n;
            info.mesh.thinInstanceBufferUpdated("matrix");
        }
        // Bounds shrink slightly; not refreshed, so the mesh keeps the full
        // tile's bounds. That only ever over-includes it in the frustum, never
        // wrongly culls it.
    }

    /** Restore a tile's MID to its whole stone list, when the near set leaves. */
    function setMidFull(tile) {
        for (const info of midByTile.get(tile) ?? []) {
            info.list.forEach((s, i) => writeMatrix(s, info.buf, i * 16));
            info.mesh.thinInstanceCount = info.list.length;
            info.mesh.thinInstanceBufferUpdated("matrix");
        }
    }

    function rebuildNear(x, z) {
        const counts = new Array(archCount).fill(0);
        const nextOccupied = new Set();

        // Only the tiles the radius can actually reach.
        const reach = TILE * 1.5 + NEAR_RADIUS;
        for (const [tile, c] of tileCenters) {
            if (Math.abs(c.x - x) > reach || Math.abs(c.z - z) > reach) continue;
            const arches = byTile.get(tile);
            if (!arches) continue;
            let touched = false;
            for (const [archetype, list] of arches) {
                for (const s of list) {
                    const dx = s.x - x;
                    const dz = s.z - z;
                    if (dx * dx + dz * dz > r2) continue;
                    const n = counts[archetype];
                    if (n >= nearCap) continue;   // see nearCap: kept generous
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

        // Punch the near stones out of every covered tile's MID, and refill any
        // tile the near set has just left. Recomputed every rebuild, not only on
        // the transition, because the circle slides as the walker crosses a tile.
        for (const tile of nextOccupied) setMidRemainder(tile, x, z);
        for (const tile of occupied) {
            if (!nextOccupied.has(tile)) setMidFull(tile);
        }
        occupied = nextOccupied;
    }

    function show(tile, want) {
        if (ring.get(tile) === want) return;
        ring.set(tile, want);
        for (const info of midByTile.get(tile) ?? []) info.mesh.setEnabled(want === "mid");
        for (const m of farMeshes.get(tile) ?? []) m.setEnabled(want === "far");
    }

    const built = {
        stones,
        farStones,
        meshes: [...midByTile.values(), ...farMeshes.values()]
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
            // whose near corner is not stays at the finer ring.
            const slack = TILE * 0.71;
            for (const [tile, c] of tileCenters) {
                const d = Math.hypot(c.x - x, c.z - z);
                // No "off": the whole strip is always drawn (DRAW_DISTANCE is
                // Infinity), so the far ring is the floor, not a cutoff. Frustum
                // culling still drops whatever is behind you.
                if (d > DRAW_DISTANCE + slack) show(tile, "off");
                else if (d > MID_DISTANCE + slack) show(tile, "far");
                // Occupied tiles are within 2 m and so always fall here — they
                // draw MID, which is now holding the tile minus its near stones.
                else show(tile, "mid");
            }
        },

        setEnabled(on) {
            for (const list of midByTile.values()) for (const i of list) i.mesh.setEnabled(on);
            for (const list of farMeshes.values()) for (const m of list) m.setEnabled(on);
            for (const m of nearMeshes) m.setEnabled(on);
            if (!on) ring.clear();
        },
        dispose() {
            for (const list of midByTile.values()) for (const i of list) i.mesh.dispose();
            for (const list of farMeshes.values()) for (const m of list) m.dispose();
            for (const m of nearMeshes) m.dispose();
        },
    };

    // Loud, because the quiet version of this failure is a beach that looks
    // exactly like a beach with no rocks on it.
    const uploaded = [...midByTile.values()].flat()
        .reduce((n, i) => n + (i.mesh.thinInstanceCount ?? 0), 0);
    if (uploaded !== stones) {
        throw new Error(
            `shore rocks: placed ${stones} stones but the mid ring reports ` +
            `${uploaded} thin instances. If it is 0 or undefined, Babylon's ` +
            `thin-instance augmentation was tree-shaken out.`
        );
    }

    return built;
}
