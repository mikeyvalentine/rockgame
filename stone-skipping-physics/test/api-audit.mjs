/**
 * API robustness audit. Run:  node test/api-audit.mjs
 *
 * headless-sweep.mjs checks the PHYSICS. This checks the INTERFACE — the failure
 * modes that show up once a player aiming system is feeding the throw and a scoring
 * system is reading the results:
 *
 *   A  hostile/garbage throw inputs        (a NaN from an unready UI element)
 *   B  score-field invariants              (skips/rings/hops must stay consistent)
 *   C  runs cut off by a time limit        (must still report distance)
 *   D  re-throwing mid-flight              (player spams the button)
 *   E  hostile water callback              (water sim still loading)
 *   F  advance() edge cases
 *   G  maxSubsteps saturation
 *   H  un-thrown sim, and the replay flag  (leaderboard integrity)
 *
 * Exits non-zero if any probe reports BAD/VIOLATION/THREW unexpectedly.
 */
import { StoneSkipSim, THROW_PRESETS } from '../src/stoneSkipping.js'
let problems = 0
const P = (l,v)=>{
  if (/^(BAD|VIOLATION)|THREW/.test(String(v).trim()) && !/^ok/.test(String(v).trim())) problems++
  console.log(`  ${l.padEnd(46)} ${v}`)
}
/** Probes where an exception is the CORRECT behaviour. */
const expectThrow = (l,v)=>{
  const threw = String(v).startsWith('THREW')
  if (!threw) problems++
  console.log(`  ${l.padEnd(46)} ${threw ? 'ok (rejected) ' : 'BAD accepted: '}${v}`)
}
const fin = v => Number.isFinite(v) ? v.toFixed(2) : `**${v}**`

console.log('\n=== A. Garbage / hostile throw inputs (player aiming system) ===')
const bad = {
  'NaN speed':        {speed:NaN},
  'undefined speed':  {speed:undefined},
  'null attack':      {attackAngleDeg:null},
  'string speed':     {speed:'14'},
  'negative speed':   {speed:-14},
  'zero speed':       {speed:0},
  'huge speed':       {speed:1e6},
  'huge spin':        {spinRPS:1e9},
  'NaN spin':         {spinRPS:NaN},
  'attack 1e5 deg':   {attackAngleDeg:1e5},
  'negative height':  {releaseHeight:-5},
  'NaN origin':       {origin:{x:NaN,z:0}},
  'Infinity elev':    {elevationDeg:Infinity},
}
const MUST_REJECT = new Set(['NaN speed','undefined speed','null attack','NaN spin','NaN origin','Infinity elev'])
for (const [l,p] of Object.entries(bad)) {
  let out
  try {
    const s=new StoneSkipSim(); s.throwStone({...THROW_PRESETS.strong, ...p})
    const r=s.simulate({maxTime:20})
    const ok = Number.isFinite(r.runDistance) && Number.isFinite(s.state.position.x) && Number.isInteger(r.skips)
    out = `${ok?'ok  ':'BAD '} skips=${r.skips} dist=${fin(r.runDistance)} x=${fin(s.state.position.x)} ${r.outcome}`
  } catch(e) { out = `THREW: ${e.message.slice(0,50)}` }
  if (MUST_REJECT.has(l)) expectThrow(l, out); else P(l, out)
}

console.log('\n=== B. Score-field invariants (must always hold) ===')
let viol=0
for (const prof of ['documentary','game','arcade'])
for (const [n,p] of Object.entries(THROW_PRESETS)) {
  const s=new StoneSkipSim({profile:prof}); s.throwStone(p)
  const r=s.simulate({maxTime:300})
  const checks = {
    'skips == ripples-1 (or 0)': r.skips === Math.max(0, r.ripples-1),
    'cleanHops <= ripples':      r.cleanHops <= r.ripples,
    'skips >= 0':                r.skips >= 0,
    'runDistance finite & >=0':  Number.isFinite(r.runDistance) && r.runDistance >= 0,
    'runDistance <= distance':   r.runDistance <= r.distance + 1e-9,
    'runTime <= time':           r.runTime <= r.time + 1e-9,
  }
  for (const [c,ok] of Object.entries(checks)) if(!ok){ viol++; P(`VIOLATION ${prof}/${n}`, c+` (skips=${r.skips} rings=${r.ripples} hops=${r.cleanHops} rd=${fin(r.runDistance)} d=${fin(r.distance)} rt=${fin(r.runTime)} t=${fin(r.time)})`) }
}
P('invariant violations', viol===0 ? 'none' : `${viol} FOUND`)

console.log('\n=== C. Run that never ends (maxTime hit) ===')
{
  const s=new StoneSkipSim(); s.throwStone({...THROW_PRESETS.strong, elevationDeg:60, speed:25})
  const r=s.simulate({maxTime:2})
  P('thrown steeply upward, cut off at 2s', `finished=${s.finished} runEnded=${s.runEnded} skips=${r.skips} runDistance=${fin(r.runDistance)} runTime=${fin(r.runTime)}`)
}

console.log('\n=== D. Re-throw mid-flight (player spams the button) ===')
{
  const s=new StoneSkipSim(); s.throwStone(THROW_PRESETS.strong)
  for(let i=0;i<400;i++) s.step(1/240)
  const midSkips=s.skips
  s.throwStone(THROW_PRESETS.strong)
  const clean = s.skips===0 && s.ripples===0 && s.cleanHops===0 && !s.runEnded && !s.finished &&
                s.contacts.length===0 && s.state.time===0 && s.runDistance===0
  P('state fully reset on re-throw', clean?`ok (was ${midSkips} skips)`:'BAD — stale state leaks')
  const r=s.simulate({maxTime:300})
  const fresh=new StoneSkipSim(); fresh.throwStone(THROW_PRESETS.strong)
  const r2=fresh.simulate({maxTime:300})
  P('re-thrown sim matches a fresh one', (r.skips===r2.skips && Math.abs(r.runDistance-r2.runDistance)<1e-9)?'ok':`BAD ${r.skips}/${fin(r.runDistance)} vs ${r2.skips}/${fin(r2.runDistance)}`)
}

console.log('\n=== E. Hostile water callback ===')
const waters = {
  'returns NaN height': ()=>({height:NaN, normal:{x:0,y:1,z:0}, flow:{x:0,y:0,z:0}}),
  'missing normal':     ()=>({height:0}),
  'missing flow':       ()=>({height:0, normal:{x:0,y:1,z:0}}),
  'returns undefined':  ()=>undefined,
  'zero normal':        ()=>({height:0, normal:{x:0,y:0,z:0}, flow:{x:0,y:0,z:0}}),
  'huge height':        ()=>({height:1e9, normal:{x:0,y:1,z:0}, flow:{x:0,y:0,z:0}}),
}
for (const [l,w] of Object.entries(waters)) {
  try {
    const s=new StoneSkipSim({water:w}); s.throwStone(THROW_PRESETS.strong)
    const r=s.simulate({maxTime:10})
    P(l, `${Number.isFinite(r.runDistance)?'ok  ':'BAD '} skips=${r.skips} dist=${fin(r.runDistance)} ${r.outcome}`)
  } catch(e){ P(l, `THREW: ${e.message.slice(0,60)}`) }
}

console.log('\n=== F. advance() edge cases ===')
{
  const s=new StoneSkipSim(); s.throwStone(THROW_PRESETS.strong)
  P('advance(0)',        JSON.stringify(s.advance(0)))
  P('advance(-1)',       JSON.stringify(s.advance(-1)))
  P('advance(NaN)',      JSON.stringify(s.advance(NaN)))
  const t0=s.state.time; s.advance(30)   // tab backgrounded 30s
  P('advance(30) big catch-up', `advanced ${(s.state.time-t0).toFixed(2)}s of sim (clamped)`)
  const s2=new StoneSkipSim(); s2.throwStone(THROW_PRESETS.strong)
  let n=0; while(!s2.finished && n++<100000) s2.advance(1/60)
  P('runs to completion via advance()', `${s2.skips} skips, finished=${s2.finished}`)
  P('advance() after finished', JSON.stringify(s2.advance(1/60)))
}

console.log('\n=== G. maxSubsteps saturation (slow machine / big dt) ===')
{
  const s=new StoneSkipSim(); s.throwStone(THROW_PRESETS.strong)
  const t0=s.state.time; s.step(1.0)
  P('step(1.0s) actually advanced', `${(s.state.time-t0).toFixed(4)}s of the 1.0s asked for`)
}

console.log('\n=== H. Un-thrown sim, and leaderboard replay flag ===')
{
  const s=new StoneSkipSim()
  try { s.step(1/240); P('step() before throwStone()', 'ok, no crash') }
  catch(e){ P('step() before throwStone()', 'THREW: '+e.message.slice(0,50)) }
  try { const d=s.getDiagnostics(); P('getDiagnostics() before throw', Number.isFinite(d.speed)?'ok':'BAD') }
  catch(e){ P('getDiagnostics() before throw', 'THREW: '+e.message.slice(0,50)) }

  const a=new StoneSkipSim(); a.throwStone(THROW_PRESETS.strong)
  let n=0; while(!a.finished && n++<100000) a.advance(1/60)
  P('normal run replayable', `${a.replayable} (dropped ${a.droppedTime.toFixed(2)}s)`)

  const b=new StoneSkipSim(); b.throwStone(THROW_PRESETS.strong)
  b.advance(1/60); b.advance(45); while(!b.finished) b.advance(1/60)
  P('alt-tabbed run replayable', `${b.replayable} (dropped ${b.droppedTime.toFixed(2)}s)`)
  P('  -> scores differ?', `${a.skips} vs ${b.skips} skips, checksums ${a.checksum()===b.checksum()?'match':'DIFFER'}`)
}



console.log(problems === 0
  ? '\nAPI AUDIT CLEAN\n'
  : `\n${problems} API PROBLEM(S)\n`)
process.exit(problems === 0 ? 0 : 1)
