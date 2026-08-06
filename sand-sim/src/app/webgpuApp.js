/**
 * The full-fidelity renderer: SNOWFLOW's WGSL pipeline, first person, HDRI-lit.
 *
 * This is the former `main.js` body. The boot loader (`src/main.js`) has
 * already decided WebGPU is available; a device-creation failure here is
 * flagged with `err.webgpuInit` so the loader can retry the page on WebGL.
 */

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
// Side-effect import: installs `captureGPUFrameTime` / `getGPUFrameTimeCounter`
// onto the engine prototype, which is what makes the overlay's GPU row a real
// GPU number rather than the presentation cadence.
import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.timeQuery";
// Side-effect import: installs createDynamicTexture/updateDynamicTexture on
// the WebGPU engine. SNOWFLOW never used DynamicTexture, so nothing else in
// the import graph pulls this in — without it MaskPaint and the water ripple
// throw "engine.createDynamicTexture is not a function" at boot.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";
import { Scene } from "@babylonjs/core/scene";
import { Color3, Color4 } from "@babylonjs/core/Maths/math";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";

import { registerShaders } from "../shaders/registry.js";
import { S, onChange } from "../core/settings.js";
import {
    sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "../core/perf.js";
import { initInput, pollInput, endFrame, input, allowPointerLock, allowWorldTools } from "../core/input.js";
import { FpsRig } from "../core/camera.js";
import { CharacterController } from "../character/controller.js";
import { SnowContact } from "../character/snowContact.js";
import { SprayField } from "../vfx/particles.js";
import { GrainField } from "../vfx/grains.js";
import { Overlay } from "../ui/overlay.js";
import { HdriEnvironment } from "../render/environment.js";
import { ShadowSystem } from "../render/shadows.js";
import { Terrain } from "../terrain/terrain.js";
import { SPAWN } from "../terrain/beachParams.js";
import { MaskPaint } from "../terrain/maskPaint.js";
import { initMaskBrush } from "../tools/maskBrush.js";
import { DigTool } from "../tools/dig.js";
import { buildWater } from "../scene/water.js";
import { buildSiftingBeds } from "../scene/siftingBeds.js";
import { loadSiftPhysics } from "../scene/siftPhysics.js";
import { Crouch, spotAt } from "../scene/crouch.js";
import { createCrouchPrompt } from "../scene/crouchPrompt.js";
import { createSiftInteraction } from "../scene/siftInteraction.js";
import { Imprints } from "../scene/imprints.js";
import { DepthPass } from "../render/depthPass.js";
import { PostChain } from "../post/postChain.js";
import { createScribblePass } from "../post/scribblePass.js";
import {
    attachScribblePanel, loadScribbleSettings, PASTEL_KEYS,
} from "../../../shared/scribble-dials.js";
import { whenReady } from "../core/gpuUtil.js";
import * as loading from "../core/loading.js";

/** @param {HTMLCanvasElement} canvas */
export async function run(canvas) {
    await loading.phase("creating device", 0.05);

    const engine = new WebGPUEngine(canvas, {
        antialias: false, // TAA handles edges; MSAA here would just cost bandwidth
        stencil: false,
        powerPreference: "high-performance",
        enableAllFeatures: true,
        setMaximumLimits: true,
    });

    try {
        await engine.initAsync();
    } catch (err) {
        // Marker for the loader: this specific failure is worth a WebGL retry.
        const e = new Error("WebGPU device initialisation failed.");
        e.webgpuInit = true;
        e.cause = err;
        throw e;
    }

    // The heightfield is R32F and is filtered in the vertex shader, which needs
    // this feature. Every desktop GPU that can run this demo has it.
    const filterable = engine.getCaps().textureFloatLinearFiltering;
    if (!filterable) {
        console.warn("[sand-sim] float32-filterable unavailable; height will step");
    }

    const applyScale = () => engine.setHardwareScalingLevel(1 / S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => engine.resize());

    installDrawCounter(engine);
    // WebGPU timestamp queries. The engine is created with `enableAllFeatures`,
    // so `timestamp-query` is on wherever the adapter has it; if it does not,
    // the counter simply stays at zero and the overlay shows a dash.
    engine.captureGPUFrameTime(true);
    registerShaders();

    await loading.phase("building scene", 0.12);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    scene.autoClear = true;
    // Do NOT clear depth between rendering groups. Babylon clears depth before
    // every group by default; here group 1 is the opaque scene and group 2 is
    // the alpha-blended spray (and later the water), which must depth-test
    // against it.
    scene.setRenderingAutoClearDepthStencil(1, false);
    scene.setRenderingAutoClearDepthStencil(2, false);
    scene.ambientColor = new Color3(0, 0, 0);

    const rig = new FpsRig(scene, canvas);
    scene.activeCamera = rig.camera;

    // ------------------------------------------------------------------ sky
    await loading.phase("loading sky", 0.2);
    const sky = new HdriEnvironment(scene);
    sky.mesh.renderingGroupId = 0;
    await sky.solve();
    // PBR env (the water's reflections). Fire-and-forget; see attachCube.
    sky.attachCube();

    // ---------------------------------------------------------------- lights
    // For a long time this path had none, and correctly so: the terrain, sky,
    // water and spray all compute their own lighting in WGSL, and a stock light
    // would have been a uniform nothing read.
    //
    // The sifting beds changed that. Their stones are ordinary PBR meshes — they
    // have to be, because they also carry convex hulls and get picked — and a
    // PBR mesh in a scene with no lights and no reflection texture yet is BLACK.
    // That is what the beds were, in every screenshot of the deployed WebGPU
    // build, and it read as a material bug rather than as a missing light.
    //
    // Matched to the WebGL path's pair rather than invented, so a stone shades
    // the same on both renderers.
    const sun = new DirectionalLight(
        "sun", new Vector3(-sky.sunDir.x, -sky.sunDir.y, -sky.sunDir.z), scene
    );
    sun.diffuse = new Color3(sky.sunColor.r, sky.sunColor.g, sky.sunColor.b);
    sun.intensity = 2.2;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.diffuse = new Color3(0.55, 0.66, 0.82);
    hemi.groundColor = new Color3(0.42, 0.40, 0.36);
    hemi.intensity = 0.35;

    // -------------------------------------------------------------- shadows
    const shadows = new ShadowSystem(scene);

    // The camera-space depth prepass. It is a custom render target, and the
    // scene renders those in registration order — so creating it here, after
    // the cascades and before anything that draws, is the whole of the
    // scheduling.
    const depthPass = new DepthPass(scene);

    // -------------------------------------------------------------- terrain
    await loading.phase("baking heightfield", 0.34);
    const terrain = new Terrain(scene, sky, shadows);
    terrain.mesh.renderingGroupId = 1;
    await terrain.build();
    onChange("showTerrain", (v) => (terrain.mesh.isVisible = v));
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

    // The paint mask must be attached before the material warms up — the sand
    // material declares its sampler.
    const maskPaint = new MaskPaint(scene);
    terrain.attachMask(maskPaint);

    // ---------------------------------------------------------------- water
    // Static context plane (no water sim). It must join the depth prepass or
    // TAA/DOF/shafts treat its pixels as sky — see waterPrepass.vertex.wgsl.
    const water = buildWater(scene);
    const waterPrepassMat = new ShaderMaterial(
        "waterPrepass",
        scene,
        { vertex: "waterPrepass", fragment: "prepass" },
        {
            attributes: ["position"],
            uniforms: ["world", "viewProjection"],
            shaderLanguage: ShaderLanguage.WGSL,
        }
    );
    waterPrepassMat.backFaceCulling = false;
    depthPass.registerCaster(water.mesh, waterPrepassMat);

    await loading.phase("placing walker", 0.62);

    const character = new CharacterController(terrain);
    character.position.set(SPAWN.x, 0, SPAWN.z);
    character.position.y = terrain.heightAt(SPAWN.x, SPAWN.z);
    rig.yaw = SPAWN.yaw; // facing the sea

    // Airborne dust (fades) and the persistent loose-grain layer (rolls,
    // settles, deposits back into the heightfield).
    const spray = new SprayField(scene, terrain, sky, shadows);
    const grains = new GrainField(scene, terrain, sky, shadows);

    // Feet write into the terrain state buffer through here. No posed figure —
    // the controller's gait events are the source (see SnowContact).
    const contact = new SnowContact(character, terrain.deform, null, spray, grains);
    const dig = new DigTool(rig.camera, terrain, spray, grains);

    const post = new PostChain(scene, rig.camera, depthPass, sky);

    // Scribble/pastel pass, appended AFTER the chain so it reads the
    // display-encoded frame. Always attached, toggled by uniform — see the
    // chain's own note on why passes never detach. Dials are the shared
    // cross-lab panel (rockgame/shared); pastel keys only, because sand-sim's
    // exposure/tonemap already live in its overlay settings.
    const scribble = createScribblePass(scene, rig.camera, depthPass.rtt);
    attachScribblePanel({
        supports: PASTEL_KEYS.filter((k) => k !== "skyDepth"),
        get: (k) => (k === "on" ? (scribble.params.enabled ? 1 : 0) : scribble.params[k]),
        apply: (k, v) => {
            if (k === "on") scribble.set("enabled", v > 0.5);
            else if (k === "ignoreSky") scribble.set("ignoreSky", v > 0.5);
            else scribble.set(k, v);
        },
        note: "Pastel only — sand-sim keeps its own tonemap in the overlay.",
    });
    // The game's look defaults ON; the store only overrides if the user
    // switched it off somewhere.
    if (!("on" in loadScribbleSettings())) scribble.set("enabled", true);

    const overlay = new Overlay({ rig, character });
    overlay.attach({ deform: terrain.deform, grains });
    initInput(canvas, { onToggleOverlay: () => overlay.toggle() });
    initMaskBrush(canvas, scene, rig.camera, (x, z) => terrain.heightAt(x, z), maskPaint);

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    // ------------------------------------------------------- sifting beds
    // The stones on the piles: baked beds from rock-sift, drawn as scenery on
    // each crown. No physics — the bed only wakes when the player crouches.
    await loading.phase("laying the beds", 0.72);
    // Group 1, with the terrain, NOT the default 0.
    //
    // This path splits the scene into three rendering groups — 0 sky, 1 opaque,
    // 2 alpha — and only group 0 still auto-clears depth. A mesh that does not
    // say which group it is in lands in 0, which means the stones were being
    // drawn with the SKY: before the terrain they lie on, and writing depth
    // into a buffer that the opaque pass then does not clear. The WebGL path
    // has no groups at all, so nothing there ever said this was wrong.
    //
    // `?beds=0` skips them entirely and `?forge=0` draws them with a plain
    // material instead of the forge one. Two URL flags rather than two deploys:
    // WebGPU cannot be run in the dev container (the software adapter refuses
    // every mappedAtCreation buffer, so no texture ever uploads and no material
    // ever compiles), so when this path misbehaves on a real GPU the fastest
    // way to find out whether the beds are involved is to be able to turn them
    // off from the address bar.
    const q = new URLSearchParams(location.search);
    const beds = q.get("beds") === "0" ? null : await buildSiftingBeds(scene, terrain, {
        renderingGroupId: 1,
        forgeMaterial: q.get("forge") !== "0",
    });
    if (beds) console.log(`[sand-sim] ${beds.stones} stones across ${beds.spots} spots`);

    // Behind the loading screen, so the crouch is a camera move and not a load.
    await loading.phase("waking the stones", 0.75);
    const physics = beds ? await loadSiftPhysics(scene) : null;
    const prompt = createCrouchPrompt();
    // rock-sift's own sweep, carry and examine, constructed against this
    // camera and this bed — see scene/siftInteraction.js.
    // The sand the beds have been resting in, and the holes sifting leaves.
    // Built after the beds because it is derived from the transforms they were
    // placed with.
    const imprints = beds ? new Imprints(terrain, beds, terrain.deform) : null;
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
    let nearSpot = null;

    window.addEventListener("keydown", (e) => {
        if (!crouch) return;
        // One key, both directions — see Crouch.toggle.
        if (e.code === "KeyE") {
            if (crouch.toggle(nearSpot)) prompt.show(false);
        } else if (e.key === "Escape" && crouch.spot && !crouch.isMoving) {
            crouch.leave();
        }
    });

    await loading.phase("compiling pipelines", 0.78);
    shadows.update(rig.camera, sky.sunDir);
    sky.render(rig, 0);
    await terrain.warmUp();
    terrain.update(rig.camera.position, character.position, 0);
    spray.update(0, rig.camera.position);
    await spray.warmUp();
    await grains.warmUp();
    await whenReady(sky.material, "sky material", [sky.mesh, false]);
    await whenReady(water.material, "water material", [water.mesh, false]);
    await depthPass.warmUp();
    post.update(0, 0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(passes[i], "post:" + passes[i].name);
    }

    await loading.phase("warming render targets", 0.92);
    // A few real frames so every render target is allocated and every pipeline
    // has actually been bound at least once.
    for (let i = 0; i < 3; i++) {
        scene.render();
        await loading.nextFrame();
    }

    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        time += dt;

        pollInput();

        // Per-system CPU timing. Babylon's WebGPU timestamp queries are
        // whole-frame, so the GPU row is a total and these are not subdivisions
        // of it — the overlay labels them `cpu` for that reason.
        const tFrame = performance.now();

        // Crouched, the walker is frozen and everything the stones touch keeps
        // running — see scene/crouch.js on why "pausing the sim" means freezing
        // the walker rather than the world.
        const knelt = crouch ? crouch.update(dt) : false;
        if (!knelt) {
            character.update(dt, rig);
            terrain.heightfield.clampToPlayArea(character.position);
            contact.update(dt);
            dig.update();
        }
        nearSpot = crouch && !crouch.engaged
            ? spotAt(character.position.x, character.position.z)
            : null;
        prompt.show(!!nearSpot);

        // Keep the nearest bed's dents drawn. Rare and cheap; see Imprints.tick.
        if (!knelt) imprints?.tick(dt, character.position.x, character.position.z);
        // While a dig stroke is held the ground is *changing* every 60 ms;
        // TAA history reprojected across that shows the previous crater
        // shapes as layered translucent facet-ghosts. No history while
        // actively carving — it re-accumulates the instant the button lifts.
        if (input.dig && input.locked) post.resetHistory();
        const tChar = performance.now();

        // The rig follows the controller; must run before anything that reads
        // the camera this frame.
        rig.update(dt, character.position);

        // Jitters the projection and republishes everything the screen-space
        // passes derive from the camera. Must be after the rig has moved and
        // before anything reads `scene.getTransformMatrix()` — which the depth
        // prepass and the beauty pass both do.
        post.update(dt, 0, rig.distance);
        sky.update();
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        terrain.update(rig.camera.position, character.position, dt);
        const tTerrain = performance.now();
        water.update(dt);
        spray.update(dt, rig.camera.position);
        grains.update(dt, rig.camera.position);
        const tVfx = performance.now();

        scene.render();
        post.endFrame();
        const tRender = performance.now();

        mark("cpu character", tChar - tFrame);
        mark("cpu terrain", tTerrain - tChar);
        mark("cpu spray", tVfx - tTerrain);
        mark("cpu submit", tRender - tVfx);
        mark("cpu total", tRender - tFrame);
        stats.gpuMs = engine.getGPUFrameTimeCounter().lastSecAverage / 1e6;

        endFrameDraws();
        stats.triangles =
            (terrain.mesh.metadata ? terrain.mesh.metadata.triangles : 0) +
            spray.liveCount * 2 + grains.liveCount * 2;

        sample(dtMs);
        checkSpike(dtMs);
        overlay.update(dtMs, engine);

        endFrame();
    });

    await loading.done();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.SANDSIM = {
        renderer: "webgpu",
        engine, scene, rig, character, contact, dig, spray, grains, water,
        maskPaint, overlay, terrain, sky, shadows, post, depthPass, scribble, beds,
        physics, crouch, sift, imprints,
        S, input, perfStats: stats,
    };
}
