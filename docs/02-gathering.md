# 02 · Sifting, Rocks, Bucket & Economy

## Sifting — decided (revised)

**Decoupled from the daily challenge.** Sifting is its own activity — searching for sea glass and enjoying the judgment-call pleasure of digging through rocks — not a step that produces your daily throwing rock. The daily throw always uses a single universal rock, identical for every player, seeded fresh each day. See `05-scoring.md`.

> First-time players sift inside the **tutorial** instead — a single tuned sift area, near-perfect rocks, tooltips. See `07-meta.md`. (The tutorial's sift-then-throw structure matches **practice**, not the real world — practice keeps the full find-and-throw loop; see below.)

- Click a searchable area, "crouch down" / zoom into the rock field.
- The field is a **full physics sim**. Click and drag to physically move rocks aside and dig through the pile.
- Click any rock to inspect it.
- **Sea glass** is found scattered through the field, independent of which rocks you inspect.

## Every stat is divergence from the ideal stone — decided

Stats are **not** magnitudes. A stat is *how close this rock is to the mathematically
ideal skipping stone on that axis*, so every bar reads the same direction: full is
perfect, empty is wrong. **Full pips on mass means "the right mass", not "heavy"** — a
boulder and a pebble both score empty on mass, from opposite sides.

This is what makes the bars comparable to each other, and it is why a rock can be
5/5 on one axis and 0/5 on another without contradiction: a 1.5 kg boulder genuinely
would hold its attitude (balance 5/5) and is genuinely unthrowable (mass 0/5).

| Stat | Ideal | Source |
| --- | --- | --- |
| Mass | **170 g** | 100–200 g good band; the solver's validated default is 172 g |
| Size | **8.5 cm** across | 5–10 cm; skimming championship caps entries at 76 mm |
| Flatness | **0.075** (thickness ÷ longest face dim) | λ = R/d wants 5–10, and flatness = 1/(2λ) |
| Roundness | **1.0** (circular face) | a round face meets the water identically every rotation |
| Balance | peaks at the right mass-to-radius | `PHYSICS-NOTES.md` §14 |

**Rarity is the weighted sum of those**, shown as a colour and a word — Common grey,
Uncommon green, Rare blue, Epic purple, Legendary orange. The player never sees the
number.

> **Roughness is not a rated stat.** It survives in the solver as a skin-friction
> multiplier, but it is close to invisible on a real stone and its effect is a
> fraction of a percent of a run. Rating it would imply a precision the player has no
> way to read and the physics does not reward.

> ⚠️ **Calibration open.** The flatness ideal (0.075) is much thinner than the 0.20 the
> old rating centred on, so typical river rocks now score near zero on that axis and a
> "classic" 8×7×1.6 cm stone lands Common. That is physically correct — most river
> rocks are bad skipping stones — but it has **not** been checked against the actual
> scanned population in `river_rocks.glb`. If the sift never yields Rare+, widen
> `STONE_STAT_TARGETS.flatness.tolerance` rather than moving the ideal.

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
| Shape irregularity | Drift **bias** — pulls one direction; the player learns its lean |
| Size / diameter | Release window width |
| **Balance** | *No* control effect — acts after release. See below. |

> Roughness used to drive drift **jitter** here. Dropped along with its rating (above):
> a stat the player cannot see on the rock should not be secretly making their aim
> twitch. If jitter is wanted back, hang it on shape irregularity, which is visible.

### Balance — hidden, and the only stat that acts after release

Every property above is a **handling** property: it shapes the pre-release aiming
drift. **Balance is the exception** — it does nothing to your aim and everything to
what happens once the stone is gone.

A stone's attitude (which way its face is pointed) walks a little with every bounce,
by gyroscopic precession. Left alone it eventually walks out of the window where
skipping is possible, and the run dies **with most of its speed still on the stone** —
measured: 11 m/s against a 2.6 m/s floor. That, not running out of energy, is what
ends most runs. Balance is how well a stone resists that walk.

- **Hidden.** Never shown as a bar, unlike the properties above. The player infers it
  from the rock's look — a stone that reads *true* holds its line; one that reads
  *warped* gives up early — and from throwing it.
- **Mostly the stone, a little the throw.** The rock supplies the value; a clean,
  coherent release collects all of it and a sloppy one keeps most (not all) of it. An
  **unspun stone gets none of it** — no rock is well-balanced enough to rescue a throw
  with no gyroscopic authority, and the skill curve depends on that staying true.
- **This is the tuned exception, spent deliberately.** `04-physics.md` permits going
  "slightly above and beyond what's possible in real life"; Balance is where that
  budget goes. The `documentary` profile does not have it.

> **Naming:** "Balance" is the stat; **true** / **warped** is how it's described in
> the fiction and in inspection copy. Do not call it *drift* — that word already means
> the pre-release aiming wobble in the table above, which is a different system.

**What it's worth** (game profile, Steiner-preset throw, 25-run ensemble median):

| Rock | Skips |
| --- | --- |
| Warped (0.0) | 29 |
| Average (0.5) | ~53 |
| True (1.0) | 58 |

Balance is a *ceiling raiser, not a floor raiser* — it can't make a bad throw good
(casual stays at 5 skips, unspun stays at 0), it only lets a good throw run out its
full length instead of dying early.

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

- Balance → `env.balanceRetention` mapping per rock quality band — `TBD` (solver side
  is calibrated: the 0..1 stat maps onto a 0..0.35 correction blend, peak measured)
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
