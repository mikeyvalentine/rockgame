/**
 * The bed as physics, in the beach's own scene, at 1:1 metres.
 *
 * This replaces the scene-swap the crouch used to do. A separate sift scene met
 * none of what the crouch actually has to be: the transition was a load rather
 * than a camera move, the bed stood on rock-sift's own ground instead of the
 * beach, and nothing a stone did could reach the sand. All three come back if
 * the bed simply wakes up where it already is.
 *
 * Why 1:1 works
 * -------------
 * rock-sift models at 4x because, in its words, that "keeps the stones well
 * clear of Havok's collision margins". Living in the beach's scene means
 * metres, so that had to be tested rather than assumed. Running rock-sift's own
 * suite with `U = 1`:
 *
 *   sweeping does not throw the bed around   ok
 *   lifting a stone does not pop neighbours  ok
 *   stones dropped in the bucket stay in it  ok
 *   stones face outwards                     ok
 *   settling a POURED bed                    6 stones still creeping (~0 at 4x)
 *
 * The two hardest interaction tests pass. The one failure is the pour, which
 * never happens in play — the game restores baked beds, and pouring is what
 * `npm run bake` does offline, still at 4x. A restored bed left awake for 8 s
 * drifted 172 mm at 1:1 against 153 mm at 4x, with nothing sinking at either.
 *
 * So the 4x world is a bake-time convenience, not a runtime requirement.
 *
 * Why there is no loading
 * -----------------------
 * Everything expensive happens while the beach loads: Havok's wasm, and one
 * convex hull per archetype. Crouching then costs only the swap — rock-sift
 * measures 540 bodies at ~28 ms — which fits inside a frame or two of the
 * camera move. `rock-sift/src/shore.js` already said as much about its own
 * swap: "comfortably inside one frame of a transition that lasts about a
 * second, so there is nothing to hide behind a loading screen."
 *
 * The ground
 * ----------
 * One static box with its top face exactly at the crown height — which is
 * *exact*, not approximate, because the pile levels its own crown into a true
 * horizontal plane (`shared/pileField.js`). rock-sift learned this the hard
 * way and its note is worth repeating: a trimesh following the sand leaves
 * convex hulls catching on the internal edges between triangles, and the bed
 * never comes to rest. A box has no internal edges and is exact for flat
 * ground.
 */

// Side-effect import: `scene.enablePhysics` / `getPhysicsEngine` are an
// augmentation of Scene, not part of it, and the tree-shaken ES6 build drops
// them. Without this `enablePhysics` appears to succeed and `getPhysicsEngine`
// then returns undefined — the third time this project has been bitten by a
// Babylon augmentation module (see thinInstanceMesh, engine.dynamicTexture).
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsShapeBox, PhysicsShapeConvexHull } from "@babylonjs/core/Physics/v2/physicsShape.js";

import { buildHullPoints } from "../../../rock-forge/src/forge/bake.js";
import { bakeLibrary } from "../../../rock-forge/src/forge/bake.js";
import { ARCHETYPES } from "../../../rock-forge/src/forge/archetypes.js";
import { mulberry32 } from "../../../rock-forge/src/forge/rng.js";
import { ROCK_SEED, ARCHETYPE_COUNT, U } from "./siftingBeds.js";

/** Metres. 1:1 — see the header. */
export const GRAVITY = -9.81;

/**
 * Havok is stepped at a fixed rate rather than at the frame delta, for the
 * reason rock-sift documents: a variable step is what makes a dense pile
 * detonate, because at 30 fps the solver gets one 33 ms step, stones move
 * further than their own thickness inside it, end up deeply overlapped, and the
 * next step fires them apart.
 */
export const PHYSICS_SUBSTEP_MS = 1000 / 60;
export const MAX_FRAME_MS = 40;

/** Solver-side clamps, in metres — rock-sift's values divided by its U. */
export const MAX_SPEED = 5;
export const MAX_SPIN = 40;

/**
 * Points sampled for the collision hull. The forge's own note is worth heeding:
 * where the directions go matters far more than how many, because evenly-spread
 * directions spend themselves on the flat faces and miss the rim, which is
 * where the entire silhouette lives.
 */
const HULL_LOD = 3;

/**
 * Build one convex hull per archetype, in metres.
 *
 * Paid at beach load so the crouch is free. The hull comes from the forge's own
 * direction set rather than from the visual mesh, which matters because the
 * scenery mesh is a coarser icosphere than rock-sift draws — the collider must
 * describe the stone, not the level of detail it happens to be drawn at.
 */
export function createHulls(scene, { count = ARCHETYPE_COUNT, seed = ROCK_SEED } = {}) {
    const lib = bakeLibrary({ count, seed });
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const hulls = new Map();

    for (const shape of lib.shapes) {
        const params = ARCHETYPES[shape.archetype];
        if (!params) continue; // skip BEFORE drawing — same order as the cast

        const [lo, hi] = shape.sizeRange ?? [0.04, 0.09];
        const sizeMetres = lo + (hi - lo) * rng();

        const points = buildHullPoints(shape, params, sizeMetres, HULL_LOD);
        const hullMesh = new Mesh(`hull_${shape.archetype}_${shape.index}`, scene);
        // A point cloud has no faces; the hull builder only reads positions, but
        // Babylon wants a valid index buffer, so give it a degenerate one.
        hullMesh.setVerticesData("position", Float32Array.from(points), false);
        hullMesh.setIndices([0, 1, 2]);
        hullMesh.isVisible = false;

        const shapeBody = new PhysicsShapeConvexHull(hullMesh, scene);
        shapeBody.material = { friction: 0.62, restitution: 0.06 };
        hullMesh.dispose(false, false);

        hulls.set(`forge_${shape.archetype}_${shape.index}`, shapeBody);
    }
    return hulls;
}

/**
 * Turn physics on for the beach scene and pre-build everything the crouch needs.
 *
 * @param scene   the beach scene — the same one the player walks in
 * @param plugin  a constructed HavokPlugin (the caller owns loading the wasm,
 *                because that is an await the loading screen should cover)
 */
export function initSiftPhysics(scene, plugin, opts = {}) {
    scene.enablePhysics(new Vector3(0, GRAVITY, 0), plugin);
    const engine = scene.getPhysicsEngine();
    engine.setSubTimeStep(PHYSICS_SUBSTEP_MS);
    // Clamp inside the solver rather than after the fact: a per-frame rescale in
    // the render loop only runs once the damage is done, and cannot see the
    // intermediate substeps at all.
    plugin.setVelocityLimits?.(MAX_SPEED, MAX_SPIN);

    const hulls = createHulls(scene, opts);
    return new SiftPhysics(scene, hulls);
}

/**
 * The bed's two states, and the swap between them.
 *
 * Only one spot is ever awake. The others stay as the thin-instanced scenery
 * `siftingBeds.js` drew, which costs no solver time at all — rock-sift measured
 * 540 dynamic bodies at 4.6 ms a substep doing nothing.
 */
export class SiftPhysics {
    constructor(scene, hulls) {
        this.scene = scene;
        this.hulls = hulls;
        /** @type {{spot: object, rocks: Array, ground: object}|null} */
        this.awake = null;
    }

    /**
     * Wake one spot's bed: scenery out, bodies in, at the same transforms.
     *
     * Bodies are created ASLEEP. They are already at rest, so waking them only
     * invites the solver to resolve contacts that are already resolved — the
     * difference between a bed that appears settled and one that visibly
     * twitches as the player arrives.
     *
     * @param beds   the handle from `buildSiftingBeds`
     * @param spot   a SIFT_SPOTS entry
     */
    wake(beds, spot) {
        if (this.awake) this.sleep(beds);

        const entry = beds.bedForSpot.get(spot.id);
        if (!entry) return null;
        const { bed, baseY } = entry;

        beds.setSceneryEnabled(spot.id, false);

        // Ground: top face exactly at the crown. Sunk half its own height so the
        // top lands on baseY without arithmetic at every contact.
        const ground = new Mesh(`siftGround_${spot.id}`, this.scene);
        ground.position.set(spot.x, baseY - 0.5, spot.z);
        ground.isVisible = false;
        const groundShape = new PhysicsShapeBox(
            Vector3.Zero(), Quaternion.Identity(), new Vector3(8, 1, 8), this.scene
        );
        groundShape.material = { friction: 0.85, restitution: 0.02 };
        const groundBody = new PhysicsBody(ground, PhysicsMotionType.STATIC, false, this.scene);
        groundBody.shape = groundShape;

        const rocks = [];
        const pos = new Vector3();
        const rot = new Quaternion();
        for (let i = 0; i < bed.count; i++) {
            const name = bed.names[bed.archIndex[i]];
            const hull = this.hulls.get(name);
            if (!hull) continue;

            pos.set(
                bed.positions[i * 3] / U + spot.x,
                bed.positions[i * 3 + 1] / U + baseY,
                bed.positions[i * 3 + 2] / U + spot.z
            );
            rot.set(
                bed.quaternions[i * 4], bed.quaternions[i * 4 + 1],
                bed.quaternions[i * 4 + 2], bed.quaternions[i * 4 + 3]
            );

            const node = new Mesh(`stone_${spot.id}_${i}`, this.scene);
            node.position.copyFrom(pos);
            node.rotationQuaternion = rot.clone();
            const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, this.scene);
            body.shape = hull;
            body.setMassProperties({ mass: 0.17 });
            body.disablePreStep = false;
            rocks.push({ node, body, archetype: name, index: i });
        }

        this.awake = { spot, rocks, ground, groundBody, groundShape };
        return this.awake;
    }

    /**
     * Put the bed back to scenery, keeping whatever arrangement it was left in.
     *
     * The live transforms are read back before the bodies go, so a bed that has
     * been dug through stays dug through — the same contract as rock-sift's
     * `captureBed`.
     */
    sleep(beds) {
        if (!this.awake) return null;
        const { spot, rocks, ground, groundBody } = this.awake;
        const entry = beds.bedForSpot.get(spot.id);

        if (entry) {
            const { bed, baseY } = entry;
            for (const r of rocks) {
                const i = r.index;
                bed.positions[i * 3] = (r.node.position.x - spot.x) * U;
                bed.positions[i * 3 + 1] = (r.node.position.y - baseY) * U;
                bed.positions[i * 3 + 2] = (r.node.position.z - spot.z) * U;
                const q = r.node.rotationQuaternion ?? Quaternion.Identity();
                bed.quaternions[i * 4] = q.x;
                bed.quaternions[i * 4 + 1] = q.y;
                bed.quaternions[i * 4 + 2] = q.z;
                bed.quaternions[i * 4 + 3] = q.w;
            }
        }

        for (const r of rocks) { r.body.dispose(); r.node.dispose(); }
        groundBody.dispose();
        ground.dispose();
        // The hulls are shared across wakes and deliberately outlive this.

        beds.setSceneryEnabled(spot.id, true);
        const was = this.awake;
        this.awake = null;
        return was;
    }
}
