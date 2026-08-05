# 02 · Sifting, Rocks, Bucket & Economy

## Sifting — decided (revised)

**Decoupled from the daily challenge.** Sifting is its own activity — searching for sea glass and enjoying the judgment-call pleasure of digging through rocks — not a step that produces your daily throwing rock. The daily throw always uses a single universal rock, identical for every player, seeded fresh each day. See `05-scoring.md`.

> First-time players sift inside the **tutorial** instead — a single tuned sift area, near-perfect rocks, tooltips. See `07-meta.md`. (The tutorial's sift-then-throw structure matches **practice**, not the real world — practice keeps the full find-and-throw loop; see below.)

- Click a searchable area, "crouch down" / zoom into the rock field.
- The field is a **full physics sim**. Click and drag to physically move rocks aside and dig through the pile.
- Click any rock to inspect it.
- **Sea glass** is found scattered through the field, independent of which rocks you inspect.

## Inspection — decided

**Stat bars, not numbers.** Deliberately slightly ambiguous.

The player should **mostly infer quality from the rock's shape and roughness** — the visible geometry — with the bars as supporting signal rather than an answer.

Inspection is no longer a selection decision — there's nothing to carry away. It's the tactile, judgment-call moment for its own sake, the same instinct the tutorial teaches by contrast.

> Note: this is the one place the "legible physics" rule is intentionally softened. It applies to *outcome-deciding* variables at throw time, not to inspection. Reading a rock is meant to be a guess.

## Rock lifecycle — revised

**The real-world sift has no bucket, no carrying, and no throw.** Since found rocks never become the daily rock, the old pick-up → bucket → throw → lost pipeline no longer applies to the real world. You search, you inspect, you collect sea glass, you leave. Nothing is carried and nothing is lost, because nothing is picked up.

**Practice is different.** A found rock in practice can still be picked up and thrown immediately, for fun — no bucket, no capacity limit, nothing scored or scarce. This is where rock-driven handling difficulty (below) is actually explored, including grabbing a heavy or ugly rock just to feel what happens.

**No banking in the MVP** still holds by construction — there's nothing to bank if nothing is carried.

## Rock properties → physics AND handling difficulty — decided

A rock's mass and size affect its skipping physics **and** how hard it is to aim and throw. This governs **whatever rock is currently in play** — the daily's seeded universal rock, or whatever a player picks up in practice.

| Property | Control effect |
| --- | --- |
| Mass | Drift **magnitude** — how hard you fight |
| Roughness | Drift **jitter** — feels unstable, twitchy |
| Shape irregularity | Drift **bias** — pulls one direction; the player learns its lean |
| Size / diameter | Release window width |

### Handling difficulty is TUNED, not simulated

Real skipping stones are light and easy to control. This is a deliberate exception.

**Rule:** the sim governs the outcome (after release); game feel governs the input (before release).

Justification: the player has a mouse and keyboard, not an arm. Amplified control difficulty stands in for the proprioception they don't have.

### Difficulty bands

| Band | Handling | Skips | Payoff |
| --- | --- | --- | --- |
| Too light / tiny | Easy | Low ceiling | Safe, unremarkable |
| **Ideal skipper** | **Fairly hard, not annoying** | Highest ceiling | The score band |
| Heavy | Hard | Few | Splashes high |
| Super heavy | Brutal | Barely any | Huge splash |

Difficulty is **not monotonic with potential.** The best rocks are not the hardest rocks. Heavy rocks are a toy, not a tactic — park them in practice mode.

### Definition of "not annoying"

The ideal rock should be controllable on most throws by a practised player, and **every failure should feel like the player's fault.**

Annoyance comes from exactly three things — avoid all three:

1. Unpredictable drift → keep it deterministic and seeded
2. Drift faster than the player's correction rate → frequency must stay under correction bandwidth
3. Failures you can't diagnose → always show why it died

Deterministic, correctable and legible reads as **craft**. Random, outpacing and opaque reads as **torment**.

## Tuning knobs

Hand-tuned values, not derived. Record them here as they're set.

- Drift magnitude multiplier, per mass band — `TBD`
- Drift frequency / oscillation rate — `TBD`
- Drift bias strength from shape irregularity — `TBD`
- Correction authority (how fast keyboard input moves the angle) — `TBD`
- Sweet-spot window width as a function of pose aggression — `TBD`
- Mass → splash height curve — `TBD`

## Economy — MVP

**Sea glass only.** Found while sifting, independent of the daily throw. Buys a minimal cosmetic set.

**Batteries and minerals are out of the MVP** — the tumbler is cut so batteries have nothing to power, and minerals have no defined use.

## Cosmetics — MVP

- **Arm only.** No full character. Customization is shoulder-down: skin tone, tattoos, watches, bracelets, rings, gloves, sleeves.
- **Rock skins apply to the throw only, never to sifting.** The rock you dig up and inspect looks honest; the skin applies once it's in hand for the throw, and carries through flight and the share card.
- **Skins must never alter silhouette** — only material and colour. Shape variation is what makes every share card unique, and shape is the mechanically real axis.

Rule: *honest during selection, skinned during performance.*

## OPEN

- Sea glass drop rate per sift — sets the whole economy pace
- What the minimal MVP cosmetic set contains
- Exact mass band boundaries
- Does the ideal band sit at real-world skipping-stone mass, or shifted?
- Is there dig depth in a rock field, or is it all surface?
- Time limit on sifting?
- Is sea glass purchasable with real money, or earned only?
- Now that sifting is decoupled from the daily throw, does it still reset once per real day, or can it happen any time?
- Does the daily's universal rock's quality band vary day to day (some days easy, some days brutal), or does it stay tuned to the "ideal" band every day?
