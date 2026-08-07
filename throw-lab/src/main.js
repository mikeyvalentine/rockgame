/**
 * Throw lab — the arm-pose editor.
 *
 * docs/03 makes the pose two 2D problems (a side plane and a top plane) to
 * avoid ambiguous 3D manipulation. This lab is the workbench for that: ONE arm
 * (the right; the left is collapsed for now), shown in four orthographic
 * panels — whole-arm side, whole-arm top, and a wrist close-up of each. Each
 * panel is a 2D plane the player will eventually pivot joints in; right now it
 * just renders the rig so we can see the framing and the skeleton drive.
 *
 * Orthographic on purpose: a 2D-modal pose editor must have no perspective
 * foreshortening, or "drag the elbow up 10°" would not read the same across the
 * panel. Cameras are framed from the right-arm BONE positions at load, so the
 * framing follows the rig rather than a hand-tuned magic box.
 *
 * Next slices (not here yet): per-joint pivot handles in each panel, the swing
 * gesture, and the hand-velocity → StoneSkipSim.throwStone() hookup.
 */

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { DracoCompression } from "@babylonjs/core/Meshes/Compression/dracoCompression";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";

import { buildRock } from "./rock.js";
import { gripRock } from "./grip.js";

const ARM_URL = "/assets/arms/FpsArmsLow-optimized.glb";
const DRACO = "/assets/vendor/draco/";

/** Which arm we pose. The left is collapsed until we need two hands. */
const SIDE = "Right";

/** Set once in main(), so findNode() can scan without threading scene around. */
let _scene = null;

function fail(msg) {
    const el = document.getElementById("err");
    el.hidden = false;
    el.textContent = msg;
    console.error(msg);
}

async function main() {
    const canvas = document.getElementById("view");
    const engine = new Engine(canvas, true, { antialias: true, stencil: false });

    const scene = new Scene(engine);
    _scene = scene;
    scene.clearColor = new Color4(0.10, 0.11, 0.13, 1);

    // Flat, even light — this is a technical posing view, not a beauty shot.
    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.3), scene);
    hemi.intensity = 0.9;
    hemi.groundColor = new Color3(0.4, 0.42, 0.45);
    const key = new DirectionalLight("key", new Vector3(-0.5, -1, -0.4), scene);
    key.intensity = 1.2;

    // --- load the rigged arm -------------------------------------------------
    registerBuiltInLoaders();
    DracoCompression.Configuration = {
        decoder: {
            wasmUrl: DRACO + "draco_wasm_wrapper_gltf.js",
            wasmBinaryUrl: DRACO + "draco_decoder_gltf.wasm",
            fallbackUrl: DRACO + "draco_decoder_gltf.js",
        },
    };

    let container;
    try {
        container = await LoadAssetContainerAsync(ARM_URL, scene);
    } catch (e) {
        fail("Failed to load the arm glb: " + e.message);
        return;
    }
    container.addAllToScene();

    // Force the world matrices so bone/node positions are real before framing.
    scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
    for (const m of scene.meshes) m.computeWorldMatrix(true);

    // --- collapse the left arm ----------------------------------------------
    // One skinned mesh covers both arms, so "hide the left" means collapsing the
    // left shoulder bone: every left-side vertex is weighted to it and its
    // children, so scaling it to ~zero folds the whole left arm into a point.
    // Not exactly zero — a singular bone matrix can NaN the skin.
    const leftShoulder = findNode("LeftShoulder");
    if (leftShoulder) {
        leftShoulder.scaling.set(1e-3, 1e-3, 1e-3);
        leftShoulder.computeWorldMatrix(true);
    } else {
        console.warn("[throw-lab] LeftShoulder node not found — left arm not hidden");
    }

    // --- resting pose: upper arm down, forearm forward (90° at the elbow) ----
    // The player will pivot from here. Posed by aiming each bone SEGMENT at a
    // world direction rather than by hand-tuned Euler angles, so it does not
    // depend on the rig's rest orientation: upper arm segment → straight down,
    // then the forearm segment → forward. That L is the sagittal (swing) plane.
    restPose();

    // Settle every world matrix after posing — aimSegment only refreshes the
    // bones it touched, so the fingers (grandchildren of the hand) still hold
    // bind-pose world positions until this runs. Two passes so parents update
    // before the children that read them. Without it the framing point sets
    // mix posed and bind positions and the panels frame the wrong region.
    for (let pass = 0; pass < 2; pass++) {
        scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
    }

    // --- borrow a rock and set it in the palm -------------------------------
    // A real rock-forge stone (its surface is what the grip will read). Anchored
    // between the wrist and the middle knuckle, then parented to the hand so it
    // rides the pose. The exact palm seat is provisional — the procedural grip
    // will settle the fingers to it next.
    // `?rock=basalt&seed=3&size=0.08` swaps the stone — the grip re-fits to
    // whatever surface it gets, which is the whole point of doing it procedurally.
    const q = new URLSearchParams(location.search);
    const rock = buildRock(scene, {
        name: q.get("rock") || "granite",
        seed: Number.parseInt(q.get("seed"), 10) || 7,
        size: Number.parseFloat(q.get("size")) || 0.10,
    });
    const handNode = findNode(SIDE + "Hand");
    const knuckle = findNode(SIDE + "HandMiddle1");
    // Palm normal from the hand skeleton: along the fingers × across the
    // knuckles. The rock is seated on the palm surface (offset out along that
    // normal by ~a third of its size) rather than sunk into the mesh.
    const handP = handNode.getAbsolutePosition();
    const fingerDir = knuckle.getAbsolutePosition().subtract(handP);
    fingerDir.normalize();
    const idx = findNode(SIDE + "HandIndex1"), pinky = findNode(SIDE + "HandPinky1");
    const across = idx.getAbsolutePosition().subtract(pinky.getAbsolutePosition());
    across.normalize();
    const palmNormal = Vector3.Cross(fingerDir, across);
    palmNormal.normalize();
    // Seat the rock's palm-side surface ON the palm: offset by its bounding
    // radius (+ a small gap), so the stone rests in the hand with the open
    // fingers around it rather than buried in it — otherwise the fingers start
    // already inside a big rock and the grip has nothing to close.
    let rockR = 0;
    const rp = rock.geometry.positions;
    for (let i = 0; i < rp.length; i += 3) {
        rockR = Math.max(rockR, Math.hypot(rp[i], rp[i + 1], rp[i + 2]));
    }
    const palm = Vector3.Lerp(handP, knuckle.getAbsolutePosition(), 0.5)
                        .add(palmNormal.scale(-(rockR + 0.005)));
    rock.mesh.position.copyFrom(palm);
    rock.mesh.computeWorldMatrix(true);
    rock.mesh.setParent(handNode); // follow the hand; setParent keeps world pose

    // --- procedural grip: curl the fingers onto the rock --------------------
    const palmar = palmNormal.scale(-1); // toward the palm / the rock
    const curled = gripRock({
        side: SIDE, findNode, rockMesh: rock.mesh, geometry: rock.geometry, palmar,
    });
    console.log(`[throw-lab] grip: ${curled} finger joints curled onto the rock`);
    for (let pass = 0; pass < 2; pass++) {
        scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
    }

    // --- frame from the right-arm bones -------------------------------------
    // The arm's real extent, not a guessed box: union the world positions of the
    // right-side joints from shoulder to fingertip.
    // Two point sets to frame on: the whole arm (shoulder→fingertips) and a
    // tight wrist/hand set. Cameras fit to the actual joint positions, so the
    // framing follows whatever pose the arm is in.
    const armPts = collectPoints([
        "Shoulder", "Arm", "ForeArm_", "ForearmRoll", "Hand",
        "HandMiddle1", "HandMiddle4", "HandThumb4", "HandIndex4",
        "HandRing4", "HandPinky4",
    ]);
    const wristPts = collectPoints([
        "Hand", "HandThumb1", "HandThumb4", "HandIndex4",
        "HandMiddle1", "HandMiddle4", "HandRing4", "HandPinky4",
    ]);
    // Keep the rock in frame in both the wrist and the whole-arm panels.
    wristPts.push(palm.clone());
    armPts.push(palm.clone());

    // --- four orthographic cameras, 2x2 -------------------------------------
    // side = profile (look -X): screen right = +Z forward, up = +Y loft.
    // top  = overhead (look -Y): screen shows the left/right line + forward.
    const cams = [
        makeOrthoCam("armSide", scene, canvas, armPts, "side", 1.25, new Viewport(0, 0.5, 0.5, 0.5)),
        makeOrthoCam("armTop", scene, canvas, armPts, "top", 1.25, new Viewport(0.5, 0.5, 0.5, 0.5)),
        makeOrthoCam("wristSide", scene, canvas, wristPts, "side", 1.35, new Viewport(0, 0, 0.5, 0.5)),
        makeOrthoCam("wristTop", scene, canvas, wristPts, "top", 1.35, new Viewport(0.5, 0, 0.5, 0.5)),
    ];
    scene.activeCameras = cams.map((c) => c.cam);

    const reframe = () => cams.forEach((c) => c.fit());
    reframe();
    window.addEventListener("resize", () => { engine.resize(); reframe(); });

    engine.runRenderLoop(() => scene.render());

    // Expose for poking from the console.
    globalThis.LAB = { engine, scene, container, cams, rock, findNode };
}

// --------------------------------------------------------------------------

/** Tolerant node lookup: exact name, else first whose name contains it. */
function findNode(name) {
    const nodes = _scene ? _scene.transformNodes : [];
    return nodes.find((n) => n.name === name) ||
           nodes.find((n) => n.name.includes(name)) || null;
}

/** World positions of the named right-side joints (missing ones dropped). */
function collectPoints(names) {
    return names
        .map((n) => findNode(SIDE + n))
        .filter(Boolean)
        .map((n) => n.getAbsolutePosition().clone());
}

/**
 * An orthographic camera fitted to a set of world POINTS, in one of two planes:
 *   side → look along -X (sagittal profile), up = +Y
 *   top  → look along -Y (overhead),        up = -Z
 * It aims at the points' centroid and sizes to their spread projected onto the
 * screen axes — so it centres and fits whatever pose the arm holds, no per-axis
 * box mapping to get wrong. Returns { cam, fit }; fit() re-runs on resize.
 */
function makeOrthoCam(name, scene, canvas, points, plane, margin, viewport) {
    const dist = 5; // ortho: distance is only for near/far, not size
    const centroid = points
        .reduce((a, p) => a.addInPlace(p), new Vector3(0, 0, 0))
        .scale(1 / Math.max(points.length, 1));

    const axis = plane === "side" ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const up = plane === "side" ? new Vector3(0, 1, 0) : new Vector3(0, 0, -1);

    const cam = new UniversalCamera(name, centroid.add(axis.scale(dist)), scene);
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    cam.minZ = -20; cam.maxZ = 20;
    cam.upVector = up;
    cam.viewport = viewport;
    cam.inputs.clear(); // static technical view
    cam.setTarget(centroid);

    // Screen right = up × forward (forward points from camera to centroid).
    const forward = centroid.subtract(cam.position);
    forward.normalize();
    const right = Vector3.Cross(up, forward);
    right.normalize();

    // Half-spread of the points on each screen axis, about the centroid.
    let hu = 1e-3, hv = 1e-3;
    for (const p of points) {
        const d = p.subtract(centroid);
        hu = Math.max(hu, Math.abs(Vector3.Dot(d, right)));
        hv = Math.max(hv, Math.abs(Vector3.Dot(d, up)));
    }

    const fit = () => {
        const panelAspect = (canvas.width * viewport.width) /
                            (canvas.height * viewport.height);
        let halfW = hu * margin;
        let halfH = hv * margin;
        if (halfW / halfH < panelAspect) halfW = halfH * panelAspect;
        else halfH = halfW / panelAspect;
        cam.orthoLeft = -halfW; cam.orthoRight = halfW;
        cam.orthoTop = halfH; cam.orthoBottom = -halfH;
    };
    return { cam, fit };
}

/**
 * Rotate `node` (in world space) so the segment from it to `child` points along
 * `targetDir`. Shortest-arc rotation; safe when already aligned or opposite.
 */
function aimSegment(node, child, targetDir) {
    node.computeWorldMatrix(true);
    child.computeWorldMatrix(true);
    const cur = child.getAbsolutePosition().subtract(node.getAbsolutePosition());
    if (cur.lengthSquared() < 1e-10) return;
    cur.normalize();
    const tgt = targetDir.clone().normalize();
    let axis = Vector3.Cross(cur, tgt);
    const s = axis.length();
    const c = Vector3.Dot(cur, tgt);
    if (s < 1e-6) {
        if (c > 0) return;                  // already aligned
        // Opposite: rotate 180° about any perpendicular axis.
        axis = Vector3.Cross(cur, new Vector3(0, 1, 0));
        if (axis.length() < 1e-6) axis = Vector3.Cross(cur, new Vector3(1, 0, 0));
    }
    axis.normalize();
    node.rotate(axis, Math.atan2(s, c), Space.WORLD);
    node.computeWorldMatrix(true);
}

/**
 * The resting throw-ready pose: upper arm straight down, forearm forward — a
 * 90° elbow, the L the swing pivots from. Directions in world space; the aim
 * approach means it does not depend on the rig's bind orientation.
 */
function restPose() {
    const arm = findNode(SIDE + "Arm");
    const fore = findNode(SIDE + "ForeArm_");
    const hand = findNode(SIDE + "Hand");
    if (!arm || !fore || !hand) {
        console.warn("[throw-lab] restPose: missing arm/forearm/hand joints");
        return;
    }
    aimSegment(arm, fore, new Vector3(0, -1, 0));   // upper arm → straight down
    aimSegment(fore, hand, new Vector3(0, 0, 1));   // forearm → forward (90° elbow)
}

main().catch((e) => fail("throw-lab boot failed: " + (e && e.stack || e)));
