import { StoneSkipSim, THROW_PRESETS } from '../src/stoneSkipping.js'
let seed=1; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff-0.5}
const base = THROW_PRESETS.steinerThrow

console.log('=== A. floor/distribution for Steiner throw, game profile (80 near-identical throws) ===')
const rows=[]
for(let i=0;i<80;i++){
  const s=new StoneSkipSim({profile:'game'})
  s.throwStone({...base, spinRPS: base.spinRPS + rnd()*0.01})
  rows.push(s.simulate({maxTime:400}).skips)
}
rows.sort((a,b)=>a-b)
console.log('  min',rows[0],' p10',rows[8],' median',rows[40],' p90',rows[72],' max',rows[79])
console.log('  fraction <20:', (rows.filter(x=>x<20).length/80*100).toFixed(0)+'%')

console.log('\n=== B. sensitivity to engine-scale (0.001 rev/s) noise, same throw ===')
const S=[]
for(let i=0;i<60;i++){
  const s=new StoneSkipSim({profile:'game'})
  s.throwStone({...base, spinRPS: base.spinRPS + (i-30)*0.001})
  S.push(s.simulate({maxTime:400}).skips)
}
S.sort((a,b)=>a-b)
console.log('  min',S[0],' median',S[30],' max',S[59],'  (was 18-47 before the fix)')

console.log('\n=== C. exact unmodified preset (what the demo actually runs) ===')
const s=new StoneSkipSim({profile:'game'})
s.throwStone(THROW_PRESETS.steinerThrow)
console.log('  ', s.simulate({maxTime:400}).skips, 'skips  checksum='+s.checksum())

console.log('\n=== D. wobbler preset - early visible wobble must survive ===')
{
  const s=new StoneSkipSim({profile:'game'}); s.throwStone(THROW_PRESETS.wobbler)
  const t=[]; let mark=0
  while(!s.finished && s.state.time<8){
    s.step(1/2000)
    if(!s.runEnded && s.state.time-mark>0.02){mark=s.state.time;t.push(s.getDiagnostics().faceTiltDeg)}
  }
  console.log('  tilt swing:', t.length?(Math.max(...t)-Math.min(...t)).toFixed(1):0, 'deg  (was 64deg)')
}

console.log('\n=== E. full regression suite ===')
