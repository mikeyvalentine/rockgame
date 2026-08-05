# Rock Game

Browser-based stone-skipping simulator. 3D, single static pond, real physics, daily challenge.

## How to use these docs

- **Decided** items are settled. Build to them. Don't relitigate.
- **OPEN** items are unresolved. Ask before implementing; don't invent an answer.
- Values marked `TBD` need a number before that system can be built.

Specs live in `/docs`, one per area. Read the relevant one before working on a system.

| Doc | Covers |
| --- | --- |
| `docs/00-overview.md` | Pillars, MVP scope, build status |
| `docs/01-world.md` | Pond, environment, conditions, navigation, cameras |
| `docs/02-gathering.md` | Sifting, inspection, rocks, bucket, economy |
| `docs/03-throwing.md` | Pose, arc, attack angle, unlock ladder |
| `docs/04-physics.md` | Sim rules, tuning philosophy, determinism |
| `docs/05-scoring.md` | Skip counting, cairn, leaderboards, daily |
| `docs/06-presentation.md` | UI, audio, share card |
| `docs/07-meta.md` | Accounts, onboarding, practice, anti-cheat |
| `docs/08-post-mvp.md` | Rooms, tumbler, banking, store, full character |
| `docs/09-sand-sim.md` | Sand particle sim, movement, rock-field LOD, sand leaderboard |
| `docs/10-performance.md` | Floor spec, framerate targets, ms budget |
| `docs/11-art-direction.md` | Visual target, water, palette, hero look |
| `docs/physics-reference.md` | Real-world values for auditing the sim |

## Non-negotiable rules

These constrain every system. Violating one is a bug even if the feature works.

1. **Aiming is the game.** All difficulty lives in the throw. The pond stays open and simple — no obstacle courses, no level design.
2. **Legible physics.** Every variable that decides an outcome gets a readable value on screen. This is also what makes cosmetics fairness-safe. If you add a mechanic that matters, give it a readout.
3. **The sim governs the outcome; game feel governs the input.** Once the rock leaves the hand, physics is honest. Before release, difficulty is tuned.
4. **Deterministic simulation.** Identical inputs must produce identical results across clients. Required for server-side score validation, and for multiplayer later.
5. **Cosmetics only.** Nothing purchasable may improve skip performance.
6. **Calm, low-strife.** No timers, no urgency cues, no red failure states, no streak guilt. The only challenge is beating your own last day.
7. **Barebones UI.** No helper copy, no tooltips explaining a number, no flavour text. The physics teaches.
8. **Every failure must be diagnosable.** The player should always be able to see why a throw died.
9. **Aliasing and mid-2000s rendering artifacts are part of the art direction.** Don't "fix" them. When a rendering shortcut is available, check whether it's period-correct before treating it as a compromise — usually it is.

## Stack

- **Client:** vanilla three.js (not R3F)
- **Rendering:** WebGPU for the sand particle sim, with a reduced-fidelity WebGL fallback
- **Backend:** Cloudflare Workers + Durable Objects, Cloudflare Pages
- **Assets:** C4D / Blender → GLB

## Performance

Full detail in `docs/10-performance.md`.

- **Floor spec:** 2020 Intel MacBook (Iris Plus Graphics G7, integrated).
- **60fps is a hard floor during the throw.** Other activities may target 30–60.
- **Fixed quality, no runtime adaptive scaling.** The floor machine therefore caps the ceiling.
- **The sand sim must be pausable** — it only steps while the player disturbs it. This is what buys the throw its budget.
- On the floor machine WebGPU is effectively **Chrome-only**, so the **WebGL fallback is a first-class renderer**, not a courtesy.
- Framerate is a fairness issue: physics is fixed-timestep, so what low framerate costs is *input resolution* on the release window and drift correction. Set the sweet-spot window width and the framerate floor together.

## Decide in engine

Some decisions are deliberately deferred until they can be seen running. **Do not resolve these on paper, and don't treat them as blocking.** Build a version, look at it, then decide.

| Decision | Doc |
| --- | --- |
| Stylization layer — cel, pastel grade, or neither | `11-art-direction.md` |
| Sweet-spot window width | `03-throwing.md` |
| Drift magnitude, frequency and correction authority | `02-gathering.md` |
| Where the "ideal rock" mass band sits | `02-gathering.md` |
| Daylight threshold for the skip counter | `04-physics.md` |
| Whether the cairn bonus should be ×2 | `05-scoring.md` |

Build them adjustable. These are feel values, and feel values get set by playing.

## MVP boundary

**In:** single player, arm-only character, desktop only, daily challenge, practice world, sea glass + minimal cosmetics, full unlock ladder.

**Out:** multiplayer/rooms, rock tumbler, banking, full store, full character, mobile, batteries, minerals.

The MVP is a **daily challenge game**. The stat-crawler identity is layered on afterward. Sequencing rationale: if the throw isn't fun, none of the crawler matters.
