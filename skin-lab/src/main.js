/**
 * Skin lab — the character skin customization workbench.
 *
 * Two live controls, previewed on the real arm rig (and a sphere swatch for
 * fast material iteration): a SKIN-COLOUR control (a natural light→dark tone
 * slider plus a free "any colour" picker) and an AGE slider (pores/cells grow
 * more apparent and macro wrinkles emerge). The look is all in skin-material.js;
 * this file just loads the geometry, wires the DOM controls, and frames it.
 *
 * `?preview=arm|sphere|both`, `?tone=0..1`, `?age=0..1`, `?color=RRGGBB`,
 * `?scale=<tiles/m>` seed the controls (so headless renders can pin a look).
 */

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { DracoCompression } from "@babylonjs/core/Meshes/Compression/dracoCompression";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";

import { createSkinMaterial } from "./skin-material.js";

const ARM_URL = "/assets/arms/FpsArmsLow-optimized.glb";
const DRACO = "/assets/vendor/draco/";
const SIDE = "Right";

let _scene = null;
const q = new URLSearchParams(location.search);
const PREVIEW = q.get("preview") || "both";

function fail(msg) {
    const el = document.getElementById("err");
    if (el) { el.hidden = false; el.textContent = msg; }
    console.error(msg);
}

async function main() {
    const canvas = document.getElementById("view");
    const engine = new Engine(canvas, true, { antialias: true, stencil: false });
    const scene = new Scene(engine);
    _scene = scene;
    scene.clearColor = new Color4(0.09, 0.10, 0.12, 1);

    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.2, 0.8,
        new Vector3(0, 0, 0), scene);
    camera.wheelDeltaPercentage = 0.02;
    camera.minZ = 0.001;
    camera.attachControl(canvas, true);

    // --- load the rigged arm -------------------------------------------------
    registerBuiltInLoaders();
    DracoCompression.Configuration = {
        decoder: {
            wasmUrl: DRACO + "draco_wasm_wrapper_gltf.js",
            wasmBinaryUrl: DRACO + "draco_decoder_gltf.wasm",
            fallbackUrl: DRACO + "draco_decoder_gltf.js",
        },
    };

    let armMeshes = [];
    if (PREVIEW === "arm" || PREVIEW === "both") {
        let container;
        try {
            container = await LoadAssetContainerAsync(ARM_URL, scene);
        } catch (e) {
            fail("Failed to load the arm glb: " + e.message);
            return;
        }
        container.addAllToScene();
        scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
        for (const m of scene.meshes) m.computeWorldMatrix(true);
        armMeshes = scene.meshes.filter((m) => m.getTotalVertices && m.getTotalVertices() > 0);

        // Collapse the other arm and set the resting pose (bent elbow) — same as
        // the throw lab, so the preview reads as a real forearm, not a T-pose.
        collapse(SIDE === "Right" ? "Left" : "Right");
        restPose();
        for (let pass = 0; pass < 2; pass++) {
            scene.transformNodes.forEach((n) => n.computeWorldMatrix(true));
        }
    }

    // --- skin materials ------------------------------------------------------
    // One skinned material for the arm, one plain for the sphere swatch. They
    // share the same controls so a change updates both.
    const skins = [];
    if (armMeshes.length) {
        const bones = armMeshes.find((m) => m.skeleton)?.skeleton?.bones?.length || 60;
        const armSkin = createSkinMaterial(scene, { skinned: true, boneCount: bones });
        for (const m of armMeshes) m.material = armSkin.material;
        skins.push(armSkin);
    }
    if (PREVIEW === "sphere" || PREVIEW === "both") {
        const sphere = CreateSphere("swatch", { diameter: 0.14, segments: 64 }, scene);
        // Sit the swatch beside the hand (or at origin when it's the only thing).
        sphere.position = armMeshes.length ? new Vector3(0.18, 0, 0.15) : new Vector3(0, 0, 0);
        const sphereSkin = createSkinMaterial(scene, { skinned: false });
        sphere.material = sphereSkin.material;
        skins.push(sphereSkin);
    }

    // --- frame the camera on what we're previewing ---------------------------
    const target = armMeshes.length ? findNode(SIDE + "Hand")?.getAbsolutePosition() : null;
    if (target) { camera.setTarget(target); camera.radius = 0.45; camera.alpha = -Math.PI / 2 + 0.5; }
    else { camera.radius = 0.32; }

    wireControls(skins);
    seedFromUrl(skins);

    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    globalThis.SKIN = { scene, engine, skins, camera };
}

// --------------------------------------------------------------------------

/** Broadcast a control change to every skin (arm + sphere). */
function apply(skins, fn) { for (const s of skins) fn(s); }

function wireControls(skins) {
    const tone = document.getElementById("tone");
    const age = document.getElementById("age");
    const free = document.getElementById("free");
    const color = document.getElementById("color");
    const scale = document.getElementById("scale");
    const ageOut = document.getElementById("ageOut");

    const useFree = () => free.checked;
    const pushColor = () => {
        if (useFree()) apply(skins, (s) => s.setColor(color.value));
        else apply(skins, (s) => s.setTone(Number(tone.value)));
    };
    const pushAge = () => {
        const t = Number(age.value);
        apply(skins, (s) => s.setAge(t));
        ageOut.textContent = Math.round(18 + t * 72) + " yrs";
    };

    tone.addEventListener("input", () => { free.checked = false; pushColor(); });
    color.addEventListener("input", () => { free.checked = true; pushColor(); });
    free.addEventListener("change", pushColor);
    age.addEventListener("input", pushAge);
    scale.addEventListener("input", () => apply(skins, (s) => s.setScale(Number(scale.value))));

    // Expose for headless / console driving.
    globalThis.SKIN_CTL = { pushColor, pushAge, tone, age, free, color, scale };
}

function seedFromUrl(skins) {
    const tone = document.getElementById("tone");
    const age = document.getElementById("age");
    const free = document.getElementById("free");
    const color = document.getElementById("color");
    const scale = document.getElementById("scale");
    const ageOut = document.getElementById("ageOut");

    if (q.has("scale")) { scale.value = q.get("scale"); apply(skins, (s) => s.setScale(Number(scale.value))); }
    if (q.has("color")) {
        color.value = "#" + q.get("color").replace(/^#/, "");
        free.checked = true;
        apply(skins, (s) => s.setColor(color.value));
    } else {
        tone.value = q.has("tone") ? q.get("tone") : "0.35";
        apply(skins, (s) => s.setTone(Number(tone.value)));
    }
    age.value = q.has("age") ? q.get("age") : "0";
    apply(skins, (s) => s.setAge(Number(age.value)));
    ageOut.textContent = Math.round(18 + Number(age.value) * 72) + " yrs";
}

/** Tolerant node lookup: exact name, else first whose name contains it. */
function findNode(name) {
    const nodes = _scene ? _scene.transformNodes : [];
    return nodes.find((n) => n.name === name) ||
           nodes.find((n) => n.name.includes(name)) || null;
}

/** Collapse one arm by scaling its shoulder bone to ~zero (see throw-lab). */
function collapse(side) {
    const shoulder = findNode(side + "Shoulder");
    if (shoulder) { shoulder.scaling.set(1e-3, 1e-3, 1e-3); shoulder.computeWorldMatrix(true); }
}

/** Rest pose: upper arm down, forearm forward — the 90° elbow (see throw-lab). */
function restPose() {
    const arm = findNode(SIDE + "Arm");
    const fore = findNode(SIDE + "ForeArm_");
    const hand = findNode(SIDE + "Hand");
    if (!arm || !fore || !hand) return;
    aimSegment(arm, fore, new Vector3(0, -1, 0));
    aimSegment(fore, hand, new Vector3(0, 0, 1));
}

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
        if (c > 0) return;
        axis = Vector3.Cross(cur, new Vector3(0, 1, 0));
        if (axis.length() < 1e-6) axis = Vector3.Cross(cur, new Vector3(1, 0, 0));
    }
    axis.normalize();
    node.rotate(axis, Math.atan2(s, c), Space.WORLD);
    node.computeWorldMatrix(true);
}

main().catch((e) => fail("skin-lab boot failed: " + (e && e.stack || e)));
