// Does sand-sim place rock-sift's baked beds correctly? Pure node — real bed
// files off disk, the real forge, no Babylon and no GPU.
//
// The question this answers is the one that cannot be answered by looking at a
// screenshot: sand-sim regenerates rock-sift's cast from the forge rather than
// importing it, so "the stones are the right stones" is a claim about two
// independent code paths agreeing. The bed stores archetype NAMES precisely so
// that claim is checkable, and this checks it.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeBed } from "../../shared/bedFormat.js";
import { SIFT_SPOTS, CROWN_RADIUS, pileCoverage } from "../../shared/pileField.js";
import { bedInstanceMatrices, U, ROCK_SEED, ARCHETYPE_COUNT } from "../src/scene/siftingBeds.js";
import { bakeLibrary } from "../../rock-forge/src/forge/bake.js";
import { ARCHETYPES } from "../../rock-forge/src/forge/archetypes.js";
import { shoreProfileJS } from "../src/terrain/beachParams.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BEDS = join(ROOT, "public", "assets", "beds");

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// The manifest and the beds
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(BEDS, "shore.json"), "utf8"));
const beds = manifest.variants.map((f) => {
    const buf = readFileSync(join(BEDS, f));
    return {
        ...decodeBed(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
        variant: f,
    };
});

check("every variant decodes", beds.length === manifest.variants.length,
    beds.length + " of " + manifest.variants.length);
check("every bed holds the manifest's stone count",
    beds.every((b) => b.count === manifest.stones),
    beds.map((b) => b.count).join(", ") + " vs " + manifest.stones);

// The manifest's own world block is what sand-sim's constants have to match.
check("U matches the manifest", manifest.world.U === U,
    "manifest " + manifest.world.U + ", siftingBeds " + U);
check("manifest was baked from this forge cast",
    manifest.world.source === `forge:${ROCK_SEED}:${ARCHETYPE_COUNT}`,
    manifest.world.source + " vs forge:" + ROCK_SEED + ":" + ARCHETYPE_COUNT);

// ---------------------------------------------------------------------------
// The cast — the real test
// ---------------------------------------------------------------------------
//
// Names are regenerated the way siftingBeds.js does it, straight from the
// forge. If sand-sim's reproduction of rock-sift's cast has drifted by so much
// as one skipped archetype, these stop matching.

const lib = bakeLibrary({ count: ARCHETYPE_COUNT, seed: ROCK_SEED });
const names = [];
for (const shape of lib.shapes) {
    if (!ARCHETYPES[shape.archetype]) continue;
    names.push(`forge_${shape.archetype}_${shape.index}`);
}

check("the forge produces a full cast", names.length === ARCHETYPE_COUNT,
    names.length + " of " + ARCHETYPE_COUNT);

let unresolved = new Set();
for (const bed of beds) {
    for (const n of bed.names) if (!names.includes(n)) unresolved.add(n);
}
check("every stone a bed names exists in the regenerated cast",
    unresolved.size === 0,
    [...unresolved].slice(0, 4).join(", "));

check("the beds name the whole cast",
    beds[0].names.length === names.length,
    beds[0].names.length + " named, " + names.length + " generated");

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

let placed = 0;
let worstRadius = 0;
let worstBelow = 0;
let highest = -Infinity;

for (const spot of SIFT_SPOTS) {
    const bed = beds[spot.variant % beds.length];
    const baseY = shoreProfileJS(spot.x, spot.z, 1);
    const buffers = bedInstanceMatrices(bed, spot, baseY, names);

    let n = 0;
    for (const [, buf] of buffers) {
        for (let i = 0; i < buf.length; i += 16) {
            // Column-major: translation is elements 12,13,14.
            const x = buf[i + 12];
            const y = buf[i + 13];
            const z = buf[i + 14];
            n++;

            worstRadius = Math.max(worstRadius, Math.hypot(x - spot.x, z - spot.z));
            // Stones may rest slightly proud of or into the surface, but a stone
            // well below the crown is a units bug — the classic symptom of
            // forgetting to divide by U.
            worstBelow = Math.min(worstBelow, y - baseY);
            highest = Math.max(highest, y - baseY);
        }
    }
    check("spot " + spot.id + " places its whole bed", n === bed.count,
        n + " of " + bed.count);
    placed += n;
}

check("every spot's stones are placed", placed === SIFT_SPOTS.length * manifest.stones,
    placed + " of " + SIFT_SPOTS.length * manifest.stones);

// The bed must land on the flat crown, not spill down the face — that is the
// whole reason CROWN_RADIUS is sized clear of rock-sift's BED_RADIUS.
check("the bed sits inside the flat crown", worstRadius < CROWN_RADIUS,
    "furthest stone " + worstRadius.toFixed(3) + " m, crown " + CROWN_RADIUS + " m");

// A units error is the failure mode here: undivided, a 2 m bed becomes an 8 m
// one and the stones tower over the walker.
check("the bed is a bed, not a monument", highest < 0.35,
    "tallest stone " + highest.toFixed(3) + " m above the crown");
check("no stone is buried under the crown", worstBelow > -0.1,
    "lowest " + worstBelow.toFixed(3) + " m");

// And the ground it lands on is genuinely flat, sampled where the stones are.
let crownMin = Infinity;
let crownMax = -Infinity;
for (const spot of SIFT_SPOTS) {
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
        for (const r of [0, worstRadius * 0.5, worstRadius]) {
            const h = shoreProfileJS(spot.x + Math.cos(a) * r, spot.z + Math.sin(a) * r, 1) -
                shoreProfileJS(spot.x, spot.z, 1);
            crownMin = Math.min(crownMin, h);
            crownMax = Math.max(crownMax, h);
        }
    }
}
check("the ground under every bed is flat", crownMax - crownMin < 0.03,
    ((crownMax - crownMin) * 1000).toFixed(1) + " mm across all four crowns");

// Each spot draws a different variant, so the shore does not repeat.
check("each spot uses its own variant",
    new Set(SIFT_SPOTS.map((s) => s.variant % beds.length)).size === SIFT_SPOTS.length);

// Every spot's centre is fully covered, i.e. the bed is on a pile at all.
check("every spot is on a pile",
    SIFT_SPOTS.every((s) => pileCoverage(s.x, s.z) === 1));

// ---------------------------------------------------------------------------
// The loud failure
// ---------------------------------------------------------------------------

let threw = false;
try {
    bedInstanceMatrices(beds[0], SIFT_SPOTS[0], 0, ["not_a_stone"]);
} catch (e) {
    threw = /re-bake/.test(e.message);
}
check("a stale bed fails loudly", threw);

process.exit(failures ? 1 : 0);
