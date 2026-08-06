# Stone Skipping Physics

A 6-DOF rigid-body stone-skipping solver in plain JavaScript, built from the primary
literature. Physics only — no renderer, no water simulation, no game loop.

```
docs/PHYSICS-NOTES.md    the research digest: equations, coefficients, sources
src/stoneSkipping.js     the solver. engine-agnostic ES module, zero imports
src/babylonAdapter.js    thin Babylon.js bridge (the only file that knows BABYLON)
test/headless-sweep.mjs  validation against the published numbers
test/debug-contact.mjs   per-substep trace of a single contact
```

```bash
node test/headless-sweep.mjs
```

## What it does

Throw a stone with every real-world parameter — speed, launch elevation, attack angle,
bank, sideslip, spin rate, spin-axis tilt, release height, plus stone mass / radius /
thickness / aspect / edge roundness / centre-of-mass offset, plus gravity, water and
air density, and wind. Step it with `dt`. Read out position and an orientation
quaternion.

The water surface is an **injected callback**, so your water sim plugs straight in:

```js
const sim = new StoneSkipSim({
  stone: { radius: 0.045, thickness: 0.010, density: 2700 },
  water: (x, z, t) => myWaterSim.sample(x, z, t),   // -> { height, normal, flow }
})
sim.throwStone(THROW_PRESETS.perfect)

// each frame — keep stepping until `finished`, not until `runEnded`
for (const e of sim.step(dt)) {
  if (e.type === 'impact')  spawnSplash(e.position)
  if (e.type === 'bounce')  score(e.count)
  if (e.type === 'outcome') showScore(e.outcome, e.skips, e.distance)  // run over
  if (e.type === 'settled') cleanUp()                                  // physics over
}
mesh.position.copyFrom(sim.state.position)
mesh.rotationQuaternion.copyFrom(sim.state.orientation)
```

It defaults to a flat plane at `y = 0`, so it runs standalone today.

### Two endings, not one

The scoring run and the simulation end at different times, and conflating them makes
the stone appear to die in mid-air the instant it stops skipping.

| Flag | Meaning | Event |
|---|---|---|
| `sim.runEnded` | Stone stopped skipping. Score is locked: `skips`, `cleanHops`, `runDistance`, `outcome` all freeze here. | `outcome` |
| `sim.finished` | Physics complete — sunk past `settleDepth`, or at rest. **Stop calling `step()` here, not before.** | `settled` |

Between the two the stone is still a physical object: it coasts on whatever momentum
is left, skims, decelerates and sinks. A run that ends at 7.7 m/s carries another 4.6 m
over 2.5 s before going under. `distance` keeps counting through that; `runDistance` is
the scoring number.

## How it works

Not a per-bounce impulse model. The stone's surface is discretised into panels — two
equal-area polar grids for the faces plus a rim ring — and the water force is
integrated over the wetted ones each substep:

```
dF = -( ½ρ[C_D (u·n)² + C_P |u_t|(u·n)]·w_spray  +  ρ g depth ) · vent · n dA
     - ½ρ C_f |u_t| u_t dA
dΓ = (r - com) × dF
```

Torque about the centre of mass comes from the same integral, with a full inertia
tensor and world-frame angular momentum. That means **gyroscopic stabilisation,
precession, wobble, tumbling, edge catches and the sideways curve are emergent**, not
scripted. Summing the hydrostatic term over the closed wetted surface recovers
Archimedes exactly, so buoyancy is the same integral and takes over as the stone slows.

Three details matter more than they look:

- **Ventilation.** Air-facing panels get no pressure while the cavity behind the stone
  is open. Wet the top face and the lift cancels — nothing skips.
- **Spray-root loading.** Planing pressure peaks at the just-wetted forward edge, not
  uniformly. Without this the load sits at the trailing rim, the pitching lever is 2–3×
  too long, and no throw survives two bounces.
- **Rotational damping in water**, applied outside `pitchMomentScale` so the
  calibration cannot weaken it. Without it a drowned stone keeps a 30 rad/s wobble
  forever and snaps around in the water instead of settling.
- **The two source papers use different force laws.** See below.

### The force-law reconciliation

Bocquet (AJP 2003) uses `F = ½ C_l ρ V² S_im` with `C_l ≈ 1` — the **full** speed.
Nagahiro & Hayakawa (PRL 2005) use `f = ½ C_D ρ (v·n)² S` with `C_D = 1.4` — the
**normal** component only. At a 20° attack angle these differ by roughly 4×.

They are both right in their own regime. Newtonian `(v·n)²` is correct for a steep slam
and badly under-predicts a shallow planing surface, where lift is closer to linear in
α because of circulation and unsteady added mass. Using Nagahiro's law alone makes the
stone penetrate about twice as deep as Bocquet's own closed form predicts, which
lengthens contact, lengthens the torque lever, drops vertical restitution to ~0.45 and
caps every throw at 2–3 skips.

The solver uses the sum:

```
p = ½ρ [ C_D (u·n)²  +  C_P |u_t| (u·n) ]
```

The cross term is linear in sin α and vanishes as the flow becomes purely normal, so it
reduces to Nagahiro at steep impact and matches Bocquet's `C_l ≈ 1` at the canonical 20°
planing condition when `C_P = 1.5`. That is where the default comes from.

## Validation

`node test/headless-sweep.mjs` — 40 checks, all passing (both profiles). Measured against the papers:

| Quantity | Literature | Model |
|---|---|---|
| Contact time | 10–40 ms, saturating ~30 ms (JFM 543) | 12 ms mean, 3–27 ms typical |
| Penetration, 20° canonical throw | ~8 mm (Bocquet closed form) | 6.7 mm |
| Energy loss per bounce, 20° | — | 9–19% |
| Best attack angle | 20° (Nature 427, PRL 94) | 20° |
| Loss vs attack angle | monotone rise | 9% at 5° → 77% at 70° |
| Nose-down attack | never rebounds | never rebounds |
| Speed floor | ~2.6 m/s (JFM 543) | no clean hop below 2.6 m/s |
| Zero spin | tumbles and dives (JFM 543) | tumbles, never leaves water |
| Stability floor | `φ̇ ≫ √(g/R)` ≈ 2.3 rev/s | 2.35 rev/s |
| Lateral drift | direction set by spin sign (Acta Mech. Sin. 37) | flips with spin sign |
| Regimes | dive / trout / skip taxonomy | all five reproduced |
| Submerged settling | wobble and spin must die | 27→4 rad/s in 0.25 s; spin 23→2.5 rev/s in 2 s |
| Coast after the run | keeps its momentum, then sinks | ends at 7.7 m/s → +4.6 m over 2.5 s → sinks |
| **Energy of a 93 mph / 2900 rpm throw** | **"close to 164 J" (Splash Lab)** | **156.5 J — within 5%** |
| Roll-over in flight | grows with time in the air (Steiner) | 0.1° after 0.5 m → 1.3° after 9 m, monotone |
| **Distance record, human inputs** | **121.8 m (Dougie Isaacs)** | **52 m — 43%, see limitations** |
| **Steiner's record throw** | **88 skips** | **12–21 skips, see limitations** |

The energy figure is the tightest external check here: it was never used to build the
model, and agreeing to 5% independently validates the stone's mass and spin inertia.

## Feeding a water sim

`sim.getDisturbance()` publishes what the surface is doing, every frame:

```js
const d = sim.getDisturbance()
// { x, z, crestHeight, displacedVolume, radius, contact, speed, impulse }
water.disturb(d.x, d.z, d.crestHeight, d.radius)
```

The stone model owns this. It computes its own bow wave, uses it for lift, and never
reads anything back — so the two never fight, stone physics stays authoritative, and
your surface is free to look however you like without changing the trajectory.

`crestHeight` is the bow wave the stone is currently riding (millimetres to ~2 cm);
`displacedVolume` is the water pushed aside; `impulse` on each `bounce` event is the
vertical momentum delivered, which is the natural driver for ripple amplitude.

### Why the assist targets angular momentum

A stone's attitude has two separable motions, and an assist must only touch one:

- **Nutation** — the symmetry axis coning around the angular-momentum vector `L`.
  This is the visible wobble. It is real physics and must be preserved.
- **Secular drift** — `L` itself precessing under hydrodynamic torque. This is what
  walks a run into a nose-down death and what the assist exists to stop.

Targeting the instantaneous face normal conflates them: it fights the cone on every
substep and flattens the wobble to nothing, which made `game` look lifeless next to
`documentary`. Targeting `L` and rotating orientation, ω and `L` by the *same*
rotation re-aims the whole coning motion rigidly, so the cone angle is preserved
exactly.

The practical result is that strength and wobble became independent — measured tilt
swing on the `wobbler` preset holds at ~64° across `attitudeAssist` from 6 to 50, while
skips scale from 3 to 51. That is why the knob can now sit at 20 (game) and 32 (arcade)
where it previously had to stay near 6.

## Profiles: physics vs game

The solver ships two game tunings. **`documentary` is the default** and is the validated
physics — nothing in the assist section changes it.

```js
new StoneSkipSim({ profile: 'game' })       // the tuned skill ladder
new StoneSkipSim()                          // pure physics, ~10 clean hops
```

Median **clean hops** (the daylight-counted score — see *How a skip is counted*) and run
distance over 15 jittered throws per cell:

| Preset | documentary | game | arcade |
|---|---|---|---|
| `casual` (11 m/s, 12 rev/s) | 4 hops, 9 m | 6 hops, 8 m | 6 hops, 8 m |
| `decent` (14, 28) | 7 hops, 20 m | 16 hops, 19 m | 16 hops, 19 m |
| `strong` (18, 45) | 9 hops, 30 m | 59 hops, 54 m | 63 hops, 57 m |
| `steinerThrow` (19.2, 47) | 10 hops, 34 m | 58 hops, 58 m | 52 hops, 59 m |
| `truscottLimit` (41.6, 48) | 12 hops, 78 m | 55 hops, 96 m | 61 hops, 95 m |

`arcade` differs from `game` in `contactLossScale` alone — the run-length knob — so it is
the same skill ladder stretched, not a different game.

### The game profile is tuned against a skill ladder, not a preset

`npm run test:ladder` scores six skill tiers as **ensembles of jittered throws**, because
skip count is chaotic and a single release measures the jitter rather than the player.
Each tier is a centre throw plus the execution error a player at that level still carries,
on the axes the throw UI actually exposes. It asserts a regression band around today's
numbers and reports the gap to the design ladder separately. Full results and the two
measured reasons the top rungs are not yet reached are in `docs/04-physics.md`.

The four knobs it is tuned on, in order of how much they move the score:

| Knob | What it sets |
|---|---|
| `env.contactLossScale` | run length. Fraction of the water's per-contact speed loss the stone keeps paying, graded by how cleanly the contact was flown (`_contactQuality`) |
| `env.hopSpeedTarget` | hop shape. Pins rebound speed from *both* sides, so hop time is constant and hop length shrinks with speed — the shape of a real record run |
| `env.hopFlattenLimit` | how much of a natural rebound one bounce may flatten. Guards the attitude instability that made champion-speed throws bimodal |
| `env.attitudeAssist` + `attitudeAssistRefSpeed` | attitude hold, per *contact* rather than per second — contacts shorten with speed, so an unscaled rate under-corrects exactly when the disturbance is largest |

### What the pure physics will NOT do: reach the record

The real record is 88 skips (Steiner, 2013). A 288-throw sweep of the parameter space
tops out at **~33 taps / 10–13 clean hops / 35–54 m**, and essentially every high-end
run ends in `tumble`. Do not expect record numbers out of this.

Measured, so you don't have to re-derive it:

- **It is not the precession torque.** Dropping `pitchMomentScale` 40× (0.2 → 0.005)
  changes clean hops by zero. The attack angle still collapses at contact ~6.
- **It is not energy.** Loss is 6–9% per bounce early on; 88 bounces at that rate is
  arithmetically fine.
- **It is vertical restitution plus attitude collapse.** e ≈ 0.84 means hop height
  decays ×0.70 per bounce, capping clean hops near 13 even with a perfect attitude —
  and in practice the attitude walks into a nose-down bite around hop 6–10 first.
- **Spin above ~65 rev/s makes things worse**, not better, which is unphysical and is
  a straightforward model artifact.

Closing this would need a better treatment of attitude dynamics during the
surface-attached "sizzle" phase, which is where the real record counts come from.

## World sizing: how far can a throw actually go

Measured by random search, 1500 throws per profile. `lateral` is drift perpendicular to
the aim line, which is what the spin curve produces — size the water for it or a good
throw will sail off the side.

**Within the demo's slider ranges** (speed 1–25 m/s, spin ±70 rev/s):

| Profile | Run distance | Total incl. sink | Lateral drift | Flight time |
|---|---|---|---|---|
| `documentary` | 46 m | 50 m | ±10 m | 5 s |
| `game` | 64 m | 74 m | ±20 m | 8 s |
| `arcade` | 113 m | 121 m | ±49 m | 12 s |

**Absolute worst case `THROW_BOUNDS` permits** (speed to 60 m/s, spin to 200 rev/s):

| Profile | Run distance | Total | Lateral | Time |
|---|---|---|---|---|
| `documentary` | 163 m | 164 m | ±39 m | 8 s |
| `game` | 178 m | 186 m | ±56 m | 11 s |
| `arcade` | 230 m | 237 m | ±82 m | 15 s |

**Conservative recommendation:** build the water for **250 m forward × ±100 m lateral**
and nothing can leave it, on any profile, at any input the API accepts. If you cap
player speed at 25 m/s and stay on `game`, **100 m × ±30 m** is comfortable. Budget
~15 s of flight for the longest possible run.

Note the lateral figure is not a rounding detail: on `arcade` a hard-spun throw curves
up to 49 m off the aim line within normal slider ranges.

## Integrating a throw system and a scoreboard

Read this before wiring player input to `throwStone()` or a score to the outputs.
`node test/api-audit.mjs` exercises all of it.

`THROW_BOUNDS` is exported — use it to drive slider ranges so the UI cannot generate an
input the solver will not accept.

**Throw inputs are validated.** Non-finite values (`NaN`, `Infinity`, `null`,
`undefined`) throw a `TypeError` naming the field; finite but out-of-range values are
clamped to `THROW_BOUNDS`. This is deliberate: an unvalidated `NaN` from an unready UI
element propagates into position and orientation within one substep and the run
returns 0 skips / 0 m with no error and no clue where it came from. Fail loudly on a
programming bug, clamp a legitimate extreme.

**Which field to score on.**

| Field | Use for |
|---|---|
| `sim.skips` | the score. Competition count, `ripples - 1` |
| `sim.runDistance` | distance while the run was live; smooth, good second axis |
| `sim.cleanHops` | never the score — not a rulebook concept |
| `sim.distance` | includes the coast/sink; use for camera, not points |

`runDistance` and `runTime` are getters that track live and freeze when the run ends,
so a run cut short by a time limit still reports what it achieved rather than 0.

**Guarantees the audit pins down**, so a scoreboard can rely on them:
`skips === max(0, ripples - 1)`, `cleanHops <= ripples`, `runDistance <= distance`,
`runTime <= time`, all finite and non-negative, across every profile and preset.

**Re-throwing mid-flight is safe** — `throwStone()` fully resets state, and a re-thrown
sim is bit-identical to a fresh one.

**The water callback is guarded.** Returning `undefined` (sim still loading), a missing
`normal`/`flow`, a zero normal or a non-finite height all fall back sensibly instead of
throwing from inside the panel loop; `sim.lastWaterError` records the first problem.

## Leaderboards: use advance(), not step()

Physics is not exactly dt-invariant, so feeding raw frame deltas makes the score
depend on the player's hardware. Measured, same throw:

```
raw step()   240 Hz -> 31 skips, 64.53 m      advance()  240 Hz -> 31, 64.5323 m
             144 Hz -> 30 skips, 62.65 m                 144 Hz -> 31, 64.5323 m
              60 Hz -> 30 skips, 62.77 m                  60 Hz -> 31, 64.5323 m
              30 Hz -> 31 skips, 64.49 m                  30 Hz -> 31, 64.5323 m
           stutter  -> 29-31 skips                     stutter  -> 31, 64.5323 m
```

`sim.advance(realDt)` accumulates real time and only advances in whole
`solver.fixedTick` increments (default 1/240 s), so the tick sequence is identical
everywhere. `sim.alpha` holds the leftover fraction for render interpolation.
`sim.checksum()` gives an order-sensitive hash of the run for validating submissions.

**Check `sim.replayable` before submitting a score.** `advance()` clamps large
catch-ups (a backgrounded tab can hand back 45 s at once), and dropped time makes the
run diverge from a server re-simulation — an alt-tab would otherwise read as cheating.
Any dropped time sets `replayable = false` and accumulates `sim.droppedTime`.

**Caveat you must design around:** `Math.sin/cos/atan2/pow` are not guaranteed
bit-identical across JavaScript engines or CPU architectures. Identical results are
verified within one Node build, not across a browser fleet. For a trusted leaderboard,
submit the *throw parameters* and re-simulate server-side on one fixed engine version,
comparing `checksum()` — do not trust a client-reported score.

### How a skip is counted

Counting follows the competition rule, not a convenient proxy. Guinness defines one
skip as a forward movement over the water "which sets off a visible series of
concentric circles, minus either the first or the last of the circles".

Two things follow, and both are implemented:

- **It is a ripple test, not an airborne test.** Any contact that disturbs the surface
  counts, including the terminal pitty-pats — a run is explicitly "composed of
  pitty-pats and plinkers". The death rattle scores.
- **It is rings minus one.** The final plunk does not count.

There is a second rulebook, and it disagrees. The **Mackinac Island** rule — the one
Rock Game scores on (`docs/05-scoring.md`) — counts only hops with *clear daylight
between the splashes*, and stops counting entirely once a stone begins to patter. Both
are implemented, side by side, because they are genuinely different sports:

| Field | Rule | Meaning |
|---|---|---|
| `sim.ripples` | — | raw count of contacts that raised a visible ring |
| `sim.skips` | Guinness | `ripples - 1`. Ripple test; the tail scores |
| `sim.cleanHops` | Mackinac | hops clearing `solver.minHopClearance` of daylight. **The game's score.** Also the metric that converges under substep refinement |

The daylight threshold is **5 mm of apex clearance**, calibrated against the record
rather than by eye: 88 skips over 76 m is a 0.86 m mean hop, ~45 ms aloft, an apex of
about 2.5 mm. Record hops are millimetres, so a centimetre-scale threshold would exclude
the runs it exists to measure. Apex comes from vertical speed at liftoff (`vy²/2g`),
where the stone is exactly at the surface by definition.

`solver.patterLimit` (3) is the other half of the same rule: three consecutive contacts
without daylight and the scoring run ends. Without it a champion throw's score was ~80%
terminal chatter, and since every skill tier grew the same tail, the score was mostly
measuring it.

`solver.minBounceSpeed` is the visible-ripple threshold. Every `bounce` event carries
`impulse` (kg·m/s of vertical momentum delivered) and `energyToWater` (J) so a water
sim can scale its ripple from the same number the counter uses — keeping what the
player sees and what the scoreboard says in agreement. Across one run those fall from
264 mN·s on the first strike to 18 mN·s on the last tap, roughly a 14x range in
splash size.

### Which numbers are trustworthy

Substep refinement on the same throw (§9b of the test suite):

| Contact substep | Taps | Clean hops | Run distance |
|---|---|---|---|
| 1/2000 | 17 | 9 | 39.9 m |
| 1/4000 | 23 | 10 | 36.0 m |
| 1/10000 | 13 | 9 | 37.8 m |
| 1/25000 | 13 | 7 | 36.5 m |

`cleanHops` and `runDistance` converge. **The total tap count does not** — the sizzle
is a chaotic, marginally-resolved regime, and refining the timestep moves the count by
3× without settling. Treat `sim.skips` as flavour, never as a score.

(The contact substep is adaptive — capped by distance travelled per step, not
wall-clock, via `solver.maxTravelPerStepRadii`. With a fixed time substep a 26 m/s
throw moved 6.5 mm per step through a contact only millimetres deep, and neither clean
hops nor distance converged at all.)

Ensemble medians over 25 jittered throws (±2° attack, ±1° elevation, ±0.5 m/s):

| Spin | Median clean hops | Median taps | Median run distance |
|---|---|---|---|
| 10 rev/s | 2 | 4 | 9.5 m |
| 18 rev/s | 2 | 5 | 11.6 m |
| 28 rev/s | 3 | 6 | 13.5 m |
| 45 rev/s | 5 | 9 | 16.5 m |
| 65 rev/s | 7 | 23 | 16.0 m |

The failure modes in `docs/PHYSICS-NOTES.md` §7 all appear without being scripted:
knife-in, tumble, edge catch, belly flop, surf, and the terminal pitty-pat.

## Known limitations

Read these before tuning.

0. **`documentary` is literature-faithful per bounce, but its runs are still ~4x too
   short.** Steiner's real 19.2 m/s / 47 rev/s throw gives 12–21 skips against a true
   88, and the best distance at human inputs is 52 m against the 121.8 m record (43%).
   It is no longer labelled "real physics" in the UI, because it isn't — it is right
   about *how each bounce works* and wrong about *how long a run lasts*.

   The diagnosis is specific, and it is NOT energy. Per-bounce loss is 4.6%, against
   the 4.44% that 88 real skips mathematically imply (19.2 m/s decaying to the 2.6 m/s
   floor over 88 bounces). Bocquet's closed form is the optimistic outlier at 0.49%,
   predicting 203. Our runs end with **11 m/s still on the stone** — four times the
   rebound floor — at an attack angle of 0.6° and 24° of bank. **They die of attitude,
   not energy.** The bow-wave term (§ How it works) roughly doubled the count by
   raising vertical restitution; closing the rest needs the attitude walk itself
   solved, not a smaller `pitchMomentScale`. See "What the model will NOT do" above for the four things I measured and
   ruled out. This is the largest known gap.

1. **Total skip count is chaotic AND not numerically converged — score on clean hops
   or distance instead.** Per-bounce physics is
   smooth and monotone, but the *number* of skips is not a smooth function of the
   throw. The same throw ±2° of attack angle gives anywhere from 5 to 19 skips. This
   is largely genuine: the attitude walks around by gyroscopic precession, and the run
   ends whenever it happens to land in a bad part of that cycle.

   **If you are scoring on skips, this is a design choice, not a defect.** A big run
   genuinely feels like luck because it partly is: the attitude walks by precession and
   a great result depends on where in that cycle the stone happens to land. What
   matters for fairness is that the luck is *reproducible* — same throw, same result —
   which `advance()` guarantees. Distance remains the smooth, predictable metric if you
   want a second scoring axis that rewards consistency rather than fortune.

2. **`env.pitchMomentScale` is a calibration, not physics.** Default `0.05`, and it
   fades out below `gyroCalibrationSpin` (12 rev/s) so unspun stones feel the raw
   torque and tumble honestly. The raw
   panel integral puts the centre of pressure ~0.2R behind the CoM, which planing
   theory agrees with, but taken literally it predicts sustained skipping only above
   ~55 rev/s whereas the measured gyro transition is ~18 rot/s. The gap lives in
   effects this quadrature does not resolve — the sub-atmospheric ventilated cavity
   pulling on the trailing edge, the spray-root singularity, unsteady added-mass
   moments. Rather than bury a fudge in the force law it is one named factor. Set it to
   `1.0` for the raw integral (expect 2–4 skips on a good throw). The value was picked
   because it gives the cleanest monotone ordering of ensemble-median skips against
   spin. Note it scales the *steady* transverse torque only — wobble damping is a
   separate term precisely so this knob cannot switch the damping off.

3. **The steep-angle cutoff is soft.** JFM 543 reports no rebound above 45° at any spin;
   the model gives a rebound that costs 45% of the energy at 45° and 77% at 70°, rather
   than a hard wall. Their measurement was at 3.5–5 m/s aluminium disks; at 14 m/s a
   single violent hop off a steep stone is plausible. The trend is right, the cliff
   is not.

4. **Added mass is a scalar along the face normal**, not a full tensor, and the
   momentum in the entrained water is not returned on exit. Tested as a small effect
   here (restitution moved <0.01 across `Ca` from 0 to 4/3) but it is an approximation.

5. **No spray, no cavity dynamics, no free-surface deformation.** The water is a
   height field sampled by the callback; the stone does not disturb it. Nagahiro's
   assumption 4. If your water sim wants a reaction force, you will need to add it.

6. **`sideslip` is meaningless for a circular stone** — a disk has no preferred in-plane
   heading. It only does something when `stone.aspect !== 1`.

## Tuning quick reference

| Want | Change |
|---|---|
| Longer runs / more skips | lower `env.contactLossScale` — the run-length knob |
| Flatter, more numerous hops | lower `env.hopSpeedTarget` |
| Champion throws blowing up on attitude | raise `env.hopFlattenLimit`, lower `env.attitudeAssistRefSpeed` |
| A stricter / looser "skip" | `solver.minHopClearance`, `solver.patterLimit` |
| More skips overall (physics side) | lower `env.pitchMomentScale` (0.2 → 0.1) |
| Stone settles too slowly / jitters | raise `env.wobbleDampingCoefficient`, `env.spinDampingCoefficient` |
| Longer / shorter sink animation | `solver.settleDepth`, `solver.settleTimeout` |
| Skip the sink entirely | stop stepping on `sim.runEnded` instead of `sim.finished` |
| Stone planes when it should drown | raise `env.cavityCloseSpeedFactor` |
| Bouncier, more arcade | raise `env.planingCoefficient` |
| Harder to keep stable | raise `env.pitchMomentScale` toward 1.0 |
| More visible curve | raise `spinRPS`, or add `bankAngleDeg` at release |
| More wobble / unpredictability | `spinAxisTiltDeg`, `stone.comOffset` |
| Stones that catch edges | `stone.edgeRoundness` → 0 |
| Cheaper CPU | lower `solver.radialSamples` / `angularSamples`, raise `contactSubstep` |

There is also a browser viewer: `demo/index.html`. Serve the project root — ES modules
need HTTP, not `file://`:

```bash
cd ~/Documents/stone-skipping-physics; npm run serve
```

Use that rather than `python -m http.server`. Browsers cache ES modules hard, and with
no cache headers an edit to `src/stoneSkipping.js` keeps running the old module on
reload — which surfaces as errors like `sim.checksum is not a function` against source
that plainly has the method. `tools/dev-server.mjs` sends `no-store` on everything.

Cost is ~132 panels × ~4000 substeps/s while wet. Sub-millisecond per frame for one
stone; profile before throwing a hundred.

## Sources

Full citations with links in [docs/PHYSICS-NOTES.md](docs/PHYSICS-NOTES.md). The load-bearing four:

- Bocquet, *The physics of stone skipping*, Am. J. Phys. **71**, 150 (2003)
- Clanet, Hersen & Bocquet, *Secrets of successful stone-skipping*, Nature **427**, 29 (2004)
- Rosellini, Hersen, Clanet & Bocquet, *Skipping stones*, J. Fluid Mech. **543**, 137 (2005)
- Nagahiro & Hayakawa, *…"magic angle" of stone skipping*, Phys. Rev. Lett. **94**, 174501 (2005)
