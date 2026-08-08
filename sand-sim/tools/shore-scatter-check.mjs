// The shore rock field's promises — pure math over shared/shoreScatter.js.
//
// The field is generated on every client rather than shipped, so "same seed,
// same stones" is not a nicety: it is CLAUDE.md rule 4, and it is what lets a
// server validate anything the player says they found.
//
// The field is now placed across the sandy CLEARING the world infers around the
// spawn (worldEnv.clearing), densest by terrain HEIGHT above the waterline.
// This drives scatterShore with a synthetic stand-in clearing + ground so the
// promises can be checked with no Babylon and no glb.

import { castSequence } from "../src/scene/siftingBeds.js";
import {
    scatterShore, densityAt, PEAK_DENSITY, MIN_GAP, SINK_FRACTION, SCATTER_SEED,
    ROCK_FREE_RISE, FULL_RISE,
} from "../../shared/shoreScatter.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

const cast = castSequence();
check("cast is the forge's forty", cast.length === 40, String(cast.length));

// A stand-in clearing: a 40x40 m box of reachable sand (edges excluded, like
// the real flood-fill leaves a margin), on a beach that rises 0.05 m/m from a
// waterline at z=0 — so "height above water" sweeps 0..2 m across the patch.
const clearing = {
    origin: { x: 0, z: 0 }, cell: 0.5, res: 80,
    contains: (x, z) => x > 2 && x < 38 && z > 2 && z < 38,
};
const waterLevel = 0;
const heightAt = (x, z) => z * 0.05;
const opts = { cast, clearing, heightAt, waterLevel };

const field = scatterShore(opts);
check("field is populated", field.length > 500, String(field.length) + " stones");

// ---- determinism ------------------------------------------------------------
const again = scatterShore(opts);
check("same seed gives the same field",
    again.length === field.length
    && again.every((s, i) => s.x === field[i].x && s.z === field[i].z
        && s.archetype === field[i].archetype),
    `${field.length} vs ${again.length}`);

const other = scatterShore({ ...opts, seed: SCATTER_SEED + 1 });
check("a different seed gives a different field",
    other.length !== field.length || other[0].x !== field[0].x);

check("no clearing means no field", scatterShore({ cast, heightAt }).length === 0);

// ---- stones stay on the reachable sand -------------------------------------
const offSand = field.filter((s) => !clearing.contains(s.x, s.z));
check("every stone is on the clearing (never water or trees)", offSand.length === 0,
    offSand.length + " off the sand");

// ---- stones sit in the shingle band by height ------------------------------
let loAbove = Infinity, hiAbove = -Infinity;
for (const s of field) {
    const above = heightAt(s.x, s.z) - waterLevel;
    loAbove = Math.min(loAbove, above);
    hiAbove = Math.max(hiAbove, above);
}
check("no stone below the rock-free rise (a clear wet edge)",
    loAbove >= ROCK_FREE_RISE - 1e-6, "lowest " + loAbove.toFixed(3));
check("stones climb well up the beach (bounded only by the clearing)",
    hiAbove > FULL_RISE, "highest " + hiAbove.toFixed(3));

// ---- none of them interpenetrate -------------------------------------------
{
    const CELL = 0.5;
    const buckets = new Map();
    const key = (cx, cz) => cx + "," + cz;
    for (const s of field) {
        const k = key(Math.floor(s.x / CELL), Math.floor(s.z / CELL));
        (buckets.get(k) ?? buckets.set(k, []).get(k)).push(s);
    }
    let worst = Infinity, clashes = 0;
    for (const s of field) {
        const cx = Math.floor(s.x / CELL), cz = Math.floor(s.z / CELL);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
            for (const o of buckets.get(key(cx + a, cz + b)) ?? []) {
                if (o === s) continue;
                const gap = Math.hypot(s.x - o.x, s.z - o.z) - s.radius - o.radius;
                worst = Math.min(worst, gap);
                if (gap < MIN_GAP - 1e-9) clashes++;
            }
        }
    }
    check("no two stones overlap", clashes === 0,
        clashes + " pairs, tightest gap " + worst.toFixed(4) + " m");
    check("the tightest gap respects MIN_GAP", worst >= MIN_GAP - 1e-9, worst.toFixed(4));
}

// ---- the density is a shingle band: heaviest at the water, fading up -------
check("density is zero at the waterline", densityAt(0) === 0);
check("density is thin just above the wet edge",
    densityAt(ROCK_FREE_RISE + 0.02) < PEAK_DENSITY * 0.2,
    densityAt(ROCK_FREE_RISE + 0.02).toFixed(0));
check("density is full up the beach", densityAt(FULL_RISE + 0.5) === PEAK_DENSITY);

{
    // Measured off the field, not off `densityAt` — a ramp the sampler ignored
    // would pass the calls above and still carpet the beach. Bands by height
    // above the water; the count must RISE as you climb (waves clear the edge,
    // shingle piles up the beach).
    const BANDS = 4;
    const top = FULL_RISE * 2; // the synthetic beach climbs past FULL_RISE
    const counts = new Array(BANDS).fill(0);
    for (const s of field) {
        const above = heightAt(s.x, s.z) - waterLevel;
        counts[Math.max(0, Math.min(BANDS - 1, Math.floor((above / top) * BANDS)))]++;
    }
    const lower = counts[0] + counts[1], upper = counts[2] + counts[3];
    check("the shingle is heavier up the beach than at the water",
        upper > lower * 1.5, counts.join(" / "));
    check("the water band is far sparser than the top band",
        counts[0] < counts[BANDS - 1] * 0.4, counts.join(" / "));
}

// ---- stones sit IN the sand, not on it -------------------------------------
{
    const bad = field.filter((s) => {
        const want = heightAt(s.x, s.z) - s.radius * SINK_FRACTION;
        return Math.abs(s.y - want) > 1e-9;
    });
    check("every stone is sunk into the ground it stands on", bad.length === 0,
        bad.length + " floating");
}

// ---- the density multiplier does something ---------------------------------
const counts = [0.05, 0.25, 1, 2].map((d) => scatterShore({ ...opts, density: d }).length);
let monotonic = true;
for (let i = 1; i < counts.length; i++) if (counts[i] <= counts[i - 1]) monotonic = false;
check("the density multiplier is monotonic", monotonic, counts.join(" < "));
check("a twentieth of the density is a small fraction of the field",
    counts[0] < field.length * 0.35, `${counts[0]} vs ${field.length}`);

console.log(`\n${field.length} stones on the clearing`);
console.log(failures ? `${failures} check(s) failed` : "all shore-scatter checks passed");
process.exit(failures ? 1 : 0);
