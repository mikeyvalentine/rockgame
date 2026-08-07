/**
 * The world beyond the sand — `public/assets/pond.0.glb`, the C4D pond
 * export: the surrounding landscape, the tree ring, boulders, deadfall and
 * shrubs, optimized by `tools/optimize-glb.mjs` (draco + webp + GPU
 * instancing).
 *
 * Scenery only. The character grounds on the procedural heightfield and the
 * game draws its own water disc, so the export's `water` plane is dropped
 * here. What remains splits in two: the RING (trees, boulders, deadfall —
 * every GPU-instanced prop, all of it scattered r=96..176 around the pond),
 * which is re-grounded onto the game's own terrain and cleared off the
 * walkable strip (see `groundInstances`), and the ISLAND (the `Landscape`
 * mesh — see the note at its dial). The whole environment hangs off one root
 * with a live yaw dial (`S.envYaw`) and a visibility toggle
 * (`S.showWorldEnv`, `?env=0` skips the load entirely).
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

import { shoreDistance, shoreArc, SHORE_HALF_ARC, SHORE_DEPTH, WADE_DEPTH }
    from "../../../shared/worldBounds.js";
import { shoreProfileJS } from "../terrain/beachParams.js";
import { S, onChange } from "../core/settings.js";
import { ENV_URL, ENV_OFFSET, DRACO_FILES } from "./worldEnvParams.js";

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

    // The export carries its own water plane and a DCC camera; the game has
    // both already. Name everything else out of the global namespace — the
    // scene's real water mesh is also called "water".
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

    // The island. The export's landscape mesh is not a shore around the pond
    // — it is a wooded island IN it (measured: the mesh only has surface
    // within ~r<80, the pond floor and the ring under the forest are holes).
    // An island in the middle of the skip lane is level design, which the
    // pillars forbid — so it ships behind a dial, off by default, and whether
    // it stays is decided by looking at it (and at a thrown stone) in engine.
    const island = container.meshes.find((m) => m.name === "env:Landscape");
    if (island) {
        island.setEnabled(S.showEnvIsland);
        onChange("showEnvIsland", (v) => island.setEnabled(v));
    }

    const group = opts.renderingGroupId ?? 0;
    let instances = 0;
    let cleared = 0;
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
            cleared += groundInstances(mesh);
            instances += mesh.thinInstanceCount;
        } else {
            instances += 1;
        }
    }
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
        cleared,
        setYaw,
        dispose() { container.dispose(); root.dispose(); },
    };
}

/** Clearance around the walkable strip before a prop may stand, metres. */
const BEACH_MARGIN = 3;

/** Seat props a hair into the sand rather than tangent to it. */
const SETTLE = 0.04;

/**
 * Re-ground one instanced prop family: drop every instance standing on the
 * walkable beach, and set the survivors' feet on the game's own terrain.
 *
 * Both are load-time corrections, not art dials. The export scattered its
 * ring uniformly — 217 instances stand inside the strip the player walks and
 * sifts (measured; no yaw avoids it, the ring has no clear arc). And the
 * ground the ring was scattered ON was not exported, so instance heights are
 * relative to terrain that does not exist here; the game's shore profile is
 * the only ground there is. `shoreProfileJS` rather than `terrain.heightAt`
 * so both renderers seat the feet identically, and because the ring reaches
 * past the WebGPU bake's extent where the analytic profile keeps going.
 *
 * Baked against the yaw at load, like the rock field is against its density
 * dial: moving `envYaw` afterwards spins the surround but does not re-derive
 * the clearing — it is a reload knob for placement, a live one for looking.
 *
 * @param {import("@babylonjs/core/Meshes/mesh").Mesh} mesh
 * @returns {number} instances dropped from the beach
 */
function groundInstances(mesh) {
    const world = mesh.computeWorldMatrix(true);
    const inv = world.clone().invert();
    const src = mesh.thinInstanceGetWorldMatrices();

    const kept = [];
    const p = new Vector3();
    for (const m of src) {
        m.getTranslationToRef(p);
        Vector3.TransformCoordinatesToRef(p, world, p);
        const d = shoreDistance(p.x, p.z);
        const arc = shoreArc(p.x, p.z);
        if (
            d > -WADE_DEPTH - BEACH_MARGIN && d < SHORE_DEPTH + BEACH_MARGIN &&
            Math.abs(arc) < SHORE_HALF_ARC + BEACH_MARGIN
        ) continue;

        p.y = shoreProfileJS(p.x, p.z, 1) - SETTLE;
        Vector3.TransformCoordinatesToRef(p, inv, p);
        m.setTranslation(p);
        kept.push(m);
    }

    if (kept.length !== src.length || kept.length) {
        const data = new Float32Array(kept.length * 16);
        kept.forEach((m, i) => m.copyToArray(data, i * 16));
        mesh.thinInstanceSetBuffer("matrix", data, 16, true);
        mesh.thinInstanceRefreshBoundingInfo();
    }
    return src.length - kept.length;
}
