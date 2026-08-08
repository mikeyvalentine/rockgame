/**
 * Swing gesture — the hand-velocity input (docs/03 Model B, first slice).
 *
 * A simple arc drawn around the SHOULDER in the arm·side panel, with a knob
 * the player drags back along it to wind up — the whole aimed arm follows,
 * rotating rigidly about the shoulder (elbow/wrist keep their aimed angles).
 * On release the arm whips forward through the aim pose (the release point,
 * marked by a tick), into a follow-through, then settles back to the aim.
 *
 * DETERMINISM: release speed is an analytic function of the wind-up angle —
 *   v = SPEED_PER_DEG × windup°   at the hand, tangent to the swing circle —
 * not a framerate-dependent measurement. The animation is presentation only.
 * SPEED_PER_DEG is a feel value (decide in engine).
 *
 * The release readout (speed + elevation) stays on screen — every variable
 * that decides an outcome gets a readable value. `LAB_SWING.lastRelease`
 * carries {speed, elevationDeg, dir} for the throwStone() hookup next.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const WMAX = 90 * RAD;          // max wind-up back from the aim pose
const SPEED_PER_DEG = 0.15;     // m/s of hand speed per degree of wind-up (feel value)
const SETTLE_S = 0.5;           // follow-through → aim-pose settle time
const X = new Vector3(1, 0, 0);

export function setupSwing({ scene, engine, canvas, cam, findNode, side }) {
    const shoulder = findNode(side + "Arm");
    const hand = findNode(side + "Hand");
    if (!shoulder || !hand) {
        console.warn("[throw-lab] swing: joints not found");
        return;
    }

    // --- overlay: arc + knob + release tick + readout, clipped to arm·side --
    const wrap = document.createElement("div");
    wrap.id = "swing";
    wrap.innerHTML = `
      <svg id="swing-svg" width="100%" height="100%">
        <path id="swing-arc" fill="none"/>
        <line id="swing-tick"/>
        <circle id="swing-knob" r="11"/>
      </svg>
      <div id="swing-readout" hidden></div>`;
    document.body.appendChild(wrap);
    const arcEl = wrap.querySelector("#swing-arc");
    const tickEl = wrap.querySelector("#swing-tick");
    const knobEl = wrap.querySelector("#swing-knob");
    const readEl = wrap.querySelector("#swing-readout");

    // --- state ---------------------------------------------------------------
    // w = wind-up angle back from the aim pose (rad, 0..WMAX). All arm motion
    // here is rotate-by-delta of w about world X at the shoulder, so w always
    // describes the offset from the aim pose exactly, and w=0 restores it.
    let w = 0;
    let mode = "idle";            // idle | windup | swing | settle
    let omega = 0, alpha = 0;     // swing angular speed/accel (rad/s, rad/s²)
    let followMin = 0;            // follow-through target (negative w)
    let fired = null;             // {omegaRel, windupDeg} captured at fire time (analytic)
    let dirScreen = 1;            // +w on screen: +1 clockwise, -1 ccw (calibrated)
    let aimAngle = 0, radius = 0; // screen-space arc geometry, refreshed when idle

    function setW(newW) {
        const d = newW - w;
        if (d === 0) return;
        shoulder.rotate(X, d, Space.WORLD);
        shoulder.computeWorldMatrix(true);
        w = newW;
    }

    // --- projection (same convention as pivot.js) ----------------------------
    function project(world) {
        const t = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
        const ndc = Vector3.TransformCoordinates(world, t);
        const W = canvas.clientWidth, H = canvas.clientHeight;
        const vp = cam.viewport;
        return {
            x: vp.x * W + (ndc.x * 0.5 + 0.5) * vp.width * W,
            y: (1 - (vp.y + vp.height)) * H + (0.5 - ndc.y * 0.5) * vp.height * H,
        };
    }

    // --- knob drag ------------------------------------------------------------
    knobEl.addEventListener("mousedown", (e) => {
        if (mode === "swing" || mode === "settle") return;
        e.preventDefault();
        mode = "windup";
        // Calibrate which screen direction +w sweeps, from the live geometry:
        // rotate the hand's offset by +ε about X and compare screen angles.
        const S3 = shoulder.getAbsolutePosition(), H3 = hand.getAbsolutePosition();
        const off = H3.subtract(S3);
        const p0 = project(H3), pS = project(S3);
        const p1 = project(S3.add(rotXBy(off, 0.02)));
        const a0 = Math.atan2(p0.y - pS.y, p0.x - pS.x);
        const a1 = Math.atan2(p1.y - pS.y, p1.x - pS.x);
        dirScreen = wrapA(a1 - a0) >= 0 ? 1 : -1;
        aimAngle = wrapA(a0 - w * dirScreen); // where w=0 sits on screen
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    });
    function onMove(e) {
        if (mode !== "windup") return;
        const pS = project(shoulder.getAbsolutePosition());
        const a = Math.atan2(e.clientY - pS.y, e.clientX - pS.x);
        const target = clamp(wrapA(a - aimAngle) * dirScreen, 0, WMAX);
        setW(target);
    }
    function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (mode !== "windup") return;
        if (w < 2 * RAD) { setW(0); mode = "idle"; return; } // too small — just relax
        // Fire: constant angular acceleration from rest so that at w=0 the hand
        // moves at exactly v = SPEED_PER_DEG × windup° (deterministic).
        const vRel = SPEED_PER_DEG * (w * DEG);
        const r = Vector3.Distance(shoulder.getAbsolutePosition(), hand.getAbsolutePosition());
        const omegaRel = vRel / Math.max(r, 1e-3);
        alpha = (omegaRel * omegaRel) / (2 * w);
        omega = 0;
        followMin = -w;           // symmetric follow-through
        fired = { omegaRel, windupDeg: +(w * DEG).toFixed(1) };
        mode = "swing";
    }

    // --- swing animation (presentation; release numbers are analytic) --------
    let settleFrom = 0, settleT = 0;
    scene.onBeforeRenderObservable.add(() => {
        const dt = Math.min(engine.getDeltaTime() / 1000, 1 / 20);
        if (mode === "swing") {
            const wasPositive = w > 0;
            omega += alpha * dt;
            let next = w - omega * dt;             // swinging forward = w decreasing
            if (wasPositive && next <= 0) {
                release();                          // crossed the aim pose — release
            }
            if (next <= followMin) {                // follow-through spent
                next = followMin;
                mode = "settle";
                settleFrom = next; settleT = 0;
            }
            setW(next);
            if (w <= 0) omega -= 2 * alpha * dt;    // decelerate past release
            if (omega <= 0 && w <= 0) { mode = "settle"; settleFrom = w; settleT = 0; }
        } else if (mode === "settle") {
            settleT += dt;
            const k = Math.min(settleT / SETTLE_S, 1);
            setW(settleFrom * (1 - k * k * (3 - 2 * k)));   // smoothstep home
            if (k >= 1) { setW(0); mode = "idle"; }
        }
        drawOverlay();
    });

    function release() {
        // Analytic release velocity: ω × r at the aim pose, tangent forward —
        // ω is the value the wind-up DETERMINES (fired.omegaRel), not the
        // frame-integrated one, so identical wind-ups give identical numbers.
        const S3 = shoulder.getAbsolutePosition(), H3 = hand.getAbsolutePosition();
        const r = H3.subtract(S3);
        // w decreasing = rotation in the −X sense.
        const omegaVec = new Vector3(-fired.omegaRel, 0, 0);
        const v = Vector3.Cross(omegaVec, r);
        const speed = v.length();
        const elev = Math.asin(clamp(v.y / Math.max(speed, 1e-6), -1, 1)) * DEG;
        readEl.hidden = false;
        readEl.textContent = `release  ${speed.toFixed(1)} m/s  @  ${elev.toFixed(0)}°`;
        globalThis.LAB_SWING = {
            lastRelease: {
                speed: +speed.toFixed(3),
                elevationDeg: +elev.toFixed(1),
                dir: { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) },
                windupDeg: fired.windupDeg,
            },
        };
        console.log("[throw-lab] " + readEl.textContent);
    }

    // --- drawing --------------------------------------------------------------
    function drawOverlay() {
        const pS = project(shoulder.getAbsolutePosition());
        const pH = project(hand.getAbsolutePosition());
        const hx = pH.x - pS.x, hy = pH.y - pS.y;
        radius = Math.hypot(hx, hy);
        if (mode === "idle") {
            // While aimable, the arc anchors to the live aim pose.
            const S3 = shoulder.getAbsolutePosition(), H3 = hand.getAbsolutePosition();
            const off = H3.subtract(S3);
            const p1 = project(S3.add(rotXBy(off, 0.02)));
            const a0 = Math.atan2(pH.y - pS.y, pH.x - pS.x);
            const a1 = Math.atan2(p1.y - pS.y, p1.x - pS.x);
            dirScreen = wrapA(a1 - a0) >= 0 ? 1 : -1;
            aimAngle = a0;
        }
        // Arc spans the wind-up range back from the aim pose.
        const aEnd = aimAngle + WMAX * dirScreen;
        arcEl.setAttribute("d", arcPath(pS.x, pS.y, radius, aimAngle, aEnd));
        // Release tick at the aim angle.
        const t0 = pointAt(pS, radius - 8, aimAngle), t1 = pointAt(pS, radius + 8, aimAngle);
        tickEl.setAttribute("x1", t0.x); tickEl.setAttribute("y1", t0.y);
        tickEl.setAttribute("x2", t1.x); tickEl.setAttribute("y2", t1.y);
        // Knob rides at the current wind-up.
        const k = pointAt(pS, radius, aimAngle + w * dirScreen);
        knobEl.setAttribute("cx", k.x); knobEl.setAttribute("cy", k.y);
        // Readout sits under the arc's shoulder.
        readEl.style.left = (pS.x - 60) + "px";
        readEl.style.top = (pS.y + 24) + "px";
    }

    drawOverlay();
}

// ----------------------------------------------------------------------------

function rotXBy(v, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return new Vector3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}
function pointAt(c, r, a) {
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}
function arcPath(cx, cy, r, a0, a1) {
    const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
    const p1 = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
    const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const sweep = a1 > a0 ? 1 : 0;
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} ${sweep} ${p1.x} ${p1.y}`;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function wrapA(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}
