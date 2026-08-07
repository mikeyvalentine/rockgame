/**
 * Procedural grip — curl the fingers around whatever rock is in the palm.
 *
 * No authored grip pose: each finger closes onto the rock's actual surface, so
 * any stone from the forge is held naturally, a bigger rock wrapped looser and
 * a smaller one tighter. This is the per-finger, per-segment collision approach
 * the VR-grip references use, reduced to what this lab needs.
 *
 * COLLIDE AND LOCK. A rock resting in the palm already touches the finger
 * BASES, so "stop the finger at first contact" never curls it. Instead every
 * joint curls together and each joint locks on its own the moment ITS phalanx
 * would push into the rock (stepping back so it rests on the surface). Proximal
 * joints lock early against the near face; the free distal joints keep curling
 * to carry the fingertip around — how a hand actually wraps a stone, and it
 * avoids the knuckle-only "claw".
 *
 * Contact is done in plain JS against the rock's triangles, not Babylon's
 * picker (mesh.intersects misses in this tree-shaken build). The rock is
 * transformed to world once; a two-sided ray from its CENTRE gives the surface
 * radius in any direction (rocks are ~star-convex from centre), and a sample's
 * signed distance is |sample − centre| − that radius.
 *
 * Curl direction is derived, not hand-tuned: rotating a bone about
 * (boneDir × palmar) turns it toward the palm — every finger and the thumb.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";

const STEP = (2 * Math.PI) / 180;    // knuckle curl per step
const RATIOS = [1.0, 1.35, 1.6];     // MCP : PIP : DIP — distal joints bend more
const MAX = (140 * Math.PI) / 180;   // ceiling on the knuckle
const PENT = 0.002;                  // let a phalanx sink this far before locking (2 mm)

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];

/**
 * @param {object} a
 * @param {string} a.side
 * @param {(name:string)=>any} a.findNode
 * @param {import("@babylonjs/core/Meshes/mesh").Mesh} a.rockMesh
 * @param {{positions:Float32Array, indices:Uint32Array|Uint16Array}} a.geometry
 * @param {Vector3} a.palmar  unit vector toward the palm (where fingers close)
 */
export function gripRock({ side, findNode, rockMesh, geometry, palmar }) {
    rockMesh.computeWorldMatrix(true);
    const centre = rockMesh.getAbsolutePosition().clone();
    const world = toWorld(geometry.positions, rockMesh.getWorldMatrix());
    const idx = geometry.indices;
    const dir = palmar.clone();
    dir.normalize();

    let curled = 0;
    for (const f of FINGERS) {
        const chain = [1, 2, 3, 4]
            .map((i) => findNode(`${side}Hand${f}${i}`))
            .filter(Boolean);
        if (chain.length < 4) continue;
        curled += curlFinger(chain, centre, world, idx, dir);
    }
    return curled;
}

/** Transform a positions buffer by a world matrix into a fresh Float32Array. */
function toWorld(positions, m) {
    const out = new Float32Array(positions.length);
    const v = new Vector3();
    for (let i = 0; i < positions.length; i += 3) {
        Vector3.TransformCoordinatesFromFloatsToRef(
            positions[i], positions[i + 1], positions[i + 2], m, v);
        out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
    }
    return out;
}

/** Two-sided Möller–Trumbore. Returns the ray parameter t>0, or Infinity. */
function rayTri(o, d, w, a, b, c) {
    const e1x = w[b] - w[a], e1y = w[b + 1] - w[a + 1], e1z = w[b + 2] - w[a + 2];
    const e2x = w[c] - w[a], e2y = w[c + 1] - w[a + 1], e2z = w[c + 2] - w[a + 2];
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return Infinity;
    const inv = 1 / det;
    const tx = o.x - w[a], ty = o.y - w[a + 1], tz = o.z - w[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return Infinity;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const vv = (d.x * qx + d.y * qy + d.z * qz) * inv;
    if (vv < 0 || u + vv > 1) return Infinity;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-7 ? t : Infinity;
}

/** Rock's surface radius from `centre` along unit `dir`. */
function surfaceRadius(centre, dir, world, idx) {
    let best = Infinity;
    for (let i = 0; i < idx.length; i += 3) {
        const t = rayTri(centre, dir, world, idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3);
        if (t < best) best = t;
    }
    return best;
}

const _d = new Vector3();
/** Signed distance from world point `p` to the rock surface (<0 inside). */
function gap(p, centre, world, idx) {
    _d.copyFrom(p).subtractInPlace(centre);
    const dist = _d.length();
    if (dist < 1e-6) return -1;
    _d.scaleInPlace(1 / dist);
    const r = surfaceRadius(centre, _d, world, idx);
    return r === Infinity ? Infinity : dist - r;
}

function refresh(chain) {
    for (const n of chain) n.computeWorldMatrix(true);
}

/**
 * Close one finger: all joints curl each step; a joint locks (stepping back)
 * the moment its phalanx tip would sink into the rock.
 * @returns {number} count of joints that ended up bent
 */
function curlFinger(chain, centre, world, idx, palmar) {
    const joints = [chain[0], chain[1], chain[2]];
    const bent = [0, 0, 0];
    const locked = [false, false, false];
    let knuckle = 0;

    while (knuckle < MAX && !locked.every(Boolean)) {
        for (let j = 0; j < 3; j++) {
            if (locked[j]) continue;
            const bone = chain[j + 1].getAbsolutePosition()
                .subtract(joints[j].getAbsolutePosition());
            if (bone.lengthSquared() < 1e-10) { locked[j] = true; continue; }
            bone.normalize();
            const axis = Vector3.Cross(bone, palmar);
            if (axis.lengthSquared() < 1e-8) { locked[j] = true; continue; }
            axis.normalize();

            const ang = STEP * RATIOS[j];
            joints[j].rotate(axis, ang, Space.WORLD);
            refresh(chain);
            if (gap(chain[j + 1].getAbsolutePosition(), centre, world, idx) < -PENT) {
                joints[j].rotate(axis, -ang, Space.WORLD); // back off to rest on the surface
                refresh(chain);
                locked[j] = true;
            } else {
                bent[j] += ang;
            }
        }
        knuckle += STEP;
    }
    refresh(chain);
    return bent.filter((b) => b > 1e-4).length;
}
