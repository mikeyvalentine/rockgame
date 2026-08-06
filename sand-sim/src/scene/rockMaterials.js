/**
 * The forge's surfacing, on the beach.
 *
 * The sifting beds used to draw with a flat `PBRMaterial` per stone whose albedo
 * was `shape.colour` — the one number the forge exposes without its shader. On
 * the WebGL path that read as plasticine; on the WebGPU path, whose scene has no
 * lights at all because the sand does its own lighting in WGSL, it read as
 * black. Neither is what the rock-forge lab spent its time on.
 *
 * So the real thing comes across: `rock-forge/src/babylon/rockMaterial.js`,
 * unchanged apart from a mode switch, with the photographed surfaces from
 * `public/assets/rock` and the procedural grain and variation maps.
 *
 * What had to change over there, and why
 * --------------------------------------
 * The forge material's vertex half exists to turn ONE shared unit sphere into
 * every rock in a field: `position` is a unit direction, and a per-instance
 * attribute says which row of a shape texture holds this rock's radii. That is
 * the right trade for thousands of scenery stones and the wrong one here — a
 * sifting bed's stones have to carry convex hulls, be picked individually, and
 * be driven by Havok, so they are real meshes with real positions.
 *
 * Handed a real mesh, the vertex half is not just redundant, it is destructive:
 * it would multiply every real position by a shape-texture radius, and the tint
 * varying would read an unbound attribute, come back zero, and paint every stone
 * black — the same symptom as the missing lights, arriving by a different route.
 * `realGeometry: true` skips that half and keeps the fragment half, which is
 * where the triplanar photo surfacing, the normal perturbation, the cavity
 * darkening and the mottle/vein/spot/band adders all live.
 *
 * The per-stone tint travels as vertex colours instead of as an instance
 * attribute. PBR folds vertex colour into `surfaceAlbedo` before the plugin's
 * hook runs, so the photograph multiplies it exactly as the tint attribute did.
 *
 * One material per FAMILY, not per stone
 * --------------------------------------
 * Roughness, grain scale, cavity strength and the adders are all properties of
 * the lithology. Forty materials would also mean forty compiled programs, since
 * the plugin deliberately gives each material a unique define so the effect
 * cache cannot swap one archetype's program for another's. Seven or so families
 * is seven programs, and the stones differ by geometry and vertex colour.
 */

import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";

import { createRockMaterials } from "../../../rock-forge/src/babylon/rockMaterial.js";
import { makeGrainTexture, makeVariationTexture } from "../../../rock-forge/src/babylon/detailTextures.js";
import { loadRockTextures } from "../../../rock-forge/src/babylon/rockTextures.js";
import { ARCHETYPES } from "../../../rock-forge/src/forge/archetypes.js";

/**
 * Per-stone albedo multiplier, as the forge computes it.
 *
 * Mirrors `rock-forge/src/main.js` `tintFor`. In photo mode the photograph
 * already carries the colour, so the tint is renormalised to average 1: it keeps
 * the archetype's hue bias and the per-stone brightness variation without
 * darkening every rock a second time by an albedo the texture has already
 * applied. A treasure has no photograph behind it, so its tint is left alone.
 */
export function tintFor(shape, jitter, photo) {
    const c = shape.colour;
    if (ARCHETYPES[shape.archetype]?.gem) {
        return c.map((v) => Math.min(1.4, v * (0.9 + (jitter - 1) * 0.5)));
    }
    if (!photo) return c.map((v) => Math.min(1, v * jitter));
    const mean = (c[0] + c[1] + c[2]) / 3 || 1;
    return c.map((v) => (0.55 + 0.45 * (v / mean)) * jitter);
}

/**
 * Build the shared textures and one material per archetype family.
 *
 * The photo surfaces are a fetch, so this is an await and belongs behind the
 * loading screen with Havok and the hulls. If the manifest is missing the
 * materials still build — the procedural grain map is enough to keep a stone
 * from looking faceted, and the beach is better with untextured rocks on it than
 * with none.
 *
 * @returns {Promise<{byFamily: Record<string, import("@babylonjs/core").PBRMaterial>, photo: boolean, notes: string[]}>}
 */
export async function createBedMaterials(scene, { detailSize = 512, surfaces = true, forge = true } = {}) {
    // `detailSize` and `surfaces` are parameters so this can be built small
    // enough for a software WebGPU adapter to accept. It turned out not to be
    // enough — that adapter refuses every `mappedAtCreation` buffer at any size,
    // so no texture ever uploads and this material cannot be compiled without
    // real hardware (see tools/wgsl-probe/README.md) — but a smaller grain map
    // costs the shader nothing and the knob is worth keeping for the next
    // attempt.
    const grainTex = makeGrainTexture(scene, { size: detailSize, grit: 64, strength: 1.25, seed: 11 });
    const varTex = makeVariationTexture(scene, { size: detailSize, seed: 4711 });

    let textures = null;
    const notes = [];
    try {
        if (surfaces) textures = await loadRockTextures(scene);
        if (textures) notes.push(...textures.notes);
    } catch (err) {
        // Loud but not fatal — see above.
        console.warn("[sand-sim] rock textures unavailable, falling back to procedural grain:", err);
        notes.push(`rock textures: ${err.message}`);
    }

    // `forge: false` is the bisect: the same materials, minus the plugin and
    // the photo surfaces, so a fault can be attributed to the shader rather
    // than to the beds existing at all. Plain PBR still needs the scene's
    // lights, so this is not the old black-stone state.
    if (!forge) {
        const plain = {};
        for (const name of Object.keys(ARCHETYPES)) {
            const m = new PBRMaterial(`rock_${name}`, scene);
            m.albedoColor = new Color3(1, 1, 1);
            m.metallic = 0;
            m.roughness = 0.75;
            plain[name] = m;
        }
        return { byFamily: plain, photo: false, notes: ["forge material bypassed (?forge=0)"], grainTex, varTex };
    }

    const byFamily = createRockMaterials(scene, null, {
        realGeometry: true,
        grainTex,
        varTex,
        surfaces: textures?.perArchetype ?? null,
        // Vertex displacement is the one part of the vertex half worth wanting,
        // and it is skipped with the rest of it. It buys ~1.2 mm of real relief
        // on a stone whose scenery LOD has 320 triangles, where the triangle
        // edge is already wider than that; and the hulls the crouch collides
        // against are built from the analytic shape, so displaced geometry would
        // disagree with them.
        heightTex: null,
    });

    // Deliberately NOT frozen: freezing pins a material to the effect it has
    // already compiled, and these need both the thin-instanced variant (the
    // scenery) and the ordinary instanced one (a woken bed). Same reasoning as
    // siftingBeds.js. `receiveShadows` is not set here either — it is a mesh
    // property, and an earlier version of this loop set it on the material,
    // where it does nothing at all.

    return { byFamily, photo: !!textures?.perArchetype, notes, grainTex, varTex };
}

/**
 * Write a stone's tint into its geometry as vertex colours.
 *
 * This is how the per-instance tint attribute crosses over: PBR multiplies
 * `surfaceAlbedo` by `vColor.rgb` before the plugin's fragment hook runs, so a
 * constant colour across a mesh's vertices is exactly the tint the instanced
 * path passes in `rockInst.yzw`.
 *
 * @param positions  the mesh's position array, to size the buffer
 * @param tint       [r, g, b]
 */
export function tintColours(positions, tint) {
    const n = positions.length / 3;
    const colours = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
        colours[i * 4] = tint[0];
        colours[i * 4 + 1] = tint[1];
        colours[i * 4 + 2] = tint[2];
        colours[i * 4 + 3] = 1;
    }
    return colours;
}

export { VertexBuffer, Color3 };
