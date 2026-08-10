# 03 · Aiming & Throwing

> **Implementation status (2026-08-08):** being built in `throw-lab`. Layer-1 pose
> = per-joint drag handles with anatomical limits (DIRECT manipulation, not IK —
> resolves that OPEN); a deterministic wind-up→release swing (Model B, first
> slice); and a size-banded procedural grip. Not yet joined into a `throwStone()`
> call, and Layers 2–3 (sweet spot, attack-angle drift) and spin are not started.
> Full state + where to put your hands: `paused-work-2026-08-08.md`.

**Aiming is the game.** All difficulty lives here. Because of that, the pond stays open and simple.

Reference: the swing system in *Normal Golf Game* (Luke Muscat). Take the multi-axis simultaneity and the drift. **Do not** take the deliberate unresponsiveness — that's comedy-frustration and it fights this game's mood.

## Aim happens at three scales

| Scale | Control | Where specified |
| --- | --- | --- |
| Macro | Where you stand on the walkable shore | `09-sand-sim.md` |
| Meso | The pose | below |
| Micro | The release point | below |

## Three layers, three skills — decided

| Layer | Input | What it is | Skill |
| --- | --- | --- | --- |
| 1. Pose | Two modals — side + top | **Intent.** Sets where the rock goes and roughly how far | Strategy |
| 2. Arc | Click, drag, release | **Fidelity.** Hit the sweet spot and it goes where you intended | Timing |
| 3. Attack angle | Keyboard, continuous | **Viability.** Hold ~20° or the rock cuts, knifes, or dies | Sustained control |

Three separate failure modes. Perfect plan, blown release. Nailed release, lost angle.

**What makes it hard:** layers 2 and 3 run simultaneously on two devices. Divided attention — not any single input being difficult.

## Layer 1 — the pose

Two **2D** problems, not one 3D problem. This avoids ambiguous 3D manipulation.

| Modal | Plane | Joints | Determines |
| --- | --- | --- | --- |
| Side view | Vertical | Elbow height, arm loft, wrist cock | Launch angle → **how far** |
| Top view | Horizontal | Body rotation, swing plane | Line → **where** |

Side view also carries sidearm-vs-overhand, which sets the spin axis.

The pose **replaces coarse aim.** There is no separate "line up the shot" step.

Pose is **static and calm** — no drift during this phase.

## Layer 2 — the arc and sweet spot

- Click and drag through the throw arc.
- **The sweet spot is visible**, shown as an indicator on the arc (as in the reference game). The challenge is hitting it *while* fighting the angle, not finding it.
- **The sweet spot is computed, not authored** — it is the point in the arc where the hand's velocity vector points at the intended target. Derive it from the pose.

### Free difficulty knob

Because it's derived, **pose aggression narrows the window automatically.** Conservative pose → forgiving release. Max-distance pose → razor window. No authoring required.

### Missing the sweet spot must be predictable, not random

- **Early release** — higher launch, shorter, steeper entry
- **Late release** — low, pulled off line, skims in too flat

Opposite, learnable errors. This is the difference between a skill check and a noise generator.

## Layer 3 — attack angle

Hold **~20°**. Above **~45°** no rebound is physically possible.

The angle **drifts continuously** and the player counter-steers on the keyboard. Drift magnitude, jitter and bias all come from the rock (see `02-gathering.md`).

**Drift must be deterministic and seeded from the daily seed.** Random drift makes scores noisy and breaks server-side replay validation.

### Failure taxonomy

Every failure must be visibly diagnosable.

| Angle error | Result | Term |
| --- | --- | --- |
| Too steep (>45°) | Plunges on first contact | Plonk |
| Nose down / negative | Knifes in, digs, stops dead | — |
| Nose up too far | Catches air, bleeds speed, dies flat | Skronker if it never lands |
| Tilted laterally | Curves and cuts off line | Cut |
| Oscillating | Wobbles, bleeds energy, weak short skips | Early pitty-pat |

## No unlock ladder — decided (reversed)

**Cut.** All three layers — pose, arc, attack angle — are live from a player's very first throw. There is no staged progression, no rung, no gating.

**Why:** the game is designed around the daily as the addiction loop. A ladder that gates layers over days of play means a new player doesn't experience the *real* throw — the one they'll face every day, forever — until well into their first week. That delays the hook instead of forming it. The daily must be the same skill test on day 1 and day 100.

Full complexity on throw one is handled by teaching, not gating — see **Guided first throw**, below.

## Spin & wobble — decided

Real skipping needs spin for gyroscopic stability (see `physics-reference.md`) — not enough spin, and the rock's attitude destabilizes mid-flight.

Two separate properties, two separate sources, neither a player-unlockable axis:

- **Spin axis** — set by the pose (sidearm vs. overhand, Layer 1 above), then **perturbed by the rock's own shape irregularity.** An imperfect rock doesn't hold the axis you set it on. Same source, same logic as the drift-bias effect shape irregularity already has on attack angle (`02-gathering.md`) — the rock's honesty about its own flaws, not a new mechanic.
- **Spin speed** — comes from **arc shape**: a flatter, more sidearm drag path yields more spin. One gesture in the arc carries power (speed), aim (release point) and spin speed together.

**Wobble is not a control axis — it's the failure state when spin runs out.** Too little spin speed, or too much axis perturbation from a rough/irregular rock, and gyroscopic stability fails mid-flight. This is the "Oscillating" row in the failure taxonomy below: wobbles, bleeds energy, weak short skips.

This resolves what used to be unlock-ladder rung 5 ("wobble / spin axis — expert tier"). There's nothing to unlock — wobble was always going to be an emergent consequence of spin and rock quality, not a separate input.

## Guided first throw — decided

A new player's first throws happen inside the **tutorial** (a tuned practice-world pass — full detail in `07-meta.md`), using near-perfect rocks so rock quality is never the variable. Full throw complexity — pose (both modals), the arc and sweet spot, attack-angle counter-steering — is present from throw one. It teaches; it does not gate.

Three throws, escalating independence: full guided walkthrough, then assisted, then solo with an easy goal. After the tutorial, the game stops talking. Full complexity, every throw, forever.

Practice mode (resettable, no stakes) is where a player who wants more reps builds comfort before taking the throw into the daily — not a staged unlock, just a place with no consequence for flailing.

## Platform

**Desktop only for the MVP.** Mouse + keyboard simultaneously has no clean touch equivalent.

## OPEN

- Sweet-spot window width — **decided by playtest**, not in advance. Must be set alongside the framerate floor (see `10-performance.md`).
- Is release a mouse-button-up inside the drag, or a discrete second input?
- Does missing the sweet spot cost distance, direction, or both?
- How narrow does an aggressive pose make the window at the extremes?
- Can a throw be aborted mid-arc without losing the rock?
- Is there a visible attack-angle readout during the drag, or is it read off the rock model?
- Two views for the pose is decided — is IK used (drag the hand, arm solves) or direct joint manipulation?
- Exact content/prompts of the guided first throw sequence
