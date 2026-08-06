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
// Side-effect import: `Mesh.createInstance` is an augmentation too — the fourth
// in this project after thinInstanceMesh, engine.dynamicTexture and the physics
// engine component. This one at least throws a message naming itself; the other
// three failed silently.
import "@babylonjs/core/Meshes/instancedMesh.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsShapeBox, PhysicsShapeConvexHull } from "@babylonjs/core/Physics/v2/physicsShape.js";

import { buildHullPoints } from "../../../rock-forge/src/forge/bake.js";
import { detailedMetrics, SOLVER_LOD } from "../../../rock-forge/src/forge/solverParams.js";
import { castSequence, U } from "./siftingBeds.js";

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

/**
 * Solver-side clamps.
 *
 * Speed is a length per second, so rock-sift's `5 * U` becomes 5 m/s here.
 * Spin is NOT — rad/s is the same number at any world scale, so rock-sift's 30
 * carries over untouched. Dividing it by U, as an earlier draft of this file
 * did, would have quietly let stones spin a third faster in the beach's scene
 * than in the lab the values were tuned in.
 */
export const MAX_SPEED = 5;
export const MAX_SPIN = 30;

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
export function createHulls(scene, opts = {}) {
    const hulls = new Map();

    // The same walk of the RNG the meshes are built from — see `castSequence`.
    // Re-deriving it here is how a stone's silhouette ends up paired with a
    // different stone's collider, so it is deliberately not re-derived.
    for (const { name, shape, params, sizeMetres } of castSequence(opts)) {
        const points = buildHullPoints(shape, params, sizeMetres, HULL_LOD);
        const hullMesh = new Mesh(`hull_${name}`, scene);
        // A point cloud has no faces; the hull builder only reads positions, but
        // Babylon wants a valid index buffer, so give it a degenerate one.
        hullMesh.setVerticesData("position", Float32Array.from(points), false);
        hullMesh.setIndices([0, 1, 2]);
        hullMesh.isVisible = false;

        const shapeBody = new PhysicsShapeConvexHull(hullMesh, scene);
        shapeBody.material = { friction: 0.62, restitution: 0.06 };
        hullMesh.dispose(false, false);

        // Real mass, measured off the same geometry, rather than one number for
        // every stone. rock-sift does this too (`arch.metrics.massKgWorld`), and
        // it matters beyond realism: docs/02 puts the good band at 100-200 g and
        // rates a rock on what it weighs, so a bed where every stone weighs the
        // same is a bed where mass has stopped meaning anything.
        const metrics = detailedMetrics(shape, params, sizeMetres, { level: SOLVER_LOD });
        hulls.set(name, { shape: shapeBody, massKg: metrics.massKg, family: shape.archetype });
    }
    return hulls;
}

/**
 * Fetch Havok and build everything the crouch needs, in one await.
 *
 * Called from the app's loading sequence, never from the crouch — that is the
 * whole arrangement. The wasm is a network fetch and the hulls are ~850 ms of
 * geometry; both belong behind the loading screen, so that pressing E later
 * costs only the ~100 ms swap.
 *
 * Dynamically imported so a build that never sifts never pulls Havok in.
 */
export async function loadSiftPhysics(scene, opts = {}) {
    const [{ HavokPlugin }, { default: HavokPhysics }, { default: wasmUrl }] = await Promise.all([
        import("@babylonjs/core/Physics/v2/Plugins/havokPlugin.js"),
        import("@babylonjs/havok"),
        import("@babylonjs/havok/lib/esm/HavokPhysics.wasm?url"),
    ]);
    const wasmBinary = await fetch(wasmUrl).then((r) => r.arrayBuffer());
    const plugin = new HavokPlugin(true, await HavokPhysics({ wasmBinary }));
    return initSiftPhysics(scene, plugin, opts);
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

        // Scenery off, real instances on.
        //
        // The previous build drove the thin instances from the bodies. That drew
        // well and could not be picked — and the sweep works by picking the
        // stone under the pointer. `createInstance` is pickable, carries
        // `metadata.rock`, and is what rock-sift's tested interaction expects,
        // so the awake spot swaps to it. Only one spot is ever awake; the other
        // three stay on thin instances and cost nothing.
        beds.setSceneryEnabled(spot.id, false);
        const archByName = new Map((beds.archetypeList ?? []).map((a) => [a.name, a]));

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

            const source = archByName.get(name);
            if (!source?.mesh) continue;
            // InstancedMesh, not Mesh: it shares the source's geometry and is
            // cheap — rock-sift measures ~28 ms for a whole bed this way, while
            // a bare Mesh per stone measured 1.9 s in the browser.
            const node = source.mesh.createInstance(`${name}_i${i}`);
            node.isPickable = true;
            node.position.copyFrom(pos);
            node.rotationQuaternion = rot.clone();
            // Third argument is startsAsleep, and it has to be true: the bed is
            // already at rest, so waking it only invites the solver to resolve
            // contacts that are already resolved. An earlier draft passed false
            // while the comment above claimed otherwise, which is what put 99 mm
            // of creep into a bed that should not have moved at all.
            const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, true, this.scene);
            body.shape = hull.shape;
            body.setMassProperties({ mass: hull.massKg });
            body.setLinearDamping(0.2);
            body.setAngularDamping(0.4);

            // The shape rock-sift's interaction reads: it picks a mesh, takes
            // `metadata.rock`, and uses `rock.arch` for the stone's radius and
            // mass. Matching that contract is what lets the tuned sweep be
            // reused rather than rewritten.
            const rock = {
                node, body, index: i, archetype: name,
                arch: {
                    mesh: source.mesh, shape: hull.shape, radius: source.radius,
                    metrics: { massKgWorld: hull.massKg }, family: hull.family,
                },
                unitScale: 1,
            };
            node.metadata = { rock };
            rocks.push(rock);
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

        beds.setSceneryEnabled(spot.id, true);
        // The hulls are shared across wakes and deliberately outlive this.
        const was = this.awake;
        this.awake = null;
        return was;
    }
}
