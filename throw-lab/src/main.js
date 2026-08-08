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
import { setupPivots } from "./pivot.js";

const ARM_URL = "/assets/arms/FpsArmsLow-optimized.glb";
const DRACO = "/assets/vendor/draco/";

/**
 * Which arm we pose (the other is collapsed until we support two hands).
 * `?side=Right|Left` overrides. NOTE: swapping arms does NOT change these
 * orthographic views — the two arms are mirror images across X and the side
 * camera looks along X, so it flattens the very axis they differ on. Which
 * FACE we see (inside vs outside) is set by the camera direction (FLIP), not
 * by the arm. A left/right player-hand choice comes later.
 */
let SIDE = "Right";

/**
 * Show the arm's OUTSIDE face (back of the hand) while keeping it pointing the
 * same way on screen. A camera alone can't do that — seeing the far face either
 * points the arm the other way or turns it upside down (it's a reflection, an
 * improper rotation). So we mirror the whole rig across X. Cost: the hand
 * geometry is mirrored (a right hand reads as left-shaped); the real left/right
 * player-hand choice comes later. `?mirror=0` disables.
 */
let MIRROR = true;

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

    const q = new URLSearchParams(location.search);
    if (q.get("side") === "Right" || q.get("side") === "Left") SIDE = q.get("side");
    if (q.get("mirror") === "0") MIRROR = false;
    console.log(`[throw-lab] SIDE=${SIDE} MIRROR=${MIRROR}`);

    // Force the world matrices so bone/node positions are real before framing.
    scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
    for (const m of scene.meshes) m.computeWorldMatrix(true);

    // --- collapse the OTHER arm ---------------------------------------------
    // One skinned mesh covers both arms, so "hide" the arm we don't pose by
    // collapsing its shoulder bone: every vertex on that side is weighted to it
    // and its children, so scaling it to ~zero folds that whole arm into a point.
    // Not exactly zero — a singular bone matrix can NaN the skin.
    const otherSide = SIDE === "Right" ? "Left" : "Right";
    const otherShoulder = findNode(otherSide + "Shoulder");
    if (otherShoulder) {
        otherShoulder.scaling.set(1e-3, 1e-3, 1e-3);
        otherShoulder.computeWorldMatrix(true);
    } else {
        console.warn(`[throw-lab] ${otherSide}Shoulder node not found — other arm not hidden`);
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
    const rockSize = Number.parseFloat(q.get("size")) || 0.10;
    const rock = buildRock(scene, {
        name: q.get("rock") || "granite",
        seed: Number.parseInt(q.get("seed"), 10) || 7,
        size: rockSize,
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
    // Skipping grip (see reference): the stone is pinched at the FRONT of the
    // hand between the thumb and the side of the index — not buried in the palm.
    // Seat it along the index's proximal phalanx; a size factor slides bigger
    // stones back toward the palm centre for support, as a real hand does.
    const mcps = ["Index1", "Middle1", "Ring1", "Pinky1"]
        .map((n) => findNode(SIDE + "Hand" + n).getAbsolutePosition());
    const knuckleCentre = mcps.reduce((a, p) => a.addInPlace(p), new Vector3())
        .scale(1 / mcps.length);
    // Seat depends on size, in three bands (a real hand changes grip by stone):
    //   ≤8cm  → PINCH between thumb and index, held forward at the front crook;
    //   9–15cm → WRAP: in the thumb–index web, sliding toward the palm as it grows;
    //   ≥16cm  → POWER: just sits in the palm centre, hand closes around it (no
    //            web-fitting — too big to hold in the crook).
    const idx1p = findNode(SIDE + "HandIndex1").getAbsolutePosition();
    const thumb2 = findNode(SIDE + "HandThumb2").getAbsolutePosition();
    const web = Vector3.Lerp(idx1p, thumb2, 0.5);
    let seat, tiltDeg;
    if (rockSize <= 0.08) {
        // Nudge forward along the fingers so it sits at the fingertips/crook,
        // pinched between thumb and index rather than down in the palm.
        seat = web.add(fingerDir.scale(rockR * 0.5));
        tiltDeg = 60;
    } else if (rockSize < 0.16) {
        const f = Math.min(1, (rockSize - 0.09) / 0.06);
        seat = Vector3.Lerp(web, knuckleCentre, f * 0.5);
        tiltDeg = 55;
    } else {
        seat = knuckleCentre.clone();
        tiltDeg = 25;
    }
    const palm = seat.add(palmNormal.scale(-(rockR * 0.5)));
    rock.mesh.position.copyFrom(palm);
    rock.mesh.computeWorldMatrix(true);
    // Held on edge, not flat in the palm: tilt the stone about the across-the-hand
    // axis so a flat skipping face stands roughly perpendicular (less for a big
    // power-gripped rock, which sits flatter in the palm).
    const tiltAxis = mcps[0].subtract(mcps[3]);
    tiltAxis.normalize();
    rock.mesh.rotate(tiltAxis, tiltDeg * Math.PI / 180, Space.WORLD);
    rock.mesh.computeWorldMatrix(true);
    rock.mesh.setParent(handNode); // follow the hand; setParent keeps world pose

    // --- procedural grip: curl the fingers onto the rock --------------------
    const palmar = palmNormal.scale(-1); // toward the palm / the rock
    globalThis.LAB_GRIP = { palmNormal: palmNormal.clone(), palmar: palmar.clone() };
    let curled = 0;
    if (q.get("nogrip") === null) {
        curled = gripRock({
            side: SIDE, findNode, rockMesh: rock.mesh, geometry: rock.geometry, palmar,
        });
        console.log(`[throw-lab] grip: ${curled} finger joints curled onto the rock`);
    }
    for (let pass = 0; pass < 2; pass++) {
        scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
    }

    // --- mirror the rig for the OUTSIDE view --------------------------------
    // Done AFTER posing + grip (which depend on the rig's own handedness) so
    // only the DISPLAY mirrors. Scale the rig root by -1 on X: the far/outside
    // face now points at the cameras while the arm still points the same way.
    if (MIRROR) {
        let root = findNode(SIDE + "Shoulder");
        while (root && root.parent) root = root.parent;
        if (root) {
            root.scaling.x *= -1;
            // A reflection flips triangle winding, so front faces would be
            // culled and the arm would render inside-out — draw both sides.
            for (const m of scene.meshes) if (m.material) m.material.backFaceCulling = false;
        } else {
            console.warn("[throw-lab] mirror: rig root not found");
        }
        for (let pass = 0; pass < 2; pass++) {
            scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
            for (const m of scene.meshes) m.computeWorldMatrix(true);
        }
    }

    // --- frame from the right-arm bones -------------------------------------
    // The arm's real extent, not a guessed box: union the world positions of the
    // right-side joints from shoulder to fingertip.
    // Two point sets to frame on: the whole arm (shoulder→fingertips) and a
    // tight wrist/hand set. Cameras fit to the actual joint positions, so the
    // framing follows whatever pose the arm is in.
    // The whole-arm panels frame the REACHABLE ENVELOPE — a shoulder-centred
    // box of radius one full arm length — not the current pose, so pivoting can
    // never swing the hand out of frame.
    // Reach = the SUM of the segment lengths (a straightened arm), not the
    // shoulder→fingertip chord of the bent rest pose, which is shorter.
    const shoulderP = findNode(SIDE + "Arm").getAbsolutePosition().clone();
    const segNames = ["Arm", "ForeArm_", "Hand", "HandMiddle4"];
    let reach = 0;
    for (let i = 0; i < segNames.length - 1; i++) {
        reach += Vector3.Distance(
            findNode(SIDE + segNames[i]).getAbsolutePosition(),
            findNode(SIDE + segNames[i + 1]).getAbsolutePosition());
    }
    reach *= 1.05;
    const armPts = [];
    for (const dx of [-reach, reach])
        for (const dy of [-reach, reach])
            for (const dz of [-reach, reach])
                armPts.push(shoulderP.add(new Vector3(dx, dy, dz)));
    // Wrist close-ups: an envelope centred ON the wrist, radius = the hand's
    // own reach — so wherever the hand points (it pivots about the wrist), it
    // stays fully in frame once the camera rides the wrist.
    const wristP = findNode(SIDE + "Hand").getAbsolutePosition().clone();
    const handReach = Vector3.Distance(wristP,
        findNode(SIDE + "HandMiddle4").getAbsolutePosition()) * 1.3;
    const wristPts = [];
    for (const dx of [-handReach, handReach])
        for (const dy of [-handReach, handReach])
            for (const dz of [-handReach, handReach])
                wristPts.push(wristP.add(new Vector3(dx, dy, dz)));

    // --- four orthographic cameras, 2x2 -------------------------------------
    // side = profile (look -X): screen right = +Z forward, up = +Y loft.
    // top  = overhead (look -Y): screen shows the left/right line + forward.
    const cams = [
        makeOrthoCam("armSide", scene, canvas, armPts, "side", 1.02, new Viewport(0, 0.5, 0.5, 0.5)),
        makeOrthoCam("armTop", scene, canvas, armPts, "top", 1.02, new Viewport(0.5, 0.5, 0.5, 0.5)),
        makeOrthoCam("wristSide", scene, canvas, wristPts, "side", 1.02, new Viewport(0, 0, 0.5, 0.5)),
        makeOrthoCam("wristTop", scene, canvas, wristPts, "top", 1.02, new Viewport(0.5, 0, 0.5, 0.5)),
    ];
    scene.activeCameras = cams.map((c) => c.cam);

    const reframe = () => cams.forEach((c) => c.fit());
    reframe();
    window.addEventListener("resize", () => { engine.resize(); reframe(); });

    // Pin the wrist close-ups to the wrist joint: keep each camera's original
    // wrist→centre offset (composition) but ride along as the pose swings, so
    // the hand never leaves those frames.
    const wristNode = findNode(SIDE + "Hand");
    const wristAnchor = wristNode.getAbsolutePosition().clone();
    const followers = [cams[2], cams[3]].map((c) => ({
        c, offset: c.centroid.subtract(wristAnchor),
    }));
    scene.onBeforeRenderObservable.add(() => {
        const w = wristNode.getAbsolutePosition();
        for (const f of followers) f.c.recenter(w.add(f.offset));
    });

    // --- per-joint pivot handles (the aim-pose editor) ----------------------
    setupPivots({ scene, canvas, cams, findNode, side: SIDE });

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
    // Re-aim at a new world point, keeping the ortho size (framing) as fitted.
    const recenter = (point) => {
        cam.position = point.add(axis.scale(dist));
        cam.setTarget(point);
    };
    return { cam, fit, recenter, centroid: centroid.clone() };
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
