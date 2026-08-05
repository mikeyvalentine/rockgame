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
        super(material, "SandDeform", 200, { SAND_DEFORM: false, SAND_DEFORM_TEX: false });
        this._field = field;
        this._enable(true);
    }

    getClassName() {
        return "SandDeformPlugin";
    }

    prepareDefines(defines) {
        defines.SAND_DEFORM = true;
        defines.SAND_DEFORM_TEX = !!this._field;
    }

    getSamplers(samplers) {
        samplers.push("sandDeformTex");
    }

    getUniforms() {
        return {
            ubo: [
                { name: "sandDeformCenter", size: 2, type: "vec2" },
                { name: "sandDeformSize", size: 1, type: "float" },
                { name: "sandWetColor", size: 3, type: "vec3" },
                { name: "sandWaterlineZ", size: 1, type: "float" },
                { name: "sandWetNear", size: 1, type: "float" },
                { name: "sandWetFar", size: 1, type: "float" },
            ],
            fragment: `
                #ifdef SAND_DEFORM
                    uniform vec2 sandDeformCenter;
                    uniform float sandDeformSize;
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
            CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
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
                            vec4 sdF = texture2D(sandDeformTex, fract(vPositionW.xz / sandDeformSize));
                            sdDep = sdF.r * sdW;
                            sdBerm = sdF.g * sdW;
                            sdComp = sdF.b * sdW;
                            sdWetC = sdF.a * sdW;
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
                    surfaceAlbedo = mix(surfaceAlbedo, sandWetColor, sdWet * 0.9);
                    // (The analytic pebble band that lived here was removed
                    // with the WGSL band — the default beach is all sand.)
                    // Depressions darken (the shading a displaced trench would get),
                    // berms brighten (loose dry sand), compaction dulls.
                    surfaceAlbedo *= 1.0 - clamp(sdDep * 1.9, 0.0, 1.0) * 0.35;
                    surfaceAlbedo *= 1.0 + clamp(sdBerm * 5.0, 0.0, 1.0) * 0.10;
                    surfaceAlbedo *= 1.0 - sdComp * 0.18;
                }
                #endif
            `,
        };
    }
}
