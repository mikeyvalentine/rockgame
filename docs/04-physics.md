# 04 · Skipping Physics

**Status:** WIP. The physics lab already records most rock stats.

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

Fill from the engine as built.

### Stone

| Param | Value | Notes |
| --- | --- | --- |
| Mass | `TBD` | |
| Radius | `TBD` | |
| Thickness | `TBD` | |
| Moment of inertia | `TBD` | derived or authored? |

### Throw

| Param | Value | Notes |
| --- | --- | --- |
| Release speed | `TBD` | |
| Attack angle α | `TBD` | target ~20° |
| Incidence angle β | `TBD` | no rebound >45° |
| Spin rate Ω | `TBD` | |
| Release height | `TBD` | |

### Environment

| Param | Value | Notes |
| --- | --- | --- |
| Gravity | `TBD` | |
| Air drag | `TBD` | modeled or ignored? |
| Water density | `TBD` | |
| Chop amplitude | `TBD` | |
| Chop wavelength | `TBD` | |
| Wind speed range | `TBD` | |

## Collision model

- Lift model — `TBD`
- Drag model — `TBD`
- Energy retained per bounce — `TBD`
- Angle change on rebound — `TBD`
- Spin decay per bounce — `TBD`
- Chop interaction — does a wave face change effective α? — `TBD`

### Termination

- Velocity below threshold — `TBD`
- Angle above threshold — `TBD`
- Spin below threshold — `TBD`
- Leaves play area — `TBD`

## Airborne-phase detection — required for scoring

Scoring counts a skip **only when the rock rises back into the air with clear daylight between splashes** (see `05-scoring.md`).

The sim must therefore detect an actual **airborne phase between contacts**, not merely a contact event. Count a skip only when the rock's height clears a threshold above the water plane between touches.

- Daylight threshold value — `TBD`, tune against real footage until the on-screen gap that stops the counter matches what a viewer would call closed.

## OPEN

- Where exactly is the tuned ceiling above real-world limits, and is it a hard cap or a soft falloff?
- Pin down the real-world ceiling: 88 (Guinness) vs 89 (as noted elsewhere)
- Which rock properties feed the sim vs which are cosmetic
- Is the sim confirmed deterministic today, or does it need work?
- Float determinism approach
