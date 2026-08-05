/**
 * The loose-grain layer — the "hybrid" half of the sand sim.
 *
 * Persistent visible grains that the heightfield never depends on: they spawn
 * from disturbances (footfalls, the dig tool), fly ballistically, bounce once
 * or twice, roll downslope while the ground is steeper than sand's angle of
 * repose, and then *settle* — at which point their mass is deposited back into
 * the deformation buffer as a tiny berm-only brush and the slot is freed. The
 * heightfield is the sole source of truth; grains are garnish by construction,
 * and the overlay can slider them to zero.
 *
 * Architecture is SprayField's, deliberately: CPU per-particle typed arrays, a
 * small data texture, one static quad-grid mesh billboarded in the vertex
 * shader (the same registered "spray" WGSL pair — grains are just heavier,
 * longer-lived clods). Free-ring recycling, zero allocation per frame.
 *
 * Sleep: with zero live grains the update, the upload and the draw all stop —
 * this is what the phase-9 pausable-sim gate leans on.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SpellLights, SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

/** Hard pool size. The live budget is `S.grainBudget`, clamped to this. */
const CAPACITY = 5120;

/** Sand's angle of repose, as a slope gradient (~31°). */
const REPOSE_TAN = 0.6;

/** Deposit brushes per frame; overflow carries in a small queue. */
const MAX_DEPOSITS_PER_FRAME = 24;
const DEPOSIT_QUEUE_CAP = 128;

/** Berm-metres one unit of grain mass deposits. Tuned so a footfall's flung
 *  grains return roughly the rim share the footfall brush itself skipped. */
const MASS_TO_BERM = 0.004;

const _right = new Vector3();
const _up = new Vector3();
const _splits = new Vector4();
const _n = new Vector3();
const _noLights = new SpellLights();

export class GrainField {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/environment.js").HdriEnvironment} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     */
    constructor(scene, terrain, sky, shadows) {
        this.scene = scene;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;

        this.pos = new Float32Array(CAPACITY * 3);
        this.vel = new Float32Array(CAPACITY * 3);
        this.size = new Float32Array(CAPACITY);
        this.seed = new Float32Array(CAPACITY);
        this.mass = new Float32Array(CAPACITY);
        this.restTimer = new Float32Array(CAPACITY);
        this.active = new Uint8Array(CAPACITY);
        this._next = 0;
        this.liveCount = 0;

        /** Deposit overflow queue: (x, z, berm) triplets. */
        this._queue = new Float32Array(DEPOSIT_QUEUE_CAP * 3);
        this._queueLen = 0;

        // Texture rows: 0 = (x, y, z, size), 1 = (age01, seed, kind, alpha).
        this._texData = new Float32Array(CAPACITY * 2 * 4);
        this.dataTex = RawTexture.CreateRGBATexture(
            this._texData, CAPACITY, 2, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.dataTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.dataTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        this.mesh = buildQuadMesh(scene, CAPACITY);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        this.mesh.renderingGroupId = 2;

        this._camPos = new Vector3();
        /** True while anything is live — the sleep gate. */
        this.awake = false;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "grains", this.scene, { vertex: "spray", fragment: "spray" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos", "camRight", "camUp",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: ["sprayTex", "skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.setTexture("sprayTex", this.dataTex);
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        _noLights.apply(mat);
        return mat;
    }

    /**
     * Spawn one grain. World space. Silently dropped when the pool or the
     * overlay budget is exhausted — a missing grain beats a hitch.
     */
    spawn(x, y, z, vx, vy, vz, size, mass) {
        const budget = Math.min(CAPACITY, Math.max(0, S.grainBudget | 0));
        if (this.liveCount >= budget) return;

        let i = this._next;
        for (let n = 0; n < CAPACITY; n++) {
            if (!this.active[i]) break;
            i = (i + 1) % CAPACITY;
            if (n === CAPACITY - 1) return;
        }
        this._next = (i + 1) % CAPACITY;

        const o = i * 3;
        this.pos[o] = x;
        this.pos[o + 1] = y;
        this.pos[o + 2] = z;
        this.vel[o] = vx;
        this.vel[o + 1] = vy;
        this.vel[o + 2] = vz;
        this.size[i] = size;
        this.mass[i] = mass;
        this.restTimer[i] = 0;
        this.seed[i] = (i * 0.618033 + x * 0.137 + z * 0.311) % 1;
        this.active[i] = 1;
        this.liveCount++;
        this.awake = true;
    }

    /**
     * Advance, deposit settlers, upload. Skips everything while asleep.
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        if (!this.awake) return;
        this._camPos.copyFrom(cameraPos);

        const h = Math.min(dt, 1 / 30);
        const t = this.terrain;
        const d = this._texData;

        // Frame-local deposit bucketing on a 0.25 m grid. A Map with numeric
        // keys allocates a little; the alternative (open-address hash into a
        // typed array) is not worth it at these counts.
        const buckets = new Map();

        let live = 0;
        for (let i = 0; i < CAPACITY; i++) {
            const to = i * 4;
            const t1 = (CAPACITY + i) * 4;

            if (!this.active[i]) {
                d[to + 3] = 0;
                d[t1 + 3] = 0;
                continue;
            }

            const o = i * 3;
            let vx = this.vel[o];
            let vy = this.vel[o + 1];
            let vz = this.vel[o + 2];

            // Gravity + light air drag.
            vy -= 9.81 * h;
            const drag = Math.min(1, 0.35 * h);
            vx -= vx * drag;
            vz -= vz * drag;

            let px = this.pos[o] + vx * h;
            let py = this.pos[o + 1] + vy * h;
            let pz = this.pos[o + 2] + vz * h;

            const ground = t.heightAt(px, pz);
            if (py <= ground) {
                py = ground + 0.005;
                const speed = Math.hypot(vx, vy, vz);
                if (speed > 0.35) {
                    // Bounce: reflect on the surface normal, damped hard.
                    t.normalAt(px, pz, _n);
                    const vn = vx * _n.x + vy * _n.y + vz * _n.z;
                    const rest = 1.15; // (1 + restitution 0.15)
                    vx = (vx - rest * vn * _n.x) * 0.6;
                    vy = (vy - rest * vn * _n.y) * 0.6;
                    vz = (vz - rest * vn * _n.z) * 0.6;
                } else {
                    // Roll: downslope acceleration past the angle of repose,
                    // friction below it.
                    t.normalAt(px, pz, _n);
                    const gradX = -_n.x / Math.max(0.2, _n.y);
                    const gradZ = -_n.z / Math.max(0.2, _n.y);
                    const slope = Math.hypot(gradX, gradZ);
                    vy = 0;
                    if (slope > REPOSE_TAN) {
                        vx += -gradX * 9.81 * 0.5 * h;
                        vz += -gradZ * 9.81 * 0.5 * h;
                    } else {
                        const s = Math.hypot(vx, vz);
                        if (s > 1e-4) {
                            const k = Math.max(0, s - 3.0 * h) / s;
                            vx *= k;
                            vz *= k;
                        }
                    }
                    const s2 = Math.hypot(vx, vz);
                    if (s2 < 0.05) {
                        this.restTimer[i] += h;
                        if (this.restTimer[i] > 0.25) {
                            // Settle: bucket the mass, free the slot.
                            const bx = Math.round(px * 4);
                            const bz = Math.round(pz * 4);
                            const key = bx * 65536 + bz;
                            const cur = buckets.get(key);
                            if (cur) {
                                cur.m += this.mass[i];
                            } else {
                                buckets.set(key, { x: px, z: pz, m: this.mass[i] });
                            }
                            this.active[i] = 0;
                            this.liveCount--;
                            d[to + 3] = 0;
                            d[t1 + 3] = 0;
                            continue;
                        }
                    } else {
                        this.restTimer[i] = 0;
                    }
                }
            }

            this.vel[o] = vx;
            this.vel[o + 1] = vy;
            this.vel[o + 2] = vz;
            this.pos[o] = px;
            this.pos[o + 1] = py;
            this.pos[o + 2] = pz;

            d[to] = px;
            d[to + 1] = py;
            d[to + 2] = pz;
            d[to + 3] = this.size[i];
            d[t1] = 0.25;            // age01: young forever — no growth, no fade
            d[t1 + 1] = this.seed[i];
            d[t1 + 2] = 1;           // kind: clod — hard edge, opaque
            d[t1 + 3] = 0.9;
            live++;
        }

        // ---- deposits ------------------------------------------------------
        // New buckets first, then the carried queue, inside one frame budget.
        const f = this.terrain.deform;
        let spent = 0;
        for (const b of buckets.values()) {
            if (spent < MAX_DEPOSITS_PER_FRAME) {
                // Millimetres, capped: a settled cluster nudges the surface, it
                // does not build a mound. (The original expression divided the
                // constant back out and requested *metres* — the "trail rising
                // after you leave" bug.)
                f.brush(b.x, b.z, 0.09, 0, Math.min(0.03, b.m * MASS_TO_BERM), 0.15, 0, 0, 1, 0.9);
                spent++;
            } else if (this._queueLen < DEPOSIT_QUEUE_CAP) {
                const q = this._queueLen++ * 3;
                this._queue[q] = b.x;
                this._queue[q + 1] = b.z;
                this._queue[q + 2] = b.m;
            }
            // Past both caps: dropped. Garnish, not ledger.
        }
        let qi = 0;
        while (qi < this._queueLen && spent < MAX_DEPOSITS_PER_FRAME) {
            const q = qi * 3;
            f.brush(
                this._queue[q], this._queue[q + 1],
                0.09, 0, Math.min(0.03, this._queue[q + 2] * MASS_TO_BERM), 0.15, 0, 0, 1, 0.9
            );
            qi++;
            spent++;
        }
        if (qi > 0) {
            this._queue.copyWithin(0, qi * 3, this._queueLen * 3);
            this._queueLen -= qi;
        }

        this.liveCount = live;
        if (live === 0 && this._queueLen === 0) {
            // Sleep: stop uploading, stop drawing, stop updating.
            this.awake = false;
            this.mesh.setEnabled(false);
            return;
        }
        this.mesh.setEnabled(true);
        this.dataTex.update(d);
        this._pushUniforms();
    }

    _pushUniforms() {
        const m = this.material;
        const sky = this.sky;
        const sh = this.shadows;
        const cam = this.scene.activeCamera;

        const v = cam.getViewMatrix();
        _right.set(v.m[0], v.m[4], v.m[8]);
        _up.set(v.m[1], v.m[5], v.m[9]);

        m.setVector3("cameraPos", this._camPos);
        m.setVector3("camRight", _right);
        m.setVector3("camUp", _up);
        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);

        bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
        _splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);
        m.setVector4("cascadeSplits", _splits);
        m.setArray4("cascadeParams", sh.paramData);
        m.setFloat("shadowTexel", sh.texelSize);
        m.setFloat("shadowSoftness", 1.6);
        m.setFloat("shadowBias", 0.05);

        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("ambientIntensity", S.ambientIntensity);
    }

    async warmUp() {
        // Compile with the mesh enabled, then sleep until something spawns.
        this.mesh.setEnabled(true);
        await whenReady(this.material, "grain material", [this.mesh, false]);
        this.mesh.setEnabled(false);
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        this.dataTex.dispose();
    }
}

/** Same static quad grid as the spray — position packs (index, cornerX, cornerY). */
function buildQuadMesh(scene, capacity) {
    const pos = new Float32Array(capacity * 4 * 3);
    const idx = new Uint32Array(capacity * 6);
    const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

    for (let i = 0; i < capacity; i++) {
        for (let c = 0; c < 4; c++) {
            const o = (i * 4 + c) * 3;
            pos[o] = i;
            pos[o + 1] = CORNERS[c * 2];
            pos[o + 2] = CORNERS[c * 2 + 1];
        }
        const b = i * 4;
        const q = i * 6;
        idx[q] = b; idx[q + 1] = b + 1; idx[q + 2] = b + 2;
        idx[q + 3] = b; idx[q + 4] = b + 2; idx[q + 5] = b + 3;
    }

    const mesh = new Mesh("grains", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: capacity * 2, vertices: capacity * 4 };
    return mesh;
}
