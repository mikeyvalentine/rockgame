import { StoneSkipSim, THROW_PRESETS } from '../src/stoneSkipping.js'
// Same throw, deterministic, but perturbed by amounts too small to be "player skill" —
// this samples the actual distribution a player would see hitting the "same" throw.
let seed=1; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff-0.5}
const base = THROW_PRESETS.steinerThrow
const N=80
const rows=[]
for(let i=0;i<N;i++){
  const s=new StoneSkipSim({profile:'game'})
  s.throwStone({...base, spinRPS: base.spinRPS + rnd()*0.01})
  const r=s.simulate({maxTime:400})
  rows.push({skips:r.skips, dist:r.runDistance, outcome:r.outcome})
}
rows.sort((a,b)=>a.skips-b.skips)
console.log(`N=${N} near-identical Steiner throws, game profile:`)
console.log('  skips:', rows.map(r=>r.skips).join(' '))
console.log('  min', rows[0].skips, ' p10', rows[Math.floor(N*0.1)].skips, ' median', rows[N>>1].skips, ' p90', rows[Math.floor(N*0.9)].skips, ' max', rows[N-1].skips)
console.log('  fraction <15 skips:', (rows.filter(r=>r.skips<15).length/N*100).toFixed(0)+'%')
