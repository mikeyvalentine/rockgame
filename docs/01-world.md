# 01 · World, Environment, Navigation & Cameras

> **The interaction window is sized per throw.** The deviation field covers a
> window on the pond, not the pond, and that window is now fitted to the run
> before the run starts: the solver is deterministic, so `placeRun()` simulates
> the throw headlessly, takes its bounding box and sizes the window to hold it
> (64 m minimum, 160 m ceiling). The previous rule — drop the window a fixed
> 0.72 of a half-span downrange — clipped two of the presets, and a ripple
> outside the window is skipped silently, so the far end of a long run's trail
> simply went missing. The precompute costs ~110 ms on the Throw press.
>
> The window can only ever WIDEN. Narrowing it for short throws would be better
> — smaller cells, deeper craters — but holding waves at a physical speed needs
> `WAVE_C` to rise as cells shrink, and below about a 53 m span at RES 2048 that
> reaches the CFL limit. Shrinking needs more `STEPS`, which costs fill on every
> frame rather than on the long throws that need it. See `docs/10`.

## Pond — decided

- Single static 3D scene. One pond, no other locations.
- **~200m across** — pending feasibility check against the water sim.
- Fully ringed by trees. The tree ring occludes the horizon (good for performance) and is the primary wind indicator.
- The player never leaves the shore.
- **Walkable zone: one small coastal stretch, at most 1/8 of the shoreline.** See `09-sand-sim.md`.
- **Throw from anywhere on the walkable shore.** The earlier single-fixed-throwing-spot rule is cut.

## Environmental variables — decided

**Wind** and **chop**. Rolled **independently** — wind does not derive chop.

**Current is cut.** Wind was chosen over it; do not implement both.

### Wind indicators

All four, in combination with a small numeric readout:

- Trees swaying (the tree ring — strongest cue, free)
- Flag / windsock at the throwing spot
- Surface streaks and ripples on the water
- Drifting particles (leaves, pollen, seeds)

### Chop indicator

Small numeric readout plus a simple wave-peak line.

## Day/night — decided

**Real-time synced to the player's clock.** Play in the morning, it's morning.

Different players see different light on the same daily. Not a fairness issue — cairn position and chop are read as data, not inferred visually.

**Night is moonlit.** Different mood, not a penalty. Possibly some lights in the water.

## Sift areas — decided

- **5 areas** along the shore.
- **Fully random, no particularities between them.** This is a real-life sim, not a zoned loot table — every area draws from the same distribution.
- Most rocks are an ordinary mid-tier spread, with sea glass reliably findable in every area.
- **Rarities are rare, not area-locked.** On any given day, the 1-2 near-perfect skipping rocks that exist could turn up in any of the 5 areas.
- **Unlabeled.** Nothing distinguishes them from a distance — there's nothing *to* distinguish, since they're identical in distribution.
- **All areas searchable in one day.** Bucket capacity is the only limit.

There is no per-area knowledge to build. The only variable is how long you're willing to look.

**Sifting is decoupled from the daily throw** — see `02-gathering.md` and `05-scoring.md`. What's found here never becomes the rock you skip in the daily.

## Navigation — decided (revised)

- **Free movement inside the walkable beach zone** — first person, with sand trails behind you.
- **HUD / click navigation** for travel between distinct areas.
- Free look around the coast at all times.

> Revises the original "no WASD, point-and-click only" rule. Free walking is bounded to the beach zone; it does not extend around the pond.

## Cameras — decided

| Camera | Behaviour |
| --- | --- |
| Standing | First-person-ish from the shore, free look |
| Crouch / sift | Zooms down into a rock field |
| Skip | Third-party side / bird's-eye, follows the rock closely through the full trajectory, slight bullet-time |

The skip camera is the hero moment and doubles as the scoring display.

## OPEN

- Verify 200m is feasible with the water sim — **gates the whole scale decision**
- Pond shape — simple bowl or irregular shoreline
- Walkable zone location relative to the cairn arc, and its exact size/shape
- What the lights in the water are, if any
- Travel time on HUD jumps — instant cut or animated
- Do in-world clickable spots show a hover indicator
- Where bullet-time ramps in — whole flight or only as skips shorten
- Does the skip camera stay on the rock after it sinks
- Time-of-day audio and lighting states — define dawn/day/dusk/night
