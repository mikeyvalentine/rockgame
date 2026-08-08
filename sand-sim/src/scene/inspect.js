/**
 * Stone inspection — the field's answer to rock-sift's examine.
 *
 * E (or a click) pulls the stone under the centre of the screen up to the
 * camera; moving the mouse turns it over; E / Escape / another click puts it
 * back. No crosshair — the centre of a first-person view IS the pointer, per
 * the barebones-UI rule.
 *
 * The stone shown is a fresh high-LOD build of the field stone's archetype
 * (the field itself draws carpet domes and level-1 instances — neither is
 * worth holding at reading distance). The ground stone stays where it lies:
 * v1 inspects a copy rather than lifting the instance out of the carpet and
 * the tile buffers, which is the pickup animation's job later.
 *
 * The stats panel is docs/02's readout in placeholder form, but the NUMBERS
 * are real: `shared/rockRating.js` — the same flatness / balance / mass
 * scoring and rarity tiers the sift examine used — fed from the archetype's
 * actual geometry (measured spans, signed-volume mass).
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";

import { input, allowWorldTools } from "../core/input.js";
import { skipRating } from "../../../shared/rockRating.js";

/** Metres in front of the eye the stone is held. */
const HOLD_DISTANCE = 0.38;
/** And a touch below the eye line, where a hand would hold it. */
const HOLD_DROP = 0.045;
/** How far away a stone can be plucked from, metres. */
const REACH = 3.2;
/** Mouse-to-rotation gain, on top of the look scale. */
const TURN_GAIN = 2.4;
/** Rock density for the mass readout, g/cm^3 — quartz-ish, placeholder. */
const ROCK_DENSITY = 2.65;

export function createInspect({ scene, rig, rocks }) {
    /** The held stone's mesh, made once and re-skinned per pick. */
    const mesh = new Mesh("inspectStone", scene);
    mesh.isPickable = false;
    mesh.setEnabled(false);
    mesh.rotationQuaternion = Quaternion.Identity();

    const panel = buildPanel();

    let engaged = false;
    let frozen = { yaw: 0, pitch: 0 };
    const lookFilter = (pose) => { pose.yaw = frozen.yaw; pose.pitch = frozen.pitch; };

    const _up = new Vector3();
    const _right = new Vector3();
    const _q = new Quaternion();

    function tryEnter() {
        if (engaged || !input.locked || !rocks.pickAlongRay) return false;
        const cam = rig.camera;
        const hit = rocks.pickAlongRay(
            cam.position.x, cam.position.y, cam.position.z,
            rig.forward.x, rig.forward.y, rig.forward.z,
            REACH
        );
        if (!hit) return false;

        const data = rocks.examineData(hit.archetype);
        data.vertexData.applyToMesh(mesh, false);
        mesh.material = data.material;
        mesh.position.copyFrom(cam.position)
            .addInPlace(rig.forward.scale(HOLD_DISTANCE))
            .addInPlace(rig.up.scale(-HOLD_DROP));
        mesh.rotationQuaternion.copyFromFloats(0, 0, 0, 1);
        mesh.setEnabled(true);

        // Freeze the view where it is; the mouse belongs to the stone now.
        frozen = { yaw: rig.yaw, pitch: rig.pitch };
        _up.copyFrom(rig.up);
        _right.copyFrom(rig.right);
        rig.lookFilter = lookFilter;
        // No digging or painting while a stone is in hand.
        allowWorldTools(false);

        panel.show(describe(data));
        engaged = true;
        return true;
    }

    function exit() {
        if (!engaged) return;
        engaged = false;
        mesh.setEnabled(false);
        panel.hide();
        rig.lookFilter = null;
        allowWorldTools(true);
    }

    // A click while locked either picks the stone ahead or puts the held one
    // back. Registered on document like the dig button, and after it — engage
    // flips worldTools off, which also drops the dig the same click started.
    document.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || !input.locked) return;
        if (engaged) exit();
        else tryEnter();
    });

    return {
        get engaged() { return engaged; },
        toggle() { engaged ? exit() : tryEnter(); },
        exit,
        /**
         * Turn the held stone by the frame's mouse delta. Returns whether the
         * mode is engaged, which the app uses to freeze the walker.
         */
        update() {
            if (!engaged) return false;
            // Losing pointer lock (Escape) must not leave a frozen camera.
            if (!input.locked) { exit(); return false; }
            if (input.lookX || input.lookY) {
                Quaternion.RotationAxisToRef(_up, input.lookX * TURN_GAIN, _q);
                _q.multiplyToRef(mesh.rotationQuaternion, mesh.rotationQuaternion);
                Quaternion.RotationAxisToRef(_right, input.lookY * TURN_GAIN, _q);
                _q.multiplyToRef(mesh.rotationQuaternion, mesh.rotationQuaternion);
            }
            return true;
        },
        dispose() { exit(); mesh.dispose(); panel.dispose(); },
    };
}

// ---------------------------------------------------------------- the stats

/**
 * Measure the archetype's real geometry and rate it with the shared scoring.
 * Span from the vertex bounds, mass from the signed volume — the same
 * quantities rock-sift's examine measured off its meshes.
 */
function describe(data) {
    const p = data.vertexData.positions;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
        if (p[i] < minX) minX = p[i];
        if (p[i] > maxX) maxX = p[i];
        if (p[i + 1] < minY) minY = p[i + 1];
        if (p[i + 1] > maxY) maxY = p[i + 1];
        if (p[i + 2] < minZ) minZ = p[i + 2];
        if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    const sortedCm = [
        (maxX - minX) * 100, (maxY - minY) * 100, (maxZ - minZ) * 100,
    ].sort((a, b) => b - a);

    const volumeM3 = Math.abs(signedVolume(p, data.vertexData.indices));
    const massGrams = volumeM3 * 1e6 * ROCK_DENSITY;

    const metrics = { sortedCm, massGrams };
    // The forge shape carries the honest flatness/balance descriptors when it
    // has them; skipRating falls back to span ratios when it does not.
    if (data.shape && typeof data.shape.flatness === "number") metrics.shape = data.shape;
    const rating = skipRating(metrics);
    return { data, sortedCm, massGrams, rating };
}

/** Signed volume of a closed triangle mesh (divergence theorem). */
function signedVolume(positions, indices) {
    let six = 0;
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
        const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
        const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
        six += ax * (by * cz - bz * cy)
             - ay * (bx * cz - bz * cx)
             + az * (bx * cy - by * cx);
    }
    return six / 6;
}

// ---------------------------------------------------------------- the panel

function buildPanel() {
    const el = document.createElement("div");
    el.id = "inspect-panel";
    el.style.cssText = [
        "position:fixed", "right:4%", "top:50%", "transform:translateY(-50%)",
        "min-width:200px", "padding:14px 16px", "border-radius:6px",
        "background:rgba(7,11,18,0.72)", "color:#dbe6f2",
        "font:500 13px/1.5 var(--stefan-tight, ui-sans-serif), ui-sans-serif",
        "letter-spacing:0.05em", "pointer-events:none",
        "opacity:0", "transition:opacity 160ms ease", "z-index:60",
    ].join(";");
    document.body.appendChild(el);

    const bar = (label, score) => {
        const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
        return `<div style="margin-top:7px">
            <div style="display:flex;justify-content:space-between">
                <span style="text-transform:lowercase">${label}</span>
                <span style="opacity:0.75">${pct}</span>
            </div>
            <div style="height:4px;border-radius:2px;background:rgba(255,255,255,0.14);margin-top:3px">
                <div style="height:100%;width:${pct}%;border-radius:2px;background:#7fb4e6"></div>
            </div>
        </div>`;
    };

    return {
        show({ data, sortedCm, massGrams, rating }) {
            const tier = rating.rarity;
            const dims = sortedCm.map((v) => v.toFixed(1)).join(" × ");
            el.innerHTML = `
                <div style="font-size:14px;text-transform:capitalize">${data.family}</div>
                <div style="opacity:0.75;margin-top:2px">${dims} cm · ${Math.round(massGrams)} g</div>
                <div style="margin-top:6px;color:${tier.color}">${tier.label}</div>
                ${bar("flatness", rating.stats.flatness)}
                ${bar("balance", rating.stats.balance)}
                ${bar("size", rating.stats.size)}
                ${bar("mass", rating.stats.mass)}
                ${bar("overall", rating.score)}
                <div style="margin-top:9px;opacity:0.8">${rating.verdict}</div>
                <div style="margin-top:10px;opacity:0.6;text-transform:lowercase">e / click to put back</div>
            `;
            el.style.opacity = "1";
        },
        hide() { el.style.opacity = "0"; },
        dispose() { el.remove(); },
    };
}
