import { StoneSkipSim, THROW_PRESETS } from '../src/stoneSkipping.js'
// The literal, unmodified preset object — exactly what the demo passes.
const s=new StoneSkipSim({profile:'game'})
s.throwStone(THROW_PRESETS.steinerThrow)
const r=s.simulate({maxTime:400})
console.log(`TRUE deterministic reference for steinerThrow (game): ${r.skips} skips, checksum=${s.checksum()}`)
console.log(`(ran 5x in exact2.mjs already confirmed bit-identical across runs)`)
