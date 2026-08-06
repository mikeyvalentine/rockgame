# 04 · Skipping Physics

**Status:** WIP. Sim parameters below are filled from the engine. The skill ladder is
tuned and measured; the top two rungs are not yet reached — see **Skill ladder**.

## Principle

**Real physics, punishing and realistic.** The only permitted tuning is letting players go slightly above and beyond what's possible in real life.

Everything else stays honest. The rock's actual size, roughness and shape drive the result — that's what makes the sifting minigame meaningful.

**Scope of the exception:** tuning applies to the *outcome ceiling* and to *input difficulty* (see `02-gathering.md`). It does not apply to how the rock behaves in flight.

## Anchor values

Full reference in `docs/physics-reference.md`.

- Optimal attack angle **~20°**
- **No rebound possible above ~45°**
- Spin stabilises attitude gyroscopically — lab throws run tens of rotations/sec
- Lift comes from planing, not surface tension
- Skip record **88** (Kurt Steiner, 2013); distance record 121.8m

## Determinism — two levels

Determinism means identical inputs produce identical outputs. This is a **separate property from the sim being physically correct** — a sim can be accurate and still non-deterministic.

### Level 1 — fixed timestep + seeded RNG — REQUIRED FOR MVP

- **Fixed timestep**, decoupled from render framerate
- **No `Math.random()` anywhere in the sim** — all randomness seeded, including the attack-angle drift
- Stable iteration order

**Why this matters even without anti-cheat:** if the sim steps by frame delta, a 144fps machine and a 30fps machine produce different trajectories from the same throw. The daily challenge promises everyone identical conditions — that promise is empty if physics varies with hardware. Not cheating; the leaderboard silently comparing different games.

Cheap now, painful to retrofit.

### Level 2 — bit-exact cross-platform determinism — DEFERRED

Needed only for server-side replay validation and lockstep multiplayer.

Hard, because:
- `Math.sin` / `cos` / `pow` are not specified to bit precision and vary across JS engines and platforms
- GPU compute results vary by driver and hardware
- Requires avoiding transcendentals or shipping own implementations

**Not required for the MVP.** Revisit when there's a player base worth cheating against, or when rooms are built.

## Sim parameters

Read from `stone-skipping-physics/src/stoneSkipping.js` (`DEFAULT_STONE`, `DEFAULT_ENV`,
`DEFAULT_SOLVER`). SI throughout; degrees only at the throw API boundary.

### Stone

| Param | Value | Notes |
| --- | --- | --- |
| Mass | 0.172 kg | derived from density × volume; `mass` overrides if set |
| Radius | 0.045 m | semi-major axis of the face |
| Thickness | 0.010 m | full thickness |
| Density | 2700 kg/m³ | slate / granite |
| Moment of inertia | derived | full tensor, exact from the mesh when one is supplied |

### Throw

| Param | Value | Notes |
| --- | --- | --- |
| Release speed | 0–60 m/s bound; 19.2 m/s = Steiner's record throw | human ceiling ~22.4 |
| Attack angle α | ±90° bound, target 20° | |
| Incidence angle β | no rebound above ~45° | emergent, not clamped |
| Spin rate Ω | ±200 rev/s bound; 47–50 rev/s = record-class | |
| Release height | 0–100 m bound; 0.12–0.6 m in play | |

### Environment

| Param | Value | Notes |
| --- | --- | --- |
| Gravity | 9.81 m/s² | |
| Air drag | modelled | C_D 1.1 on projected area; ~half a run's total speed decay |
| Water density | 1000 kg/m³ | |
| Air density | 1.225 kg/m³ | |
| Chop | injected | `water(x, z, t)` callback; flat plane at y = 0 by default |

## Collision model

Not a per-bounce impulse model — the wetted surface is integrated by panel quadrature
every substep. Full derivation in `stone-skipping-physics/docs/PHYSICS-NOTES.md`.

| Aspect | Model |
| --- | --- |
| Lift | planing + Newtonian: `p = ½ρ[C_D(u·n)² + C_P|u_t|(u·n)]`, C_D 1.4, C_P 1.5 |
| Drag | skin friction C_f 0.005 on wetted panels; induced drag falls out of the pressure integral |
| Energy retained | emergent. ~4–8% speed loss per contact at 20°, rising steeply off-angle |
| Angle change on rebound | emergent, from torque about the CoM with a full inertia tensor |
| Spin decay | emergent + explicit damping: wobble 3.0, spin 0.02 |
| Chop interaction | yes — the injected surface's height and normal change effective α |

### Termination

| Condition | Value |
| --- | --- |
| Speed below | 0.35 m/s (`restSpeed`) |
| Centre depth past | 2.5 radii (`diveDepthRadii`) |
| Tumbled | face tilt > 75° with Rossby < 1.5 |
| Pattering | 3 consecutive contacts failing the daylight test (`patterLimit`) |
| Surfing | 0.30 s in contact with no bounce peak |

## Airborne-phase detection — required for scoring

Scoring counts a skip **only when the rock rises back into the air with clear daylight between splashes** (see `05-scoring.md`).

The sim must therefore detect an actual **airborne phase between contacts**, not merely a contact event. Count a skip only when the rock's height clears a threshold above the water plane between touches.

**Threshold: 5 mm of apex clearance** (`solver.minHopClearance`) — resolved, calibrated
against the record rather than by eye. 88 skips over 76 m is a 0.86 m mean hop, ~45 ms
aloft, an apex of about 2.5 mm; record hops are *millimetres*, so a threshold in the
centimetres would exclude the very runs it exists to measure. 5 mm is half the default
stone's own thickness — unambiguously clear, splashes read as separate — and still cuts
the sub-millimetre chatter.

Apex is taken from the vertical speed at liftoff (`vy²/2g`), where the stone is exactly
at the surface by definition, so the test is one comparison and does not depend on when
the airborne phase is sampled.

Counting only cleared hops also implements the second half of the Mackinac rule: after
three consecutive failures the scoring run ends. Before this, a champion throw's score
was ~80% terminal chatter — 68 of 80 contacts were a 0.5 m/s skim at attack angles from
-40° to +32°, and because every skill tier grew the same tail, the score was largely
measuring it.

## Skill ladder — the tuning target

The score curve the game is tuned to, and the only reason the assist knobs exist.

| Rung | Score | What it should take |
| --- | --- | --- |
| Decent throw | >10 | |
| Good rock, aimed well | >30 | |
| Real skill | >50 | |
| Master / record | ~100 | a day that goes right |

Measured by `stone-skipping-physics/test/skill-ladder.mjs`, which scores six skill tiers
as **ensembles of jittered throws** rather than single releases — skip count is chaotic,
so one sample measures the jitter, not the player. Scored on `cleanHops`, the
daylight-counted number, which is also the metric that converges under substep
refinement.

Medians on the `game` profile, 25 throws per tier:

| Tier | Score | Distance | Design |
| --- | --- | --- | --- |
| first-timer | 4 | 7 m | 0–5 ✅ |
| casual | 9 | 13 m | 4–10 ✅ |
| decent | 15 | 19 m | 10–30 ✅ |
| good | 24 | 33 m | 30–50 — **short** |
| expert | 60 | 58 m | 50–80 ✅ |
| master | 58 | 65 m | 80–130 — **short** |

Rock choice is worth 30 hops at identical execution, which is what makes a find matter.

### Why the top two rungs are not reached — measured, not guessed

Both causes are structural, and neither is fixable by turning the existing knobs
further. Recorded here so the next pass does not re-derive them:

1. **Air drag between hops is quality-blind.** It accounts for roughly half a run's
   total speed decay, and it does not care how well the stone is flown. Grading the
   *contact* loss on flight quality (`contactLossScale` × `_contactQuality`) can
   therefore only move the count by about 2×, where the top of the ladder needs 3×.
   Confirmed by sweeping `contactLossScale` from 0.5 to 0.03: the top three tiers moved
   by a few hops and stayed within noise of each other.
2. **Champion release speed is bimodal.** At 21 m/s, 4 of 11 otherwise-identical throws
   died on attitude with 10 m/s still on the stone. `env.attitudeAssistRefSpeed` fixed
   the measured half of this — contacts shorten with speed, so a rate-based attitude
   hold under-corrects exactly when the hydrodynamic disturbance is largest — and
   `env.hopFlattenLimit` fixed the other measured half, but a residue is genuine model
   behaviour at the top of the speed range.

Two approaches were tried and rejected, both with data, so they are not re-tried:
damping the per-contact attitude *walk* (the walk that kills runs is nutation-phase, so
undoing the contact arc does nothing), and *penalising* sloppy contacts as well as
relieving clean ones (depressed the bottom of the ladder without lifting the top, and
broke monotonicity).

The ladder test asserts a **regression band** around today's numbers and *reports* the
design gap. A permanently red suite teaches everyone to ignore it.

## OPEN

- Closing the top two rungs. The lever is the air-drag share of the decay — either the drag model itself or shorter hops — not the assist knobs.
- Where exactly is the tuned ceiling above real-world limits, and is it a hard cap or a soft falloff?
- Pin down the real-world ceiling: 88 (Guinness) vs 89 (as noted elsewhere)
- Which rock properties feed the sim vs which are cosmetic
- ~~Is the sim confirmed deterministic today, or does it need work?~~ Level 1 confirmed: `advance()` is frame-rate independent (identical checksum at 30/60/144/240 Hz and under stutter), no `Math.random` in the sim.
- Float determinism approach
