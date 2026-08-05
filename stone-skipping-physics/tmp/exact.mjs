import { StoneSkipSim, THROW_PRESETS } from '../src/stoneSkipping.js'
// No arithmetic construction at all — the literal preset object, exactly as the
// demo's throwStone(THROW_PRESETS.steinerThrow) call uses it. Run it 5 times to
// confirm true determinism (should be bit-identical every time).
for(let i=0;i<5;i++){
  const s=new StoneSkipSim({profile:'game'})
  s.throwStone(THROW_PRESETS.steinerThrow)
  const r=s.simulate({maxTime:400})
  console.log(`  run ${i}: skips=${r.skips} checksum=${s.checksum()}`)
}
