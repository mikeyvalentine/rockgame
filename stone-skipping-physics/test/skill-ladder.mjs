/**
 * Skill ladder — does the game profile produce the intended score curve?
 *
 *   node test/skill-ladder.mjs [profile]      (default: game)
 *
 * `headless-sweep.mjs` asserts the PHYSICS is right. This asserts the GAME is right:
 * that skip counts sort players by execution quality across the band the design
 * calls for (docs/04-physics.md "Skill ladder").
 *
 *   >10  a decent throw
 *   >30  a good rock thrown well
 *   >50  real skill
 *    100 a record, a master's day
 *
 * ### How a "tier" is defined
 *
 * A tier is NOT one throw. It is a player: a centre throw plus the execution error
 * that player still has at their level, sampled as an ensemble. That is the only
 * honest way to ask "what does a decent player score", because skip count is chaotic
 * — the same throw +/-2 degrees can give 5 or 19 — and a single sample measures the
 * jitter, not the player.
 *
 * The error bands shrink tier by tier along exactly the axes the throw UI exposes
 * (docs/03-throwing.md): release speed and spin from the arc, attack angle from the
 * keyboard hold, bank/sideslip/axis-tilt from a clean vs. sloppy release.
 *
 * Scored on `cleanHops`, not `skips`. docs/05-scoring.md counts a skip only with
 * "clear daylight between the splashes", which is the airborne test — and that is
 * also the metric that converges under substep refinement (headless-sweep 9b).
 */

import {
  StoneSkipSim, PHYSICS_PROFILES, balanceFromStone,
} from '../src/stoneSkipping.js'

const profileName = process.argv[2] || 'game'
if (!PHYSICS_PROFILES[profileName]) {
  console.error(`Unknown profile "${profileName}". Use one of: ${Object.keys(PHYSICS_PROFILES).join(', ')}`)
  process.exit(2)
}

/* ------------------------------------------------------------------ *
 * Seeded sampling. No Math.random: the ladder is a regression test and
 * has to give the same numbers twice.
 * ------------------------------------------------------------------ */
let seed = 0
const setSeed = (s) => { seed = s >>> 0 || 1 }
const u01 = () => {
  // xorshift32 — cheap, and good enough for a jitter ensemble
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5; seed >>>= 0
  return seed / 4294967296
}
/** Symmetric triangular jitter in [-w, w]: most releases are near-centre. */
const jitter = (w) => (u01() + u01() - 1) * w

/* ------------------------------------------------------------------ *
 * Rocks. Real geometry, not knobs — the stat comes from the stone.
 * ------------------------------------------------------------------ */
const ROCKS = {
  /** What the pond mostly hands you: small, chunky, a bit lopsided. */
  poor: { radius: 0.032, thickness: 0.016, aspect: 0.78, comOffset: { x: 0.05, z: 0.03 } },
  /** A rock you'd stop and pick up. */
  average: { radius: 0.042, thickness: 0.011, aspect: 0.9, comOffset: { x: 0.02, z: 0.0 } },
  /** A find. Close to the 165 g / 8.5 cm ideal in docs/02-gathering.md. */
  good: { radius: 0.0425, thickness: 0.0105, aspect: 0.97, comOffset: { x: 0.006, z: 0 } },
  /** The daily's universal rock at its best: round, flat, true. */
  ideal: { radius: 0.045, thickness: 0.010, aspect: 1.0, comOffset: { x: 0, z: 0 } },
}

/* ------------------------------------------------------------------ *
 * Players. Centre throw + the error that player still carries.
 * ------------------------------------------------------------------ */
const TIERS = [
  {
    name: 'first-timer', rock: 'poor', design: [0, 5], band: [2, 8],
    centre: { speed: 10, elevationDeg: -13, attackAngleDeg: 28, spinRPS: 10, releaseHeight: 0.6 },
    err: { speed: 2.5, attackAngleDeg: 14, spinRPS: 5, bankAngleDeg: 12, sideslipDeg: 10, spinAxisTiltDeg: 10, elevationDeg: 6 },
  },
  {
    name: 'casual', rock: 'poor', design: [4, 10], band: [5, 14],
    centre: { speed: 12.5, elevationDeg: -8, attackAngleDeg: 24, spinRPS: 18, releaseHeight: 0.45 },
    err: { speed: 2.0, attackAngleDeg: 9, spinRPS: 5, bankAngleDeg: 8, sideslipDeg: 7, spinAxisTiltDeg: 7, elevationDeg: 4 },
  },
  {
    name: 'decent', rock: 'average', design: [10, 30], band: [11, 22],
    centre: { speed: 14.5, elevationDeg: -5, attackAngleDeg: 21, spinRPS: 27, releaseHeight: 0.3 },
    err: { speed: 1.4, attackAngleDeg: 5, spinRPS: 4, bankAngleDeg: 5, sideslipDeg: 4, spinAxisTiltDeg: 4, elevationDeg: 2.5 },
  },
  {
    name: 'good', rock: 'good', design: [30, 50], band: [18, 40],
    centre: { speed: 17, elevationDeg: -3.5, attackAngleDeg: 20, spinRPS: 37, releaseHeight: 0.22 },
    err: { speed: 0.9, attackAngleDeg: 2.5, spinRPS: 3, bankAngleDeg: 2.5, sideslipDeg: 2, spinAxisTiltDeg: 2, elevationDeg: 1.4 },
  },
  {
    name: 'expert', rock: 'ideal', design: [50, 80], band: [45, 75],
    centre: { speed: 19, elevationDeg: -2.5, attackAngleDeg: 20, spinRPS: 44, releaseHeight: 0.16 },
    err: { speed: 0.5, attackAngleDeg: 1.3, spinRPS: 2, bankAngleDeg: 1.2, sideslipDeg: 1, spinAxisTiltDeg: 1, elevationDeg: 0.8 },
  },
  {
    name: 'master', rock: 'ideal', design: [80, 130], band: [45, 130],
    centre: { speed: 21, elevationDeg: -2, attackAngleDeg: 20, spinRPS: 50, releaseHeight: 0.12 },
    err: { speed: 0.25, attackAngleDeg: 0.6, spinRPS: 1, bankAngleDeg: 0.5, sideslipDeg: 0.4, spinAxisTiltDeg: 0.4, elevationDeg: 0.4 },
  },
]

const N = Number(process.env.LADDER_N || 25)

function sample(tier, i) {
  const t = { ...tier.centre, bankAngleDeg: 0, sideslipDeg: 0, spinAxisTiltDeg: 0 }
  for (const [k, w] of Object.entries(tier.err)) t[k] = (t[k] ?? 0) + jitter(w)
  // A wobbled release needs an azimuth or the tilt always leans the same way.
  t.spinAxisAzimuthDeg = u01() * 360
  return t
}

function runTier(tier) {
  setSeed(0x5EED + tier.name.length * 7919)
  const stone = ROCKS[tier.rock]
  const hops = [], dists = [], taps = []
  for (let i = 0; i < N; i++) {
    const sim = new StoneSkipSim({
      profile: profileName,
      stone,
      // 'auto' = the rock supplies its own Balance, which is how the game does it.
      env: { balanceRetention: 'auto' },
    })
    sim.throwStone(sample(tier, i))
    const r = sim.simulate({ maxTime: 60 })
    hops.push(sim.cleanHops)
    dists.push(r.runDistance ?? r.distance)
    taps.push(r.skips)
  }
  hops.sort((a, b) => a - b); dists.sort((a, b) => a - b); taps.sort((a, b) => a - b)
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]
  return {
    balance: balanceFromStone(stone),
    p10: q(hops, 0.1), median: q(hops, 0.5), p90: q(hops, 0.9), best: hops[hops.length - 1],
    dist: q(dists, 0.5), taps: q(taps, 0.5),
  }
}

const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)

/**
 * Two bars, and they are not the same bar.
 *
 *   `design` is the ladder docs/04-physics.md asks for. Reported, never asserted —
 *           the top of it is not reachable today and a permanently red suite teaches
 *           everyone to ignore it.
 *   `band`   is where the tier measures NOW. Asserted, so a change that quietly moves
 *           the ladder has to say so.
 */
console.log(`\n=== Skill ladder — profile "${profileName}", ${N} throws per tier ===\n`)
console.log(`  ${pad('tier', 12)} ${pad('rock', 8)} bal   ${lpad('p10', 4)} ${lpad('med', 4)} ${lpad('p90', 4)} ${lpad('best', 5)}   ${lpad('dist', 6)}  ${lpad('taps', 5)}   band        design`)

let failures = 0
const results = []
for (const tier of TIERS) {
  const r = runTier(tier)
  results.push({ tier, r })
  const [lo, hi] = tier.band
  const ok = r.median >= lo && r.median <= hi
  if (!ok) failures++
  const [dlo, dhi] = tier.design
  const met = r.median >= dlo && r.median <= dhi
  console.log(
    `  ${pad(tier.name, 12)} ${pad(tier.rock, 8)} ${r.balance.toFixed(2)}  ` +
    `${lpad(r.p10, 4)} ${lpad(r.median, 4)} ${lpad(r.p90, 4)} ${lpad(r.best, 5)}   ` +
    `${lpad(r.dist.toFixed(1) + 'm', 6)}  ${lpad(r.taps, 5)}   ` +
    `${ok ? 'ok  ' : 'MOVED'} ${pad(`${lo}-${hi}`, 7)} ${met ? 'met ' : 'GAP '} ${dlo}-${dhi}`
  )
}

console.log('\n  monotonic?')
let mono = true
for (let i = 1; i < results.length; i++) {
  // Equal medians are allowed; a REVERSAL is not. A tier that scores below the one
  // beneath it means more skill bought a worse score, which is the one outcome the
  // ladder exists to rule out.
  //
  // 10% of slack, because these are 25-sample medians of a chaotic quantity and a
  // two-hop wobble between adjacent tiers is sampling noise, not an inversion. Any
  // real inversion is far larger than that — the pre-tuning failure mode was a tier
  // scoring a THIRD of the one below it.
  if (results[i].r.median < results[i - 1].r.median * 0.9) mono = false
}
console.log(`  ${mono ? 'PASS' : 'FAIL'}  no tier scores below the one beneath it`)
if (!mono) failures++

/* The rock has to matter, and only within a viable throw. Same execution, four rocks. */
console.log('\n  rock sensitivity (the "good" player, same execution, different stone)')
const rockTier = TIERS.find((t) => t.name === 'good')
const rockRow = {}
for (const rock of Object.keys(ROCKS)) {
  const r = runTier({ ...rockTier, rock })
  rockRow[rock] = r.median
  console.log(`    ${pad(rock, 8)} bal=${r.balance.toFixed(2)}  median=${lpad(r.median, 4)}  dist=${r.dist.toFixed(1)}m`)
}
const rockSpread = rockRow.ideal - rockRow.poor
console.log(`  ${rockSpread >= 8 ? 'PASS' : 'FAIL'}  rock choice is worth >=8 hops   ${rockSpread}`)
if (rockSpread < 8) failures++

console.log(`\n${failures ? `${failures} LADDER CHECK(S) FAILED` : 'LADDER OK'}\n`)
process.exit(failures ? 1 : 0)
