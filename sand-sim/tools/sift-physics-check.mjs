// The bed waking up in the beach's own scene, at 1:1 metres. Real Havok, real
// bed files, NullEngine — no GPU.
//
// What this pins is the swap, because the swap is where the crouch stops being
// a load and becomes a camera move. Scenery out, bodies in, at the same
// transforms; and back again, keeping whatever arrangement the bed was left in.
//
// It also re-measures the thing that made 1:1 possible at all: a restored bed
// on a flat crown should sit still. rock-sift models at 4x to stay clear of
// Havok's margins, and this is the check that living in metres did not quietly
// cost that.

import fs from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import HavokPhysics from "@babylonjs/havok";

import { decodeBed } from "../../shared/bedFormat.js";
import { SIFT_SPOTS } from "../../shared/pileField.js";
import { shoreProfileJS } from "../src/terrain/beachParams.js";
import { initSiftPhysics, PHYSICS_SUBSTEP_MS } from "../src/scene/siftPhysics.js";
import { U } from "../src/scene/siftingBeds.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

const wasmBinary = fs.readFileSync(
    new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url)
);
const havok = await HavokPhysics({ wasmBinary });

const raw = fs.readFileSync(new URL("../../public/assets/beds/shore-0.bed", import.meta.url));
const bed = decodeBed(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

const engine = new NullEngine();
const scene = new Scene(engine);

const t0 = Date.now();
const physics = initSiftPhysics(scene, new HavokPlugin(true, havok));
const hullMs = Date.now() - t0;

check("a hull exists for every stone the bed names",
    bed.names.every((n) => physics.hulls.has(n)),
    bed.names.filter((n) => !physics.hulls.has(n)).slice(0, 3).join(", "));

// Hulls are the expensive half of the preload, and the reason the crouch has no
// loading is that this cost is paid while the beach loads instead.
check("hulls build inside a loading screen", hullMs < 4000, hullMs + " ms for 40 hulls");
console.log("     preload: " + hullMs + " ms for 40 convex hulls");

// ---------------------------------------------------------------------------
// The swap
// ---------------------------------------------------------------------------

const spot = SIFT_SPOTS[0];
const baseY = shoreProfileJS(spot.x, spot.z, 1);

// Stand in for buildSiftingBeds' handle: the same shape, without a GPU.
let sceneryOn = true;
const beds = {
    bedForSpot: new Map([[spot.id, { bed, baseY }]]),
    setSceneryEnabled: (id, on) => { sceneryOn = on; },
};

const tWake = Date.now();
const awake = physics.wake(beds, spot);
const wakeMs = Date.now() - tWake;

check("the whole bed wakes", awake.rocks.length === bed.count,
    awake.rocks.length + " of " + bed.count);
check("scenery goes away while the bed is awake", sceneryOn === false);
// The number that decides whether the crouch can be a camera move rather than a
// load. rock-sift measured ~28 ms for the same swap.
check("waking fits inside the camera move", wakeMs < 500, wakeMs + " ms");
console.log("     wake: " + wakeMs + " ms for " + awake.rocks.length + " bodies");

// Bodies must land where the scenery was: same world metres, bed units over U.
let worstPlacement = 0;
for (const r of awake.rocks) {
    const i = r.index;
    const wantX = bed.positions[i * 3] / U + spot.x;
    const wantY = bed.positions[i * 3 + 1] / U + baseY;
    const wantZ = bed.positions[i * 3 + 2] / U + spot.z;
    worstPlacement = Math.max(worstPlacement, Math.hypot(
        r.node.position.x - wantX, r.node.position.y - wantY, r.node.position.z - wantZ
    ));
}
check("bodies spawn exactly where the scenery was", worstPlacement < 1e-6,
    (worstPlacement * 1000).toFixed(4) + " mm");

// And on the crown, not floating above it or buried in it.
let lowest = Infinity;
let highest = -Infinity;
for (const r of awake.rocks) {
    lowest = Math.min(lowest, r.node.position.y - baseY);
    highest = Math.max(highest, r.node.position.y - baseY);
}
check("the bed sits on the crown", lowest > -0.1 && highest < 0.35,
    lowest.toFixed(3) + " .. " + highest.toFixed(3) + " m above the crown");

// ---------------------------------------------------------------------------
// It has to stay put — this is what 1:1 was tested for
// ---------------------------------------------------------------------------

const before = awake.rocks.map((r) => r.node.position.clone());
const dt = PHYSICS_SUBSTEP_MS / 1000;
for (let i = 0; i < 4 / dt; i++) scene.getPhysicsEngine()._step(dt);

let maxDrift = 0;
let sunk = 0;
for (const [i, r] of awake.rocks.entries()) {
    maxDrift = Math.max(maxDrift, Vector3.Distance(r.node.position, before[i]));
    if (r.node.position.y - baseY < -0.05) sunk++;
}
// Creep, not collapse. rock-sift's own bed-test documents that a dense pile of
// convex hulls Havok never sleeps micro-creeps indefinitely and always did —
// what matters is that nothing falls through the crown.
check("nothing tunnels through the crown", sunk === 0, sunk + " stones below it");
check("the bed creeps rather than collapses", maxDrift < 0.35,
    (maxDrift * 1000).toFixed(0) + " mm over 4 s");
console.log("     drift: " + (maxDrift * 1000).toFixed(0) + " mm over 4 s awake, " + sunk + " sunk");

// ---------------------------------------------------------------------------
// Standing back up
// ---------------------------------------------------------------------------

const moved = awake.rocks[0].node.position.clone();
physics.sleep(beds);

check("scenery comes back", sceneryOn === true);
check("the bed is asleep", physics.awake === null);
// A dug bed stays dug: the live transforms are read back into the bed before
// the bodies go, so the scenery redraws the arrangement the player left.
const keptX = bed.positions[0] / U + spot.x;
check("the arrangement is kept", Math.abs(keptX - moved.x) < 1e-4,
    "captured " + keptX.toFixed(4) + " vs live " + moved.x.toFixed(4));

// And waking a second time still works — the hulls outlive the bodies.
const again = physics.wake(beds, spot);
check("a second crouch works", again && again.rocks.length === bed.count);
physics.sleep(beds);

engine.dispose();
process.exit(failures ? 1 : 0);
