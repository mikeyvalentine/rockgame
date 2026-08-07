/**
 * The static water plane — context, not simulation (the game's water sim is a
 * separate project; docs/09 wants the beach to *meet* water, nothing more).
 *
 * Shared by both renderers: a two-triangle PBR quad at the water level, env
 * reflections from `scene.environmentTexture`, and a scrolling CPU-generated
 * ripple normal map — rock-sift's proven recipe, constants and all.
 *
 * The quad starts at the waterline and extends seaward only; the sand carries
 * the wet look on its own side of the line (phase 5), which is what visually
 * anchors the boundary against clipmap ring morphs.
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Constants } from "@babylonjs/core/Engines/constants";

import { WATERLINE_Z, WATER_LEVEL_Y, POND_RADIUS } from "../terrain/beachParams.js";

/**
 * The pond, not a sea.
 *
 * This was a 4000 x 3600 m quad running to the horizon, which is what you build
 * when the world has no edge. It has one now (`shared/worldBounds.js`): a disc
 * of radius 100, its near rim on the waterline. The bank it ends against is the
 * beach profile's own, raised by the same foreshore slope measured from that
 * same rim — so the two meet at y = 0 all the way round by construction rather
 * than by being lined up here.
 *
 * Round rather than square because the shoreline is what the player stands on,
 * and a disc gives it curvature: the water is nearest straight ahead and falls
 * back on both sides, so the strip is a shallow bay instead of a pool edge.
 */
/**
 * Segments around the rim.
 *
 * 128 puts a vertex every 4.9 m, which at the 100 m across the pond is well
 * under a pixel of chord error — and the rim is where the water meets a sand
 * edge that curves smoothly, so a coarse polygon reads as a crease.
 */
const RIM_SEGMENTS = 128;

/**
 * The quad sits a hair below the true water level so it cannot z-fight the
 * sand exactly at the waterline; the wet band owns that pixel-wide seam.
 */
const SINK = 0.02;

/**
 * @param {import("@babylonjs/core/scene").Scene} scene
 * @returns {{ mesh: import("@babylonjs/core/Meshes/mesh").Mesh,
 *             material: PBRMaterial, update(dt:number):void }}
 */
export function buildWater(scene) {
    const mesh = CreateDisc("water", {
        radius: POND_RADIUS, tessellation: RIM_SEGMENTS,
    }, scene);
    // CreateDisc builds in the XY plane facing +Z; lay it flat.
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(0, WATER_LEVEL_Y - SINK, WATERLINE_Z + POND_RADIUS);
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    // Alpha-blended, after the opaque sand — group 2, like the spray.
    mesh.renderingGroupId = 2;

    const mat = new PBRMaterial("waterMat", scene);
    mat.albedoColor = new Color3(0.06, 0.13, 0.15);
    mat.metallic = 0.05;
    mat.roughness = 0.08;
    mat.environmentIntensity = 1.1;
    mat.alpha = 0.92;

    const ripple = makeRippleNormalTexture(scene, 256, 5, 3, 0.9, 55);
    ripple.uScale = 24;
    ripple.vScale = 24;
    mat.bumpTexture = ripple;
    mat.invertNormalMapY = true;
    mesh.material = mat;

    let t = 0;
    return {
        mesh,
        material: mat,
        /** Scroll the ripples. Cheap; called once per frame. */
        update(dt) {
            t += dt;
            ripple.uOffset = t * 0.012;
            ripple.vOffset = t * 0.0072;
        },
    };
}

/**
 * CPU-generated tiling normal map from value-noise fbm — the engine-agnostic
 * port of rock-sift's `makeNoiseNormalTexture`. DynamicTexture so it works
 * identically on both renderers.
 */
function makeRippleNormalTexture(scene, size, freq, octaves, strength, seed) {
    // --- tiling value-noise heightfield ------------------------------------
    const rand = mulberry32(seed);
    const grid = 16;
    const lattice = new Float32Array(grid * grid);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

    const latAt = (x, y) => lattice[((y % grid + grid) % grid) * grid + ((x % grid + grid) % grid)];
    const noiseAt = (u, v) => {
        const x = u * grid;
        const y = v * grid;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const fx = x - ix;
        const fy = y - iy;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const a = latAt(ix, iy);
        const b = latAt(ix + 1, iy);
        const c = latAt(ix, iy + 1);
        const d = latAt(ix + 1, iy + 1);
        return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    };

    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let sum = 0;
            let amp = 0.5;
            let f = freq;
            for (let o = 0; o < octaves; o++) {
                // fract() keeps every octave tiling.
                sum += noiseAt((x / size * f) % 1, (y / size * f) % 1) * amp;
                f *= 2;
                amp *= 0.5;
            }
            h[y * size + x] = sum;
        }
    }

    // --- heightfield → tangent-space normal map ----------------------------
    const tex = new DynamicTexture("rippleNormal", size, scene, true);
    const ctx = tex.getContext();
    const img = ctx.createImageData(size, size);
    const px = img.data;
    const wrap = (v) => ((v % size) + size) % size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (h[y * size + wrap(x + 1)] - h[y * size + wrap(x - 1)]) * strength * size * 0.5;
            const dy = (h[wrap(y + 1) * size + x] - h[wrap(y - 1) * size + x]) * strength * size * 0.5;
            const inv = 1 / Math.hypot(dx, dy, 1);
            const o = (y * size + x) * 4;
            px[o] = (-dx * inv * 0.5 + 0.5) * 255;
            px[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
            px[o + 2] = (inv * 0.5 + 0.5) * 255;
            px[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    tex.update(false);
    tex.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    tex.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    return tex;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
