/**
 * Per-joint pivot handles — the aim-pose editor (docs/03 Layer-1).
 *
 * Each 2D panel edits rotation IN its own plane, i.e. about the axis pointing
 * into the screen:
 *   SIDE panels (look along X) → rotate about world X  (the fore/back swing)
 *   TOP  panels (look along Y) → rotate about world Y  (the left/right aim)
 *
 * Handles:
 *   arm · side  → shoulder, elbow, wrist   about X
 *   arm · top   → shoulder, elbow, wrist   about Y
 *   wrist · side→ wrist (fine)             about X
 *   wrist · top → wrist (fine)             about Y
 *
 * Interaction: click-and-hold a joint dot and drag around it to pivot — the
 * bone follows the cursor's angle (drag sign is calibrated per grab so it feels
 * direct regardless of the mirror). A small "− NN° +" readout appears by the
 * joint on first grab and then stays; its buttons nudge ±1°.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const NUDGE = 1 * RAD;             // ± button step
const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);

/**
 * Anatomical limits per DOF, degrees of CUMULATIVE rotation from the rest pose
 * (upper arm down, elbow at 90°, hand forward). Signs are in the world-axis
 * terms the readouts use, verified empirically in the lab:
 *   X (side views): + swings the limb DOWN/BACK, − swings it UP/FORWARD.
 *   Y (top views):  + swings it toward the body's midline, − away from it.
 * The elbow's +90 is exactly "arm hangs straight"; past it would hyperextend.
 */
const LIMITS = {
    "shoulder|X": [-170, 45],   // flexion way up forward ... a little extension back
    "shoulder|Y": [-90, 90],    // horizontal aim sweep
    "elbow|X": [-55, 90],       // deeper flex ... straight arm (no hyperextension)
    "elbow|Y": [-80, 80],       // forearm sweep (really shoulder rotation, kept modest)
    "wrist|X": [-70, 75],       // extension (knuckles up) ... flexion (palm in)
    "wrist|Y": [-40, 40],       // radial/ulnar deviation — small by nature
};

export function setupPivots({ scene, canvas, cams, findNode, side }) {
    const node = {
        shoulder: findNode(side + "Arm"),
        elbow: findNode(side + "ForeArm_"),
        wrist: findNode(side + "Hand"),
    };
    // A point down-chain of each joint, to read the bone's on-screen direction
    // (used only to calibrate the drag sign).
    const childNode = {
        shoulder: node.elbow,
        elbow: node.wrist,
        wrist: findNode(side + "HandMiddle3"),
    };
    if (!node.shoulder || !node.elbow || !node.wrist) {
        console.warn("[throw-lab] pivots: joints not found");
        return;
    }

    // Cumulative angle per joint+axis (radians), shared across panels that edit
    // the same DOF (e.g. wrist·X in both arm-side and wrist-side).
    const angle = {};
    const key = (joint, axisName) => `${joint}|${axisName}`;

    // Handles: one per (panel, joint). cams order = armSide, armTop, wristSide, wristTop.
    const panels = [
        { cam: cams[0].cam, axis: X, axisName: "X", joints: ["shoulder", "elbow", "wrist"] },
        { cam: cams[1].cam, axis: Y, axisName: "Y", joints: ["shoulder", "elbow", "wrist"] },
        { cam: cams[2].cam, axis: X, axisName: "X", joints: ["wrist"] },
        { cam: cams[3].cam, axis: Y, axisName: "Y", joints: ["wrist"] },
    ];

    // --- overlay DOM --------------------------------------------------------
    const overlay = document.createElement("div");
    overlay.id = "pivots";
    document.body.appendChild(overlay);

    const handles = [];
    for (const panel of panels) {
        for (const joint of panel.joints) {
            const dot = document.createElement("div");
            dot.className = "pivot-dot";
            const readout = document.createElement("div");
            readout.className = "pivot-readout";
            readout.hidden = true;
            const minus = el("span", "pivot-btn", "−");
            const val = el("span", "pivot-val", "0°");
            const plus = el("span", "pivot-btn", "+");
            readout.append(minus, val, plus);
            overlay.append(dot, readout);

            const h = { panel, joint, dot, readout, val, shown: false };
            handles.push(h);

            const k = key(joint, panel.axisName);
            if (angle[k] === undefined) angle[k] = 0;

            dot.addEventListener("mousedown", (e) => startDrag(e, h));
            minus.addEventListener("mousedown", (e) => { e.stopPropagation(); nudge(h, -NUDGE); });
            plus.addEventListener("mousedown", (e) => { e.stopPropagation(); nudge(h, +NUDGE); });
        }
    }

    // --- projection ---------------------------------------------------------
    function panelRect(cam) {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        const vp = cam.viewport;
        return {
            left: vp.x * W, top: (1 - (vp.y + vp.height)) * H,
            width: vp.width * W, height: vp.height * H,
        };
    }
    function project(world, cam) {
        const t = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
        const ndc = Vector3.TransformCoordinates(world, t);
        const r = panelRect(cam);
        return {
            x: r.left + (ndc.x * 0.5 + 0.5) * r.width,
            y: r.top + (0.5 - ndc.y * 0.5) * r.height,
            r,
        };
    }

    // --- drag ---------------------------------------------------------------
    let drag = null;
    function startDrag(e, h) {
        e.preventDefault();
        const j = node[h.joint];
        j.computeWorldMatrix(true);
        const pivotW = j.getAbsolutePosition();
        const p = project(pivotW, h.panel.cam);

        // Calibrate sign: does +ε about the axis increase the child's screen angle?
        const cW = childNode[h.joint].getAbsolutePosition();
        const rotated = rotateAbout(cW, pivotW, h.panel.axis, 0.02);
        const c0 = project(cW, h.panel.cam), c1 = project(rotated, h.panel.cam);
        const a0 = Math.atan2(c0.y - p.y, c0.x - p.x);
        const a1 = Math.atan2(c1.y - p.y, c1.x - p.x);
        const sign = wrap(a1 - a0) >= 0 ? 1 : -1;

        drag = {
            h, joint: j, axis: h.panel.axis, key: key(h.joint, h.panel.axisName),
            jx: p.x, jy: p.y, sign,
            last: null,   // set on first move (grab point is on the joint, angle is degenerate there)
        };
        reveal(h);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }
    function onMove(e) {
        if (!drag) return;
        const a = mouseAngle(e, drag.jx, drag.jy);
        if (drag.last === null) { drag.last = a; return; }
        const d = wrap(a - drag.last) * drag.sign;
        drag.last = a;
        applyRotation(drag.joint, drag.axis, drag.key, d);
    }
    function onUp() {
        drag = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
    }
    function nudge(h, delta) {
        reveal(h);
        applyRotation(node[h.joint], h.panel.axis, key(h.joint, h.panel.axisName), delta);
    }
    function applyRotation(j, axis, k, delta) {
        // Clamp to the DOF's anatomical range: apply only what fits, so the
        // joint parks exactly at its limit instead of over-rotating.
        const lim = LIMITS[k];
        if (lim) {
            const next = Math.min(lim[1] * RAD, Math.max(lim[0] * RAD, angle[k] + delta));
            delta = next - angle[k];
            if (delta === 0) return;
        }
        j.rotate(axis, delta, Space.WORLD);
        j.computeWorldMatrix(true);
        angle[k] += delta;
        // Reflect the shared value on every handle bound to this DOF.
        for (const h of handles) {
            if (key(h.joint, h.panel.axisName) === k && h.shown) setVal(h, angle[k]);
        }
    }
    function reveal(h) {
        h.shown = true;
        h.readout.hidden = false;
        setVal(h, angle[key(h.joint, h.panel.axisName)]);
    }
    function setVal(h, rad) {
        const d = Math.round(rad * DEG);
        h.val.textContent = (d > 0 ? "+" : "") + d + "°";
    }

    // Console/automation access: LAB_PIVOT.rotate("elbow","X",40) drives the
    // same clamped path as a drag; angles() reads the pose back in degrees.
    globalThis.LAB_PIVOT = {
        rotate: (joint, axisName, deg) => {
            const j = node[joint];
            if (!j || (axisName !== "X" && axisName !== "Y")) return null;
            applyRotation(j, axisName === "X" ? X : Y, key(joint, axisName), deg * RAD);
            return angle[key(joint, axisName)] * DEG;
        },
        angles: () => Object.fromEntries(
            Object.entries(angle).map(([k, v]) => [k, +(v * DEG).toFixed(1)])),
        limits: LIMITS,
    };

    // --- per-frame: keep dots and readouts glued to the joints --------------
    scene.onBeforeRenderObservable.add(() => {
        for (const h of handles) {
            const j = node[h.joint];
            const p = project(j.getAbsolutePosition(), h.panel.cam);
            const inside = p.x >= p.r.left && p.x <= p.r.left + p.r.width &&
                           p.y >= p.r.top && p.y <= p.r.top + p.r.height;
            h.dot.style.display = inside ? "block" : "none";
            h.dot.style.left = p.x + "px";
            h.dot.style.top = p.y + "px";
            if (h.shown) {
                h.readout.hidden = !inside;
                h.readout.style.left = (p.x + 16) + "px";  // diagonally up-right
                h.readout.style.top = (p.y - 30) + "px";
            }
        }
    });
}

// --------------------------------------------------------------------------

function el(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    e.textContent = text;
    return e;
}
function mouseAngle(e, jx, jy) {
    // clientX/Y are viewport coords; the canvas fills the viewport so they equal
    // canvas-local coords (canvas at 0,0), which is what jx/jy are in too.
    return Math.atan2(e.clientY - jy, e.clientX - jx);
}
function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}
function rotateAbout(p, pivot, axis, ang) {
    const q = Quaternion.RotationAxis(axis, ang);
    const v = p.subtract(pivot);
    const out = new Vector3();
    v.rotateByQuaternionToRef(q, out);
    return pivot.add(out);
}
