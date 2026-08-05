// Does the scatter actually stop stones interpenetrating?
//
//   node tools/packing-check.mjs
//
// The naive placement this replaced overlapped essentially every stone, and it
// looked like a rendering or physics problem rather than an arithmetic one. So
// the property is asserted directly: no pair closer than the sum of their
// footprint radii times `touch`, checked by brute force against every pair.

import { bakeLibrary } from "../src/forge/bake.js";
import { packDisc } from "../src/forge/scatter.js";
import { mulberry32, hash32, lerp } from "../src/forge/rng.js";
import { drawSize, sizeReport } from "../src/forge/sizes.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`  ok    ${name}${detail ? " — " + detail : ""}`);
};

const TOUCH = 0.86;
const lib = bakeLibrary({ count: 96, seed: 7, lod0Level: 3 });

function drawRadii(count, rng, sorting = 0.85, median = 0.055) {
  const radii = new Float64Array(count);
  const sizes = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const s = lib.shapes[Math.floor(rng() * lib.shapes.length)];
    const size = drawSize(rng, { median, sorting, bias: s.sizeBias });
    sizes[i] = size;
    radii[i] = 0.5 * size * Math.sqrt(s.unitSpan[0] * s.unitSpan[2]);
  }
  radii.sizes = sizes;
  return radii;
}

/** Worst interpenetration as a fraction of the allowed separation. */
function worstOverlap(x, z, radii) {
  let worst = 0, pairs = 0;
  for (let i = 0; i < radii.length; i++) {
    for (let j = i + 1; j < radii.length; j++) {
      const d = Math.hypot(x[i] - x[j], z[i] - z[j]);
      const want = (radii[i] + radii[j]) * TOUCH;
      if (d < want) {
        pairs++;
        worst = Math.max(worst, (want - d) / want);
      }
    }
  }
  return { worst, pairs };
}

console.log("\nnon-overlap, brute-force over every pair");
for (const count of [200, 800, 2000]) {
  const rng = mulberry32(hash32(count * 31 + 7));
  const radii = drawRadii(count, rng);
  const t0 = Date.now();
  const r = packDisc({ radii, packing: 0.55, touch: TOUCH, rng });
  const ms = Date.now() - t0;
  const { worst, pairs } = worstOverlap(r.x, r.z, radii);
  check(`${String(count).padStart(4)} stones`, pairs === 0,
    `${pairs} overlapping pairs, coverage ${(r.coverage * 100).toFixed(0)}%, ` +
    `disc grew ${r.grew}x, ${r.rejected} rejects, ${ms} ms`);
  if (pairs) console.log(`        worst interpenetration ${(worst * 100).toFixed(1)}% of the allowed gap`);
}

console.log("\nthe old placement, for comparison");
{
  // 0.62 * size^2 per stone, positions drawn independently — what the field used
  // to do. Included so the failure mode stays legible rather than becoming
  // folklore about "physics not being baked in".
  const count = 800;
  const rng = mulberry32(hash32(count * 31 + 7));
  const radii = drawRadii(count, rng);
  let area = 0;
  for (const r of radii) area += Math.PI * r * r;
  const radius = Math.sqrt(area / (Math.PI * 1.0));   // ~100% coverage demanded
  const x = new Float64Array(count), z = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const t = Math.sqrt(rng()), a = rng() * Math.PI * 2;
    x[i] = Math.cos(a) * t * radius;
    z[i] = Math.sin(a) * t * radius;
  }
  const { pairs } = worstOverlap(x, z, radii);
  console.log(`  ${pairs} overlapping pairs out of ${count} stones ` +
    `(${(pairs / count).toFixed(1)} per stone)`);
}

console.log("\ncoverage tracks the request");
{
  // Growing the disc can only lower coverage, never raise it, so the request is
  // an upper bound. Below the saturation limit it should be met almost exactly.
  for (const packing of [0.3, 0.45, 0.55]) {
    const rng = mulberry32(hash32(1234));
    const radii = drawRadii(600, rng);
    const r = packDisc({ radii, packing, touch: TOUCH, rng });
    check(`requested ${(packing * 100).toFixed(0)}%`,
      r.coverage <= packing + 1e-9 && r.coverage > packing * 0.95,
      `achieved ${(r.coverage * 100).toFixed(0)}%, grew ${r.grew}x`);
  }

  // Above it, asking for more is simply not achievable by rejection sampling —
  // worth measuring rather than pretending the slider goes higher than it does.
  const rng = mulberry32(hash32(1234));
  const r = packDisc({ radii: drawRadii(600, rng), packing: 0.9, touch: TOUCH, rng });
  console.log(`  note  saturates at ${(r.coverage * 100).toFixed(0)}% however much is asked for`);
}

/* -- polydisperse: a cobble among granules ------------------------------- */

console.log("\nsize distribution (phi-scale log-normal)");
{
  // packDisc sizes its grid to the *median* stone and registers each stone in
  // every cell it overlaps. Sizing to the largest instead — which is what it did
  // when every stone was roughly the same size — makes one cobble inflate every
  // cell, and each rejection test then scans hundreds of neighbours. This is the
  // case that justifies the rewrite, so it is the case that gets measured.
  for (const sorting of [0.35, 0.85, 1.60]) {
    const rng = mulberry32(hash32(99));
    const radii = drawRadii(1500, rng, sorting);
    const rep = sizeReport(Array.from(radii.sizes));
    const t0 = Date.now();
    const r = packDisc({ radii, packing: 0.55, touch: TOUCH, rng });
    const ms = Date.now() - t0;
    const { pairs } = worstOverlap(r.x, r.z, radii);
    check(`sorting ${sorting.toFixed(2)}`, pairs === 0,
      `d10/50/90 ${(rep.d10 * 1000).toFixed(0)}/${(rep.median * 1000).toFixed(0)}/${(rep.d90 * 1000).toFixed(0)} mm, ` +
      `${(rep.max / rep.min).toFixed(0)}x spread, ${pairs} overlaps, ${ms} ms`);
    console.log(`        by count: ${Object.entries(rep.byCount)
      .map(([k, v]) => `${k} ${Math.round(100 * v / rep.n)}%`).join(", ")}`);
    console.log(`        by area:  ${Object.entries(rep.byArea)
      .map(([k, v]) => `${k} ${Math.round(100 * v)}%`).join(", ")}`);
  }
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
