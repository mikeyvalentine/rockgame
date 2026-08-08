/**
 * Procedural grip — curl the fingers around whatever rock is in the palm.
 *
 * Approach (matching the VR-grip references): drive each finger with a NATURAL
 * curl — the three joints bend in fixed anatomical proportions (MCP, PIP, DIP),
 * so the finger shape always reads as a real curl rather than a knuckle-only
 * claw — and close it until the fingertip reaches the rock, or until a phalanx
 * would sink into it (then step back). Small rock → the finger closes most of
 * the way; big rock → it stops early, draped over the surface.
 *
 * Flexion happens about the hand's ACROSS-THE-KNUCKLES axis (index→pinky),
 * MEASURED from the rig, not guessed — finger flexion is planar about that one
 * hinge, so using the same world axis for a finger's three joints gives a clean
 * curl. The sign is chosen so the curl goes toward the palm.
 *
 * Contact is plain JS against the rock's triangles (Babylon's mesh.intersects
 * misses in this tree-shaken build): the rock is transformed to world once and
 * a two-sided ray from its centre gives the surface radius in any direction.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";

const DT = 1 / 48;                    // close fraction per step
const DEG = Math.PI / 180;
// Full-curl target = a firm FIST, so a finger that never reaches the rock keeps
// closing until it meets the palm/other fingers instead of floating mid-air.
// Rock contact (below) stops a finger earlier when it does touch the stone.
const TARGET = [95 * DEG, 105 * DEG, 75 * DEG];
const THUMB_TARGET = [40 * DEG, 50 * DEG, 40 * DEG];
const SKIN = 0.006;                   // fingertip rests this far off the surface
const PENT = 0.004;                   // a phalanx may sink this far before we stop
const PALM_STOP = 0.02;               // stop once a fingertip curls to the palm (a closed fist)

const FINGERS = ["Index", "Middle", "Ring", "Pinky"];

/**
 * @param {object} a
 * @param {string} a.side
 * @param {(name:string)=>any} a.findNode
 * @param {import("@babylonjs/core/Meshes/mesh").Mesh} a.rockMesh
 * @param {{positions:Float32Array, indices:Uint32Array|Uint16Array}} a.geometry
 * @param {Vector3} a.palmar  unit vector toward the palm
 */
export function gripRock({ side, findNode, rockMesh, geometry, palmar }) {
    rockMesh.computeWorldMatrix(true);
    const centre = rockMesh.getAbsolutePosition().clone();
    const world = toWorld(geometry.positions, rockMesh.getWorldMatrix());
    const idx = geometry.indices;

    // Flexion hinge: the across-the-knuckles axis, signed so + curls to the palm.
    const i1 = findNode(`${side}HandIndex1`), p1 = findNode(`${side}HandPinky1`);
    const across = i1.getAbsolutePosition().subtract(p1.getAbsolutePosition());
    across.normalize();
    const mid1 = findNode(`${side}HandMiddle1`), mid4 = findNode(`${side}HandMiddle4`);
    const tipRel = mid4.getAbsolutePosition().subtract(mid1.getAbsolutePosition());
    if (Vector3.Dot(Vector3.Cross(across, tipRel), palmar) < 0) across.negate();

    // Where a fully-curled fingertip comes home to (the fist/palm), so a finger
    // that never reaches the rock stops there instead of floating.
    const palmPoint = FINGERS.concat("Thumb")
        .map((f) => findNode(`${side}Hand${f}1`))
        .filter(Boolean)
        .reduce((a, n) => a.addInPlace(n.getAbsolutePosition()), new Vector3())
        .scale(1 / (FINGERS.length + 1));

    let curled = 0;
    for (const f of FINGERS) {
        const chain = names(side, f).map(findNode).filter(Boolean);
        if (chain.length === 4) {
            curled += closeFinger(chain, across, TARGET, centre, world, idx, palmPoint);
        }
    }

    // The thumb OPPOSES rather than curls on a finger hinge: its own axis swings
    // its tip toward the rock (cross of the thumb's reach and the direction to
    // the rock), so its pad presses onto the top of the stone — the pinch.
    const thumb = names(side, "Thumb").map(findNode).filter(Boolean);
    if (thumb.length === 4) {
        const tRel = thumb[3].getAbsolutePosition().subtract(thumb[0].getAbsolutePosition());
        const toRock = centre.subtract(thumb[0].getAbsolutePosition());
        const thumbAxis = Vector3.Cross(tRel, toRock);
        if (thumbAxis.lengthSquared() > 1e-8) {
            thumbAxis.normalize();
            curled += closeFinger(thumb, thumbAxis, THUMB_TARGET, centre, world, idx, palmPoint);
        }
    }
    return curled;
}

const names = (side, f) => [1, 2, 3, 4].map((i) => `${side}Hand${f}${i}`);

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

/** Two-sided Möller–Trumbore. Ray param t>0, else Infinity. */
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

const _d = new Vector3();
/** Signed distance from world point `p` to the rock surface (<0 inside). */
function gap(p, centre, world, idx) {
    _d.copyFrom(p).subtractInPlace(centre);
    const dist = _d.length();
    if (dist < 1e-6) return -1;
    _d.scaleInPlace(1 / dist);
    let best = Infinity;
    for (let i = 0; i < idx.length; i += 3) {
        const t = rayTri(centre, _d, world, idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3);
        if (t < best) best = t;
    }
    return best === Infinity ? Infinity : dist - best;
}

function refresh(chain) {
    for (const n of chain) n.computeWorldMatrix(true);
}

/**
 * Swing a finger's base joint sideways about the palm normal `n` — the natural
 * abduction/adduction "wiggle" DOF — by `frac` of the angle that would aim the
 * fingertip straight at the rock. Makes the fingers converge on the stone
 * instead of curling in stiff parallel planes.
 */
function aimLateral(mcp, tip, rockC, n, frac) {
    mcp.computeWorldMatrix(true);
    tip.computeWorldMatrix(true);
    const m = mcp.getAbsolutePosition();
    const a = tip.getAbsolutePosition().subtract(m);
    const b = rockC.subtract(m);
    if (a.lengthSquared() < 1e-10 || b.lengthSquared() < 1e-10) return;
    const ang = Math.atan2(Vector3.Dot(Vector3.Cross(a, b), n), Vector3.Dot(a, b));
    mcp.rotate(n, ang * frac, Space.WORLD);
    mcp.computeWorldMatrix(true);
}

/**
 * Close one finger with a natural curl until the tip reaches the rock or a
 * phalanx would penetrate. Joints bend in proportion to `target`.
 * @returns {number} 1 if it moved
 */
function closeFinger(chain, axis, target, centre, world, idx, palmPoint) {
    const joints = [chain[0], chain[1], chain[2]];
    const tip = chain[3];
    const palmStopSq = PALM_STOP * PALM_STOP;
    let t = 0, moved = 0;

    while (t < 1) {
        // Step the whole finger a little, in proportion.
        for (let j = 0; j < 3; j++) joints[j].rotate(axis, target[j] * DT, Space.WORLD);
        refresh(chain);
        t += DT;

        // Penetration guard: if any phalanx tip sinks into the rock, step back.
        let penetrated = false;
        for (let j = 1; j < 4; j++) {
            if (gap(chain[j].getAbsolutePosition(), centre, world, idx) < -PENT) { penetrated = true; break; }
        }
        if (penetrated) {
            for (let j = 0; j < 3; j++) joints[j].rotate(axis, -target[j] * DT, Space.WORLD);
            refresh(chain);
            moved = 1;
            break;
        }
        moved = 1;
        // Stop on the rock (snug on its surface)...
        if (gap(tip.getAbsolutePosition(), centre, world, idx) <= SKIN) break;
        // ...or, failing the rock, once the fingertip has curled home to the
        // palm — so a finger that never reaches the stone still closes into the
        // fist and supports, instead of floating at a fixed angle.
        if (Vector3.DistanceSquared(tip.getAbsolutePosition(), palmPoint) < palmStopSq) break;
    }
    refresh(chain);
    return moved;
}
