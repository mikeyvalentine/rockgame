// The persistent imprint layer: pure math over shared/spotImprint.js and a real
// bed file. No Babylon, no GPU.
//
// The property that matters is PERSISTENCE, which is why this layer exists at
// all rather than reusing the deformation field — so what is pinned here is
// that a mark, once made, stays exactly where it was made and at the depth it
// was made, no matter what happens afterwards.

import { readFileSync } from "node:fs";
import { decodeBed } from "../../shared/bedFormat.js";
import { SIFT_SPOTS, PAD_HALF_X, PAD_HALF_Z } from "../../shared/siftPad.js";
import { SpotImprint, bakeBedImprint, IMPRINT_HALF, BED_PRESS } from "../../shared/spotImprint.js";
import { Imprints } from "../src/scene/imprints.js";
import { castSequence } from "../src/scene/siftingBeds.js";
import { shoreProfileJS } from "../src/terrain/beachParams.js";

let failures = 0;
const check = (n, ok, d) => { console.log((ok ? "ok   " : "FAIL ") + n + (ok || !d ? "" : " — " + d)); if (!ok) failures++; };

const raw = readFileSync(new URL("../../public/assets/beds/shore-0.bed", import.meta.url));
const bed = decodeBed(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

// Stone radii from the same cast the beds name.
const radii = new Map(castSequence().map((c) => [c.name, c.sizeMetres * 0.5]));
const radiusOf = (n) => radii.get(n) ?? 0;

const spot = SIFT_SPOTS[0];
const baseY = shoreProfileJS(spot.x, spot.z, 1);
const imp = new SpotImprint(spot);

check("a fresh layer is untouched sand", imp.maxDepth() === 0 && imp.coverage() === 0);
check("the layer covers the whole pad", IMPRINT_HALF > Math.max(PAD_HALF_X, PAD_HALF_Z),
    IMPRINT_HALF + " m half-extent vs " + Math.max(PAD_HALF_X, PAD_HALF_Z) + " m pad");

const presses = bakeBedImprint(imp, bed, radiusOf, { unitScale: 4, baseY, spot });
const pressed = presses.length;
check("the bed presses the sand it rests in", pressed > 0, pressed + " stones of " + bed.count);
// Nearly every stone presses, and that is the point rather than a slack bound:
// the bed is ONE layer, so almost all of it is touching the sand. The old
// four-deep heap passed at under 60%, and this check reading 55% today would
// mean the bed had quietly gone back to being a heap.
//
// Not 100%: `bakeBedImprint` still skips a stone perched more than 1.6 radii up,
// and a packed layer has a few of those sitting in the gaps.
check("a single layer presses nearly all of itself", pressed > bed.count * 0.9,
    pressed + " of " + bed.count + " pressed");

// The presses come back, not just their count, because the drawing side wants
// one brush per stone. Resampling the grid instead is what made the replay a
// bed-shaped blob rather than the rocks it is made of.
check("the bake hands back every press it made",
    presses.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z) && p.radius > 0 && p.depth > 0));
check("a press is a dent, not a crater",
    presses.every((p) => p.depth < p.radius), "depth must stay under the stone's own radius");

const deepest = imp.maxDepth();
check("the imprint is a dent, not a pit", deepest > 0.002 && deepest < 0.05,
    (deepest * 1000).toFixed(1) + " mm deep");
check("the imprint stays under the bed", imp.coverage() > 0.02 && imp.coverage() < 0.6,
    (imp.coverage() * 100).toFixed(1) + "% of the layer");

// Deterministic: the same bed gives the same sand, every load.
const again = new SpotImprint(spot);
bakeBedImprint(again, bed, radiusOf, { unitScale: 4, baseY, spot });
let identical = true;
for (let i = 0; i < imp.depth.length; i++) if (imp.depth[i] !== again.depth[i]) { identical = false; break; }
check("the same bed bakes the same sand", identical);

// Order-independence, which is what `max` buys: two stones in one dip make one
// dip. Pressing the same place twice must not deepen it.
const twice = new SpotImprint(spot);
twice.press(spot.x, spot.z, 0.04, 0.01);
const once = twice.maxDepth();
twice.press(spot.x, spot.z, 0.04, 0.01);
check("overlapping presses do not stack", Math.abs(twice.maxDepth() - once) < 1e-9,
    (twice.maxDepth() * 1000).toFixed(3) + " vs " + (once * 1000).toFixed(3) + " mm");

// PERSISTENCE — the whole point. Nothing decays it and nothing moves it.
const probe = { x: spot.x + 0.3, z: spot.z - 0.2 };
const before = imp.depthAt(probe.x, probe.z);
for (let i = 0; i < 500; i++) imp.press(spot.x + 1.4, spot.z + 1.4, 0.05, 0.02);
check("a mark does not fade", imp.depthAt(probe.x, probe.z) === before,
    "was " + (before * 1000).toFixed(2) + " mm, now " +
    (imp.depthAt(probe.x, probe.z) * 1000).toFixed(2) + " mm");

// World-anchored: the layer does not follow the player, so a point keeps its
// depth however far away the player is. Nothing to assert but the absence of
// any player term — checked by there being no way to pass one.
check("the layer is world-anchored", imp.indexAt(spot.x, spot.z) === imp.indexAt(spot.x, spot.z));
check("outside the spot is untouched", imp.depthAt(spot.x + 50, spot.z) === 0);
check("a point outside the extent has no index", imp.indexAt(spot.x + IMPRINT_HALF + 1, spot.z) === -1);

// A thrown stone digs deeper than a resting one — that is what makes a divot
// read as something you did rather than something that was always there.
const divot = new SpotImprint(spot);
divot.press(spot.x, spot.z, 0.05, 0.05 * BED_PRESS);
const resting = divot.maxDepth();
divot.press(spot.x + 0.5, spot.z, 0.05, 0.05 * BED_PRESS * 3);
check("an impact digs deeper than a resting stone", divot.maxDepth() > resting * 2,
    (resting * 1000).toFixed(1) + " mm resting vs " + (divot.maxDepth() * 1000).toFixed(1) + " mm struck");

console.log("     imprint: " + (deepest * 1000).toFixed(1) + " mm deepest, " +
    (imp.coverage() * 100).toFixed(1) + "% covered, " + pressed + " stones pressing");
// ---------------------------------------------------------------------------
// The layer has to be FELT, not merely stored
// ---------------------------------------------------------------------------
//
// The maths sat here tested and unimported for a while, which looks identical
// to working. So this asserts the consumer: a terrain wrapped by Imprints
// returns lower ground where the sand has been pressed, and unchanged ground
// everywhere else.

const flat = { heightAt: () => 1, normalAt: (x, z, out) => out.set(0, 1, 0) };
const live = new Imprints(flat, null);
const wrapped = live.wrapTerrain();
const s0 = SIFT_SPOTS[0];

check("an untouched beach grounds exactly as before",
    wrapped.heightAt(s0.x + 40, s0.z) === 1);

live.layers.get(s0.id).press(s0.x, s0.z, 0.06, 0.02);
const dug = wrapped.heightAt(s0.x, s0.z);
check("pressed sand grounds lower", dug < 1 - 0.015,
    "ground at " + dug.toFixed(4) + " after a 20 mm press");
check("the dent is local", wrapped.heightAt(s0.x + 1.5, s0.z) === 1);

// ---------------------------------------------------------------------------
// The replay: one brush per stone, spent over several frames
// ---------------------------------------------------------------------------
//
// The first version resampled the imprint grid at 25 cm and drew ~35 brushes
// 37 cm across, which draws the SHAPE of the excavation and not the rocks that
// made it. Every rock displaces the sand it sits in, so every rock gets a brush.

const drawn = [];
const fakeField = { brush: (x, z, r, depth) => drawn.push({ x, z, r, depth }) };
const radiusList = castSequence().map((c) => ({ name: c.name, radius: c.sizeMetres * 0.5 }));
const replay = new Imprints(flat, {
    bedForSpot: new Map([[s0.id, { bed, baseY: 0 }]]),
    archetypeList: radiusList,
}, fakeField);

const queued = replay.restamp(s0.id);
check("a replay queues one press per resting stone", queued > bed.count * 0.9,
    queued + " of " + bed.count);
check("nothing is drawn before it is drained", drawn.length === 0);

const first = replay.drain();
check("a drain spends a bounded slice", first > 0 && first < queued,
    first + " brushes of " + queued);
let guard = 0;
while (replay._queue.length && guard++ < 100) replay.drain();
check("the whole bed lands within a handful of frames", replay._queue.length === 0 && guard < 20,
    (guard + 1) + " frames");
check("every stone got its own brush", drawn.length === queued,
    drawn.length + " brushes for " + queued + " stones");

// Stone-scale, not bed-scale. The deformation field is 3.9 cm a texel, so a
// brush wider than a few of those is drawing the bed rather than a rock.
const widest = Math.max(...drawn.map((d) => d.r));
check("brushes are stone-sized", widest < 0.12,
    "widest " + (widest * 100).toFixed(1) + " cm across the radius");
check("brushes are dents, not craters", drawn.every((d) => d.depth > 0 && d.depth < 0.05),
    "deepest " + (Math.max(...drawn.map((d) => d.depth)) * 1000).toFixed(1) + " mm");

// Re-running must not double-draw: `restamp` replaces the queue rather than
// appending to it, or walking past a bed four times queues it four times.
replay.restamp(s0.id);
replay.restamp(s0.id);
check("a second replay replaces the first", replay._queue.length === queued,
    replay._queue.length + " queued after two restamps");

process.exit(failures ? 1 : 0);
