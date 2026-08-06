// node tools/water-coupling-check.mjs
//
// The seam between the two halves of the game: the water the player SEES
// (shared/ambientWater.js, the CPU twin of babylon-water's AMBIENT_GLSL) and
// the water the stone PLANES ON (StoneSkipSim's injected `water` callback).
//
// This lives at the repo root, not in either package, because it is the only
// thing that touches both. In particular it must NOT live in
// stone-skipping-physics: that package has no dependencies and must keep none,
// and its own suite has to run with no install at all.
//
// ## What it guards
//
// 1. **Shape.** `makeAmbientWater()` must return exactly what the solver's
//    `water` option consumes — height, a unit normal, a flow vector — for any
//    (x, z, t). A missing normal used to throw from inside the panel loop and
//    kill the frame; the solver now guards it, which means a broken twin
//    degrades to a silent flat plane instead. Silent is worse.
// 2. **Determinism.** docs/04 requires identical inputs to give identical
//    results. The water field is an input, so it has to be a pure function of
//    (x, z, t) — no clock, no RNG, no accumulated state.
// 3. **The solver actually runs on it**, and produces a plausible run rather
//    than diving on contact one.
// 4. **Chop costs what it should.** Waves are the daily's strategic layer
//    (docs/05: "some days the cairn is downwind, some days across the chop"),
//    so the relationship has to be monotone: rougher water, shorter run. If
//    chop ever HELPED, the daily's wind roll would be a gift rather than a
//    challenge and the leaderboard would sort by luck.
//
// The numbers this prints are the measurement that was missing: how much a
// given wind actually costs a throw. The skill ladder is tuned on flat water,
// so it is the delta here that says how much of that tuning survives contact
// with the real pond.

import assert from 'node:assert/strict';
import { StoneSkipSim, THROW_PRESETS } from '../stone-skipping-physics/src/stoneSkipping.js';
import { makeAmbientWater, sampleAmbient, POND_CONDITIONS } from '../shared/ambientWater.js';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

/* ------------------------------------------------------------------ *
 * 1. Shape — the twin speaks the solver's water contract
 * ------------------------------------------------------------------ */

const WIND = { windStrength: 0.5, windDirDeg: 25, waveScale: 4 };

test('the twin returns the solver water contract', () => {
  const w = makeAmbientWater(WIND);
  for (const [x, z, t] of [[0, 0, 0], [13.7, -4.2, 3.5], [-90, 90, 61.25]]) {
    const s = w(x, z, t);
    assert.ok(Number.isFinite(s.height), `height not finite at ${x},${z},${t}`);
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Number.isFinite(s.normal[k]), `normal.${k} not finite`);
      assert.ok(Number.isFinite(s.flow[k]), `flow.${k} not finite`);
    }
    const len = Math.hypot(s.normal.x, s.normal.y, s.normal.z);
    assert.ok(Math.abs(len - 1) < 1e-9, `normal not unit length: ${len}`);
    assert.ok(s.normal.y > 0, 'normal must point up out of the water');
  }
});

/* ------------------------------------------------------------------ *
 * 2. Determinism — the field is a pure function of (x, z, t)
 * ------------------------------------------------------------------ */

test('the water field is a pure function of (x, z, t)', () => {
  const a = sampleAmbient(7.3, -2.1, 9.75, WIND);
  const b = sampleAmbient(7.3, -2.1, 9.75, WIND);
  assert.equal(a.height, b.height, 'same input gave a different height');
  assert.equal(a.normal.x, b.normal.x);
});

test('a whole run on real water is bit-reproducible', () => {
  const run = () => {
    const sim = new StoneSkipSim({ profile: 'game', water: makeAmbientWater(WIND) });
    sim.throwStone(THROW_PRESETS.steinerThrow);
    sim.simulate({ maxTime: 60 });
    return sim.checksum();
  };
  assert.equal(run(), run(), 'two identical runs on the ambient field diverged');
});

test('run on real water is frame-rate independent', () => {
  const at = (hz) => {
    const sim = new StoneSkipSim({ profile: 'game', water: makeAmbientWater(WIND) });
    sim.throwStone(THROW_PRESETS.steinerThrow);
    while (!sim.finished && sim.state.time < 60) sim.advance(1 / hz);
    return sim.checksum();
  };
  const a = at(240), b = at(60), c = at(30);
  assert.equal(a, b, `240Hz ${a} vs 60Hz ${b}`);
  assert.equal(b, c, `60Hz ${b} vs 30Hz ${c}`);
});

/* ------------------------------------------------------------------ *
 * 3 & 4. What chop actually costs
 * ------------------------------------------------------------------ */

/** Median of an ensemble, because a single skip count is chaotic. */
let seed = 0;
const u01 = () => {
  seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};
const jitter = (w) => (u01() + u01() - 1) * w;

function ensemble(windStrength, n = 15) {
  seed = 0xC0FFEE;
  const hops = [], dist = [];
  for (let i = 0; i < n; i++) {
    const sim = new StoneSkipSim({
      profile: 'game',
      water: makeAmbientWater({ windStrength, windDirDeg: 25, waveScale: 4 }),
    });
    sim.throwStone({
      ...THROW_PRESETS.steinerThrow,
      speed: THROW_PRESETS.steinerThrow.speed + jitter(0.5),
      attackAngleDeg: 20 + jitter(1.5),
      headingDeg: jitter(3),
    });
    const r = sim.simulate({ maxTime: 60 });
    hops.push(sim.cleanHops); dist.push(r.runDistance);
  }
  hops.sort((a, b) => a - b); dist.sort((a, b) => a - b);
  return { hops: hops[n >> 1], dist: dist[n >> 1] };
}

// Measured across four independent seeds, because a single ensemble is not
// enough to read this curve. What survives re-seeding:
//
//   windStrength   0     0.15    0.35    0.55
//   hops        47-56   43-58   42-48   25-31
//
// Glass and 0.15 are indistinguishable — an apparent +13% "chop helps" at 0.15
// in the first ensemble did NOT survive re-seeding. From 0.35 the cost is real
// and monotone: about -22% at 0.35 and about -49% at 0.55, which is
// babylon-water's own default wind.
//
// That last number is the one that matters for tuning: the skill ladder in
// docs/04 is measured on FLAT water, and the pond's default conditions cost
// roughly half of it.
console.log('\n  what the wind costs a champion throw (median of 15):\n');
console.log(`    ${pad('windStrength', 14)} ${lpad('hops', 5)} ${lpad('distance', 10)}   vs glass`);

const WINDS = [0, 0.15, 0.35, 0.55, 0.8, 1.0];
const results = [];
for (const w of WINDS) {
  const r = ensemble(w);
  results.push({ w, ...r });
  const base = results[0];
  const rel = base.hops > 0 ? `${((r.hops / base.hops - 1) * 100).toFixed(0)}%` : '—';
  console.log(
    `    ${pad(w === 0 ? '0 (glass)' : w, 14)} ${lpad(r.hops, 5)} ` +
    `${lpad(r.dist.toFixed(1) + ' m', 10)}   ${lpad(rel, 6)}`
  );
}
console.log('');

test('the solver produces a real run on the pond surface', () => {
  const glass = results[0];
  assert.ok(glass.hops >= 5, `only ${glass.hops} hops on near-glass water — the twin ` +
    `is probably not being read at all (a broken water callback degrades to a flat plane)`);
});

test('rougher water never scores better than glass', () => {
  const glass = results[0].hops;
  const worse = results.filter((r) => r.hops > glass * 1.15);
  assert.deepEqual(
    worse.map((r) => r.w), [],
    `chop HELPED at windStrength ${worse.map((r) => r.w).join(', ')} — the daily's wind ` +
    `roll is meant to be a challenge, not a gift, and a leaderboard where rough days ` +
    `score higher sorts by luck (docs/05).`
  );
});

test('a full gale costs a champion throw real distance', () => {
  const glass = results[0], gale = results[results.length - 1];
  assert.ok(
    gale.dist < glass.dist * 0.98,
    `windStrength 1.0 ran ${gale.dist.toFixed(1)} m against ${glass.dist.toFixed(1)} m on ` +
    `glass — the water is barely coupling into the physics. Chop should change the ` +
    `effective attack angle on every contact.`
  );
});

/* ------------------------------------------------------------------ *
 * 5. Is the flat-water skill ladder still valid at the pond's own
 *    conditions?
 * ------------------------------------------------------------------ */

// docs/04's ladder is measured against a flat plane, because the solver package
// is dependency-free and cannot import the pond. That is only honest while the
// pond is near-glass. POND_CONDITIONS is currently windStrength 0.01, which the
// table above shows is indistinguishable from glass — so the ladder holds.
//
// If someone dials the pond choppier, this check fails and says so, because at
// that point every number in docs/04 describes water the game no longer has.
// Measured: at 0.55 a champion throw loses about half its score.
const flat = (() => {
  seed = 0xC0FFEE;
  const hops = [];
  for (let i = 0; i < 15; i++) {
    const sim = new StoneSkipSim({ profile: 'game' });
    sim.throwStone({
      ...THROW_PRESETS.steinerThrow,
      speed: THROW_PRESETS.steinerThrow.speed + jitter(0.5),
      attackAngleDeg: 20 + jitter(1.5),
      headingDeg: jitter(3),
    });
    sim.simulate({ maxTime: 60 });
    hops.push(sim.cleanHops);
  }
  hops.sort((a, b) => a - b);
  return hops[7];
})();
const pond = ensemble(POND_CONDITIONS.windStrength).hops;

console.log(`  pond conditions: ${JSON.stringify(POND_CONDITIONS)}`);
console.log(`  champion throw — flat water ${flat} hops · real pond ${pond} hops\n`);

test("docs/04's flat-water ladder is still valid at POND_CONDITIONS", () => {
  const ratio = flat > 0 ? pond / flat : 0;
  assert.ok(
    ratio >= 0.75 && ratio <= 1.35,
    `the pond now scores ${pond} against ${flat} on flat water (${(ratio * 100).toFixed(0)}%). ` +
    `docs/04's skill ladder is measured on a flat plane, so it no longer describes ` +
    `this pond. Either re-derive the ladder at POND_CONDITIONS or reconsider the ` +
    `conditions — see docs/04 "The ladder is a FLAT-WATER measurement".`
  );
});

console.log(`\nwater-coupling: ${passed} passed\n`);
