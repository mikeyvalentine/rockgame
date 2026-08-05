# 08 · Post-MVP

Designed but explicitly out of the MVP. Do not build these. Recorded so MVP decisions don't foreclose them.

## Game identity, long term

**A stat crawler with a daily ritual.** Progression primary; the daily is the share hook, not a fairness engine.

Everything persists. Tumbling, banking and rock improvement are all allowed.

> ⚠️ **Unresolved conflict with the MVP's universal daily rock (`05-scoring.md`):** this paragraph originally read "the daily gives everyone the same pond, field and cairn — but you bring what you've got" — i.e. post-MVP, players use their own banked/tumbled rock in the daily, and the share card is a trophy rather than a claim everyone started equal (the OSRS social contract). That directly contradicts the MVP decision that the daily throw is always one universal, seeded rock for every player, forever — no personal rock ever enters it.
>
> This needs a call: does the daily **stay universal-rock forever**, even once banking/tumbling exist — meaning banked and tumbled rocks are for some *other*, non-daily mode — or does the daily **eventually reopen to personal rocks** once the crawler identity is live, reversing the MVP's isolation-of-skill design? Whichever way this goes decides what banking and the tumbler are actually *for*.

## Where stats live — decided, applies now

**All performance stats live in the rock. The player is a constant.**

No throwing level, no power stat, no accuracy stat. Two players with the same rock and the same inputs get the same result, forever.

**Why:** the centrepiece is a hard execution minigame. Player stats would compete with execution for credit — every point of stat is a point of skill expression removed.

### Progression axes — none touch physics

1. **Access** — deeper sift areas, the tumbler, bucket capacity, bank slots
2. **Information** — inspection detail improves: verbal → range → tighter range. The rock behaves identically; you just know more. **Guardrail: narrow uncertainty, never eliminate it.**
3. **Inventory & throughput**

> Aiming axes are **not** a progression axis — full throw complexity is live from a player's first throw, forever, and that applies MVP and post-MVP alike (the daily must stay the same skill test on day 1 and day 100). See `03-throwing.md`.

## Banking

Hold a rock back for another day — bad conditions, or not confident enough to use a great find yet.

Allowed in the daily once the crawler identity is live. **Bank slots, not unlimited storage** — unlimited turns into hoarding, and hoarding turns the daily into spending from a vault.

## Rock tumbler

Battery-powered. **Improves roughness and shape** — smooths the surface and rounds the profile.

Because rock properties drive *handling difficulty* as well as physics, tumbling makes a rock **more controllable**, not merely statistically better. The fantasy is *"tame this monster"*, not *"+5 to stats"* — a real reason to work a heavy, high-ceiling rock until its potential is usable.

**Watch:** if tumbling is cheap and strong it devalues sifting. Battery cost is the lever. A mass cost per tumble would give a second lever and a real ceiling.

## Store

Sea glass buys cosmetics. Eventually: full character customisation, skybox, rock trailing effect, splash effect, environment, bucket, rock skins — pretty much anything.

### Catalogue sorting

- **Tier A — seen by others** (via the share card): the arm and its cosmetics, the rock. Strongest purchase motivation.
- **Tier B — seen only by you**: skybox, environment, bucket, splash, trail.

**Tier B is on-brand here in a way it usually isn't.** A calm nature sim where you buy a nicer sky for a place that's yours alone is coherent — you're decorating your own morning, not signalling.

But with no multiplayer there's no organic discovery loop, so the store needs real merchandising rather than envy.

### Fairness rule

Environment cosmetics are **not** a pay-to-win risk, because cairn position and chop are surfaced via readouts rather than read visually.

The forward-looking rule: **every gameplay-relevant property must have an explicit readout. Once it does, cosmetics are unconstrained.** The only risk is adding a mechanic that matters with no number attached.

## Rooms (private & public)

Groups sift and throw together in friendly competition.

### Cost analysis summary

Unusually cheap, for three reasons already true:

1. **Nobody moves** — no locomotion, collision or pathing to sync
2. **The sim is already deterministic** for anti-cheat, so rock flight never needs syncing — broadcast throw parameters once and every client simulates identically (deterministic lockstep, the cheapest model)
3. **Existing stack** — Workers + Durable Objects + partyserver

WebSocket Hibernation means idle connections accrue no duration charges; incoming messages bill at 20:1. Running cost is noise.

### Fidelity tiers

| Tier | Players see | Cost |
| --- | --- | --- |
| 0 | Results only | Trivial |
| 1 | Static figures at their spots | Small |
| **2** | **Their throw, arm visible** | **Target** |
| 3 | Them posing live | Poor value |
| 4 | Simultaneous throws | Perf risk |

Tier 2 is where cosmetics become visible to others — the entire reason cosmetics exist.

### Simultaneous throwing + rock collisions

Rocks **deflect** each other and ruin trajectories — they do not annihilate.

**Why deflection is better:** the run survives, degraded; outcomes form a readable spectrum; and it couples to the attack-angle system for free — a clip changes *attitude*, and attitude already decides whether a rock skips or plonks. The punishment is emergent, not a rule.

**Technically practical because this game tolerates large input delay** — nothing requires reaction, so lockstep's usual difficulty doesn't apply.

**Design constraint:** this is adversarial, in a game whose mood is calm and self-directed.

| Context | Throwing |
| --- | --- |
| Daily | Solo |
| Public / ranked rooms | Turn-based |
| **Private rooms with friends** | **Simultaneous + collisions** |

Turn-based public rooms also cap simultaneous physics at one, removing the performance risk entirely — and taking turns is how it works at a real lakeside.

### The real cost is the room product, not the sync

Lobbies, join codes, public discovery, reconnection, turn management, AFK handling, moderation (profanity filter extends to room names), and testing that requires N clients.

## Full character

Arm-only is a **deferral, not a dead end** — the arm becomes part of a body rather than being discarded.

If rooms arrive first, arm-only survives: when another player throws, you watch their throw with their arm visible. Cosmetics stay social without ever authoring a torso.

**Note:** a 2D projection character was considered and rejected. 2D is only cheaper with few angles and few items; a cosmetics-heavy game is exactly where it becomes *more* expensive, since 3D cosmetics author once and work everywhere while 2D multiplies by pose count.

## Also deferred

- Batteries, minerals (minerals still have no defined use — give them a job or cut them)
- Mobile
- Ghost replays
- Seasonal locations
- Tournament/bracket mode
