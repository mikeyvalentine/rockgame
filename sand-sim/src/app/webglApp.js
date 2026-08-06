/**
 * The WebGL2 fallback — first-class, reduced fidelity (docs/09: "simpler sand,
 * fewer particles"). Same shared systems as the WebGPU app: input, FPS rig,
 * locomotion controller, beach params, water, settings, overlay, HDRI
 * environment. What differs is everything shader-bound.
 *
 * Phase-4 state: the real beach as a displaced dense grid over the shared
 * `shoreProfileJS` (grounding reads the same function — per-renderer
 * self-consistency, no GPU readback needed on this path), the shared static
 * water with env reflections, HDRI sky. Deformation (GLSL ping-pong) and the
 * PBR displacement plugin land in phase 5.
 */

import { Engine } from "@babylonjs/core/Engines/engine";
// Side-effect import: DynamicTexture support (MaskPaint, water ripple) — see
// the note in webgpuApp.js; this is the WebGL twin of the same extension.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4, Vector3 } from "@babylonjs/core/Maths/math";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Effect } from "@babylonjs/core/Materials/effect";

import { createScribble } from "../../../shared/scribble-fx.js";
import {
    attachScribblePanel, loadScribbleSettings, PASTEL_KEYS,
} from "../../../shared/scribble-dials.js";

import { registerShadersGL } from "../shaders/registry.js";
import { S, onChange } from "../core/settings.js";
import {
    sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "../core/perf.js";
import { initInput, pollInput, endFrame, input, allowPointerLock, allowWorldTools } from "../core/input.js";
import { FpsRig } from "../core/camera.js";
import { CharacterController } from "../character/controller.js";
import { SnowContact } from "../character/snowContact.js";
import { DeformationField } from "../terrain/deformation.js";
import { SandDeformPlugin } from "../render/sandDeformPlugin.js";
import { Overlay } from "../ui/overlay.js";
import { HdriEnvironment } from "../render/environment.js";
import {
    WORLD_SIZE, SPAWN, shoreProfileJS, clampToPlayRect,
} from "../terrain/beachParams.js";
import { buildWater } from "../scene/water.js";
import { buildSiftingBeds } from "../scene/siftingBeds.js";
import { loadSiftPhysics } from "../scene/siftPhysics.js";
import { Crouch, spotAt } from "../scene/crouch.js";
import { createCrouchPrompt } from "../scene/crouchPrompt.js";
import { createSiftInteraction } from "../scene/siftInteraction.js";
import { Imprints } from "../scene/imprints.js";
import * as loading from "../core/loading.js";

/** Grid density for the visible beach. 256² over 512 m = 2 m spacing. */
const GRID_SUBDIVISIONS = 256;

/** @param {HTMLCanvasElement} canvas */
export async function run(canvas) {
    await loading.phase("creating context", 0.05);

    const engine = new Engine(canvas, false, {
        stencil: false,
        powerPreference: "high-performance",
    });
    if (engine.webGLVersion < 2) {
        throw new Error("WebGL2 is not available in this browser.");
    }

    const applyScale = () => engine.setHardwareScalingLevel(1 / S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => engine.resize());

    installDrawCounter(engine);
    registerShadersGL();

    await loading.phase("building scene", 0.15);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);

    const rig = new FpsRig(scene, canvas);
    scene.activeCamera = rig.camera;

    await loading.phase("loading sky", 0.3);
    const sky = new HdriEnvironment(scene);
    await sky.solve();
    // PBR env for the sand and the water — reflections + a believable ambient.
    sky.attachCube();

    // ---------------------------------------------------------------- lights
    // Stock lights stand in for the WGSL material's own lighting model. The
    // sun matches the HDRI's found sun; the hemisphere fills what the cube's
    // IBL leaves flat.
    const sun = new DirectionalLight(
        "sun",
        new Vector3(-sky.sunDir.x, -sky.sunDir.y, -sky.sunDir.z),
        scene
    );
    sun.diffuse = new Color3(sky.sunColor.r, sky.sunColor.g, sky.sunColor.b);
    sun.intensity = 2.2;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.diffuse = new Color3(0.55, 0.66, 0.82);
    hemi.groundColor = new Color3(0.42, 0.40, 0.36);
    hemi.intensity = 0.35;

    // ---------------------------------------------------------------- ground
    await loading.phase("displacing beach", 0.45);
    // The visible beach: one displaced dense grid over the shared profile —
    // rock-sift's `displace()` pattern, including its silent-failure guard.
    const ground = CreateGround("beach", {
        width: WORLD_SIZE, height: WORLD_SIZE,
        subdivisions: GRID_SUBDIVISIONS, updatable: true,
    }, scene);
    const posBuffer = ground.geometry?.getVertexBuffer(VertexBuffer.PositionKind);
    if (posBuffer && !posBuffer.isUpdatable()) {
        throw new Error("beach: positions not updatable — displacement would be silently dropped");
    }
    const positions = ground.getVerticesData(VertexBuffer.PositionKind);
    for (let i = 0; i < positions.length; i += 3) {
        positions[i + 1] = shoreProfileJS(positions[i], positions[i + 2], 1);
    }
    ground.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    ground.createNormals(true);
    ground.isPickable = false;
    ground.freezeWorldMatrix();

    const groundMat = new PBRMaterial("sandGL", scene);
    groundMat.albedoColor = new Color3(0.62, 0.61, 0.57); // pale cool grey-beige
    groundMat.roughness = 0.95;
    groundMat.metallic = 0;
    groundMat.environmentIntensity = 0.7;
    ground.material = groundMat;

    // Grounding reads the same profile the mesh was displaced from. Amp fixed
    // at 1 on this path — the mesh is baked once, and the two must agree.
    const terrain = {
        heightAt: (x, z) => shoreProfileJS(x, z, 1),
        normalAt: (x, z, out) => {
            const e = 0.5;
            const hx = shoreProfileJS(x + e, z, 1) - shoreProfileJS(x - e, z, 1);
            const hz = shoreProfileJS(x, z + e, 1) - shoreProfileJS(x, z - e, 1);
            out.set(-hx / (2 * e), 1, -hz / (2 * e));
            out.normalize();
            return out;
        },
    };

    // ----------------------------------------------------------------- water
    const water = buildWater(scene);

    // ------------------------------------------------------- sifting beds
    // The stones on the piles. Renderer-agnostic — it wants nothing but
    // `heightAt`, and the stones are ordinary meshes, so the fallback draws
    // them as well as the WebGPU path does. (The mound they sit on is the part
    // this renderer loses; see docs/09.)
    await loading.phase("laying the beds", 0.68);
    const beds = await buildSiftingBeds(scene, terrain);
    if (beds) console.log(`[sand-sim] ${beds.stones} stones across ${beds.spots} spots`);

    // Physics is built HERE, not at the crouch, and that is the whole reason
    // crouching is a camera move: the wasm fetch and the forty convex hulls are
    // the expensive part, and they are paid once, behind this loading screen.
    await loading.phase("waking the stones", 0.74);
    const physics = beds ? await loadSiftPhysics(scene) : null;

    const character = new CharacterController(terrain);
    character.position.set(SPAWN.x, 0, SPAWN.z);
    character.position.y = terrain.heightAt(SPAWN.x, SPAWN.z);
    rig.yaw = SPAWN.yaw; // facing the sea

    // ------------------------------------------------------------ deformation
    // The same DeformationField class and the same brush model as the WebGPU
    // app, running the GLSL twin of the sim pass at half resolution. The
    // plugin reads it tonally (no displacement — reduced fidelity). If the
    // machine can't render half-float targets, the sim is off and the plugin
    // still paints the analytic wet band.
    await loading.phase("deformation", 0.6);
    let deform = null;
    let contact = null;
    if (DeformationField.supported(engine)) {
        deform = new DeformationField(scene);
        await deform.warmUp();
        contact = new SnowContact(character, deform, null, null);
    } else {
        console.warn("[sand-sim] half-float RTT unavailable — deformation off on WebGL");
    }
    new SandDeformPlugin(groundMat, deform);

    const overlay = new Overlay({ rig, character });
    if (deform) overlay.attach({ deform });
    initInput(canvas, { onToggleOverlay: () => overlay.toggle() });

    // ------------------------------------------------------------------ post
    // The stock pipeline stands in for the custom WGSL chain: ACES + grain.
    await loading.phase("post", 0.8);
    const pipe = new DefaultRenderingPipeline("post", true, scene, [rig.camera]);
    pipe.imageProcessing.toneMappingEnabled = true;
    pipe.imageProcessing.toneMappingType = 1; // ACES
    pipe.imageProcessing.exposure = 1.15;
    pipe.imageProcessing.contrast = 1.05;
    pipe.grainEnabled = true;
    pipe.grain.intensity = 7;
    pipe.grain.animated = true;
    pipe.fxaaEnabled = false; // aliasing is period-correct (docs/11)

    // Scribble/pastel pass — created after the pipeline so it attaches behind
    // the tone mapping. Shared GLSL implementation, shared cross-lab dials.
    // Note: ignoreSky here rides Babylon's DepthRenderer, which draws the sky
    // dome's real geometry — if the mask misbehaves, turn "ignore sky" off.
    const scribble = createScribble(scene, rig.camera, engine, {},
        { PostProcess, DynamicTexture, Texture, Effect });
    attachScribblePanel({
        supports: PASTEL_KEYS.filter((k) => k !== "skyDepth"),
        get: (k) => (k === "on" ? (scribble.isOn ? 1 : 0) : scribble.params[k]),
        apply: (k, v) => {
            if (k === "on") scribble.enable(v > 0.5);
            else if (k === "ignoreSky") scribble.set("ignoreSky", v > 0.5);
            else scribble.set(k, v);
        },
        note: "Pastel only — sand-sim keeps its own tonemap in the overlay.",
    });
    if (!("on" in loadScribbleSettings())) scribble.enable(true);

    // ------------------------------------------------------------- run loop
    let prev = performance.now();

    // ------------------------------------------------------------ the crouch
    // One scene. Crouching is a camera move with the bed waking behind it —
    // see scene/crouch.js.
    const prompt = createCrouchPrompt();
    // rock-sift's own sweep, carry and examine, constructed against this
    // camera and this bed — see scene/siftInteraction.js.
    // The sand the beds have been resting in, and the holes sifting leaves.
    // Built after the beds because it is derived from the transforms they were
    // placed with.
    const imprints = beds ? new Imprints(terrain, beds, deform) : null;
    // The walker grounds on the DUG terrain from here on, so a bed that has
    // been sifted is one you stand lower in. Reassigned rather than passed at
    // construction because the imprints are derived from bed transforms that do
    // not exist until after the controller is built.
    if (imprints) character.terrain = imprints.wrapTerrain();
    const sift = physics ? createSiftInteraction(scene, rig.camera, physics) : null;
    const crouch = physics
        ? new Crouch({
            rig, character, physics, beds,
            interaction: sift?.interaction, examine: sift?.examine, imprints,
            // Sifting is done with the cursor, so crouching gives it back and
            // standing up takes it again. `allowPointerLock` is what stops the
            // canvas click handler from grabbing it straight back — without it
            // the first click on a stone re-locks and the bed goes dead.
            pointer: {
                release() {
                    allowPointerLock(false);
                    // The world's cursor tools go with it: while sifting, the
                    // only thing allowed to disturb the sand is the stones.
                    allowWorldTools(false);
                    document.exitPointerLock?.();
                },
                restore() {
                    allowPointerLock(true);
                    allowWorldTools(true);
                },
            },
        })
        : null;
    // A knelt player leans; they do not turn around. See scene/crouch.js.
    if (crouch) rig.lookFilter = (pose) => crouch.clampLook(pose);
    let nearSpot = null;    // the spot under the player, or null

    window.addEventListener("keydown", (e) => {
        if (!crouch) return;
        // One key, both directions — see Crouch.toggle.
        if (e.code === "KeyE") {
            if (crouch.toggle(nearSpot)) prompt.show(false);
        } else if (e.key === "Escape" && crouch.spot && !crouch.isMoving) {
            crouch.leave();
        }
    });

    engine.runRenderLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;

        pollInput();
        const tFrame = performance.now();

        // Crouched, the walker is frozen and everything the stones touch keeps
        // running — which is the point of being in this scene. The sand sim is
        // still only stepping because something is disturbing it; while sifting
        // that something is the bed rather than the boots.
        const knelt = crouch ? crouch.update(dt) : false;
        if (!knelt) {
            character.update(dt, rig);
            clampToPlayRect(character.position);
            if (contact) contact.update(dt);
        }

        // Proximity for the crouch prompt. spotAt measures to the pad's flat
        // region — standing out on the blend is not standing at the bed.
        nearSpot = crouch && !crouch.engaged
            ? spotAt(character.position.x, character.position.z)
            : null;
        prompt.show(!!nearSpot);

        // Keep the nearest bed's dents drawn. Rare and cheap; see Imprints.tick.
        if (!knelt) imprints?.tick(dt, character.position.x, character.position.z);

        rig.update(dt, character.position);
        sky.update();
        sky.render(rig, 0);
        sun.direction.set(-sky.sunDir.x, -sky.sunDir.y, -sky.sunDir.z);
        water.update(dt);
        // After contact staged its brushes, before the render consumes them.
        if (deform) deform.update(dt, character.position);

        scene.render();
        const tRender = performance.now();

        mark("cpu total", tRender - tFrame);
        endFrameDraws();
        stats.triangles = (ground.getTotalIndices() / 3) + 2;

        sample(dtMs);
        checkSpike(dtMs);
        overlay.update(dtMs, engine);
        endFrame();
    });

    await loading.done();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.SANDSIM = {
        renderer: "webgl2",
        engine, scene, rig, character, overlay, sky, water, ground,
        deform, contact, scribble, beds, physics, crouch, sift, imprints, imprints,
        S, input, perfStats: stats,
    };
}
