/**
 * Forge -> solver bridge validation. Run:  node tools/solver-bridge-test.mjs
 *
 * Two things to establish:
 *
 *   1. A generated rock can actually be thrown, and its shape reaches the physics —
 *      a slate disc and a cobble must not skip alike.
 *   2. The LOD used for physics is coarse ENOUGH. The claim in solverParams.js is
 *      that level 2 is sufficient because the solver consumes volume integrals,
 *      which do not care about millimetre surface detail. That is a measurable
 *      claim, so it is measured here rather than asserted.
 */

import { bakeLibrary } from "../src/forge/bake.js";
import { ARCHETYPES } from "../src/forge/archetypes.js";
import {
  rockPhysics, solverStone, detailedMetrics, SOLVER_LOD,
} from "../src/forge/solverParams.js";
import { StoneSkipSim, THROW_PRESETS } from "../../stone-skipping-physics/src/stoneSkipping.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(label).padEnd(46)} ${detail}`);
};
const rel = (a, b) => (Math.abs(b) > 1e-30 ? Math.abs(a - b) / Math.abs(b) : Math.abs(a - b));

// One baked library, reused. `only` keeps it to the families we assert on.
const lib = bakeLibrary({ count: 24, seed: 7 });
const pick = (family) => {
  const i = lib.shapes.findIndex((s) => s.archetype === family);
  return i >= 0 ? lib.shapes[i] : null;
};

console.log("\n=== 1. A forged rock produces a usable stone ===");
{
  const shape = lib.shapes[0];
  const params = ARCHETYPES[shape.archetype];
  const stone = solverStone(shape, params, 0.085);
  check("solverStone returns mesh geometry",
    stone.mesh && stone.mesh.positions.length > 0 && stone.mesh.indices.length > 0,
    `${stone.mesh.positions.length / 3} verts, ${stone.mesh.indices.length / 3} tris`);
  check("balance is derived from the mesh", stone.balanceRetention === "auto");

  const sim = new StoneSkipSim({ stone, profile: "game" });
  check("solver accepts it and measures a real body",
    sim.mass > 0 && Number.isFinite(sim.inertiaBody.yy) && sim.panels.length > 0,
    `${(sim.mass * 1000).toFixed(0)} g, ${sim.panels.length} panels`);
  check("mesh path was taken, not the disc fallback", sim.meshShape !== null);

  sim.throwStone(THROW_PRESETS.steinerThrow);
  const r = sim.simulate({ maxTime: 40 });
  check("a forged rock can be thrown", Number.isFinite(r.runDistance) && r.runDistance > 0,
    `${r.skips} skips, ${r.runDistance.toFixed(1)} m`);
}

console.log("\n=== 2. Physics LOD is coarse enough (the SOLVER_LOD claim) ===");
{
  const shape = lib.shapes[0];
  const params = ARCHETYPES[shape.archetype];
  const ref = rockPhysics(shape, params, 0.085, { level: 4 }).descriptors;
  console.log(`        reference (level 4): volume ${ref.volume.toExponential(4)}  ` +
    `flatness ${ref.flatness.toFixed(4)}  asym ${ref.asymmetry.toFixed(4)}`);
  for (const level of [1, 2, 3]) {
    const d = rockPhysics(shape, params, 0.085, { level }).descriptors;
    const dv = rel(d.volume, ref.volume);
    const df = Math.abs(d.flatness - ref.flatness);
    const da = Math.abs(d.asymmetry - ref.asymmetry);
    const iyy = rel(d.inertia.yy, ref.inertia.yy);
    console.log(`        level ${level}: volume ${(dv * 100).toFixed(2)}%  I_yy ${(iyy * 100).toFixed(2)}%  ` +
      `flatness ${df.toFixed(4)}  asym ${da.toFixed(4)}`);
    if (level >= SOLVER_LOD) {
      check(`level ${level}: volume within 3% of level 4`, dv < 0.03, `${(dv * 100).toFixed(2)}%`);
      check(`level ${level}: spin inertia within 5% of level 4`, iyy < 0.05, `${(iyy * 100).toFixed(2)}%`);
      check(`level ${level}: flatness within 0.03 of level 4`, df < 0.03, df.toFixed(4));
    }
  }
}

console.log("\n=== 3. Shape reaches the physics: archetypes must differ ===");
{
  // slate is the classic disc (axes [1, 0.74, 0.22]); granite is the equant cobble.
  // Both are common enough to be present in any reasonable bake.
  const rows = [];
  for (const family of ["slate", "granite"]) {
    const shape = pick(family);
    if (!shape) { console.log(`        (no ${family} in this bake, skipped)`); continue; }
    const params = ARCHETYPES[family];
    const d = rockPhysics(shape, params, 0.085).descriptors;
    const sim = new StoneSkipSim({ stone: solverStone(shape, params, 0.085), profile: "game" });
    sim.throwStone(THROW_PRESETS.steinerThrow);
    const r = sim.simulate({ maxTime: 40 });
    rows.push({ family, flatness: d.flatness, skips: r.skips, dist: r.runDistance, balance: sim.stoneBalance });
    console.log(`        ${family.padEnd(8)} flatness ${d.flatness.toFixed(3)}  balance ${sim.stoneBalance.toFixed(3)}  ` +
      `-> ${r.skips} skips, ${r.dist === undefined ? r.runDistance.toFixed(1) : r.runDistance.toFixed(1)} m`);
  }
  if (rows.length === 2) {
    const slate = rows.find((r) => r.family === "slate");
    const cobble = rows.find((r) => r.family === "granite");
    check("slate reads flatter than the cobble", slate.flatness > cobble.flatness,
      `${slate.flatness.toFixed(3)} vs ${cobble.flatness.toFixed(3)}`);
    // The cobble has the BETTER balance, and that is correct: an equant stone packs
    // more mass per unit radius, so a higher m/R, so more gyroscopic authority. It is
    // the same result as the chunky test stone that held its attitude best of all.
    // Balance and flatness are independent axes, and this is the case that proves it.
    check("the cobble scores better balance than slate", cobble.balance > slate.balance,
      `${cobble.balance.toFixed(3)} vs ${slate.balance.toFixed(3)}`);
    // ...and loses anyway, by a mile, because it cannot plane. Attitude retention is
    // worth nothing to a stone that never gets airborne.
    check("slate still out-skips it by a wide margin", slate.skips > cobble.skips * 3,
      `${slate.skips} vs ${cobble.skips} skips`);
  }
}

console.log("\n=== 4. Metrics are graded from the real geometry ===");
{
  const shape = lib.shapes[0];
  const params = ARCHETYPES[shape.archetype];
  const m = detailedMetrics(shape, params, 0.085);
  check("detailedMetrics carries measured descriptors",
    m.shape && !m.shape.degenerate && typeof m.shape.lopsidedness === "number",
    `lopsided ${m.shape.lopsidedness.toFixed(3)}`);
  check("rating uses the mesh path", m.rating && m.rating.rarity !== undefined,
    `${m.rating.score.toFixed(3)} ${m.rating.rarity.label}`);
  check("mass is positive and sane", m.massGrams > 1 && m.massGrams < 5000,
    `${m.massGrams.toFixed(0)} g`);
}

console.log("\n=== 5. Memoisation: the mesh pass runs once per (rock, size, LOD) ===");
{
  const shape = lib.shapes[1];
  const params = ARCHETYPES[shape.archetype];
  const a = rockPhysics(shape, params, 0.085);
  const b = rockPhysics(shape, params, 0.085);
  check("same request returns the cached object", a === b);
  const c = rockPhysics(shape, params, 0.09);
  check("a different size is a different entry", c !== a);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL BRIDGE CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
