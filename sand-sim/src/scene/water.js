/**
 * The pond surface — the ambient water sim, brought in from babylon-water.
 *
 * This was a static PBR disc with a scrolling noise normal map. It is now the
 * lab's analytic surface: four wind-turned octaves with deep-water dispersion,
 * generated from `shared/ambientWater.js` (the `ambientWater` shader include),
 * so the world renders the exact water the solver planes on and the lab tunes.
 * Both renderers run it — WGSL on WebGPU, the GLSL twin on WebGL — from that
 * one octave table.
 *
 * The one thing the world does that the lab does not: the reflection is a
 * PLANAR MIRROR of the scene (trees, shore, sky) rather than the lab's sky
 * cubemap, because the world has a forest to catch on the water. The mirror's
 * render list is filled by the app after the scenery exists (`setReflection`);
 * the 117k shore rocks are deliberately kept OUT of it — a second pass over
 * them would not survive the floor machine and they are a centimetre of pebble
 * a reflection will never resolve anyway.
 *
 * Open surface only, by the current scope: no interaction/drop ripples (that is
 * the skip sim, not wired yet). The wave field is anchored to world xz and is a
 * pure function of (x, z, t), so it stays in lockstep with the physics twin.
 *
 * The shore. When a baked terrain grid is handed in (`opts.terrain`), the
 * surface reads terrain HEIGHT per pixel and ends its foam/shallows/fade on the
 * real waterline of the authored ground — which is not a circle (its radius
 * varies ~25 m around this pond). Without a grid it falls back to a circle SDF
 * from the pond centre, which is what the standalone lab and the WebGPU path
 * (terrain not yet wired there) still use.
 *
 * Conventions unchanged: metres, water toward +Z, waterline at WATERLINE_Z.
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { MirrorTexture } from "@babylonjs/core/Materials/Textures/mirrorTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";

import {
    WATERLINE_Z, WATER_LEVEL_Y, POND_RADIUS,
    POND_CENTER_X, POND_CENTER_Z, FORESHORE_SLOPE, SEABED_DEPTH,
} from "../terrain/beachParams.js";
import { POND_CONDITIONS } from "../../../shared/ambientWater.js";
import { S } from "../core/settings.js";

/** Segments around the rim — a vertex every ~4.9 m, under a pixel of chord. */
const RIM_SEGMENTS = 128;

/** A hair below true level so the surface cannot z-fight the wet sand seam. */
const SINK = 0.02;

/**
 * Mirror render-target scale. Was 0.5 (half res), which read blocky once the
 * wave distortion magnified the texels; 0.75 is sharper without paying for a
 * full-resolution second scene render (the tree ring makes the mirror pass the
 * expensive one, so this is the main perf lever — dial back toward 0.5 if the
 * floor machine drops frames).
 */
const MIRROR_RATIO = 0.75;

/**
 * Gaussian blur on the mirror, in adaptive kernel units (scaled by RT size, so
 * it looks the same at any ratio). A little blur is what water reflections
 * actually look like and it hides the render target's remaining pixelation —
 * the reflection is rippled and never wants to be a crisp mirror.
 */
const MIRROR_BLUR = 16;

/** How far the wave slope drags the reflection sample, in UV. */
const DISTORTION = 0.02;

/**
 * Water disc overshoot past the pond radius, metres. The authored basin reaches
 * a little past POND_RADIUS in places (shore radius measured 75–101 m); the
 * extra ring is faded out by the terrain-depth alpha on land and occluded by
 * the higher sand, so it only guarantees the whole basin is covered.
 */
const DISC_MARGIN = 15;

/**
 * @param {import("@babylonjs/core/scene").Scene} scene
 * @param {{ terrain?: { grid: Float32Array, gridRes: number,
 *           gridOrigin: {x:number,z:number}, gridSize: number } }} [opts]
 *   terrain = the baked ground grid (worldEnv.terrain); when given, the shore
 *   follows it instead of a circle.
 * @returns {{ mesh: import("@babylonjs/core/Meshes/mesh").Mesh,
 *             material: ShaderMaterial, mirror: MirrorTexture,
 *             setReflection(meshes: any[]): void, update(dt:number, camera:any):void }}
 */
export function buildWater(scene, opts = {}) {
    const engine = scene.getEngine();
    const wgpu = !!engine.isWebGPU;
    const terrain = opts.terrain && opts.terrain.grid ? opts.terrain : null;

    const mesh = CreateDisc("water", {
        radius: POND_RADIUS + (terrain ? DISC_MARGIN : 0), tessellation: RIM_SEGMENTS,
    }, scene);
    mesh.rotation.x = Math.PI / 2; // CreateDisc faces +Z; lay it flat
    mesh.position.set(0, WATER_LEVEL_Y - SINK, WATERLINE_Z + POND_RADIUS);
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true; // its bounds move with the waves
    mesh.renderingGroupId = 2; // alpha group, after the opaque sand

    // Planar mirror of the scene, at the water level. Render list filled later.
    const mirror = new MirrorTexture(
        "waterMirror",
        { ratio: MIRROR_RATIO },
        scene,
        /* generateMipMaps */ true
    );
    // Plane normal points down (-y); Babylon reflects the far side (above), which
    // is the sky and the tree line. d = level so the plane sits on the surface.
    mirror.mirrorPlane = new Plane(0, -1, 0, WATER_LEVEL_Y);
    mirror.renderList = [];
    // A gentle gaussian softens the half-ish-res reflection into something that
    // reads as water rather than a pixelated mirror; the in-shader lod blur on
    // top is the extra roughness from unresolved ripples (see the fragment).
    mirror.adaptiveBlurKernel = MIRROR_BLUR;
    mirror.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    mirror.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    // A MirrorTexture only renders on its own when it is the reflectionTexture of
    // a StandardMaterial; bound into a custom ShaderMaterial by hand it must be
    // registered as a scene render target or it never draws and reads back black.
    if (!scene.customRenderTargets.includes(mirror)) {
        scene.customRenderTargets.push(mirror);
    }

    const mat = new ShaderMaterial(
        "water",
        scene,
        { vertex: "water", fragment: "water" },
        {
            attributes: ["position"],
            uniforms: [
                "world", "viewProjection", "time", "windDir", "windStrength",
                "waveScale", "detailScale", "cameraPosition", "sunDir", "tint",
                "blurGain", "distortion",
                "pondCenter", "pondRadius", "foreshoreSlope", "seabedDepth",
                "useTerrainDepth", "terrainOrigin", "terrainSize", "waterLevelY",
            ],
            samplers: ["reflectionTex", "terrainHeightTex"],
            shaderLanguage: wgpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
        }
    );
    mat.backFaceCulling = false;
    // Alpha blend so the surface can fade to nothing on the shore contour and
    // reveal the wet sand under its edge. A hair under 1 is what turns blending
    // on for a ShaderMaterial; the real per-pixel alpha comes from the shader.
    mat.alpha = 0.999;
    mat.alphaMode = Constants.ALPHA_COMBINE;
    mat.setTexture("reflectionTex", mirror);
    mat.setColor3("tint", new Color3(0.10, 0.20, 0.24));
    mat.setFloat("detailScale", 1.0);
    mat.setFloat("blurGain", 1.0);
    mat.setFloat("distortion", DISTORTION);
    mat.setVector3("sunDir", new Vector3(0.3, 0.6, 0.74).normalize());
    mat.setVector2("pondCenter", new Vector2(POND_CENTER_X, POND_CENTER_Z));
    mat.setFloat("pondRadius", POND_RADIUS);
    mat.setFloat("foreshoreSlope", FORESHORE_SLOPE);
    mat.setFloat("seabedDepth", SEABED_DEPTH);
    mat.setFloat("waterLevelY", WATER_LEVEL_Y);

    // Terrain-driven shore: upload the baked height grid and let the shader end
    // the water on the real waterline. R32F, clamped; the sampler is always
    // declared, so a 1x1 stand-in is bound when there is no terrain to keep the
    // binding valid on both shader languages.
    if (terrain) {
        const tex = RawTexture.CreateRTexture(
            terrain.grid, terrain.gridRes, terrain.gridRes, scene,
            /* genMips */ false, /* invertY */ false,
            Constants.TEXTURE_BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT
        );
        tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        mat.setTexture("terrainHeightTex", tex);
        mat.setFloat("useTerrainDepth", 1);
        mat.setVector2("terrainOrigin", new Vector2(terrain.gridOrigin.x, terrain.gridOrigin.z));
        mat.setFloat("terrainSize", terrain.gridSize);
    } else {
        mat.setTexture("terrainHeightTex",
            RawTexture.CreateRTexture(new Float32Array([0]), 1, 1, scene, false, false,
                Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT));
        mat.setFloat("useTerrainDepth", 0);
        mat.setVector2("terrainOrigin", new Vector2(0, 0));
        mat.setFloat("terrainSize", 1);
    }
    mesh.material = mat;

    const windDir = new Vector2();
    let t = 0;

    /** Read the day's wind from settings, falling back to POND_CONDITIONS. */
    function wind() {
        const strength = S.waterWind !== undefined ? S.waterWind : POND_CONDITIONS.windStrength;
        const deg = S.waterWindDir !== undefined ? S.waterWindDir : POND_CONDITIONS.windDirDeg;
        const scale = S.waterWaveScale !== undefined ? S.waterWaveScale : POND_CONDITIONS.waveScale;
        const rad = (deg * Math.PI) / 180;
        windDir.set(Math.cos(rad), Math.sin(rad));
        return { strength, scale };
    }

    return {
        mesh,
        material: mat,
        mirror,
        /** Add scenery the water should reflect. Rocks are deliberately excluded. */
        setReflection(meshes) {
            for (const m of meshes) if (m) mirror.renderList.push(m);
        },
        /** Advance the surface and republish per-frame uniforms. */
        update(dt, camera) {
            t += dt;
            const { strength, scale } = wind();
            mat.setFloat("time", t);
            mat.setVector2("windDir", windDir);
            mat.setFloat("windStrength", strength);
            mat.setFloat("waveScale", scale);
            if (camera) mat.setVector3("cameraPosition", camera.position);
        },
    };
}
