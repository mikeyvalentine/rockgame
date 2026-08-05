import { StoneSkipSim, THROW_PRESETS, V, Q } from '../src/stoneSkipping.js'

const sim = new StoneSkipSim()
sim.throwStone({ ...THROW_PRESETS.perfect })
console.log('mass', sim.mass.toFixed(4), 'I', sim.inertiaBody, 'panels', sim.panels.length)

let t = 0
let lastPrint = -1
while (!sim.finished && t < 1.2) {
  sim.step(1 / 2000)
  t = sim.state.time
  const d = sim.getDiagnostics()
  if (!d.airborne || t - lastPrint > 0.05) {
    if (t - lastPrint > 0.004) {
      lastPrint = t
      console.log(
        `t=${t.toFixed(4)} y=${d.heightAboveWater.toFixed(4)} vy=${sim.state.velocity.y.toFixed(2)}` +
        ` sp=${d.speed.toFixed(2)} alpha=${d.attackAngleDeg.toFixed(1)} tilt=${d.faceTiltDeg.toFixed(1)}` +
        ` bank=${d.bankAngleDeg.toFixed(1)} spin=${d.spinRPS.toFixed(1)} air=${d.airborne}`
      )
    }
  }
}
console.log('outcome', sim.outcome, 'skips', sim.skips)
