/**
 * Procedural grip — curl the fingers around whatever rock is in the palm.
 *
 * No authored grip pose: each finger closes onto the rock's actual surface, so
 * any stone from the forge is held naturally. Per joint, base to tip, we curl
 * toward the palm in small steps and stop when that joint's distal end reaches
 * the rock — so each phalanx comes to rest against the stone and the finger
 * wraps its real shape. The thumb opposes with the same rule.
 *
 * "Reach the rock" is a ray from the rock's CENTRE outward through the joint:
 * the hit distance is the stone's radius in that direction, and the joint has
 * arrived once it is within a finger-thickness of it. Rocks are roughly
 * star-convex from their centre, so one ray per test is enough and cheap.
 *
 * Curl direction is derived, not hand-tuned: rotating a bone about
 * (boneDir × palmar) by a positive angle turns it toward the palm — true for
 * every finger and the thumb regardless of how they fan out.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Ray } from "@babylonjs/core/Culling/ray";

const STEP = (4 * Math.PI) / 180;    // curl increment per step
const MAX = (115 * Math.PI) / 180;   // ceiling per joint, so a miss can't spin
const SKIN = 0.008;                  // finger half-thickness — rest just off the surface

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];

/**
 * @param {object} a
 * @param {string} a.side  "Right"/"Left"
 * @param {(name:string)=>any} a.findNode
 * @param {import("@babylonjs/core/Meshes/mesh").Mesh} a.rockMesh
 * @param {Vector3} a.palmar  unit vector toward the palm (where fingers close)
 */
export function gripRock({ side, findNode, rockMesh, palmar }) {
    rockMesh.computeWorldMatrix(true);
    const centre = rockMesh.getAbsolutePosition().clone();
    const dir = palmar.clone();
    dir.normalize();

    let curled = 0;
    for (const f of FINGERS) {
        const chain = [1, 2, 3, 4]
            .map((i) => findNode(`${side}Hand${f}${i}`))
            .filter(Boolean);
        if (chain.length >= 2) curled += curlChain(chain, centre, rockMesh, dir);
    }
    return curled;
}

/** True once `pointW` is within SKIN of the rock's surface (or inside it). */
function atRock(pointW, centre, rockMesh) {
    const d = pointW.subtract(centre);
    const dist = d.length();
    if (dist < 1e-6) return true;
    d.normalize();
    const pick = rockMesh.intersects(new Ray(centre, d, 2.0), false);
    const surfaceR = pick && pick.hit ? pick.distance : 0;
    return dist <= surfaceR + SKIN;
}

function refresh(chain) {
    for (const n of chain) n.computeWorldMatrix(true);
}

/** Curl a finger's joints (base→second-last) until each one's child meets the rock. */
function curlChain(chain, centre, rockMesh, palmar) {
    let moved = 0;
    for (let j = 0; j < chain.length - 1; j++) {
        const joint = chain[j];
        const child = chain[j + 1];
        let total = 0;
        while (total < MAX) {
            refresh(chain);
            if (atRock(child.getAbsolutePosition(), centre, rockMesh)) break;
            const bone = child.getAbsolutePosition().subtract(joint.getAbsolutePosition());
            if (bone.lengthSquared() < 1e-10) break;
            bone.normalize();
            const axis = Vector3.Cross(bone, palmar);
            if (axis.lengthSquared() < 1e-8) break; // bone parallel to palmar
            axis.normalize();
            joint.rotate(axis, STEP, Space.WORLD);
            total += STEP;
        }
        if (total > 0) moved++;
        refresh(chain);
    }
    return moved;
}
