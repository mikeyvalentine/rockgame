// The GPU half of the scheme: a PBRMaterial plugin that turns a shared unit
// sphere into whichever rock the instance says it is.
//
// The vertex shader does one texture fetch. `position` on the base mesh is the
// *unit direction* of the vertex, `vertIndex` is which vertex it is, and the
// instance's `rockInst.x` is which row of the shape texture to read. Radius and
// normal come back from that one texel, and the vertex lands on the rock's
// surface. Nothing about the rock exists in a vertex buffer.
//
// The fragment shader triplanar-samples the shared grain map in the rock's own
// object space and perturbs the normal with it, which is what lets a
// 1,280-triangle stone hold up at arm's length.
//
// Rocks are grouped one material per archetype rather than one material for
// everything. Roughness, grain scale and cavity strength are the difference
// between slate and sandstone and none of them wants to be a per-instance
// attribute; six materials times three LODs is eighteen draw calls for the
// whole beach, which is not a number worth optimising.

import { Color3, Constants, MaterialPluginBase, PBRMaterial, RawTexture, ShaderLanguage, Texture } from "@babylonjs/core";
import { ARCHETYPES } from "../forge/archetypes.js";
import { lerp, clamp01 } from "../forge/rng.js";

/** Object-space grain is normalised against a stone of this size, in metres. */
const GRAIN_REFERENCE = 0.06;

// Ordinary rock's polish curve — the plain-stone equivalent of a gem's own
// roughRaw/roughPolished/specular endpoints, which every archetype without a
// `gem` block falls back to. Raw is close to matte with almost no specular
// glint; fully tumbled is a uniform glossy, wet-looking finish regardless of
// lithology, because tumbling is what makes ANY stone read as smooth — the
// difference between a dull nodule and a keeper is the polish, not the rock.
// Exported so main.js's standalone reference-mesh material (the "20k-tri
// reference" toggle) can match the field material's curve exactly rather than
// keeping a second copy of these numbers that could quietly drift apart.
export const ROCK_RAW_SPECULAR = 0.10;
export const ROCK_POLISHED_SPECULAR = 0.95;
export const ROCK_POLISHED_ROUGHNESS = 0.08;

const f = (x) => x.toFixed(8);

/**
 * Strip `//` comments from injected shader code.
 *
 * Babylon's ShaderCodeCursor splits any line containing a semicolon that is not
 * the last character on that line — on *every* semicolon in it — and it does
 * not know what a comment is. So this:
 *
 *     w = w * w * w;   // tighten the blend; a linear one smears
 *
 * becomes three lines, the third being the bare text `a linear one smears`,
 * and the shader fails with "'a' : undeclared identifier". A comment is not
 * supposed to be able to do that, which is exactly why it is worth removing the
 * possibility rather than remembering the rule. The explanations stay in this
 * file where they are useful; they just never reach the compiler.
 *
 * Safe as a blunt regex: GLSL has no string literals for `//` to hide inside,
 * and division is a single slash.
 */
const stripComments = (chunks) =>
  Object.fromEntries(Object.entries(chunks).map(([k, v]) => {
    const code = v.replace(/\/\/[^\n]*/g, "");
    // The same splitter mangles any *code* line with a mid-line semicolon, so
    // warn rather than let it corrupt the shader silently.
    for (const line of code.split("\n")) {
      const t = line.trim();
      const i = t.indexOf(";");
      if (i !== -1 && i !== t.length - 1) {
        console.warn(`[rock-forge] ${k}: mid-line semicolon will be split by Babylon's shader processor:\n  ${t}`);
      }
    }
    return [k, code];
  }));

/** Upload a baked library's per-vertex normal+radius rows as one RGBA16F texture. */
export function createShapeTexture(scene, lib) {
  const tex = new RawTexture(
    lib.texel, lib.width, lib.count,
    Constants.TEXTUREFORMAT_RGBA, scene,
    false,                                  // no mips: rows are unrelated rocks
    false,                                  // no Y flip: row s must stay row s
    Texture.NEAREST_SAMPLINGMODE,
    Constants.TEXTURETYPE_HALF_FLOAT
  );
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.name = "rock-shapes";
  return tex;
}

class RockShapePlugin extends MaterialPluginBase {
  constructor(material, opts) {
    // addToPluginList=false is load-bearing. Registering a plugin makes the
    // manager call getCustomCode immediately, and `super()` necessarily runs
    // before `this._o = opts` — so registering from the base constructor asks
    // the plugin to emit its shader code before it knows the texture
    // dimensions to bake into it. Defer registration by one statement.
    super(material, "RockShape", 200, { ROCKFORGE: true, ROCKFORGE_VARIANT: 0 }, false);
    this._o = opts;
    this._pluginManager._addPlugin(this);
    this._enable(true);
  }

  getClassName() { return "RockShapePlugin"; }
  isCompatible(shaderLanguage) { return shaderLanguage === ShaderLanguage.GLSL; }

  // ROCKFORGE_VARIANT is load-bearing even though no GLSL ever reads it.
  //
  // Babylon caches compiled effects by `shaderName + "@" + defines` — and the
  // per-material code this plugin injects through processFinalCode is NOT part
  // of that key; the cache is consulted before the code is even generated. Two
  // materials with identical define strings therefore share one compiled
  // program, and the second silently runs with the FIRST one's injected
  // constants. That is exactly what was happening here: all seven plain-rock
  // families produce identical defines, so granite, sandstone, basalt and the
  // rest all rendered with slate's baked texture repeat, vein colour and band
  // amounts — their own textures bound over another family's shader. The
  // treasures collided the same way within their feature groups (jade wearing
  // amethyst's colour ramp). A per-material value define makes every define
  // string unique, which is the supported way to tell the cache these programs
  // genuinely differ.
  prepareDefines(defines) {
    defines.ROCKFORGE = true;
    defines.ROCKFORGE_VARIANT = this._o.variant ?? 0;
  }
  getAttributes(attributes) { attributes.push("vertIndex", "rockInst", "rockVar"); }

  getSamplers(samplers) {
    const o = this._o;
    samplers.push("shapeTex", "grainTex");
    if (o.colTex) samplers.push("colTex");
    if (o.nrmTex) samplers.push("nrmTex");
    if (o.aoTex) samplers.push("aoTex");
    if (o.heightTex) samplers.push("heightTex");
    if (o.varTex) samplers.push("varTex");
  }

  bindForSubMesh(uniformBuffer) {
    const o = this._o;
    uniformBuffer.setTexture("shapeTex", o.shapeTex);
    uniformBuffer.setTexture("grainTex", o.grainTex);
    if (o.colTex) uniformBuffer.setTexture("colTex", o.colTex);
    if (o.nrmTex) uniformBuffer.setTexture("nrmTex", o.nrmTex);
    if (o.aoTex) uniformBuffer.setTexture("aoTex", o.aoTex);
    if (o.heightTex) uniformBuffer.setTexture("heightTex", o.heightTex);
    if (o.varTex) uniformBuffer.setTexture("varTex", o.varTex);
  }

  // NOTE: everything below is GLSL ES 3.00, deliberately.
  //
  // Babylon's shader processor is what rewrites `attribute` -> `in`,
  // `varying` -> `out`/`in` and `texture2D(` -> `texture(` for WebGL 2 — but
  // plugin code is injected through `processFinalCode`, which runs *after* that
  // conversion. Anything written here in ES 1.00 syntax reaches the compiler
  // untouched, inside a `#version 300 es` shader, and every rock material fails
  // to compile with nothing on screen but the ground. Write ES 3.00 directly.
  // The WebGL 2 check in createEngine() is what makes that safe.
  getCustomCode(shaderType) {
    const o = this._o;
    if (shaderType === "vertex") {
      return stripComments({
        CUSTOM_VERTEX_DEFINITIONS: `
in float vertIndex;
in vec4 rockInst;                 // x: shape row, yzw: albedo tint
in vec2 rockVar;                  // per-instance offset into the variation map
uniform sampler2D shapeTex;
out vec3 vRockObj;
out vec2 vRockVar;
out vec3 vRockNrm;
out vec3 vRockTint;
out vec3 vRockTX;
out vec3 vRockTY;
${o.heightTex ? `
uniform sampler2D heightTex;

// Triplanar height. A vertex shader has no derivatives, so the mip level has to
// be chosen explicitly — and choosing it wrong is what produced sawtooth rims.
//
// At LOD0 there are only about 25 vertices across a stone, while the sample
// coordinates span 500-1900 texels of the height map depending on size. Read at
// mip 0 that is 21-75 texels *per vertex*: neighbouring vertices sample
// completely uncorrelated heights and each gets pushed a different distance
// along its own normal. Around the rim of a flat stone, where the normals fan
// out fastest, that reads as teeth.
//
// So the height is filtered down to roughly ten features across a stone, which
// is the most the geometry can actually represent. Everything finer belongs to
// the normal map, which has derivatives and filters itself.
float rockHeight(vec3 p, vec3 n, float rockScale) {
    vec3 w = abs(n);
    w = w * w;
    w /= (w.x + w.y + w.z);

    float texelsAcross = ${f(o.heightWidth)} * ${f(o.texRepeat)} * (rockScale * ${f(1 / GRAIN_REFERENCE)});
    float lod = clamp(log2(max(1.0, texelsAcross / 10.0)), 0.0, 12.0);

    // Keeps texels square when the source is not — see heightAspect.
    vec2 k = vec2(1.0, ${f(1 / (o.heightAspect || 1))});
    return textureLod(heightTex, p.zy * k, lod).r * w.x
         + textureLod(heightTex, p.xz * k, lod).r * w.y
         + textureLod(heightTex, p.xy * k, lod).r * w.z;
}
` : ""}`,
        // Runs before instancesVertex, so positionUpdated/normalUpdated are
        // still in object space and still writable.
        CUSTOM_VERTEX_UPDATE_POSITION: `
${o.bypassShapeTexture ? `
// Debug bisect: ignore the shape texture entirely and draw the base sphere at a
// fixed radius. If rocks appear like this but not otherwise, the fault is the
// texture fetch; if nothing appears either way, the meshes are not drawing at
// all and the shader is not the problem.
vec4 rockShape = vec4(normalize(positionUpdated), 0.42);
` : `
vec2 rockUV = vec2((vertIndex + 0.5) * ${f(1 / o.shapeWidth)},
                   (rockInst.x  + 0.5) * ${f(1 / o.shapeCount)});
vec4 rockShape = texture(shapeTex, rockUV);
`}
positionUpdated = positionUpdated * rockShape.w;   // position is the unit direction
#ifdef NORMAL
normalUpdated = rockShape.xyz;
#endif
vRockNrm = rockShape.xyz;
vRockTint = rockInst.yzw;
vRockVar = rockVar;

// finalWorld does not exist yet, but world0 is an attribute and for a thin
// instance it is the first column of the instance matrix — so its length is the
// instance's uniform scale, available here where the displacement needs it.
#if defined(INSTANCES) && defined(THIN_INSTANCES)
float rockScale = length(world0.xyz);
#else
float rockScale = 1.0;
#endif

// Sample coordinates are fixed to world size, so a 3 cm pebble and a 10 cm
// cobble get the same grain size rather than the same number of grains. Taken
// before displacement so the fragment shader samples the identical point.
vRockObj = positionUpdated * (rockScale * ${f(1 / GRAIN_REFERENCE)});
${o.heightTex ? `
// Real relief, not a lighting trick. At LOD0 the triangle edge is about 3 mm on
// a 7 cm stone, so this is what breaks the silhouette; everything finer than a
// triangle still has to live in the normal map. Amplitude is in metres and
// divided by the instance scale because positionUpdated is pre-scale.
//
// The physics hull does not know about this — it is built from the analytic
// shape alone. Keeping the amplitude near a millimetre puts it well inside the
// hull's own measured error (mean 0.27 mm, worst 4.28 mm), so the two do not
// meaningfully disagree. Push it much higher and that stops being true.
{
    float h = rockHeight(vRockObj * ${f(o.texRepeat)} + 0.5, rockShape.xyz, rockScale) - 0.5;
    positionUpdated += rockShape.xyz * (h * ${f(o.dispMetres)} / max(rockScale, 1e-4));
}
` : ""}`,
        CUSTOM_VERTEX_MAIN_END: `
vRockTX = normalize(finalWorld[0].xyz);
vRockTY = normalize(finalWorld[1].xyz);
`,
      });
    }

    if (shaderType === "fragment") {
      return stripComments({
        CUSTOM_FRAGMENT_DEFINITIONS: `
uniform sampler2D grainTex;
${o.colTex ? "uniform sampler2D colTex;" : ""}
${o.nrmTex ? "uniform sampler2D nrmTex;" : ""}
${o.aoTex ? "uniform sampler2D aoTex;" : ""}
${o.varTex ? "uniform sampler2D varTex;" : ""}
in vec3 vRockObj;
in vec3 vRockNrm;
in vec3 vRockTint;
in vec3 vRockTX;
in vec3 vRockTY;
in vec2 vRockVar;

// Blend weights, shared by every triplanar sample so they all agree about which
// plane dominates. Cubed to tighten the transition; a linear blend smears.
vec3 rockWeights(vec3 n) {
    vec3 w = abs(n);
    w = w * w * w;
    return w / (w.x + w.y + w.z);
}

vec4 rockTri(sampler2D t, vec3 p, vec3 w) {
    return texture(t, p.zy) * w.x + texture(t, p.xz) * w.y + texture(t, p.xy) * w.z;
}

// Whiteout blend: add each plane's tangent normal to the surface normal's
// in-plane components, keep the surface normal's sign on the third axis.
vec3 rockTriNormal(sampler2D t, vec3 p, vec3 n, vec3 w) {
    vec3 nx = texture(t, p.zy).xyz * 2.0 - 1.0;
    vec3 ny = texture(t, p.xz).xyz * 2.0 - 1.0;
    vec3 nz = texture(t, p.xy).xyz * 2.0 - 1.0;
    nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
    ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
    nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
    return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
}
`,
        // normalW is final and surfaceAlbedo exists by this point; lighting and
        // IBL are both still ahead of us.
        // Solid across the bulk of a face, a little see-through right at the
        // silhouette rim.
        //
        // An earlier version of this had the bulk read as the transparent part
        // — reasoning that a flat plate's thin axis (which is what a face-on
        // view looks through) should be the clearer one — and it looked
        // exactly as wrong as that sounds: most of a stone's visible area in
        // any ordinary view IS close to face-on, so the whole piece read as
        // thin and wispy rather than as a solid object. What actually reads as
        // "frosted glass" is the opposite emphasis: solid through the bulk,
        // with a thin band of light bleeding through right at the rim, which
        // is the ordinary rim-light cue for a thin translucent edge — a leaf,
        // an ear, a chip of sea glass held up to the sun. `alphaFace` pairs
        // with a face-on normal (ndv near 1) and `alphaEdge` with the
        // silhouette (ndv near 0); for an opaque mineral both are 1 and this
        // whole block never emits. Kept deliberately subtle — the frost term
        // below pulls it back toward opaque again, so this reads as a hint of
        // translucency at the edge, not a window.
        ...(o.gem && ((o.gem.alphaFace ?? 1) < 1 || (o.gem.alphaEdge ?? 1) < 1) ? {
          CUSTOM_FRAGMENT_UPDATE_ALPHA: `
{
    float ndv = clamp(abs(dot(normalW, viewDirectionW)), 0.0, 1.0);
    // sqrt narrows the band: it lifts ndv fast away from zero, so the blend
    // reaches the solid face value within the first few degrees off the
    // silhouette and the see-through stays a rim accent rather than a broad
    // angular fade across half the stone.
    float shaped = sqrt(ndv);
    alpha = mix(${f(o.gem.alphaEdge)}, ${f(o.gem.alphaFace)}, shaped);
    ${o.gem.frost > 0 ? `
    // Frost is a scattering layer, so it hides what is behind it: the frostier
    // the piece, the less it transmits. Polishing clears it, which is exactly
    // what wetting a piece of sea glass does.
    alpha = mix(alpha, 1.0, ${f(o.gem.frost)} * 0.45);
    ` : ""}
}
`,
        } : {}),

        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
{
    vec3 nObj = normalize(vRockNrm);
    vec3 w = rockWeights(nObj);
    // The +0.5 puts the sampled window in the middle of the tile.
    //
    // Object space is centred on zero, and zero is the tile *corner*, so without
    // this every stone at every size straddles the wrap seam — measured, a 7 cm
    // granite samples u from -0.24 to +0.24 tiles, which wraps. It has been
    // invisible only because the chosen surfaces tile well (seam error 0.94 to
    // 1.55). On a source that joins less cleanly it draws a line across every
    // rock in the field.
    vec3 pT = vRockObj * ${f(o.texRepeat)} + 0.5;
    vec3 pG = vRockObj * ${f(o.grainScale)} + 0.5;

    ${o.nrmTex ? `
    vec3 detail = rockTriNormal(nrmTex, pT, nObj, w);
    ` : `
    vec3 detail = rockTriNormal(grainTex, pG, nObj, w);
    `}
    vec3 perturbed = normalize(mix(nObj, detail, ${f(o.grainStrength)}));

    vec3 tz = cross(vRockTX, vRockTY);
    // The instance transform is a rotation times a uniform scale, so its
    // normalised basis rotates object-space normals into world space exactly.
    normalW = normalize(vRockTX * perturbed.x + vRockTY * perturbed.y + tz * perturbed.z);

    ${o.aoTex ? `
    float ao = rockTri(aoTex, pT, w).r;
    ` : `
    float ao = rockTri(grainTex, pG, w).a;
    `}

    ${o.colTex ? `
    // The photograph carries the colour. The per-instance tint is normalised to
    // average 1 in this mode, so it varies stones around the photograph rather
    // than multiplying two colours together and muting the whole field.
    surfaceAlbedo = rockTri(colTex, pT, w).rgb * vRockTint;
    ` : `
    surfaceAlbedo *= vRockTint;
    `}
    surfaceAlbedo *= mix(1.0, ao, ${f(o.cavity)});
${o.varTex ? `
    // proc-rock's texture adders. A photographed albedo tiled across a thousand
    // stones is one photograph a thousand times; these are what stop that
    // reading as a repeat. The per-instance offset is what makes them differ
    // stone to stone rather than being the same marks on every rock.
    {
        vec3 pV = vRockObj * ${f(o.varScale)} + vec3(vRockVar, vRockVar.x + vRockVar.y);
        vec4 vr = rockTri(varTex, pV, w);

        // Variance: broad mottling. The thesis is blunt about why it exists —
        // it "makes it look less uniform".
        surfaceAlbedo *= mix(1.0, 0.55 + 0.9 * vr.r, ${f(o.mottle)});

        // Bedding: bands read along the stone's short axis, at the same
        // frequency the shape model uses for its geometric banding, so the
        // colour layering and the ridges agree instead of cutting across each
        // other. Faded on the flat faces, strongest around the rim, matching
        // how the geometry weights it.
        ${o.band > 0 ? `
        float rim = pow(1.0 - abs(nObj.y), 1.5);
        float bands = texture(varTex, vec2(vRockObj.y * ${f(o.bandFreq)} + vRockVar.x, vRockVar.y)).a;
        surfaceAlbedo *= 1.0 + ${f(o.band)} * (bands - 0.5) * rim;
        ` : ""}

        // Spots: discrete mineral grains, flat-valued per Voronoi cell. This is
        // proc-rock's own fix for granite reading as featureless.
        ${o.spot > 0 ? `
        float spot = smoothstep(0.74, 0.88, vr.b);
        surfaceAlbedo = mix(surfaceAlbedo, vec3(${f(o.spotColour[0])}, ${f(o.spotColour[1])}, ${f(o.spotColour[2])}), spot * ${f(o.spot)});
        ` : ""}

        // Veins: mineral filling old cracks. Applied last so nothing darkens
        // them — on a real beach the white-veined stone is the one you notice.
        ${o.vein > 0 ? `
        surfaceAlbedo = mix(surfaceAlbedo, vec3(${f(o.veinColour[0])}, ${f(o.veinColour[1])}, ${f(o.veinColour[2])}), vr.g * ${f(o.vein)});
        ` : ""}
${o.gem ? `
        // A gem's colour is a ramp between two ends, not a photograph. Which
        // coordinate drives the ramp is what separates agate's parallel layers
        // from malachite's concentric rings, and both come from the same map.
        {
            ${o.gem.pattern === "planar" ? `
            // Bands wander. Agate grew against the wall of a gas cavity, so its
            // layers vary in thickness and drift out of parallel; perfectly
            // even stripes read as machined, which is what they looked like.
            // Warping the band coordinate by the mottle field does it in one
            // multiply-add.
            float bandC = vRockObj.y * ${f(o.gem.bandFreq)} + (vr.r - 0.5) * ${f(o.gem.bandWarp)};
            float gt = texture(varTex, vec2(bandC + vRockVar.x, vRockVar.y)).a;
            ` : o.gem.pattern === "concentric" ? `
            float bandC = length(vRockObj) * ${f(o.gem.bandFreq)} + (vr.r - 0.5) * ${f(o.gem.bandWarp)};
            float gt = texture(varTex, vec2(bandC + vRockVar.x, vRockVar.y)).a;
            ` : o.gem.pattern === "cloudy" ? `
            float gt = clamp((vr.r - 0.5) * 1.9 + 0.5, 0.0, 1.0);
            ` : `
            float gt = clamp((vr.r - 0.5) * 0.8 + 0.5, 0.0, 1.0);
            `}
            vec3 gemA = vec3(${f(o.gem.colours[0][0])}, ${f(o.gem.colours[0][1])}, ${f(o.gem.colours[0][2])});
            vec3 gemB = vec3(${f(o.gem.colours[1][0])}, ${f(o.gem.colours[1][1])}, ${f(o.gem.colours[1][2])});
            surfaceAlbedo = mix(gemA, gemB, gt) * vRockTint;

            ${o.gem.flaw > 0 ? `
            // Altered patches: rust in jade, chalky zones in agate.
            //
            // These used to be read from the vein channel, which is a network of
            // thin intersecting *lines* — widening it produced hard angular
            // shapes with straight edges rather than blotches. A separate
            // low-frequency sample of the mottle field gives soft irregular
            // patches, which is what alteration actually looks like.
            float flawSrc = rockTri(varTex, pV * 0.30 + 3.7, w).r;
            float flaw = smoothstep(0.40, 0.78, flawSrc) * ${f(o.gem.flaw)};
            surfaceAlbedo = mix(surfaceAlbedo, vec3(${f(o.gem.flawColour[0])}, ${f(o.gem.flawColour[1])}, ${f(o.gem.flawColour[2])}), flaw);
            ` : ""}

            ${o.gem.speck > 0 ? `
            // Dark mineral inclusions. Voronoi cells thresholded hard so they
            // stay discrete grains rather than becoming another cloud.
            float speck = smoothstep(0.80, 0.94, vr.b) * ${f(o.gem.speck)};
            surfaceAlbedo = mix(surfaceAlbedo, vec3(${f(o.gem.speckColour[0])}, ${f(o.gem.speckColour[1])}, ${f(o.gem.speckColour[2])}), speck);
            ` : ""}

            ${o.gem.veinAmount > 0 ? `
            surfaceAlbedo = mix(surfaceAlbedo, vec3(${f(o.gem.veinColour[0])}, ${f(o.gem.veinColour[1])}, ${f(o.gem.veinColour[2])}), vr.g * ${f(o.gem.veinAmount)});
            ` : ""}

            ${o.gem.frost > 0 ? `
            // Frost, applied last so nothing tints it.
            //
            // Sea glass is not glossy-but-rougher: the sea etches the surface
            // into microscopic pits that scatter light *before* it enters the
            // body, so the frost is a diffuse near-white layer sitting on top of
            // transparent glass. It lifts the albedo toward a pale version of
            // its own colour, strongest where the surface faces the viewer
            // least — which is why a frosted piece glows at its edges. An
            // earlier version of this comment promised that view dependence
            // while the code below had none; the rim term now delivers it, and
            // it pairs with the rim alpha above so the silhouette reads bright
            // AND faintly see-through at once — which is the whole sea-glass
            // edge look. Polishing removes it, exactly as wetting a piece does.
            {
                float grit = 0.55 + 0.45 * vr.r;
                float fnv = clamp(abs(dot(normalW, viewDirectionW)), 0.0, 1.0);
                float frostRim = pow(1.0 - fnv, 2.0);
                float fr = min(${f(o.gem.frost)} * grit * (0.80 + 0.55 * frostRim), 1.0);
                // Toward a pale version of the glass's *own* colour, not toward
                // white. Pushing it to white made the pieces read as fog rather
                // than as frosted seafoam or frosted cobalt — the colour is
                // still what identifies a piece, and the frost only lightens
                // and desaturates it.
                vec3 pale = mix(surfaceAlbedo, vec3(1.0), 0.52);
                surfaceAlbedo = mix(surfaceAlbedo, pale, fr);
            }
            ` : ""}
        }
` : ""}
    }
` : ""}
}
`,
      });
    }
    return null;
  }
}

/**
 * One PBR material per archetype, all sharing the same shape and grain textures.
 * @returns {Record<string, PBRMaterial>}
 */
export function createRockMaterials(scene, lib, {
  shapeTex, grainTex, grainStrength = 1, bypassShapeTexture = false,
  surfaces = null,        // per-archetype photo texture sets from loadRockTextures
  heightTex = null,       // shared displacement source
  heightAspect = 1,       // height source's height/width, to keep its texels square
  heightWidth = 1024,     // height source's pixel width, to pick a mip that matches vertex spacing
  varTex = null,          // shared mottle/vein/spot/band map
  adders = 1,             // global scale on the texture adders, for A/B
  polish = null,          // null = each family's own startPolish; 0 = raw, 1 = tumbled
  dispMetres = 0.0012,    // ~1.2 mm of real relief on any size of stone
} = {}) {
  const mats = {};
  let variant = 0;
  for (const [name, a] of Object.entries(ARCHETYPES)) {
    const surf = surfaces?.[name] || null;
    const m = new PBRMaterial(`rock_${name}`, scene);
    // Albedo is white and the per-instance tint does the colouring; anything
    // else would multiply two colours together and mute the whole field.
    m.albedoColor = new Color3(1, 1, 1);
    m.metallic = 0;
    m.environmentIntensity = 0.9;
    m.backFaceCulling = true;
    m.forceIrradianceInFragment = true;

    // Every archetype gets a polish axis, not just the treasures — a tumbling
    // mechanic drives this later, and until it exists `polish` defaults to
    // null, which falls back to whatever state the archetype is *found* in
    // (`startPolish` for a treasure, unpolished for an ordinary rock — there is
    // no "already a bit shiny" state for a stone straight out of the shingle).
    const startPolish = a.gem?.startPolish ?? a.startPolish ?? 0;
    const pol = clamp01(polish ?? startPolish);

    if (a.gem) {
      // Treasures: translucent, and polishable.
      //
      // Translucency is the whole reason a gem reads as a gem rather than as a
      // coloured rock — no amount of albedo work substitutes for light coming
      // *through* the stone — and Babylon's PBR carries it natively. `polish`
      // takes roughness down, fades a clear coat in, and lets more light
      // through, which together are the difference between a dull nodule and
      // something worth money.
      const g = a.gem;
      m.roughness = lerp(g.roughRaw, g.roughPolished, pol);
      m.specularIntensity = lerp(0.5, 1.0, pol);

      // A frosted surface has no coat to speak of — the pitting *is* the
      // finish — so the coat only fades in as polish removes the frost.
      const coat = pol * (1 - (g.frost ?? 0) * (1 - pol));
      if (coat > 0.02) {
        m.clearCoat.isEnabled = true;
        m.clearCoat.intensity = coat * 0.9;
        m.clearCoat.roughness = lerp(0.35, 0.02, pol);
      }

      // Entering the alpha-blend pass is what lets ANY part of the stone show
      // the background through it — subsurface translucency scatters light
      // inside the body but never transmits the scene behind. Sea glass uses
      // this for a thin see-through band at the silhouette (alphaEdge < 1,
      // alphaFace = 1); a stone with both at 1 stays in the opaque pass and
      // pays none of the sorting cost.
      if ((g.alphaFace ?? 1) < 1 || (g.alphaEdge ?? 1) < 1) {
        m.alpha = 0.999;                 // trips needAlphaBlending; the shader sets the real value
        m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        // A thin plate should show its own far face through its near one —
        // that read *is* what makes something look like glass rather than a
        // painted chip. Two culling passes keep back and front ordered.
        m.backFaceCulling = false;
        m.separateCullingPass = true;
      }

      m.subSurface.isTranslucencyEnabled = true;
      // A rough surface scatters light before it can enter, so a raw stone
      // transmits less than the same stone polished.
      m.subSurface.translucencyIntensity = g.translucency * lerp(0.5, 1.0, pol);
      m.subSurface.tintColor = new Color3(...g.colours[0]);
      m.subSurface.tintColorAtDistance = g.tintDistance;
      m.subSurface.minimumThickness = g.thickness * 0.35;
      m.subSurface.maximumThickness = g.thickness;

      if (g.iridescence > 0) {
        // Opal's colour is not pigment: it is diffraction from a lattice of
        // silica spheres, which is thin-film interference, which is what this
        // block models. Thicknesses are in nanometres.
        m.iridescence.isEnabled = true;
        m.iridescence.intensity = g.iridescence;
        m.iridescence.minimumThickness = 280;
        m.iridescence.maximumThickness = 900;
        m.iridescence.indexOfRefraction = 1.42;
      }
    } else {
      // Plain rock. Raw is the average of the archetype's own range — see the
      // comment on `roughness` in archetypes.js for why those ranges sit high
      // — and polish pulls every family toward the same low-roughness,
      // high-specular finish, because tumbling flatters granite and basalt
      // exactly alike. specularIntensity is what actually kills the glare on
      // a raw stone: roughness alone softens a highlight, it does not remove
      // it, and 0.35 flat (the old constant) still put a visible glint on
      // every rock regardless of how matte its roughness said it should be.
      const roughRaw = (a.roughness[0] + a.roughness[1]) / 2;
      m.roughness = lerp(roughRaw, ROCK_POLISHED_ROUGHNESS, pol);
      m.specularIntensity = lerp(ROCK_RAW_SPECULAR, ROCK_POLISHED_SPECULAR, pol);

      const coat = pol * 0.85;
      if (coat > 0.02) {
        m.clearCoat.isEnabled = true;
        m.clearCoat.intensity = coat;
        m.clearCoat.roughness = lerp(0.40, 0.03, pol);
      }
    }

    new RockShapePlugin(m, {
      // See prepareDefines: keeps this material's compiled program from being
      // swapped for another archetype's by the effect cache.
      variant: variant++,
      shapeTex, grainTex,
      shapeWidth: lib.width,
      shapeCount: lib.count,
      grainScale: a.grain ?? 1.6,   // treasures carry no photo surface, so this is the procedural grain scale
      // A photographed normal map is measured relief and can be applied nearly
      // at full strength. The procedural grain cannot: it is meant only to keep
      // a 1,280-triangle stone from looking faceted, and pushed high it reads as
      // a pattern stamped onto the rock rather than as the rock.
      //
      // The extra `lerp(1.0, 0.15, pol)` is the "rounder, smoother, less
      // normals" half of polish. It cannot make the underlying LOD0 mesh
      // rounder — the facet edges are real vertex positions, shared across
      // every instance of this shape, and changing them would mean rebaking
      // the shape texture rather than a material tweak — but fading out the
      // fine normal-map detail is most of what "smoother" reads as at a
      // glance, and it costs nothing extra since grainStrength is already a
      // per-material scalar.
      grainStrength: (surf?.normal ? 0.90 : 0.42) * grainStrength * lerp(1.0, 0.15, pol),
      cavity: surf?.surf ? 0.55 : 0.30,
      colTex: surf?.colour || null,
      nrmTex: surf?.normal || null,
      aoTex: surf?.surf || null,
      heightTex,
      heightAspect,
      heightWidth,
      varTex,
      varScale: 0.55,
      vein: (a.vein ?? 0) * adders,
      veinColour: a.veinColour ?? [0.9, 0.9, 0.88],
      spot: (a.spot ?? 0) * adders,
      spotColour: a.spotColour ?? [0.8, 0.8, 0.8],
      mottle: (a.mottle ?? 0) * adders,
      band: (a.band ?? 0) * adders,
      bandFreq: (a.beddingFreq ?? 6) * 0.12,
      gem: a.gem ? { pattern: a.gem.pattern, colours: a.gem.colours,
                     bandFreq: a.gem.bandFreq ?? 3.0, bandWarp: a.gem.bandWarp ?? 0,
                     veinColour: a.gem.veinColour ?? [0, 0, 0],
                     veinAmount: a.gem.veinAmount ?? 0,
                     speck: a.gem.speck ?? 0, speckColour: a.gem.speckColour ?? [0, 0, 0],
                     flaw: a.gem.flaw ?? 0, flawColour: a.gem.flawColour ?? [1, 1, 1],
                     // Frost is a property of the *unpolished* surface, so it
                     // fades out as the stone is tumbled.
                     frost: (a.gem.frost ?? 0) * (1 - pol),
                     alphaFace: a.gem.alphaFace ?? 1, alphaEdge: a.gem.alphaEdge ?? 1 } : null,
      texRepeat: surf?.repeat ?? 0.45,
      // Same idea as grainStrength above, for the coarser relief that is real
      // geometry rather than a normal map: tumbling wears the bumps down, not
      // just the micro-facets, so the vertex displacement fades with it too.
      dispMetres: dispMetres * lerp(1.0, 0.10, pol),
      bypassShapeTexture,
    });

    mats[name] = m;
  }
  return mats;
}
