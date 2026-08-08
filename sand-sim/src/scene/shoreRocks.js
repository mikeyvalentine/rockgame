/**
 * The shore's rocks, drawn.
 *
 * `shared/shoreScatter.js` decides where every stone is; this puts them on
 * screen. It is the four sifting beds' drawing code generalised from "four
 * patches of 620" to a hundred thousand across the whole strip, and it inherits
 * that code's one hard-won rule about how to split the meshes up.
 *
 * Two layers, after the ring system tanked the frame rate
 * --------------------------------------------------------
 * The previous build was three thin-instance rings (near/mid/far) split per
 * (archetype, tile) — thousands of meshes, thousands of draw calls, a rebuild
 * every step, and either stones popping (far ring dropped 3 of 4) or, with the
 * drop removed, millions of triangles. The premise needs a HUGE number of
 * stones (more than the player could ever inspect) but none of them need
 * physics — only pickup later — so the drawing is now:
 *
 *   CARPET  every stone, always. ONE frozen mesh for the whole field: a
 *           4-triangle vertex-coloured dome per stone, tinted from the
 *           archetype's own vertex colours so it matches the real rock that
 *           replaces it up close. One draw call, ~10 bytes of GPU work per
 *           stone, never rebuilt, never culled, never pops.
 *   MID     real forge geometry (level 1, 80 tris) as thin instances per
 *           (archetype, tile), enabled only within MID_DISTANCE of the walker.
 *           This is the layer the eye actually inspects; beyond it a 6 cm
 *           stone is a few pixels and the dome underneath carries it.
 *
 * A stone therefore only ever changes SHAPE with distance (dome <-> forge
 * geometry), never existence — which is the whole cure for the walk-popping.
 *
 * Geometry is copied per mesh, not cloned: `thinInstanceSetBuffer` stores the
 * matrix buffer on the *Geometry*, and clones share geometry. `siftingBeds.js`
 * has the long version of that note; it cost a day there.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
// Side-effect import: `thinInstanceSetBuffer` is an augmentation of Mesh and
// the tree-shaken build drops it unless the module is pulled in by hand.
// Without it every call below is a no-op on `undefined`, nothing throws, and
// the beach is simply empty.
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";

import { createBedArchetypes, castSequence } from "./siftingBeds.js";
import { createBedMaterials } from "./rockMaterials.js";
import { scatterShore } from "../../../shared/shoreScatter.js";

/**
 * Icosphere level for the detail ring: 80 triangles. The beds draw at level 3
 * (1280) because the player is crouched 30 cm away with a hand in them; a
 * standing eye is never closer than ~1.5 m, where 80 reads fine.
 */
export const MID_LOD = 1;

/**
 * Tile edge, metres. Culling granularity for the detail ring: a tile is either
 * wholly in the ring or wholly out.
 */
export const TILE = 6;

/**
 * Tile distance out to which the detail ring draws, metres. Beyond it a stone
 * is carried by the carpet alone — a change of SHAPE, never of existence.
 * The detail ring's cost is quadratic in this (area x density x 80 tris), so
 * it is the first dial to turn if the frame is over budget.
 */
export const MID_DISTANCE = 8;

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
    // No clearing (no glb / `?env=0`) means no beach to spread on — the field
    // is inferred entirely from the glb now, so there is nothing to build.
    if (!opts.clearing) {
        console.warn("[sand-sim] no clearing — shore rocks skipped");
        return emptyRocks();
    }
    const { byFamily, photo, notes } = await createBedMaterials(scene, {
        forge: opts.forgeMaterial !== false,
    });
    if (notes.length) console.info("[sand-sim] rock surfaces:", notes.join("; "));

    // One archetype set, at the detail ring's level (`?lod=` overrides). The
    // carpet lifts its tints from these same archetypes, so a dome matches the
    // rock that replaces it up close.
    const midArch = createBedArchetypes(
        scene, { ...opts, lod: opts.lod ?? MID_LOD }, byFamily, photo
    );
    const archCount = midArch.length;

    // The clearing (worldEnv) bounds the field: rocks only on reachable sand
    // around the spawn, densest near the water, none in the water or trees.
    const clearing = opts.clearing;
    const cast = castSequence(opts);
    const field = scatterShore({
        seed: opts.seed,
        density: opts.density,
        cast,
        heightAt: (x, z) => terrain.heightAt(x, z),
        waterLevel: opts.waterLevel ?? 0,
        clearing,
    });

    /** Lazy: the high-LOD archetype set the inspect view holds up close. */
    let examineArch = null;

    // Tiled in world x/z over the clearing's bounding box (the field is a real
    // patch of sand now, not a curved strip). One tile is either wholly in a
    // ring or wholly out, so tiling is only for culling granularity.
    const originX = clearing.origin.x;
    const originZ = clearing.origin.z;
    const span = clearing.res * clearing.cell;
    const cols = Math.ceil(span / TILE);
    const rows = Math.ceil(span / TILE);

    /** tile -> archetype -> stones. Kept, because the near set re-reads it. */
    const byTile = new Map();
    for (const s of field) {
        const c = Math.min(cols - 1, Math.max(0, Math.floor((s.x - originX) / TILE)));
        const r = Math.min(rows - 1, Math.max(0, Math.floor((s.z - originZ) / TILE)));
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

    // ---- the carpet: every stone, one frozen mesh, always on ----------------
    const carpet = buildCarpet(scene, field, midArch, group);

    // ---- the detail ring: real geometry per (archetype, tile) ---------------
    const midMeshes = new Map();   // tile -> Mesh[]
    let stones = 0;

    for (const [tile, arches] of byTile) {
        const mid = [];
        for (const [archetype, list] of arches) {
            stones += list.length;
            const midBuf = new Float32Array(list.length * 16);
            list.forEach((s, i) => writeMatrix(s, midBuf, i * 16));
            const m = makeMesh(midArch[archetype], `rockMid_${archetype}#${tile}`);
            m.thinInstanceSetBuffer("matrix", midBuf, 16, true);
            m.thinInstanceRefreshBoundingInfo(true);
            m.freezeWorldMatrix();
            mid.push(m);
        }
        midMeshes.set(tile, mid);
    }

    // Tile centres in world x/z — the tiling is a plain x/z grid now.
    const tileCenters = new Map();
    for (const tile of byTile.keys()) {
        const c = tile % cols;
        const r = (tile - c) / cols;
        tileCenters.set(tile, {
            x: originX + (c + 0.5) * TILE,
            z: originZ + (r + 0.5) * TILE,
        });
    }

    /** Per tile: whether the detail ring is showing, so `setEnabled` is only
     *  called on change. */
    const ring = new Map();

    function show(tile, want) {
        if (ring.get(tile) === want) return;
        ring.set(tile, want);
        for (const m of midMeshes.get(tile) ?? []) m.setEnabled(want);
    }

    const built = {
        stones,
        meshes: [...midMeshes.values()].reduce((n, l) => n + l.length, 0) + 1,
        tiles: cols * rows,

        /**
         * Enable the detail ring around the walker. Call once a frame with the
         * walker's position. The carpet needs no update — it is always on.
         */
        update(x, z) {
            // Half a tile of slack, so a tile whose centre is out of range but
            // whose near corner is not stays detailed.
            const slack = TILE * 0.71;
            for (const [tile, c] of tileCenters) {
                const d = Math.hypot(c.x - x, c.z - z);
                show(tile, d <= MID_DISTANCE + slack);
            }
        },

        /**
         * The stone nearest the centre-screen ray, within `reach` metres, or
         * null. Only the tiles the ray crosses are scanned, so this is cheap
         * enough to run on a key press without a physics engine.
         */
        pickAlongRay(ox, oy, oz, dx, dy, dz, reach) {
            let best = null;
            let bestT = reach;
            const seen = new Set();
            for (let t = 0; t <= reach; t += TILE * 0.5) {
                const c0 = Math.floor((ox + dx * t - originX) / TILE);
                const r0 = Math.floor((oz + dz * t - originZ) / TILE);
                for (let r = r0 - 1; r <= r0 + 1; r++) {
                    for (let c = c0 - 1; c <= c0 + 1; c++) {
                        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
                        const tile = r * cols + c;
                        if (seen.has(tile)) continue;
                        seen.add(tile);
                        const arches = byTile.get(tile);
                        if (!arches) continue;
                        for (const [archetype, list] of arches) {
                            for (const s of list) {
                                // Closest approach of the ray to the centre.
                                const px = s.x - ox, py = s.y - oy, pz = s.z - oz;
                                const along = px * dx + py * dy + pz * dz;
                                if (along < 0.25 || along > bestT) continue;
                                const qx = px - dx * along;
                                const qy = py - dy * along;
                                const qz = pz - dz * along;
                                // A forgiving hit radius: a 6 cm pebble is a
                                // small target from standing height.
                                const hit = Math.max(s.radius * 1.35, 0.05);
                                if (qx * qx + qy * qy + qz * qz > hit * hit) continue;
                                best = { stone: s, archetype };
                                bestT = along;
                            }
                        }
                    }
                }
            }
            return best;
        },

        /**
         * The archetype at inspect fidelity (level 3, 1280 tris — the bed
         * crouch's own LOD). Built lazily, once, on the first inspect.
         */
        examineData(archetype) {
            if (!examineArch) {
                examineArch = createBedArchetypes(
                    scene, { ...opts, lod: 3 }, byFamily, photo
                );
                for (const a of examineArch) a.mesh?.setEnabled(false);
            }
            const a = examineArch[archetype];
            return {
                vertexData: a.vertexData, material: a.material,
                family: a.family, name: a.name, sizeMetres: a.sizeMetres,
                shape: cast[archetype]?.shape,
            };
        },

        setEnabled(on) {
            for (const list of midMeshes.values()) for (const m of list) m.setEnabled(on);
            carpet.setEnabled(on);
            if (!on) ring.clear();
        },
        dispose() {
            for (const list of midMeshes.values()) for (const m of list) m.dispose();
            carpet.dispose();
            if (examineArch) for (const a of examineArch) a.mesh?.dispose();
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

/**
 * The carpet: every stone in the field as a 4-triangle dome, one frozen mesh.
 *
 * ~520k triangles for a 130k-stone field, in ONE draw call with no per-frame
 * work at all — against the ring system's thousands of draw calls this is what
 * buys the premise ("more stones than the player could ever inspect") back its
 * frame rate. Each dome is tinted from its archetype's real vertex colours and
 * sized to tuck inside the forge geometry that replaces it up close, so the
 * handoff at MID_DISTANCE is a change of silhouette, not of colour or place.
 */
function buildCarpet(scene, field, archetypes, group) {
    const n = field.length;
    const positions = new Float32Array(n * 5 * 3);
    const normals = new Float32Array(n * 5 * 3);
    const colors = new Float32Array(n * 5 * 4);
    const indices = new Uint32Array(n * 4 * 3);

    // One representative tint per archetype, lifted from the real stone's own
    // vertex colours so the dome matches the rock it stands in for.
    const tints = archetypes.map((a) => {
        const c = a.vertexData?.colors;
        return c && c.length >= 3 ? [c[0], c[1], c[2]] : [0.55, 0.55, 0.55];
    });

    const SIDE = 0.62; // base normals: mostly outward, a little up
    for (let i = 0; i < n; i++) {
        const s = field[i];
        const r = s.radius * 0.85;
        const h = s.radius * 0.8;
        const t = tints[s.archetype];
        const vo = i * 5;
        const po = vo * 3;
        const co = vo * 4;
        const io = i * 12;

        for (let k = 0; k < 4; k++) {
            // The square base spun by the stone's own yaw, so the field does
            // not read as a grid of axis-aligned diamonds.
            const ang = s.yaw + k * (Math.PI / 2);
            const dx = Math.cos(ang);
            const dz = Math.sin(ang);
            positions[po + k * 3] = s.x + dx * r;
            positions[po + k * 3 + 1] = s.y;
            positions[po + k * 3 + 2] = s.z + dz * r;
            const inv = 1 / Math.hypot(dx, SIDE, dz);
            normals[po + k * 3] = dx * inv;
            normals[po + k * 3 + 1] = SIDE * inv;
            normals[po + k * 3 + 2] = dz * inv;
        }
        positions[po + 12] = s.x;
        positions[po + 13] = s.y + h;
        positions[po + 14] = s.z;
        normals[po + 12] = 0;
        normals[po + 13] = 1;
        normals[po + 14] = 0;

        for (let k = 0; k < 5; k++) {
            colors[co + k * 4] = t[0];
            colors[co + k * 4 + 1] = t[1];
            colors[co + k * 4 + 2] = t[2];
            colors[co + k * 4 + 3] = 1;
        }
        for (let k = 0; k < 4; k++) {
            indices[io + k * 3] = vo + k;
            indices[io + k * 3 + 1] = vo + ((k + 1) % 4);
            indices[io + k * 3 + 2] = vo + 4;
        }
    }

    const vd = new VertexData();
    vd.positions = positions;
    vd.normals = normals;
    vd.colors = colors;
    vd.indices = indices;
    const mesh = new Mesh("rockCarpet", scene);
    vd.applyToMesh(mesh, false);

    const mat = new PBRMaterial("rockCarpet", scene);
    mat.roughness = 0.95;
    mat.metallic = 0;
    mat.environmentIntensity = 0.7;
    // Winding varies with each stone's yaw; two-sided costs nothing measurable
    // on unlit-sized fragments and removes the whole question.
    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.renderingGroupId = group;
    // One mesh spanning the whole field: culling it is all-or-nothing anyway,
    // so skip the bounds evaluation and just draw it.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
    return mesh;
}

/** The no-op field, returned when there is no clearing to spread on. */
function emptyRocks() {
    return {
        stones: 0, meshes: 0, tiles: 0,
        update() {}, setEnabled() {}, dispose() {},
    };
}
