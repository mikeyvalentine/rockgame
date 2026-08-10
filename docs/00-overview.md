# 00 · Overview

## The game

You stand on the shore of a quiet tree-ringed pond. The daily challenge hands you the day's rock — one universal spec, identical for every player, seeded fresh each day alongside the cairn and conditions. Pose your arm, work a difficult release, and throw — three times, same rock each time. The camera follows the rock out across the water while the count climbs. The rock sinks. It's gone.

Separately, whenever you sift, you comb the lakebed for rocks — physically shifting them aside, inspecting each for size, roughness and shape — searching for sea glass and for the pleasure of the judgment call. **Sifting is decoupled from the daily throw**: nothing found there becomes the rock you skip. See `02-gathering.md` and `05-scoring.md`.

## Identity

**Long term:** a stat crawler with a daily ritual. Progression is primary; the daily is the share hook, not a fairness engine.

**MVP:** a daily challenge game. Crawler systems (tumbler, banking, store) come later.

## Mood

Calm, idyllic nature sim. Slow pace, minimal strife. Good sound design, satisfying textures and buttons. The only challenge is internal — self-improvement, beating the last day.

## Visual target

Fairly realistic 3D, in the vein of Wii-era Nintendo sports games. Possibly a stylized pastel or cel shader on top.

**Hard constraint:** must run in-browser on most computers.

## Build status

| System | Status |
| --- | --- |
| Physics lab (records rock stats) | working |
| Water sim | WIP |
| Rock sifting | WIP |
| Rock object generation | WIP |
| Skipping physics | WIP |
| Map / environment | not started |
| Player navigation | not started |
| Aiming & throwing | WIP — `throw-lab` (pose editor + swing + grip); see `paused-work-2026-08-08.md` |
| Character skin / customization | WIP — `skin-lab` (tone/colour + age); see `paused-work-2026-08-08.md` |
| Scoring | not started |
| Skip camera | not started |
| UI | not started |
| Accounts / leaderboard | not started |

## Rejected approaches

Recorded so they aren't revisited.

- **Trajectory drawing** — a golf-sim approach where you draw the full skip line. Prototyped; boring, and it leaned entirely on an elaborate obstacle map. Drawing the line moves skill from execution to planning; planning needs obstacles; obstacles need a content treadmill. Execution needs only a flat pond.
- **Heavy rocks as cairn-killers** — spending a throw on a heavy rock to smash a cairn. Nobody would take the trade. Heavy rocks are a toy, not a tactic.
- **Score = skips × distance** — destroys legibility, double-counts a correlated signal, and kills the live count-up.
- **Player stats** — no throwing level, no power stat. All performance variance lives in the rock.

## OPEN

- Name — is "Rock Game" final? Domain not secured.
- Real-world skip ceiling cited as 89 in early notes; Guinness records 88 (Kurt Steiner, 2013). Pin down 88 as the reference — it defines the tuned ceiling (see `04-physics.md`).
- Accessibility — the throw uses two devices simultaneously. No plan yet.
