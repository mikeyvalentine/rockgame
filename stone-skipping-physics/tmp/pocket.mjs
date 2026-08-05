import { StoneSkipSim, THROW_PRESETS } from '../src/stoneSkipping.js'
const base = THROW_PRESETS.steinerThrow
console.log('is the EXACT default (spin=47.0) a bad pocket vs its neighbors?')
console.log('spin sweep at fixed base, +/-0.5 rev/s steps around 47:')
for(let w=45; w<=49; w+=0.25){
  const s=new StoneSkipSim({profile:'game'})
  s.throwStone({...base, spinRPS: w})
  const r=s.simulate({maxTime:400})
  console.log(`  spin=${w.toFixed(2)}  -> ${String(r.skips).padStart(3)} skips  ${r.outcome}`)
}
console.log('\nare OTHER exact presets also landing badly? (unperturbed, as-shipped)')
for(const n of ['casual','decent','strong','steinerThrow','truscottLimit']){
  const s=new StoneSkipSim({profile:'game'}); s.throwStone(THROW_PRESETS[n])
  const r=s.simulate({maxTime:400})
  // compare vs the jittered median measured earlier this session for context
  console.log(`  ${n.padEnd(14)} exact-default -> ${r.skips} skips`)
}
