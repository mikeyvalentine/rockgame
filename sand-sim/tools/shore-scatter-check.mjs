// The shore rock field's promises — pure math over shared/shoreScatter.js.
//
// The field is generated on every client rather than shipped, so "same seed,
// same stones" is not a nicety: it is CLAUDE.md rule 4, and it is what lets a
// server validate anything the player says they found.

import { castSequence } from "../src/scene/siftingBeds.js";
import {
    scatterShore, densityAt, PEAK_DENSITY, MIN_GAP, SINK_FRACTION, SCATTER_SEED,
} from "../../shared/shoreScatter.js";
import {
    SHORE_HALF_ARC, ROCK_FREE_MARGIN, SHORE_DEPTH,
    shoreDistance, shoreArc, inRockField,
} from "../../shared/worldBounds.js";

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

const cast = castSequence();
check("cast is the forge's forty", cast.length === 40, String(cast.length));

const field = scatterShore({ cast });
check("field is populated", field.length > 1000, String(field.length) + " stones");

// ---- determinism ------------------------------------------------------------
const again = scatterShore({ cast });
check("same seed gives the same field",
    again.length === field.length
    && again.every((s, i) => s.x === field[i].x && s.z === field[i].z
        && s.archetype === field[i].archetype),
    `${field.length} vs ${again.length}`);

const other = scatterShore({ cast, seed: SCATTER_SEED + 1 });
check("a different seed gives a different field",
    other.length !== field.length || other[0].x !== field[0].x);

// ---- the water's edge is clear ---------------------------------------------
//
// Measured as distance from the water, not as z. The shore is curved, so a
// straight line across the strip is not a constant distance from the pond —
// checked in z, a clear band that followed the curve would look like a
// violation and a straight one would pass.
let nearest = Infinity;
for (const s of field) {
    nearest = Math.min(nearest, shoreDistance(s.x, s.z) - s.radius);
}
check(`no stone within ${ROCK_FREE_MARGIN} m of the water`,
    nearest >= ROCK_FREE_MARGIN - 1e-9,
    "closest " + nearest.toFixed(2) + " m vs limit " + ROCK_FREE_MARGIN);

// ---- nothing leaves the strip ----------------------------------------------
// The whole footprint, not the centre: a stone half over the edge of the field
// is a stone sticking out of the world. In (arc, depth), which is where the
// strip is actually a rectangle.
const strayed = field.filter((s) => {
    const d = shoreDistance(s.x, s.z);
    const a = shoreArc(s.x, s.z);
    return d - s.radius < ROCK_FREE_MARGIN || d + s.radius > SHORE_DEPTH
        || Math.abs(a) + s.radius > SHORE_HALF_ARC;
});
check("every stone sits wholly inside the shore strip", strayed.length === 0,
    strayed.length + " outside");
check("every stone is in the rock field", field.every((s) => inRockField(s.x, s.z)));

// ---- and none of them interpenetrate ---------------------------------------
//
// The whole point of placing rather than dropping: with no physics to push
// them apart, non-overlap has to be true by construction. Checked with a grid
// so this is not 8,000 squared.
{
    const CELL = 0.5;
    const buckets = new Map();
    const key = (cx, cz) => cx + "," + cz;
    for (const s of field) {
        const k = key(Math.floor(s.x / CELL), Math.floor(s.z / CELL));
        (buckets.get(k) ?? buckets.set(k, []).get(k)).push(s);
    }
    let worst = Infinity;
    let clashes = 0;
    for (const s of field) {
        const cx = Math.floor(s.x / CELL);
        const cz = Math.floor(s.z / CELL);
        for (let a = -1; a <= 1; a++) {
            for (let b = -1; b <= 1; b++) {
                for (const o of buckets.get(key(cx + a, cz + b)) ?? []) {
                    if (o === s) continue;
                    const gap = Math.hypot(s.x - o.x, s.z - o.z) - s.radius - o.radius;
                    worst = Math.min(worst, gap);
                    if (gap < MIN_GAP - 1e-9) clashes++;
                }
            }
        }
    }
    check("no two stones overlap", clashes === 0,
        clashes + " pairs, tightest gap " + worst.toFixed(4) + " m");
    check("the tightest gap respects MIN_GAP", worst >= MIN_GAP - 1e-9,
        worst.toFixed(4));
}

// ---- the density actually ramps --------------------------------------------
check("density is zero at the water", densityAt(0) === 0);
check("density is zero at the margin", densityAt(ROCK_FREE_MARGIN) === 0);
check("density peaks at the back",
    Math.abs(densityAt(SHORE_DEPTH) - PEAK_DENSITY) < 1e-9);

{
    // Measured off the field itself, not off `densityAt` — a ramp in the
    // density function that the sampler failed to honour would pass every
    // check above and still produce a uniform beach.
    // Bands run from the rock-free margin landward, not from the water. Cut
    // from the water instead and the first band straddles the margin, so it is
    // part empty by definition and says nothing about the ramp.
    const BANDS = 4;
    const bandDepth = (SHORE_DEPTH - ROCK_FREE_MARGIN) / BANDS;
    const counts = new Array(BANDS).fill(0);
    for (const s of field) {
        const d = shoreDistance(s.x, s.z) - ROCK_FREE_MARGIN;
        counts[Math.max(0, Math.min(BANDS - 1, Math.floor(d / bandDepth)))]++;
    }
    let rising = true;
    for (let i = 1; i < BANDS; i++) if (counts[i] <= counts[i - 1]) rising = false;
    check("stone count rises with every band landward", rising, counts.join(" < "));
    check("the back band carries several times the first",
        counts[BANDS - 1] > counts[0] * 4, counts.join(" / "));
}

// ---- stones sit IN the sand, not on it -------------------------------------
{
    const ground = (x, z) => 1.5 + x * 0.001 - z * 0.02;   // any sloped plane
    const sunk = scatterShore({ cast, heightAt: ground });
    const bad = sunk.filter((s) => {
        const want = ground(s.x, s.z) - s.radius * SINK_FRACTION;
        return Math.abs(s.y - want) > 1e-9;
    });
    check("every stone is sunk into the ground it stands on", bad.length === 0,
        bad.length + " floating");
}

// ---- the density multiplier does something ----------------------------------
//
// Monotonic, but nowhere near proportional, and the check says so rather than
// pretending otherwise: the field is close to jammed at the default, so most
// of what the multiplier asks for is rejected against a neighbour. Quartering
// the ask only halves the field.
const counts = [0.05, 0.25, 1, 2].map((d) => scatterShore({ cast, density: d }).length);
let monotonic = true;
for (let i = 1; i < counts.length; i++) if (counts[i] <= counts[i - 1]) monotonic = false;
check("the density multiplier is monotonic", monotonic, counts.join(" < "));
check("a twentieth of the density is a small fraction of the field",
    counts[0] < field.length * 0.25, `${counts[0]} vs ${field.length}`);
check("doubling the default barely moves a jammed field",
    counts[3] < field.length * 1.35, `${counts[3]} vs ${field.length}`);

console.log(`\n${field.length} stones across the shore`);
console.log(failures ? `${failures} check(s) failed` : "all shore-scatter checks passed");
process.exit(failures ? 1 : 0);
