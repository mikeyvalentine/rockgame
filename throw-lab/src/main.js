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
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { DracoCompression } from "@babylonjs/core/Meshes/Compression/dracoCompression";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";

const ARM_URL = "/assets/arms/FpsArmsLow-optimized.glb";
const DRACO = "/assets/vendor/draco/";

/** Which arm we pose. The left is collapsed until we need two hands. */
const SIDE = "Right";

/** Panel framing margin (1 = tight, >1 leaves air around the arm). */
const MARGIN = 1.4;

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

    // --- frame from the right-arm bones -------------------------------------
    // The arm's real extent, not a guessed box: union the world positions of the
    // right-side joints from shoulder to fingertip.
    const armNodes = [
        "Shoulder", "Arm", "ForeArm_", "ForearmRoll", "Hand",
        "HandMiddle1", "HandMiddle4", "HandThumb4", "HandPinky4",
    ].map((n) => findNode(SIDE + n)).filter(Boolean);
    const armBox = aabbOf(armNodes);
    const handBox = aabbOf([
        "Hand", "HandMiddle1", "HandMiddle4", "HandThumb4", "HandPinky4",
    ].map((n) => findNode(SIDE + n)).filter(Boolean), 0.06);

    console.log("[throw-lab] arm box", armBox, "hand box", handBox);

    // --- four orthographic cameras, 2x2 -------------------------------------
    // Screen axes per view: side looks along world X (horizontal=Z, vertical=Y);
    // top looks straight down -Y (horizontal=X, vertical=Z). Guessed axes — easy
    // to flip once we see the first render.
    const cams = [
        makeOrthoCam("armSide", scene, canvas, armBox, "side", new Viewport(0, 0.5, 0.5, 0.5)),
        makeOrthoCam("armTop", scene, canvas, armBox, "top", new Viewport(0.5, 0.5, 0.5, 0.5)),
        makeOrthoCam("wristSide", scene, canvas, handBox, "side", new Viewport(0, 0, 0.5, 0.5)),
        makeOrthoCam("wristTop", scene, canvas, handBox, "top", new Viewport(0.5, 0, 0.5, 0.5)),
    ];
    scene.activeCameras = cams.map((c) => c.cam);

    const reframe = () => cams.forEach((c) => c.fit());
    reframe();
    window.addEventListener("resize", () => { engine.resize(); reframe(); });

    engine.runRenderLoop(() => scene.render());

    // Expose for poking from the console.
    globalThis.LAB = { engine, scene, container, cams, findNode };
}

// --------------------------------------------------------------------------

/** Tolerant node lookup: exact name, else first whose name contains it. */
function findNode(name) {
    const nodes = _scene ? _scene.transformNodes : [];
    return nodes.find((n) => n.name === name) ||
           nodes.find((n) => n.name.includes(name)) || null;
}

/** World-space AABB spanning the given nodes' origins, padded by `pad` metres. */
function aabbOf(nodes, pad = 0) {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const n of nodes) {
        const p = n.getAbsolutePosition();
        min.minimizeInPlace(p);
        max.maximizeInPlace(p);
    }
    const center = min.add(max).scale(0.5);
    const half = max.subtract(min).scale(0.5).add(new Vector3(pad, pad, pad));
    return { center, half };
}

/**
 * An orthographic camera fitted to a box, in one of two 2D planes. The arm
 * extends along world X, lofts in Y, and lines out in Z, so:
 *   side → look along -Z; screen X = world X (arm length), Y = world Y (loft)
 *   top  → look along -Y; screen X = world X (arm length), Y = world Z (line)
 * Returns { cam, fit } — fit() recomputes ortho extents for the panel's aspect.
 */
function makeOrthoCam(name, scene, canvas, box, plane, viewport) {
    const { center, half } = box;
    const dist = 5; // ortho: distance is only for near/far, not size
    const cam = new UniversalCamera(name, center.clone(), scene);
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    cam.minZ = -20; cam.maxZ = 20;
    cam.viewport = viewport;
    cam.inputs.clear(); // static technical view — no user camera control

    let hU, hV;
    if (plane === "side") {
        cam.position = center.add(new Vector3(0, 0, dist));
        cam.upVector = new Vector3(0, 1, 0);
        hU = half.x; hV = half.y;       // screen X=X (length), Y=Y (loft)
    } else { // top
        cam.position = center.add(new Vector3(0, dist, 0));
        cam.upVector = new Vector3(0, 0, -1);
        hU = half.x; hV = half.z;       // screen X=X (length), Y=Z (line)
    }
    cam.setTarget(center);

    const fit = () => {
        const panelAspect = (canvas.width * viewport.width) /
                            (canvas.height * viewport.height);
        let halfW = Math.max(hU, 1e-3) * MARGIN;
        let halfH = Math.max(hV, 1e-3) * MARGIN;
        // Grow the smaller axis so content is never squashed by the panel aspect.
        if (halfW / halfH < panelAspect) halfW = halfH * panelAspect;
        else halfH = halfW / panelAspect;
        cam.orthoLeft = -halfW; cam.orthoRight = halfW;
        cam.orthoTop = halfH; cam.orthoBottom = -halfH;
    };
    return { cam, fit };
}

main().catch((e) => fail("throw-lab boot failed: " + (e && e.stack || e)));
