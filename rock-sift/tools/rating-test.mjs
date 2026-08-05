/**
 * Rating and rarity validation. Run:  node tools/rating-test.mjs
 *
 * Dependency-free on purpose (rocks.js only pulls clamp01 out of noise.js), so this
 * runs without installing Babylon.
 *
 * The check that matters most here is REACHABILITY. Mass, size and thickness are not
 * independent — for a stone of density rho, `mass = rho * pi * (D/2)^2 * t`, so
 * fixing any two fixes the third. Picking all three targets by hand once produced a
 * set no real rock could satisfy, and the top two rarity tiers silently became
 * undroppable: the best score any physically possible disc could reach was 0.816,
 * against an Epic threshold of 0.82. Nothing failed; the tiers just never appeared.
 *
 * So: sweep real stones, and assert every tier can actually be earned.
 */

import { skipRating, RARITY_TIERS, STONE_STAT_TARGETS, flatnessFromShape } from "../src/rocks.js";

const RHO = 2650; // kg/m^3, matching assetRocks.js
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(label).padEnd(46)} ${detail}`);
};

/** Mass of a real round disc, grams, from diameter and thickness in cm. */
const discMass = (D, t) => RHO * Math.PI * Math.pow(D / 200, 2) * (t / 100) * 1000;

console.log("\n=== 1. The stat targets describe a stone that can exist ===");
{
  const D = STONE_STAT_TARGETS.size.ideal;
  const t = STONE_STAT_TARGETS.flatness.ideal * D;
  const m = discMass(D, t);
  check(
    "ideal size + ideal flatness gives ideal mass",
    Math.abs(m - STONE_STAT_TARGETS.mass.ideal) / STONE_STAT_TARGETS.mass.ideal < 0.08,
    `${D} cm x ${t.toFixed(2)} cm -> ${m.toFixed(0)} g, target ${STONE_STAT_TARGETS.mass.ideal} g`
  );
}

console.log("\n=== 2. Every rarity tier is reachable by a real stone ===");
{
  const seen = new Set();
  let best = null;
  for (let D = 3; D <= 18; D += 0.05) {
    for (let t = 0.15; t <= 4; t += 0.01) {
      const r = skipRating({ sortedCm: [D, D, t], massGrams: discMass(D, t) });
      seen.add(r.rarity.key);
      if (!best || r.score > best.score) best = { score: r.score, D, t, rarity: r.rarity };
    }
  }
  console.log(
    `        best real stone: ${best.D.toFixed(1)} cm x ${best.t.toFixed(2)} cm ` +
      `= ${discMass(best.D, best.t).toFixed(0)} g -> ${best.score.toFixed(3)} ${best.rarity.label}`
  );
  for (const tier of RARITY_TIERS) {
    check(`${tier.label} is reachable`, seen.has(tier.key));
  }
  const top = RARITY_TIERS[RARITY_TIERS.length - 1];
  check("top tier sits below the achievable maximum", top.min <= best.score,
    `${top.label} needs ${top.min}, best possible is ${best.score.toFixed(3)}`);
}

console.log("\n=== 3. Junk is Common, and the curve is a loot curve ===");
{
  const cases = [
    ["pebble 3.5x0.6", 3.5, 0.6, "common"],
    ["boulder 16x4", 16, 4, "common"],
    ["thick chunk 8x3", 8, 3, "common"],
  ];
  for (const [label, D, t, expect] of cases) {
    const r = skipRating({ sortedCm: [D, D * 0.92, t], massGrams: discMass(D, t) });
    check(`${label} reads ${expect}`, r.rarity.key === expect, `${r.score.toFixed(3)} ${r.rarity.label}`);
  }
  const ideal = skipRating({ sortedCm: [8.5, 8.4, 1.1], massGrams: discMass(8.5, 1.1) });
  check("the ideal stone reads Epic or better",
    ideal.score >= RARITY_TIERS[3].min, `${ideal.score.toFixed(3)} ${ideal.rarity.label}`);
}

console.log("\n=== 4. A ball is the worst possible shape ===");
{
  // shapeDescriptors-style input: flatness 0 is a sphere, 1 a wafer.
  check("ball scores zero flatness", flatnessFromShape({ flatness: 0, asymmetry: 0 }) === 0);
  check("wafer scores full flatness", flatnessFromShape({ flatness: 1, asymmetry: 0 }) === 1);
  check("oblong wafer is marked down",
    flatnessFromShape({ flatness: 1, asymmetry: 0.8 }) < 0.7,
    flatnessFromShape({ flatness: 1, asymmetry: 0.8 }).toFixed(3));
}

console.log("\n=== 5. Measured geometry beats the bounding box ===");
{
  // Same bounding box and mass, different insides. Only the mesh path can tell them
  // apart, and a stone whose weight sits off to one side must grade lower.
  const metrics = { sortedCm: [9, 9, 1.3], massGrams: discMass(9, 1.3) };
  const centred = skipRating({ ...metrics, shape: { flatness: 0.95, asymmetry: 0.05, lopsidedness: 0.0, mass: metrics.massGrams / 1000 } });
  const lopsided = skipRating({ ...metrics, shape: { flatness: 0.95, asymmetry: 0.05, lopsidedness: 0.25, mass: metrics.massGrams / 1000 } });
  check("a lopsided stone grades below a centred one", lopsided.score < centred.score,
    `${lopsided.score.toFixed(3)} vs ${centred.score.toFixed(3)}`);
  check("lopsided stone gets the off-centre verdict",
    lopsided.stats.balance < centred.stats.balance,
    `balance ${lopsided.stats.balance.toFixed(3)} vs ${centred.stats.balance.toFixed(3)}`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL RATING CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
