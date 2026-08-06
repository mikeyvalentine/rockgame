# 01 · World, Environment, Navigation & Cameras

## Pond — decided

- Single static 3D scene. One pond, no other locations.
- **200 m across, round** — built. `shared/worldBounds.js`: a disc of radius
  100 with its near rim on the waterline, its floor a bowl reaching the 2.5 m
  seabed depth in the middle. Round rather than square so the shoreline curves:
  the walkable strip bows 6.3 m from its ends to its middle, and the water is
  nearest straight ahead and falls back on both sides.
- Fully ringed by trees. The tree ring occludes the horizon (good for performance) and is the primary wind indicator.
- The player never leaves the shore.
- **Walkable zone: one small coastal stretch, at most 1/8 of the shoreline.** See `09-sand-sim.md`.
  Built at **70 m of shoreline by 25 m deep** — about 1/9 of the pond's 628 m
  perimeter. It is a rectangle in (arc, depth), not in x/z, so it is the same
  size everywhere on the curve; an axis-aligned box would have run 25 m deep in
  the middle and 31 m at the ends.
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

- Walkable zone location relative to the cairn arc
- What the lights in the water are, if any
- Travel time on HUD jumps — instant cut or animated
- Do in-world clickable spots show a hover indicator
- Where bullet-time ramps in — whole flight or only as skips shorten
- Does the skip camera stay on the rock after it sinks
- Time-of-day audio and lighting states — define dawn/day/dusk/night
