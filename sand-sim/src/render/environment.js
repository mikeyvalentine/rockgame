/**
 * HDRI environment — the sand lab's replacement for SNOWFLOW's analytic sky.
 *
 * Implements the exact consumer contract `Sky` had, so the terrain, spray,
 * shadows and post chain do not know anything changed: `sunDir`, `sunColor`,
 * `sunRadiance`, `sh` (36 floats, radiance-convention SH the shader applies
 * Lambert weights to at lookup), `lut` (equirect radiance texture sampled via
 * `dirToLatLong`), `mesh`/`material` (the skybox), `solve()`, `update()`,
 * `render(rig, time)`.
 *
 * Everything derives from one CPU parse of the .hdr file:
 *
 *   lut   a box-downsampled copy of the equirect. The HDR file's own layout
 *         (row 0 = zenith, u wraps azimuth) *is* the `latLongToDir` convention,
 *         so no resampling math exists to get wrong — reflections, fog and the
 *         visible sky cannot rotate against each other.
 *   sh    the identical 9-coefficient projection `sky.js` ran, over the same
 *         solid-angle weighting, just fed by HDR texels instead of a Nishita
 *         bake. Radiance convention preserved.
 *   sun   found by luminance argmax over the LUT — the brightest texel of a
 *         clear-sky HDRI is the sun. Its direction seeds the (debug) azimuth/
 *         elevation sliders, so the shadow cascades and the light shafts agree
 *         with the baked sun disc without anyone hand-matching angles.
 *
 * The sun's *colour* still comes from the Kasten-Young air-mass extinction the
 * analytic sky used (driven by elevation), because the HDRI's sun texels are
 * clipped by the format and unusable as a radiance measurement.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import {
    RGBE_ReadHeader, RGBE_ReadPixels,
} from "@babylonjs/core/Misc/HighDynamicRange/hdr";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";

import { S, set as setSetting } from "../core/settings.js";

const HDRI_URL = "/assets/sky/autumn_field_puresky_4k.hdr";

/** LUT size. 1024×512 keeps the clouds legible on the visible skybox. */
const LUT_W = 1024;
const LUT_H = 512;

/**
 * Converts the `sunIntensity` slider into the shared radiometric scale used by
 * the direct sun. Same constant the analytic sky used, so the slider range
 * keeps meaning roughly the same thing.
 */
const SUN_SCALE_BASE = 5.5;

const _dir = new Vector3();

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class HdriEnvironment {
    /** @param {import("@babylonjs/core/scene").Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.engine = scene.getEngine();

        /** Unit vector pointing *toward* the sun. */
        this.sunDir = new Vector3(0, 0.7, 0.7);
        /** Normalised hue of direct sunlight, for tinting effects. */
        this.sunColor = new Color3(1, 0.9, 0.75);
        /** Direct solar irradiance, same units the LUT stores radiance in. */
        this.sunRadiance = new Color3(1, 1, 1);
        this.sunScale = 1;
        /** 36 floats: 9 SH coefficients as vec4, for the shader UBO. */
        this.sh = new Float32Array(36);

        /** @type {RawTexture|null} set by `solve()` */
        this.lut = null;

        // ----------------------------------------------------------- skybox
        this.mesh = CreateBox("sky", { size: 2 }, scene);
        this.mesh.infiniteDistance = false; // positioned manually in the shader
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.isPickable = false;
        this.mesh.renderingGroupId = 0;

        // The skybox shader exists twice: hand-written WGSL for the full
        // renderer, a GLSL twin (registry.js `registerShadersGL`) for the
        // fallback. Same names, per-language shader stores.
        const lang = this.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL;
        const mat = new ShaderMaterial(
            "hdriSky",
            scene,
            { vertex: "sky", fragment: "hdriSky" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPosition", "skyScale", "envIntensity",
                ],
                samplers: ["skyLUT"],
                shaderLanguage: lang,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        this.mesh.material = mat;
        this.material = mat;
    }

    /**
     * Fetch and parse the HDR, build the LUT, project the SH, find the sun.
     * Replaces the analytic sky's iterative bounce solve; runs once.
     */
    async solve() {
        if (this.lut) return;

        const res = await fetch(HDRI_URL);
        if (!res.ok) throw new Error("HDRI fetch failed: " + res.status);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const info = RGBE_ReadHeader(bytes);
        // Interleaved RGB float32, row 0 = the top of the panorama (zenith).
        const rgb = RGBE_ReadPixels(bytes, info);

        const data = this._downsample(rgb, info.width, info.height);

        // Half float everywhere: WebGL2 filters 16F as core (32F filtering is
        // an extension the floor machines may lack), and radiance to 65504 is
        // ample. Mips only on WebGPU — the WGSL ambient specular samples
        // `sqrt(rough) * 6`; the GL path only draws the skybox at base level,
        // and generateMipmap on 16F is exactly the kind of capability the
        // fallback should not bet on.
        const isWebGPU = this.engine.isWebGPU;
        this.lut = new RawTexture(
            toHalf(data), LUT_W, LUT_H,
            Constants.TEXTUREFORMAT_RGBA,
            this.scene,
            isWebGPU, // mips
            false,    // no invertY: HDR row 0 is zenith, latLongToDir's v=0 is zenith
            isWebGPU
                ? Constants.TEXTURE_TRILINEAR_SAMPLINGMODE
                : Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
            Constants.TEXTURETYPE_HALF_FLOAT
        );
        this.lut.name = "skyLUT";
        this.lut.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.lut.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        this.material.setTexture("skyLUT", this.lut);
        this.material.setFloat("envIntensity", 1.0);

        this._projectSH(data);
        this._findSun(data);
        this.syncFromSettings();
    }

    /**
     * Box-filter the equirect down to LUT size, RGB → RGBA.
     *
     * Columns are resampled through Babylon's own panorama convention
     * (`theta = atan2(z, x)` — see panoramaToCubemap.js), while this LUT is
     * read back with `dirToLatLong`'s `atan2(x, z)`. Doing the remap here means
     * the LUT skybox and any `HDRCubeTexture` built from the same file agree
     * about where every azimuth lives — including the sun — by construction.
     * Rows already share the `acos(y)` convention.
     */
    _downsample(rgb, w, h) {
        const fx = Math.max(1, Math.floor(w / LUT_W));
        const fy = Math.max(1, Math.floor(h / LUT_H));
        const inv = 1 / (fx * fy);
        const out = new Float32Array(LUT_W * LUT_H * 4);

        for (let y = 0; y < LUT_H; y++) {
            const sy0 = y * fy;
            for (let x = 0; x < LUT_W; x++) {
                // This texel's azimuth in the LUT convention…
                const a = ((x + 0.5) / LUT_W - 0.5) * 2 * Math.PI;
                // …mapped to the source column via Babylon's convention.
                // atan2(cos a, sin a) is exactly PI/2 - a, wrapped.
                const uSrc = (Math.atan2(Math.cos(a), Math.sin(a)) / Math.PI + 1) / 2;
                const sx0 = Math.round(uSrc * w - fx / 2);

                let r = 0;
                let g = 0;
                let b = 0;
                for (let sy = 0; sy < fy; sy++) {
                    const row = (sy0 + sy) * w;
                    for (let sx = 0; sx < fx; sx++) {
                        const sxx = (((sx0 + sx) % w) + w) % w;
                        const i = (row + sxx) * 3;
                        r += rgb[i];
                        g += rgb[i + 1];
                        b += rgb[i + 2];
                    }
                }
                const o = (y * LUT_W + x) * 4;
                out[o] = r * inv;
                out[o + 1] = g * inv;
                out[o + 2] = b * inv;
                out[o + 3] = 1;
            }
        }
        return out;
    }

    /**
     * Attach the same HDR as `scene.environmentTexture` (a 512 cube, the
     * sibling-repo recipe) for PBR consumers — the water. Fire-and-forget:
     * PBR materials wait on texture readiness themselves, so the warm-up's
     * `whenReady(waterMat)` is the synchronisation point.
     */
    attachCube() {
        if (this.cube) return this.cube;
        this.cube = new HDRCubeTexture(HDRI_URL, this.scene, 512);
        this.scene.environmentTexture = this.cube;
        return this.cube;
    }

    /**
     * Project the LUT into 9 SH coefficients on the CPU — the byte-identical
     * basis, weighting and layout `sky.js` used, so `shIrradiance()` in the
     * shader sees the convention it was written for.
     */
    _projectSH(px) {
        const sh = this.sh;
        const Y = _shBasis;
        sh.fill(0);

        const dOmega = ((2 * Math.PI) / LUT_W) * (Math.PI / LUT_H);

        for (let y = 0; y < LUT_H; y++) {
            const theta = ((y + 0.5) / LUT_H) * Math.PI;
            const st = Math.sin(theta);
            const ct = Math.cos(theta);
            const w = st * dOmega;

            for (let x = 0; x < LUT_W; x++) {
                const phi = ((x + 0.5) / LUT_W - 0.5) * 2 * Math.PI;
                const dx = st * Math.sin(phi);
                const dy = ct;
                const dz = st * Math.cos(phi);

                Y[0] = 0.282095;
                Y[1] = 0.488603 * dy;
                Y[2] = 0.488603 * dz;
                Y[3] = 0.488603 * dx;
                Y[4] = 1.092548 * dx * dy;
                Y[5] = 1.092548 * dy * dz;
                Y[6] = 0.315392 * (3 * dz * dz - 1);
                Y[7] = 1.092548 * dx * dz;
                Y[8] = 0.546274 * (dx * dx - dy * dy);

                const i = (y * LUT_W + x) * 4;
                const r = px[i] * w;
                const g = px[i + 1] * w;
                const b = px[i + 2] * w;

                for (let c = 0; c < 9; c++) {
                    sh[c * 4] += r * Y[c];
                    sh[c * 4 + 1] += g * Y[c];
                    sh[c * 4 + 2] += b * Y[c];
                }
            }
        }
    }

    /**
     * The brightest texel of a clear-sky panorama is the sun. Its direction
     * seeds the azimuth/elevation settings (kept as *debug* sliders — moving
     * them desyncs the light from the baked sun disc, which is sometimes
     * exactly what a lighting experiment wants).
     */
    _findSun(px) {
        let best = -1;
        let bx = 0;
        let by = 0;
        for (let y = 0; y < LUT_H; y++) {
            for (let x = 0; x < LUT_W; x++) {
                const i = (y * LUT_W + x) * 4;
                const lum = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
                if (lum > best) {
                    best = lum;
                    bx = x;
                    by = y;
                }
            }
        }

        const phi = ((bx + 0.5) / LUT_W - 0.5) * 2 * Math.PI;
        const theta = ((by + 0.5) / LUT_H) * Math.PI;
        const st = Math.sin(theta);
        _dir.set(st * Math.sin(phi), Math.cos(theta), st * Math.cos(phi));

        const az = (Math.atan2(_dir.x, _dir.z) * 180) / Math.PI;
        const el = (Math.asin(clamp(_dir.y, -1, 1)) * 180) / Math.PI;
        setSetting("sunAzimuth", Math.round(((az % 360) + 360) % 360));
        setSetting("sunElevation", Math.round(el * 10) / 10);
    }

    /**
     * Sun vector + colour from the settings. The vector tracks the sliders
     * (seeded from the HDRI's own sun); the colour comes from air-mass
     * extinction at that elevation, exactly as the analytic sky derived it.
     */
    syncFromSettings() {
        const az = (S.sunAzimuth * Math.PI) / 180;
        const el = (S.sunElevation * Math.PI) / 180;
        const ce = Math.cos(el);
        this.sunDir.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);

        this.sunScale = S.sunIntensity * SUN_SCALE_BASE;

        const zenithDeg = (Math.acos(clamp(this.sunDir.y, -1, 1)) * 180) / Math.PI;
        // Kasten-Young air mass — stays finite at the horizon, unlike 1/cos.
        const denom =
            Math.cos((zenithDeg * Math.PI) / 180) +
            0.50572 * Math.pow(Math.max(1e-3, 96.07995 - zenithDeg), -1.6364);
        const airMass = Math.min(denom > 0 ? 1 / denom : 40, 40);

        const tauR = [0.0464, 0.108, 0.265];
        const tauM = 0.0252;
        const r = Math.exp(-(tauR[0] + tauM) * airMass);
        const g = Math.exp(-(tauR[1] + tauM) * airMass);
        const b = Math.exp(-(tauR[2] + tauM) * airMass);

        this.sunRadiance.set(r * this.sunScale, g * this.sunScale, b * this.sunScale);

        const m = Math.max(r, Math.max(g, b)) || 1;
        this.sunColor.set(r / m, g / m, b / m);
    }

    /**
     * Per-frame settings sync. The sky itself is static — there is nothing to
     * rebake — so this is a handful of scalar ops. Returns false ("no rebake
     * happened") for call-site symmetry with the old Sky.
     */
    update() {
        this.syncFromSettings();
        return false;
    }

    /**
     * Push the skybox uniforms. `time` is accepted for call-site symmetry and
     * ignored — a captured sky does not animate.
     * @param {import("../core/camera.js").FpsRig} rig
     * @param {number} [time]
     */
    render(rig, time) {
        const m = this.material;
        m.setVector3("cameraPosition", rig.camera.position);
        m.setFloat("skyScale", rig.camera.maxZ * 0.5);
        m.setFloat("envIntensity", 1.0);
    }

    dispose() {
        this.lut?.dispose();
        this.cube?.dispose();
        this.mesh.dispose();
        this.material.dispose();
    }
}

const _shBasis = new Float32Array(9);

/**
 * Float32 → float16 bits, truncating, denormals flushed, clamped to the 16F
 * max. Radiance is non-negative so the sign path only guards against noise.
 * @param {Float32Array} src
 */
function toHalf(src) {
    const out = new Uint16Array(src.length);
    const f = new Float32Array(1);
    const u = new Uint32Array(f.buffer);
    for (let i = 0; i < src.length; i++) {
        let v = src[i];
        if (!(v > 0)) v = 0;
        else if (v > 65504) v = 65504;
        f[0] = v;
        const x = u[0];
        const e = (x >> 23) & 0xff;
        if (e < 113) {
            out[i] = 0;
        } else {
            out[i] = ((e - 112) << 10) | ((x >> 13) & 0x3ff);
        }
    }
    return out;
}
