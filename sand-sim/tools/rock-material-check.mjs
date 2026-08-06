// The forge material, as sand-sim uses it — real geometry, both dialects.
//
// The beds' stones are drawn by `rock-forge/src/babylon/rockMaterial.js` in its
// real-geometry mode, and that mode has to emit TWO shaders: GLSL for the WebGL
// fallback, WGSL for the WebGPU path that is the primary renderer. Neither can
// be compiled here — a NullEngine has no GPU and this container has no WebGPU at
// all — so what is checkable is everything up to the compiler:
//
//   - the plugin is accepted by a WGSL material at all. This one is not
//     cosmetic: `MaterialPluginManager` THROWS on an incompatible plugin, and
//     `PBRMaterial` picks WGSL by itself on a WebGPU engine. Get it wrong and
//     the beach does not render with black stones, it does not render.
//   - both dialects emit code at every injection point they claim, with
//     balanced braces and no leftovers from the other dialect.
//   - the vertex half really is skipped: real geometry must not be rescaled by
//     a shape texture, and must not read the instance attributes that are not
//     bound. A stray `rockInst` here is exactly the black-stone bug.
//   - every family in the cast has a material to draw with.

import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";

import { RockShapePlugin, createRockMaterials } from "../../rock-forge/src/babylon/rockMaterial.js";
import { ARCHETYPES } from "../../rock-forge/src/forge/archetypes.js";
import { castSequence } from "../src/scene/siftingBeds.js";
import { tintFor, tintColours } from "../src/scene/rockMaterials.js";

let failures = 0;
const check = (n, ok, d) => { console.log((ok ? "ok   " : "FAIL ") + n + (ok || !d ? "" : " — " + d)); if (!ok) failures++; };

const engine = new NullEngine();
const scene = new Scene(engine);

/** The options sand-sim hands the plugin, with stand-ins for the textures. */
const fakeTex = { name: "stand-in" };
const OPTS = {
    realGeometry: true,
    variant: 3,
    varOffset: [0.31, 0.72],
    grainTex: fakeTex, colTex: fakeTex, nrmTex: fakeTex, aoTex: fakeTex, varTex: fakeTex,
    grainScale: 1.6, grainStrength: 0.9, cavity: 0.55, texRepeat: 0.42, varScale: 0.55,
    mottle: 0.4, band: 0.3, bandFreq: 0.72, spot: 0.2, spotColour: [0.8, 0.8, 0.8],
    vein: 0.25, veinColour: [0.9, 0.9, 0.88],
};

/** Build a plugin against a material whose shader language is forced. */
function emit(language) {
    const m = new PBRMaterial(`probe_${language}`, scene);
    // The one seam: a material takes its language from the engine, and there is
    // no WebGPU engine to be had here.
    m._shaderLanguage = language;
    const plugin = new RockShapePlugin(m, OPTS);
    return {
        vertex: plugin.getCustomCode("vertex", language) ?? {},
        fragment: plugin.getCustomCode("fragment", language) ?? {},
    };
}

let wgsl = null;
try {
    wgsl = emit(ShaderLanguage.WGSL);
    check("a WGSL material accepts the plugin", true);
} catch (err) {
    check("a WGSL material accepts the plugin", false, String(err));
}

const glsl = emit(ShaderLanguage.GLSL);
check("a GLSL material accepts the plugin", true);

// ---------------------------------------------------------------------------
// Both dialects, same shape
// ---------------------------------------------------------------------------

for (const [name, code] of [["GLSL", glsl], ["WGSL", wgsl]]) {
    if (!code) continue;
    check(name + " emits a vertex definitions block", !!code.vertex.CUSTOM_VERTEX_DEFINITIONS);
    check(name + " emits a vertex position hook", !!code.vertex.CUSTOM_VERTEX_UPDATE_POSITION);
    check(name + " emits the world basis at vertex end", !!code.vertex.CUSTOM_VERTEX_MAIN_END);
    check(name + " emits a fragment definitions block", !!code.fragment.CUSTOM_FRAGMENT_DEFINITIONS);
    check(name + " emits the surfacing hook", !!code.fragment.CUSTOM_FRAGMENT_BEFORE_LIGHTS);

    const all = Object.values(code.vertex).join("\n") + "\n" + Object.values(code.fragment).join("\n");

    let depth = 0;
    let minDepth = 0;
    for (const c of all) {
        if (c === "{") depth++;
        else if (c === "}") depth--;
        minDepth = Math.min(minDepth, depth);
    }
    check(name + " braces balance", depth === 0 && minDepth === 0, "ends at " + depth);
    check(name + " parens balance",
        [...all].filter((c) => c === "(").length === [...all].filter((c) => c === ")").length);

    // The vertex half must be inert. These three attributes are the instanced
    // path's, and none of them is bound on a real-geometry mesh: `rockInst`
    // reaching the shader is what made every stone black.
    for (const attr of ["rockInst", "vertIndex", "rockVar;", "shapeTex"]) {
        check(name + " never reads " + attr.replace(";", ""), !all.includes(attr));
    }
    check(name + " leaves positionUpdated alone",
        !/positionUpdated\s*[*+]?=/.test(all),
        "real geometry must not be displaced or rescaled");

    // The tint comes from vertex colours in this mode, so the instanced
    // varying must be gone entirely — a declaration with nothing writing it is
    // how it would come back as zero.
    check(name + " carries no vRockTint", !all.includes("vRockTint"));

    // The per-material variation offset is baked in as a literal, so two
    // families do not sample the variation map identically.
    check(name + " bakes in the variation offset", all.includes("0.31000000"));
}

// Dialect purity, in both directions: plugin code is injected AFTER Babylon's
// own processing, so anything in the wrong dialect reaches the compiler as-is.
if (wgsl) {
    const w = Object.values(wgsl.vertex).join("\n") + Object.values(wgsl.fragment).join("\n");
    for (const glslism of ["texture2D(", "gl_", "uniform sampler2D", "\nin vec", "\nout vec", "vec3(", "vec2("]) {
        check("WGSL is free of `" + glslism.trim() + "`", !w.includes(glslism));
    }
    check("WGSL declares its varyings the WGSL way", w.includes("varying vRockObj: vec3f;"));
    check("WGSL reads varyings through fragmentInputs", w.includes("fragmentInputs.vRockNrm"));
    check("WGSL writes varyings through vertexOutputs", w.includes("vertexOutputs.vRockNrm"));
    check("WGSL declares a sampler per texture",
        w.includes("var colTexSampler: sampler;") && w.includes("var grainTexSampler: sampler;"));
    // Sampling goes through the triplanar helpers, which take the texture and
    // its sampler as parameters — so what proves the dialect is the helper
    // signature and the call site, not a bare fetch of a named texture.
    check("WGSL samples with textureSample", w.includes("textureSample(t, s, p.zy)"));
    check("WGSL passes texture and sampler together",
        w.includes("fn rockTri(t: texture_2d<f32>, s: sampler,"));
    check("WGSL writes the perturbed normal", w.includes("normalW = normalize("));
    check("WGSL multiplies the photograph onto the albedo",
        w.includes("surfaceAlbedo *= rockTri(colTex, colTexSampler, pT, w).rgb;"));
}

const g = Object.values(glsl.vertex).join("\n") + Object.values(glsl.fragment).join("\n");
for (const wgslism of ["fragmentInputs", "vertexOutputs", "vec3f", "textureSample(", "-> f32"]) {
    check("GLSL is free of `" + wgslism + "`", !g.includes(wgslism));
}

// ---------------------------------------------------------------------------
// The materials sand-sim actually builds
// ---------------------------------------------------------------------------

const mats = createRockMaterials(scene, null, { realGeometry: true, grainTex: fakeTex, varTex: fakeTex });
check("one material per archetype", Object.keys(mats).length === Object.keys(ARCHETYPES).length,
    Object.keys(mats).length + " of " + Object.keys(ARCHETYPES).length);

const families = new Set(castSequence().map((c) => c.shape.archetype));
check("every family in the cast has a material",
    [...families].every((fam) => !!mats[fam]),
    [...families].filter((fam) => !mats[fam]).join(", "));
check("the cast is plain rock only — no treasure needs the gem path",
    [...families].every((fam) => !ARCHETYPES[fam]?.gem),
    [...families].filter((fam) => ARCHETYPES[fam]?.gem).join(", "));

// ---------------------------------------------------------------------------
// The tint, which is the other half of the port
// ---------------------------------------------------------------------------

const shape = { colour: [0.42, 0.38, 0.33], archetype: "granite" };

// In photo mode the tint must average about 1: it varies stones AROUND the
// photograph rather than multiplying two albedos together and muting the field.
// This is the number that stops textured rocks coming out muddy.
const photo = tintFor(shape, 1, true);
const mean = (photo[0] + photo[1] + photo[2]) / 3;
check("a photo-mode tint averages 1", Math.abs(mean - 1) < 0.02, "mean " + mean.toFixed(3));

// Without a photograph the tint IS the colour, so it must not be renormalised.
const raw = tintFor(shape, 1, false);
check("a procedural tint is the stone's own colour",
    Math.abs(raw[0] - shape.colour[0]) < 1e-9);

const cols = tintColours(new Float32Array(9), photo);
check("vertex colours cover every vertex", cols.length === 12);
check("vertex colours are opaque", cols[3] === 1 && cols[7] === 1 && cols[11] === 1);
check("vertex colours carry the tint", Math.abs(cols[0] - photo[0]) < 1e-6);

scene.dispose();
engine.dispose();
process.exit(failures ? 1 : 0);
