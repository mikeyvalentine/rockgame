// The heightfield ray-marcher both interaction tools aim with — pure math.

import { marchHeightfield } from "../src/tools/raymarch.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

const flat = () => 0;

// Straight down onto flat ground.
let hit = marchHeightfield({ origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -1, z: 0 } }, flat, 10);
check("vertical hit lands", !!hit && Math.abs(hit.y) < 0.02 && Math.abs(hit.x) < 1e-9,
    hit && "y " + hit.y.toFixed(4));

// 45° forward: hits the ground two metres out.
const s = Math.SQRT1_2;
hit = marchHeightfield({ origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -s, z: s } }, flat, 20);
check("angled hit at z≈2", !!hit && Math.abs(hit.z - 2) < 0.05, hit && "z " + hit.z.toFixed(3));

// A sloped field: the hit sits on the surface, not near it.
const slope = (x) => x * 0.5;
hit = marchHeightfield({ origin: { x: 4, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } }, (x, z) => slope(x), 20);
check("slope hit on surface", !!hit && Math.abs(hit.y - slope(hit.x)) < 0.02,
    hit && "dy " + (hit.y - slope(hit.x)).toFixed(4));

// Pointing at the sky: no hit.
hit = marchHeightfield({ origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, flat, 50);
check("sky ray misses", hit === null);

// Grazing above the ground inside maxDist: no hit.
hit = marchHeightfield({ origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: 0.001, z: 1 } }, flat, 30);
check("grazing ray misses", hit === null);

process.exit(failures ? 1 : 0);
