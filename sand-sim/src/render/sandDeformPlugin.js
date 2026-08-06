/**
 * The WebGL sand look, as a PBR material plugin — rock-forge's proven
 * MaterialPluginBase pattern applied to the fallback beach.
 *
 * Reduced fidelity by contract (docs/09): no custom lighting model, no
 * displacement — the 2 m ground grid could not carry a boot print anyway. What
 * the fallback keeps is the *state read*: depressions darken, berms brighten,
 * compaction dulls, and the wet band (analytic + the deformation buffer's
 * wetness channel) darkens hard — so a trail on WebGL reads as a trail, just a
 * tonal one rather than a carved one.
 *
 * The normal is tilted by the buffer's slope as well. That is not displacement
 * and it costs four taps; it is what makes a centimetre-deep rock dent visible
 * at all, since as albedo alone such a dent is under one percent.
 *
 * The toroidal UV (`fract(worldXZ / size)`) and the window falloff are the
 * byte-same formulas as `lib/deform.wgsl`.
 */

// Explicit .js: this module is also loaded by the headless checks under plain
// node, which (unlike vite) does not resolve extensionless deep imports.
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.js";

import { SAND_WET, WET_NEAR, WET_FAR } from "../looks/sandTone.js";
import { WATERLINE_Z } from "../terrain/beachParams.js";

export class SandDeformPlugin extends MaterialPluginBase {
    /**
     * @param {import("@babylonjs/core/Materials/PBR/pbrMaterial").PBRMaterial} material
     * @param {import("../terrain/deformation.js").DeformationField|null} field
     *   null = no deformation buffer on this machine; the plugin still applies
     *   the analytic shore-wetness band.
     */
    constructor(material, field) {
        super(material, "SandDeform", 200, {
            SAND_DEFORM: false, SAND_DEFORM_TEX: false, SAND_DEFORM_DEBUG: false,
        });
        this._field = field;
        // `?deform=debug` paints the sand with the deformation buffer's own
        // channels instead of shading by them: red = depth, green = berm,
        // blue = wetness. Nothing subtle to judge — brushed sand is bright,
        // unbrushed sand is black, and a buffer that is not being written is
        // black everywhere.
        //
        // It is here rather than in a scratch file because the question it
        // answers cannot be answered from this side. The deformation renders
        // nothing under the software driver this project is developed on, with
        // every diagnostic reporting health: plugin attached, both defines set,
        // brushes staged and consumed, both ping-pong targets ready with no
        // compilation error, and half-float render AND linear filtering both
        // supported. Either the driver is dropping the writes, or the sim is
        // genuinely broken on WebGL — and one look at this on real hardware is
        // the difference.
        // Guarded: `tools/glsl-check.mjs` constructs this plugin under a
        // NullEngine, where there is no `location` — and it caught the
        // unguarded version on the first run.
        this._debug = typeof location !== "undefined"
            && new URLSearchParams(location.search).get("deform") === "debug";
        this._enable(true);
    }

    getClassName() {
        return "SandDeformPlugin";
    }

    prepareDefines(defines) {
        defines.SAND_DEFORM = true;
        defines.SAND_DEFORM_TEX = !!this._field;
        defines.SAND_DEFORM_DEBUG = this._debug;
    }

    getSamplers(samplers) {
        samplers.push("sandDeformTex");
    }

    getUniforms() {
        return {
            ubo: [
                { name: "sandDeformCenter", size: 2, type: "vec2" },
                { name: "sandDeformSize", size: 1, type: "float" },
                { name: "sandDeformTexel", size: 1, type: "float" },
                { name: "sandWetColor", size: 3, type: "vec3" },
                { name: "sandWaterlineZ", size: 1, type: "float" },
                { name: "sandWetNear", size: 1, type: "float" },
                { name: "sandWetFar", size: 1, type: "float" },
            ],
            fragment: `
                #ifdef SAND_DEFORM
                    uniform vec2 sandDeformCenter;
                    uniform float sandDeformSize;
                    uniform float sandDeformTexel;
                    uniform vec3 sandWetColor;
                    uniform float sandWaterlineZ;
                    uniform float sandWetNear;
                    uniform float sandWetFar;
                #endif
            `,
        };
    }

    bindForSubMesh(uniformBuffer, scene, engine, subMesh) {
        uniformBuffer.updateFloat3(
            "sandWetColor", SAND_WET.r, SAND_WET.g, SAND_WET.b
        );
        uniformBuffer.updateFloat("sandWaterlineZ", WATERLINE_Z);
        uniformBuffer.updateFloat("sandWetNear", WET_NEAR);
        uniformBuffer.updateFloat("sandWetFar", WET_FAR);
        const f = this._field;
        if (f) {
            uniformBuffer.updateFloat2("sandDeformCenter", f.center.x, f.center.y);
            uniformBuffer.updateFloat("sandDeformSize", f.size);
            uniformBuffer.updateFloat("sandDeformTexel", f.texel);
            // Re-bound every frame: the field ping-pongs its targets.
            uniformBuffer.setTexture("sandDeformTex", f.texture);
        }
    }

    getCustomCode(shaderType) {
        if (shaderType !== "fragment") return null;
        return {
            CUSTOM_FRAGMENT_DEFINITIONS: `
                #ifdef SAND_DEFORM_TEX
                    uniform sampler2D sandDeformTex;
                #endif
            `,
            // CUSTOM_FRAGMENT_BEFORE_LIGHTS, not CUSTOM_FRAGMENT_UPDATE_ALBEDO:
            // the latter is injected inside `albedoOpacityBlock`, a function
            // where `normalW` does not exist. This marker sits in main() with
            // both `surfaceAlbedo` and the finalised `normalW` in scope, and
            // still runs before anything reads either.
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
                #ifdef SAND_DEFORM
                {
                    float sdDep = 0.0;
                    float sdBerm = 0.0;
                    float sdComp = 0.0;
                    float sdWetC = 0.0;
                    #ifdef SAND_DEFORM_TEX
                    {
                        vec2 sdD = abs(vPositionW.xz - sandDeformCenter) / (sandDeformSize * 0.5);
                        float sdW = 1.0 - smoothstep(0.80, 0.96, max(sdD.x, sdD.y));
                        if (sdW > 0.001) {
                            vec2 sdUV = fract(vPositionW.xz / sandDeformSize);
                            vec4 sdF = texture2D(sandDeformTex, sdUV);
                            sdDep = sdF.r * sdW;
                            sdBerm = sdF.g * sdW;
                            sdComp = sdF.b * sdW;
                            sdWetC = sdF.a * sdW;

                            // Tilt the normal by the buffer's own slope.
                            //
                            // The ground grid is 2 m, so the fallback cannot
                            // displace a boot print — but it does not have to.
                            // A dent is read from its shading, and shading comes
                            // from the normal, so the normal is where the mark
                            // has to land. Tonal darkening alone put a 10 mm
                            // rock dent under 1% of albedo: invisible. The same
                            // dent as a slope is a degree or two of tilt against
                            // a low sun, which is exactly what the eye picks up.
                            //
                            // Central differences on (berm - depth), one texel
                            // apart. The beach is near-horizontal, so the tilt
                            // can be added straight to normalW rather than built
                            // through a tangent frame.
                            vec2 sdT = vec2(sandDeformTexel / sandDeformSize, 0.0);
                            vec4 sdXL = texture2D(sandDeformTex, sdUV - sdT.xy);
                            vec4 sdXR = texture2D(sandDeformTex, sdUV + sdT.xy);
                            vec4 sdZD = texture2D(sandDeformTex, sdUV - sdT.yx);
                            vec4 sdZU = texture2D(sandDeformTex, sdUV + sdT.yx);
                            float sdHx = (sdXR.g - sdXR.r) - (sdXL.g - sdXL.r);
                            float sdHz = (sdZU.g - sdZU.r) - (sdZD.g - sdZD.r);
                            vec2 sdSlope = vec2(sdHx, sdHz) / (2.0 * sandDeformTexel);
                            // Capped: a brush edge steeper than the sand's angle
                            // of repose is the sim clamping, not a real wall, and
                            // an uncapped normal there flips the face black.
                            float sdMag = length(sdSlope);
                            if (sdMag > 0.9) sdSlope *= 0.9 / sdMag;
                            normalW = normalize(normalW - vec3(sdSlope.x, 0.0, sdSlope.y) * sdW);
                        }
                    }
                    #endif
                    // Analytic shore band; a cheap sine stands in for the tide noise.
                    float sdTide = sin(vPositionW.x * 0.045 + 1.7) * 1.4;
                    float sdShore = 1.0 - smoothstep(
                        sandWetNear, sandWetFar,
                        -(vPositionW.z - sandWaterlineZ) + sdTide
                    );
                    float sdWet = max(sdShore, sdWetC);
                    #ifdef SAND_DEFORM_DEBUG
                        // See the constructor. Gains are large on purpose: this
                        // is a yes/no about whether the buffer holds anything,
                        // not a picture of the sand.
                        surfaceAlbedo = vec3(
                            clamp(sdDep * 4.0, 0.0, 1.0),
                            clamp(sdBerm * 8.0, 0.0, 1.0),
                            clamp(sdWetC, 0.0, 1.0)
                        );
                    #else
                    surfaceAlbedo = mix(surfaceAlbedo, sandWetColor, sdWet * 0.9);
                    // (The analytic pebble band that lived here was removed
                    // with the WGSL band — the default beach is all sand.)
                    // Depressions darken (the shading a displaced trench would get),
                    // berms brighten (loose dry sand), compaction dulls.
                    surfaceAlbedo *= 1.0 - clamp(sdDep * 1.9, 0.0, 1.0) * 0.35;
                    surfaceAlbedo *= 1.0 + clamp(sdBerm * 5.0, 0.0, 1.0) * 0.10;
                    surfaceAlbedo *= 1.0 - sdComp * 0.18;
                    #endif
                }
                #endif
            `,
        };
    }
}
