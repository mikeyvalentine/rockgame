/**
 * The world beyond the sand — `public/assets/pond.0.glb`, the C4D pond
 * export: the surrounding landscape, the tree ring, boulders, deadfall and
 * shrubs, optimized by `tools/optimize-glb.mjs` (draco + webp + GPU
 * instancing).
 *
 * The glb IS the world; everything is inferred from it. Its `water` plane is
 * dropped (the game draws its own surface), and what remains splits in two:
 * the RING (trees, boulders, deadfall — every GPU-instanced prop, scattered
 * r=96..176 around the pond), left exactly as the artist placed it and only
 * re-seated in height onto the terrain (see `groundInstances`), and the pond
 * TERRAIN (the `Landscape` mesh, a basin with a shore) which is baked into the
 * height grid the world grounds on and returned as `.terrain`. The whole
 * environment hangs off one root with a live yaw dial (`S.envYaw`) and a
 * visibility toggle (`S.showWorldEnv`, `?env=0` skips the load entirely).
 *
 * Alignment is one translation — `worldEnvParams.js` has the measured facts
 * and `tools/env-glb-check.mjs` holds the file to them.
 *
 * Two things this deliberately does NOT do yet, both inherited from the
 * shore-rocks precedent and both waiting on a look at real hardware:
 *
 *  - No depth-prepass registration. Like the scattered stones, these meshes
 *    are invisible to TAA/DOF/shafts on the WebGPU path — the tree line may
 *    ghost or catch light shafts that belong to the sky.
 *  - No per-instance culling. EXT_mesh_gpu_instancing arrives as thin
 *    instances, and a thin-instanced mesh is culled by the union of its
 *    instances — the tree ring circles the pond, so it never leaves the
 *    frustum. The inspect puts the whole export at ~26 M rendered vertices;
 *    if that is what it costs on the floor machine, splitting the ring into
 *    arcs is the known fix (see siftingBeds' per-spot split).
 */

// Thin instances are an augmentation module: without this side-effect import
// every EXT_mesh_gpu_instancing buffer lands on a method that does not exist,
// nothing throws, and the forest just fails to appear (see pausedwork §2).
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { DracoCompression } from "@babylonjs/core/Meshes/Compression/dracoCompression";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";

import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { POND_CENTER_X, POND_CENTER_Z } from "../../../shared/worldBounds.js";
import { shoreProfileJS, WATER_LEVEL_Y } from "../terrain/beachParams.js";
import { bakeHeightGrid, makeHeightSampler } from "../../../shared/glbHeightfield.js";
import { S, onChange } from "../core/settings.js";
import { ENV_URL, ENV_OFFSET, DRACO_FILES } from "./worldEnvParams.js";

/**
 * The baked terrain grid's world extent, centred on the pond. 300 m covers the
 * ±100 m pond and the shore with margin; 512 cells is ~0.6 m/cell, ample for
 * grounding and for displacing the ground mesh. Heights outside the mesh clamp
 * to the nearest edge (hidden under the tree ring and the water).
 */
const TERRAIN_GRID_SIZE = 300;
const TERRAIN_GRID_RES = 512;

/**
 * How close to a prop counts as "in the treeline", metres. The player is walled
 * out within this of any trunk/boulder, and rocks are kept this clear of them,
 * so the dense ring reads as a solid edge to the sandy clearing.
 */
const TREE_CLEAR = 1.4;

/**
 * The sandy clearing the player is confined to and rocks spread on: sand that
 * is reachable on foot from the spawn without crossing water or the treeline,
 * capped at this radius so it stays "the spawn beach" rather than running off
 * along the shore. Flood-filled, so a gap between two trees does not leak the
 * player into the forest — the wall is the connected edge, not each trunk.
 */
const REACH_RADIUS = 35;
const REACH_CELL = 0.5;
/** Sand starts this far below the waterline (a little wade), metres. */
const REACH_WADE = 0.5;

let registered = false;

/**
 * Load the world export and hang it on the game's pond.
 *
 * @param {import("@babylonjs/core/scene").Scene} scene
 * @param {{ renderingGroupId?: number }} [opts]
 * @returns {Promise<{ root: TransformNode, meshes: number, instances: number,
 *                     setYaw(deg: number): void, dispose(): void }>}
 */
export async function buildWorldEnv(scene, opts = {}) {
    if (!registered) {
        registered = true;
        registerBuiltInLoaders();
        // Local decoder, not the CDN default — the repo pins its CDN URLs and
        // this one would be unpinned. The files ship in public/vendor/draco.
        DracoCompression.Configuration = {
            decoder: {
                wasmUrl: DRACO_FILES[0],
                wasmBinaryUrl: DRACO_FILES[1],
                fallbackUrl: DRACO_FILES[2],
            },
        };
    }

    const container = await LoadAssetContainerAsync(ENV_URL, scene);

    // The export's DCC camera (`RS Camera`) marks where the player should spawn
    // and which way they face. Capture its transform before disposing it — the
    // game supplies its own camera. Local here (nothing is parented yet); it is
    // turned into a world spawn once the root's offset+yaw exist, below.
    let camLocalPos = null, camLocalFwd = null;
    const cam0 = container.cameras[0];
    if (cam0) {
        // The node's TRS may sit on a parent transform, so `cam0.position` is
        // local (often 0,0,0) — read the resolved world matrix instead. This is
        // env-local (the export's own space); the root maps it to world below.
        cam0.computeWorldMatrix(true);
        camLocalPos = cam0.getWorldMatrix().getTranslation();
        camLocalFwd = cam0.getForwardRay(1).direction.clone();
    }
    for (const cam of [...container.cameras]) {
        container.cameras.splice(container.cameras.indexOf(cam), 1);
        cam.dispose();
    }
    let dropped = null;
    for (const mesh of container.meshes) {
        if (mesh.name === "water") dropped = mesh;
        mesh.name = "env:" + mesh.name;
    }
    if (dropped) {
        container.meshes.splice(container.meshes.indexOf(dropped), 1);
        dropped.dispose();
    }

    // The leaf cards carry their own alpha mask and alphaMode MASK now — the
    // C4D export flattened both onto black, and `tools/key-atlas-alpha.mjs`
    // put them back in the asset (see its header). So the glTF loader sets up
    // the alpha test on its own and nothing is forced here. The one thing the
    // loader will not infer is that a leaf card is two-sided — the export
    // authored single-sided cards, and a one-sided leaf vanishes when the
    // camera crosses its plane — so double-siding is set from the alpha mode
    // the asset now declares, no name matching required.
    for (const mat of container.materials) {
        if (!(mat instanceof PBRMaterial)) continue;
        if (mat.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHATEST) {
            mat.backFaceCulling = false;
        }
    }

    const root = new TransformNode("worldEnv", scene);
    root.position.set(ENV_OFFSET.x, ENV_OFFSET.y, ENV_OFFSET.z);
    const setYaw = (deg) => { root.rotation.y = (deg * Math.PI) / 180; };
    setYaw(S.envYaw);

    container.addAllToScene();
    for (const node of container.rootNodes) node.parent = root;

    // The player spawn, from the export's camera, put through the root's
    // offset+yaw so it lands in world space. Position feeds the walker's feet
    // (grounded on the terrain); the camera's horizontal heading becomes the
    // rig yaw (yaw 0 faces +Z, per FpsRig). Null if the export had no camera.
    let spawn = null;
    if (camLocalPos) {
        root.computeWorldMatrix(true);
        const wm = root.getWorldMatrix();
        const wp = Vector3.TransformCoordinates(camLocalPos, wm);
        const wd = Vector3.TransformNormal(camLocalFwd, wm);
        spawn = { x: wp.x, z: wp.z, yaw: Math.atan2(wd.x, wd.z) };
        console.log(`[worldEnv] spawn from camera: ${wp.x.toFixed(1)}, ${wp.z.toFixed(1)} ` +
            `yaw ${(spawn.yaw * 180 / Math.PI).toFixed(0)}°`);
    }

    // The authored pond terrain — the C4D Landscape: a pond basin (deepening
    // toward the middle) with a shore rising to the waterline around its rim.
    // (An earlier note here called it an island; that was a bad measurement —
    // a max-height triangle walk latched onto the noisy cavity geometry at the
    // centre and misread the bowl as a peak. Corrected 2026-08-07.)
    //
    // Off by DEFAULT for a different reason than being wrong: the world still
    // grounds the player on the PROCEDURAL beach (shoreProfileJS / the height
    // bake), and drawing this mesh on top of it double-terrains the shore and
    // z-fights. Turning it on is really the decision to make the authored
    // terrain the world's ground — which means porting walking / sand
    // deformation / sifting onto its heightfield — so it stays a dial until
    // that reconciliation happens.
    const landscape = container.meshes.find((m) => m.name === "env:Landscape");

    // Bake the authored terrain into the height grid the world grounds on. The
    // baked grid IS the ground: the app displaces its ground mesh from this and
    // the character walks it, so the raw Landscape mesh is left disabled (the
    // `GLB terrain` dial re-shows it as a debug overlay). Vertices are read
    // through Babylon (correct de-interleave) and transformed to world by the
    // mesh's own matrix, so the yaw and offset are baked in.
    let ground = null;
    if (landscape) {
        ground = bakeTerrain(landscape);
        landscape.setEnabled(S.showEnvIsland);
        onChange("showEnvIsland", (v) => landscape.setEnabled(v));
    }
    // Trees stand on the baked terrain, not the procedural profile — so the
    // ring rises and falls with the authored ground and a re-export moves it.
    const groundHeightAt = ground ? ground.heightAt : (x, z) => shoreProfileJS(x, z, 1);

    const group = opts.renderingGroupId ?? 0;
    let instances = 0;
    // Every instanced prop's world (x,z) — the ring of trees/boulders/shrubs.
    // Collected here so the game can wall the player out of the treeline and
    // keep rocks on the open sand, both inferred from the glb rather than a
    // hardcoded shape.
    const propXZ = [];
    for (const mesh of container.meshes) {
        mesh.renderingGroupId = group;
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        // COLOR_0 on these meshes is not colour: its per-channel range tracks
        // each mesh's own position bounds (the C4D tree rig bakes positional/
        // wind data into the vertex-colour channel). Multiplied in as albedo
        // it is negative-and-huge garbage that reads as black foliage. Left
        // in the geometry — it is probably the wind rig, and docs/01 wants
        // swaying trees eventually — just not shaded with.
        mesh.useVertexColors = false;
        if (mesh.thinInstanceCount > 0) {
            groundInstances(mesh, groundHeightAt, propXZ);
            instances += mesh.thinInstanceCount;
        } else {
            instances += 1;
        }
    }

    // Spatial hash of the prop ring, for O(1) "is (x,z) up against the trees?"
    // queries. Cell = clearance radius, so a query only looks at 3x3 cells.
    const treeHash = buildPropHash(propXZ, TREE_CLEAR);
    const blockedByTree = (x, z) => propHashHit(treeHash, propXZ, x, z);

    // The reachable sandy clearing (flood-filled from the spawn). Needs the
    // spawn + the ground + the tree wall, all of which exist by here.
    const clearing = (spawn && ground)
        ? buildReachable(spawn, ground.heightAt, blockedByTree)
        : null;
    // The post-condition the sifting beds earned: a missing augmentation or a
    // silently dropped buffer shows up here as a count, not as an empty world.
    if (instances <= container.meshes.length) {
        console.warn(
            "[worldEnv] no thin instances arrived — the forest is probably missing"
        );
    }

    root.setEnabled(S.showWorldEnv);
    onChange("showWorldEnv", (v) => root.setEnabled(v));
    onChange("envYaw", setYaw);

    return {
        root,
        meshes: container.meshes.length,
        instances,
        // The baked ground: `{ heightAt, normalAt, min, max }`, or null when the
        // export carried no Landscape (`?env=0`, or a stripped glb). The app
        // uses this as the world's terrain when present.
        terrain: ground,
        // `{ x, z, yaw }` from the export's camera, or null. Where the player
        // spawns and which way they face.
        spawn,
        // True where (x,z) is within TREE_CLEAR of a prop — the raw treeline.
        blockedByTree,
        // The reachable sandy clearing: `{ contains(x,z), grid, origin, cell,
        // res }`, or null with no spawn/terrain. The walk bound confines the
        // player to it; the rocks spread across it.
        clearing,
        setYaw,
        dispose() { container.dispose(); root.dispose(); },
    };
}

/**
 * Bake the Landscape mesh into the height grid + sampler the world grounds on.
 * @param {import("@babylonjs/core/Meshes/mesh").Mesh} mesh (parented, so its
 *   world matrix carries ENV_OFFSET and the yaw)
 */
function bakeTerrain(mesh) {
    mesh.computeWorldMatrix(true);
    const wm = mesh.getWorldMatrix();
    const local = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    // World-space positions (Babylon de-interleaves getVerticesData for us).
    const world = new Float32Array(local.length);
    const v = new Vector3();
    for (let i = 0; i < local.length; i += 3) {
        Vector3.TransformCoordinatesFromFloatsToRef(local[i], local[i + 1], local[i + 2], wm, v);
        world[i] = v.x; world[i + 1] = v.y; world[i + 2] = v.z;
    }
    const baked = bakeHeightGrid({
        positions: world, indices,
        origin: { x: POND_CENTER_X - TERRAIN_GRID_SIZE / 2, z: POND_CENTER_Z - TERRAIN_GRID_SIZE / 2 },
        size: TERRAIN_GRID_SIZE, res: TERRAIN_GRID_RES,
        // Below the real basin (~-13 m) and above the shore (~+2.5 m); only a
        // wild spike would hit these.
        clampLo: -20, clampHi: 30,
    });
    const sampler = makeHeightSampler(baked);
    sampler.min = baked.min;
    sampler.max = baked.max;
    // The raw grid + its world mapping, so the water shader can sample terrain
    // height per pixel and end its foam/shallows on the real (irregular) shore
    // instead of an idealised circle.
    sampler.grid = baked.grid;
    sampler.gridRes = baked.res;
    sampler.gridOrigin = baked.origin;
    sampler.gridSize = baked.size;
    console.log(`[worldEnv] terrain baked ${baked.res}² over ${TERRAIN_GRID_SIZE} m: ` +
        `${baked.min.toFixed(1)}..${baked.max.toFixed(1)} m`);
    return sampler;
}

/** Seat props a hair into the sand rather than tangent to it. */
const SETTLE = 0.04;

/**
 * Re-seat an instanced prop family's feet on the world's ground.
 *
 * Nothing is dropped. The glb IS the world, so the tree ring is the artist's
 * placement and stays exactly as authored in plan; only the HEIGHT is set —
 * onto `heightAt`, the terrain baked from this same export — so feet meet the
 * ground the player actually walks, and a re-export moves both together.
 *
 * (An earlier version deleted ~217 trees that fell inside a fixed 70 m walkable
 * arc, to clear a beach. That arc was placeholder scaffolding and cut a visible
 * gap in the ring; the walkable/rock area is inferred from the glb now, not
 * carved out of the forest. Removed.)
 *
 * @param {import("@babylonjs/core/Meshes/mesh").Mesh} mesh
 * @param {(x:number,z:number)=>number} heightAt  the world's ground
 * @param {number[]} collect  world (x,z) pairs are pushed here per instance
 */
function groundInstances(mesh, heightAt, collect) {
    const world = mesh.computeWorldMatrix(true);
    const inv = world.clone().invert();
    const src = mesh.thinInstanceGetWorldMatrices();

    const p = new Vector3();
    for (const m of src) {
        m.getTranslationToRef(p);
        Vector3.TransformCoordinatesToRef(p, world, p);
        collect.push(p.x, p.z);            // world footprint, for the tree wall
        p.y = heightAt(p.x, p.z) - SETTLE;
        Vector3.TransformCoordinatesToRef(p, inv, p);
        m.setTranslation(p);
    }

    const data = new Float32Array(src.length * 16);
    src.forEach((m, i) => m.copyToArray(data, i * 16));
    mesh.thinInstanceSetBuffer("matrix", data, 16, true);
    mesh.thinInstanceRefreshBoundingInfo();
}

// ------------------------------------------------------------ the clearing

/**
 * Flood-fill the sandy clearing the player spawns in: cells that are above the
 * waterline, clear of the treeline, within REACH_RADIUS of the spawn, and
 * connected to the spawn on foot. The flood is what makes the treeline a hard
 * edge — a gap between trunks that leads nowhere is not reachable, so it is not
 * walkable, and rocks do not spill through it either.
 *
 * @param {{x:number,z:number}} spawn
 * @param {(x:number,z:number)=>number} heightAt
 * @param {(x:number,z:number)=>boolean} blocked  in the treeline
 */
function buildReachable(spawn, heightAt, blocked) {
    const size = (REACH_RADIUS + 3) * 2;
    const res = Math.ceil(size / REACH_CELL);
    const origin = { x: spawn.x - size / 2, z: spawn.z - size / 2 };
    const r2 = REACH_RADIUS * REACH_RADIUS;

    // Candidate sand: in radius, above water, not in the trees.
    const sand = new Uint8Array(res * res);
    for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
            const x = origin.x + (i + 0.5) * REACH_CELL;
            const z = origin.z + (j + 0.5) * REACH_CELL;
            const dx = x - spawn.x, dz = z - spawn.z;
            if (dx * dx + dz * dz > r2) continue;
            if (heightAt(x, z) < WATER_LEVEL_Y - REACH_WADE) continue;
            if (blocked(x, z)) continue;
            sand[j * res + i] = 1;
        }
    }

    // BFS from the spawn cell (nearest sand cell if the spawn itself grazes an
    // edge), 4-connected.
    const reach = new Uint8Array(res * res);
    let si = Math.floor((spawn.x - origin.x) / REACH_CELL);
    let sj = Math.floor((spawn.z - origin.z) / REACH_CELL);
    if (!sand[sj * res + si]) {
        let best = -1, bestD = Infinity;
        for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
            if (!sand[j * res + i]) continue;
            const d = (i - si) ** 2 + (j - sj) ** 2;
            if (d < bestD) { bestD = d; best = j * res + i; }
        }
        if (best < 0) return { contains: () => false, grid: reach, origin, cell: REACH_CELL, res };
        si = best % res; sj = (best - si) / res;
    }
    const queue = [sj * res + si];
    reach[sj * res + si] = 1;
    for (let head = 0; head < queue.length; head++) {
        const idx = queue[head];
        const ci = idx % res, cj = (idx - ci) / res;
        const nb = [idx + 1, idx - 1, idx + res, idx - res];
        const ok = [ci < res - 1, ci > 0, cj < res - 1, cj > 0];
        for (let k = 0; k < 4; k++) {
            if (!ok[k]) continue;
            const n = nb[k];
            if (sand[n] && !reach[n]) { reach[n] = 1; queue.push(n); }
        }
    }

    return {
        grid: reach, origin, cell: REACH_CELL, res,
        contains(x, z) {
            const i = Math.floor((x - origin.x) / REACH_CELL);
            const j = Math.floor((z - origin.z) / REACH_CELL);
            if (i < 0 || j < 0 || i >= res || j >= res) return false;
            return reach[j * res + i] === 1;
        },
    };
}

// --------------------------------------------------------------- tree wall

/**
 * Bucket prop (x,z) into a grid keyed by cell, cell size = the clearance
 * radius. A point's neighbourhood is then just its own cell and the eight
 * around it, so a hit test never scans more than a handful of props.
 * @param {number[]} xz  flat [x0,z0, x1,z1, ...] world positions
 * @param {number} cell  metres per cell (= TREE_CLEAR)
 */
function buildPropHash(xz, cell) {
    const grid = new Map();
    for (let i = 0; i < xz.length; i += 2) {
        const key = ((xz[i] / cell) | 0) + "," + ((xz[i + 1] / cell) | 0);
        let bucket = grid.get(key);
        if (!bucket) grid.set(key, (bucket = []));
        bucket.push(i);
    }
    return { grid, cell };
}

/** True if (x,z) is within `cell` (TREE_CLEAR) of any prop in the hash. */
function propHashHit({ grid, cell }, xz, x, z) {
    const cx = (x / cell) | 0;
    const cz = (z / cell) | 0;
    const r2 = cell * cell;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
            const bucket = grid.get(gx + "," + gz);
            if (!bucket) continue;
            for (const i of bucket) {
                const dx = xz[i] - x;
                const dz = xz[i + 1] - z;
                if (dx * dx + dz * dz < r2) return true;
            }
        }
    }
    return false;
}
