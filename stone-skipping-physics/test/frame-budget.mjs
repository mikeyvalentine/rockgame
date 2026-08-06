/**
 * Does the solver fit inside a 60fps frame? (docs/10-performance.md)
 *
 *   node test/frame-budget.mjs
 *
 * "60fps is a hard floor during the throw" is the one performance rule with no
 * escape hatch — there is no runtime adaptive scaling, so the frame either fits
 * or the player sees it. This turns that from an argument into a number.
 *
 * ### What it measures, and why the WORST frame is the metric
 *
 * Not the average. A solver that averages 1 ms and spikes to 20 ms on the frame
 * the stone first hits the water has failed exactly where the rule points — the
 * spike lands on the most important frame of the run. So this reports p50, p99
 * and max, and asserts on max.
 *
 * Contact frames are the expensive ones: the adaptive substep can ask for ~20 kHz
 * through a fast impact, so one `advance(1/60)` can run hundreds of substeps over
 * a 144-panel quadrature. That is the spike this exists to watch.
 *
 * ### The budget is NOT 16.7 ms
 *
 * 16.7 ms is the whole frame — physics AND rendering AND everything else. The
 * solver is one system among several, so it is held to a fraction of the frame,
 * set by `SOLVER_BUDGET_MS` below.
 *
 * ### Contention, and why this takes the BEST of several runs
 *
 * Wall-clock timing on a shared machine measures the machine's mood as much as
 * the code. Measured: the `casual` case reads 1.41 ms idle and 8.73 ms with four
 * busy cores alongside it — 6x, none of it the solver's doing. A single-shot
 * assertion on that number fails spuriously on any loaded CI runner, and a suite
 * that cries wolf is worse than no suite.
 *
 * Interference is one-sided: it can only ever make a run look slower, never
 * faster. So the profile is repeated and the MINIMUM of the per-run maxima is
 * taken — the least-interrupted observation is the closest to the truth. That is
 * the right estimator here, not the mean or the median.
 *
 * ### The number this CANNOT give you
 *
 * This machine is not the floor machine. docs/10 sets the floor at a 2020 Intel
 * MacBook (Iris Plus G7), whose single-thread performance is materially below a
 * CI runner or a dev box. A result that passes here at 7 ms could be 15-20 ms
 * there. Treat a comfortable pass as "not obviously broken", not as "meets the
 * floor spec" — that claim needs the floor machine, and nobody has run it yet.
 */

import { StoneSkipSim, THROW_PRESETS } from '../src/stoneSkipping.js'
import { performance } from 'node:perf_hooks'

const FRAME_MS = 1000 / 60
/**
 * The solver's slice of the frame. Deliberately well under the full 16.7 ms:
 * rendering the pond, the water sim and the UI all come out of the same frame,
 * and the solver is not entitled to most of it.
 *
 * 6 ms is ~36% of the frame. Generous for one system, but chosen to leave real
 * headroom for the floor machine being slower than whatever runs this.
 */
const SOLVER_BUDGET_MS = 6

/** Presets that bracket the playable range, cheapest to most demanding. */
const CASES = ['casual', 'decent', 'strong', 'steinerThrow', 'truscottLimit']

const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)

/** Run one throw frame-by-frame at a fixed 60 Hz tick, timing every frame. */
function profile(preset) {
  const sim = new StoneSkipSim({ profile: 'game' })
  sim.throwStone(THROW_PRESETS[preset])
  const times = []
  while (!sim.finished && sim.state.time < 40) {
    const t0 = performance.now()
    sim.advance(1 / 60)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return {
    frames: times.length,
    p50: times[times.length >> 1],
    p99: times[Math.floor(times.length * 0.99)],
    max: times[times.length - 1],
    over: times.filter((t) => t > SOLVER_BUDGET_MS).length,
  }
}

/** How many times to repeat each profile. See "Contention" above. */
const REPEATS = 3

/** Best (least-interrupted) observation of a preset's worst frame. */
function bestOf(preset) {
  let best = null
  for (let i = 0; i < REPEATS; i++) {
    const r = profile(preset)
    if (!best || r.max < best.max) best = r
  }
  return best
}

// Warm the JIT first. Without this the first case absorbs compilation and reads
// several times slower than it runs in a real session, which would make the
// numbers a measurement of Node's startup rather than of the solver.
for (const preset of CASES) profile(preset)

console.log(`\n=== Frame budget — solver slice ${SOLVER_BUDGET_MS} ms of a ${FRAME_MS.toFixed(1)} ms frame ===\n`)
console.log(`  ${pad('throw', 16)} ${lpad('frames', 6)} ${lpad('p50', 8)} ${lpad('p99', 8)} ${lpad('max', 8)}   over`)

let failures = 0
for (const preset of CASES) {
  const r = bestOf(preset)
  const ok = r.max <= SOLVER_BUDGET_MS
  if (!ok) failures++
  console.log(
    `  ${pad(preset, 16)} ${lpad(r.frames, 6)} ` +
    `${lpad(r.p50.toFixed(2) + 'ms', 8)} ${lpad(r.p99.toFixed(2) + 'ms', 8)} ` +
    `${lpad(r.max.toFixed(2) + 'ms', 8)}   ${ok ? 'ok' : `FAIL ${r.over} frame(s)`}`
  )
}

console.log(
  '\n  Reminder: this is not the floor machine (2020 Intel MacBook, Iris Plus G7).\n' +
  '  A pass here means "not obviously broken", not "meets the floor spec".'
)
console.log(`\n${failures ? `${failures} CASE(S) OVER BUDGET` : 'FRAME BUDGET OK'}\n`)
process.exit(failures ? 1 : 0)
