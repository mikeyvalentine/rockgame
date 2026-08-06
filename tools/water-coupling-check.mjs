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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StoneSkipSim, THROW_PRESETS } from '../stone-skipping-physics/src/stoneSkipping.js';
import { makeAmbientWater, sampleAmbient, POND_CONDITIONS } from '../shared/ambientWater.js';

const here = dirname(fileURLToPath(import.meta.url));

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

/* ------------------------------------------------------------------ *
 * 6. The fields the skip lab reads off the solver
 * ------------------------------------------------------------------ */

// babylon-water drives its ripples, spray and foam from these. They are a
// contract, and an unusually quiet one to break: the solver's water callback is
// guarded, so a missing field arrives as `undefined`, becomes NaN in a shader
// uniform, and the drop silently does nothing. No error, no splash, and nothing
// in any test to say so — which is exactly how the lab spent its first version
// making an identical round dimple for every bounce regardless of the impact.
{
  const sim = new StoneSkipSim({ profile: 'game', water: makeAmbientWater() });
  sim.throwStone(THROW_PRESETS.steinerThrow);
  let bounce = null, contactFrames = 0, afterRunEnded = 0;
  while (!sim.finished && sim.state.time < 40) {
    for (const e of sim.advance(1 / 60)) if (e.type === 'bounce' && !bounce) bounce = e;
    if (sim.getDisturbance().contact) {
      contactFrames++;
      if (sim.runEnded) afterRunEnded++;
    }
  }

  test('the sim exposes mass and effRadius', () => {
    assert.ok(sim.mass > 0, 'sim.mass');
    assert.ok(sim.effRadius > 0, 'sim.effRadius');
  });

  test('a bounce event carries what the splash needs', () => {
    assert.ok(bounce, 'no bounce event at all');
    for (const k of ['position', 'speed', 'approachSpeed', 'penetration', 'impulse', 'energyToWater']) {
      const v = bounce[k];
      assert.ok(v !== undefined, `bounce.${k} is missing — the lab reads it`);
      if (k !== 'position') assert.ok(Number.isFinite(v), `bounce.${k} is not finite`);
    }
  });

  test('getDisturbance() carries what the plough needs', () => {
    const g = sim.getDisturbance();
    for (const k of ['x', 'z', 'displacedVolume', 'radius', 'speed']) {
      assert.ok(Number.isFinite(g[k]), `getDisturbance().${k} is not finite`);
    }
    assert.equal(typeof g.contact, 'boolean', 'getDisturbance().contact');
  });

  // The reason continuous displacement exists. If this ever goes to zero the
  // feature is dead weight and the pond is glassy again the moment scoring stops.
  test('most of a stone\'s time in the water is NOT a scoring bounce', () => {
    assert.ok(
      afterRunEnded > 10,
      `only ${afterRunEnded} contact frames after the run ended, of ${contactFrames} — ` +
      `continuous displacement has nothing left to draw`
    );
    console.log(`      (${contactFrames} contact frames, ${afterRunEnded} of them after scoring stopped)`);
  });
}

/* ------------------------------------------------------------------ *
 * 7. Volume -> crater. The arithmetic that turns the stone into a ripple.
 * ------------------------------------------------------------------ *
 *
 * ## The bug this exists to prevent, which shipped
 *
 * The first version of the plough computed
 *
 *     ploughGain * displacedVolume * speed * dt * 60
 *
 * with the gain at 0.010. For a 172 g stone the displaced volume is ~3e-5 m^3,
 * so that expression returns about 1e-6 — against a visible drop of 1e-2. Four
 * orders of magnitude. Nothing in any suite said so, because nothing checked
 * that a formula mixing a gain, a volume, a speed and a frame count produced a
 * LENGTH. It does not; it produces whatever the gain's units happen to be.
 *
 * The impact path failed the opposite way at the same time: `rippleGain *
 * energy * (0.25 + 0.75 sinA)` came to 0.047 m against a 0.050 m cap, so every
 * bounce in the playable range was clipped to the same maximum crater. That is
 * the reported symptom — "the ripples are fairly static" — and it is a
 * DYNAMIC RANGE failure, which no single-value assertion can see.
 *
 * So both halves are checked here: the conversion round-trips a volume, and
 * the spread between the softest and hardest real impact survives it.
 */
{
  const html = readFileSync(join(here, '..', 'babylon-water', 'index.html'), 'utf8');
  const constant = (name) => {
    const m = html.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m, `${name} is not declared in index.html`);
    return m[1];
  };

  // The page's own numbers, evaluated rather than copied — a duplicated
  // literal here would drift and this file would then be testing itself.
  const CRATER_KAPPA = eval(constant('CRATER_KAPPA'));
  const RIM_NEUTRAL = eval(constant('RIM_NEUTRAL'));
  const MIN_DROP_CELLS = eval(constant('MIN_DROP_CELLS'));
  const SIZE = eval(constant('SPAN_BASE'));
  const SPAN_MAX = eval(constant('SPAN_MAX'));
  const SPAN_MARGIN = eval(constant('SPAN_MARGIN'));
  const craterSpread = Number(html.match(/craterSpread:\s*([0-9.]+)/)[1]);
  // The page's DEFAULT resolution, which sets the cell size and so the depth
  // every crater comes out at. Parsed rather than assumed: `?res=` can change
  // it at runtime, but what ships is what this table has to describe.
  const RES_DEFAULT = Number(html.match(/\.includes\(q\)\s*\?\s*q\s*:\s*(\d+);/)[1]);
  const rippleMax = Number(html.match(/rippleMax:\s*([0-9.]+)/)[1]);
  const elongMax = Number(html.match(/elongMax:\s*([0-9.]+)/)[1]);

  // A twin of the shipped fragment shader's radial profile. Asserting the
  // source lines first means this cannot quietly test a shader that no longer
  // exists — the constants above are only meaningful for THIS profile.
  test('the drop shader still uses the crater+rim profile these constants describe', () => {
    for (const line of [
      'float w = 0.5 - cos((1.0 - u) * PI) * 0.5;',
      'float ring = sin(u * PI);',
      'float shape = -w + dropRim * ring * ring;',
    ]) assert.ok(html.includes(line), `drop shader no longer contains: ${line}`);
  });

  const N = 20000;
  const integrate = (f) => {
    let s = 0;
    for (let i = 0; i < N; i++) { const u = (i + 0.5) / N; s += f(u) * 2 * u / N; }
    return s;
  };
  const wLobe = (u) => 0.5 - Math.cos((1 - u) * Math.PI) * 0.5;
  const ring = (u) => Math.sin(u * Math.PI) ** 2;

  test('CRATER_KAPPA is the crater lobe\'s own volume coefficient', () => {
    const measured = integrate(wLobe);
    assert.ok(Math.abs(measured - CRATER_KAPPA) < 1e-4,
      `shader profile integrates to ${measured.toFixed(6)}, CRATER_KAPPA is ${CRATER_KAPPA}`);
  });

  // Water is incompressible. It also matters mechanically: damping is 0.9992
  // by design, so a drop that adds net volume never gives it back and fifty
  // bounces leave a standing mound on the pond.
  test('a drop at RIM_NEUTRAL displaces zero net volume', () => {
    const net = integrate((u) => -wLobe(u) + RIM_NEUTRAL * ring(u));
    assert.ok(Math.abs(net) < 1e-4, `net volume ${net.toExponential(2)} per unit depth`);
  });

  const CELL = SIZE / RES_DEFAULT;
  const MIN_ACROSS = (MIN_DROP_CELLS * CELL) / SIZE;
  const craterDepth = (volume, across, elong) => {
    const R = across * SIZE;
    return volume / (Math.PI * R * R * elong * CRATER_KAPPA);
  };

  // THE ROUND TRIP. Whatever radius legibility forces, the crater has to hold
  // the volume that went in — that is the entire claim the conversion makes,
  // and it is what makes `rippleGain: 1.0` mean "what the solver said".
  test('crater depth round-trips a displaced volume at any radius', () => {
    for (const V of [1e-6, 3e-5, 1e-4, 1e-3]) {
      for (const across of [MIN_ACROSS, MIN_ACROSS * 2, MIN_ACROSS * 0.5]) {
        for (const elong of [1, 2.9, elongMax]) {
          const d = craterDepth(V, across, elong);
          const R = across * SIZE;
          const back = d * Math.PI * R * R * elong * CRATER_KAPPA;
          assert.ok(Math.abs(back - V) / V < 1e-9,
            `V ${V} -> depth ${d} -> ${back}`);
        }
      }
    }
  });

  // Real throws, real penetrations, the page's real formula. This is the
  // measurement the "static ripples" report needed and nothing produced.
  const PRESETS = ['casual', 'decent', 'strong', 'steinerThrow'];
  const depths = [], widths = [];
  console.log(`\n  crater depth per bounce, volume-true ` +
    `(RES ${RES_DEFAULT}, ${(CELL * 1000).toFixed(1)} mm cells):\n`);
  console.log(`    ${pad('throw', 15)} ${lpad('bounces', 8)} ${lpad('softest', 10)} ${lpad('hardest', 10)}`);
  for (const name of PRESETS) {
    const sim = new StoneSkipSim({ profile: 'game', water: makeAmbientWater() });
    sim.throwStone(THROW_PRESETS[name]);
    const d = [];
    while (!sim.finished && sim.state.time < 40) {
      for (const e of sim.advance(1 / 60)) {
        if (e.type !== 'bounce') continue;
        const v = sim.state.velocity;
        const h = Math.hypot(v.x, v.z) || 1;
        const sinA = Math.sin(Math.atan2(Math.max(0, e.approachSpeed), h));
        const elong = Math.min(elongMax, Math.max(1.6, 1 / Math.max(0.05, sinA)));
        const volume = 0.8 * Math.PI * sim.effRadius ** 2 * e.penetration;
        // Width scales with volume too — see craterSpread. Depth follows from
        // whatever width that gives, so this is the depth the page actually
        // writes, not the depth at a fixed radius.
        const across = Math.max(MIN_ACROSS, (craterSpread * Math.cbrt(volume)) / SIZE);
        d.push(craterDepth(volume, across, elong));
        widths.push(across * SIZE);
      }
    }
    if (!d.length) continue;
    depths.push(...d);
    console.log(`    ${pad(name, 15)} ${lpad(d.length, 8)} ` +
      `${lpad((Math.min(...d) * 1000).toFixed(3) + 'mm', 10)} ` +
      `${lpad((Math.max(...d) * 1000).toFixed(3) + 'mm', 10)}`);
  }
  console.log('');

  // THE REPORTED BUG, as an assertion. The old formula clipped every playable
  // impact to rippleMax, so throw and rock made no visible difference at all.
  test('no bounce in the playable range is clipped by rippleMax', () => {
    const clipped = depths.filter((d) => d >= rippleMax).length;
    assert.equal(clipped, 0,
      `${clipped} of ${depths.length} bounces hit the ${rippleMax} m cap — ` +
      `a saturated cap is why ripples read as identical regardless of the throw`);
  });

  test('crater depth spans a wide range across real throws', () => {
    const spread = Math.max(...depths) / Math.min(...depths);
    assert.ok(spread > 4,
      `softest to hardest is only ${spread.toFixed(1)}x — the water cannot be ` +
      `showing the difference between a good throw and a bad one`);
    console.log(`      (${spread.toFixed(0)}x between the softest and hardest bounce)`);
  });

  /* ---------------------------------------------------------------- *
   * The COASTING AND SINKING half, reported broken twice.
   * ---------------------------------------------------------------- *
   *
   * A stone spends more of a run not-bouncing than bouncing, and both times
   * this was shipped the non-bouncing half made no mark at all. The second
   * time was subtler than the first: the volume bound was right (a body can
   * only hold aside its own volume) but applied to the flux INPUT, so the cap
   * was reached during the run and by the time the stone started sinking there
   * was no headroom left to emit.
   *
   * So the assertion is not "the function exists" or "a knob is non-zero". It
   * is that displacement actually comes out DURING THE SINK, which is the only
   * statement either bug would have failed.
   */
  const surfaceVolume = (displaced, faceArea, thickness, effRadius) => {
    const depth = displaced / faceArea;
    return faceArea * Math.min(depth, thickness) *
      Math.exp(-Math.max(0, depth - thickness) / effRadius);
  };

  {
    const sim = new StoneSkipSim({ profile: 'game', water: makeAmbientWater() });
    sim.throwStone(THROW_PRESETS.steinerThrow);
    const faceArea = Math.PI * sim.effRadius ** 2;
    const thickness = 0.010;
    let last = 0, duringRun = 0, duringSink = 0, sinkTotal = 0, peak = 0;
    while (!sim.finished && sim.state.time < 40) {
      const bounced = sim.advance(1 / 60).some((e) => e.type === 'bounce');
      const g = sim.getDisturbance();
      const v = surfaceVolume(g.displacedVolume, faceArea, thickness, sim.effRadius);
      const dV = v - last;
      last = v;
      peak = Math.max(peak, v);
      if (bounced || Math.abs(dV) < 1e-9) continue;
      if (sim.runEnded) { duringSink++; sinkTotal += Math.abs(dV); } else duringRun++;
    }

    test('the stone displaces water while it is still skipping', () => {
      assert.ok(duringRun > 20,
        `only ${duringRun} ploughing frames emitted anything`);
    });

    test('the stone displaces water while it is SINKING', () => {
      assert.ok(duringSink > 20,
        `only ${duringSink} frames of the sink displaced anything — this is the ` +
        `reported "no water displacement when the stone is coasting/sinking", and ` +
        `it survived one fix already`);
      assert.ok(sinkTotal > 1e-6,
        `the whole sink moved ${sinkTotal.toExponential(2)} m^3`);
      console.log(`      (${duringRun} ploughing frames, ${duringSink} sinking)`);
    });

    // The physical bound, and the reason the sink closes rather than digging
    // forever. Without it the solver's raw prism reaches 1.6e-3 m^3.
    test('the surface never holds more water aside than the stone displaces', () => {
      const stoneVolume = faceArea * thickness;
      assert.ok(peak <= stoneVolume * 1.001,
        `peak depression ${peak.toExponential(2)} m^3 exceeds the stone's own ` +
        `${stoneVolume.toExponential(2)} m^3`);
    });

    test('the dimple closes again once the stone is under', () => {
      assert.ok(last < peak * 0.2,
        `the depression finished at ${last.toExponential(2)} m^3 against a peak of ` +
        `${peak.toExponential(2)} — a hole that never shuts`);
    });
  }

  /* ---------------------------------------------------------------- *
   * The ENERGY fallback, for callers that stop dead (Plunge).
   * ---------------------------------------------------------------- *
   *
   * Same saturation trap as the impact path, on a different road. The first
   * efficiency tried here was 0.15, at which a 2.7 J drop computed a 104 mm
   * crater against a 60 mm cap — so every plunge from a gentle one to a
   * cannonball produced the identical maximum hole. It was caught by hand,
   * after the volume path had already been fixed for exactly this.
   */
  const PLUNGE_EFFICIENCY = eval(constant('PLUNGE_EFFICIENCY'));
  const CRATER_KAPPA2 = eval(constant('CRATER_KAPPA2'));
  const elongMin = Number(html.match(/elongMin:\s*([0-9.]+)/)[1]);
  const depthFromEnergy = (J, across, elong) => {
    const R = across * SIZE;
    return Math.sqrt(2 * PLUNGE_EFFICIENCY * J /
      (1000 * 9.81 * Math.PI * R * R * elong * CRATER_KAPPA2));
  };

  {
    // Straight down, so elongation is at its floor — the deepest case.
    const at = (m, v) => depthFromEnergy(0.5 * m * v * v, MIN_ACROSS, elongMin);
    const gentle = at(0.15, 6);      // a stone dropped in
    const plunge = at(0.25, 14);     // the Plunge button
    const cannon = at(1.20, 25);     // "a huge rock thrown straight in at speed"

    test('a gentle drop is a dimple, not a maximum crater', () => {
      assert.ok(gentle < rippleMax * 0.5,
        `${(gentle * 1000).toFixed(0)} mm against a ${rippleMax * 1000} mm cap`);
    });

    test('the plunge button lands under the cap rather than through it', () => {
      assert.ok(plunge < rippleMax && plunge > rippleMax * 0.5,
        `${(plunge * 1000).toFixed(0)} mm against a ${rippleMax * 1000} mm cap — ` +
        `over it and every plunge looks identical, far under it and Plunge is limp`);
    });

    test('a cannonball still outruns an ordinary plunge', () => {
      assert.ok(cannon > plunge,
        `${(cannon * 1000).toFixed(0)} mm vs ${(plunge * 1000).toFixed(0)} mm`);
      console.log(`      (gentle ${(gentle * 1000).toFixed(0)} mm · plunge ` +
        `${(plunge * 1000).toFixed(0)} mm · cannonball ` +
        `${(Math.min(cannon, rippleMax) * 1000).toFixed(0)} mm at the cap)`);
    });
  }

  /* ---------------------------------------------------------------- *
   * The window has to HOLD the run it is placed for.
   * ---------------------------------------------------------------- *
   *
   * A drop queued outside the interaction window is silently skipped — there
   * is no deviation field out there to write into — so a run that outgrows its
   * window loses the far end of its trail with nothing to say so.
   *
   * Placement used to be a guess: drop the window 0.72 of a half-span
   * downrange of the first impact. Measured against the presets, `strong`
   * needed 30.3 m from that centre against 29.4 m usable, and `truscottLimit`
   * needed 81.6 m. Both clipped.
   *
   * placeRun() replaces the guess with the run itself, since the solver is
   * deterministic and can be run to completion first. This asserts the fit for
   * every preset in the picker, which is the only way to know the widening
   * rule and SPAN_MAX are actually big enough.
   */
  console.log('\n  window span chosen per throw (placeRun):\n');
  console.log(`    ${pad('throw', 15)} ${lpad('path', 9)} ${lpad('span', 8)} ` +
    `${lpad('usable', 9)} ${lpad('worst', 8)}`);

  for (const name of Object.keys(THROW_PRESETS)) {
    const sim = new StoneSkipSim({ profile: 'game', water: makeAmbientWater() });
    sim.throwStone({ ...THROW_PRESETS[name], headingDeg: 0, origin: { x: -42, z: 0 } });
    const r = sim.simulate({ maxTime: 40, dt: 1 / 240, collectPath: true, pathEvery: 1 / 60 });
    if (!r.path.length) continue;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of r.path) {
      minX = Math.min(minX, s.p.x); maxX = Math.max(maxX, s.p.x);
      minZ = Math.min(minZ, s.p.z); maxZ = Math.max(maxZ, s.p.z);
    }
    // The page's own rule, verbatim.
    const need = Math.max(maxX - minX, maxZ - minZ) + 2 * SPAN_MARGIN;
    const span = Math.min(SPAN_MAX, Math.max(SIZE, need / 0.84));
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const worst = Math.max(Math.abs(minX - cx), Math.abs(maxX - cx),
      Math.abs(minZ - cz), Math.abs(maxZ - cz));
    const usable = (span / 2) * 0.92;

    console.log(`    ${pad(name, 15)} ${lpad((maxX - minX).toFixed(1) + 'm', 9)} ` +
      `${lpad(span.toFixed(0) + 'm', 8)} ${lpad(usable.toFixed(1) + 'm', 9)} ` +
      `${lpad(worst.toFixed(1) + 'm', 8)}${worst > usable ? '  CLIPS' : ''}`);

    test(`${name} fits the window placed for it`, () => {
      assert.ok(worst <= usable,
        `the run reaches ${worst.toFixed(1)} m from the window centre but only ` +
        `${usable.toFixed(1)} m is usable — the far end of the trail is dropped ` +
        `silently. Raise SPAN_MAX (currently ${SPAN_MAX} m).`);
    });
  }
  console.log('');

  // Every one of them still has to be a ripple rather than a rounding error.
  test('even the softest bounce leaves a crater the grid can carry', () => {
    const min = Math.min(...depths);
    assert.ok(min > 1e-5,
      `softest crater is ${min.toExponential(2)} m — below anything the surface ` +
      `shader will show, which is how the plough came to be invisible`);
  });
}

console.log(`\nwater-coupling: ${passed} passed\n`);
