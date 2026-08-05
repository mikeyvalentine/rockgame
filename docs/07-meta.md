# 07 · Accounts, Onboarding, Practice & Anti-Cheat

## Accounts — decided

- **Proprietary sign-in, with Google as an option**
- Player chooses a **username** — this is what appears on the leaderboard
- **Profanity filter required** on usernames
- **Account first, then the pond.** Sign in before any gameplay, so progress is never lost and leaderboard identity exists from the first throw

Tradeoff accepted: a sign-in wall costs some drop-off, but no player ever loses a first session.

## Practice mode — decided

Two worlds. Everything that matters is decided by which one you're in.

### Practice world

- **Static.** Conditions **fixed** for the MVP (settable later).
- **Resettable** unlimited times
- **No treasure** in the sifting — no sea glass
- Rocks are throwaway; nothing is consumed
- **Nothing is recorded** — no scores, no leaderboard, no stats

This resolves the practice-vs-scarcity contradiction entirely: practice rocks aren't real rocks, so unlimited practice costs nothing.

It's also where heavy-rock toy throws belong — splashing boulders costs no daily throw.

### Real world

- Sift fields reset daily and are universal
- Cairn is universal
- Everything is recorded
- Rocks are real, consumed on throw, lost

## Tutorial — decided

A **first-time-only, tuned variant of the practice world.** Not a separate system — the same practice world, temporarily reconfigured to teach. Everything else about practice (static conditions, resettable, unrecorded, no treasure) still applies.

### Sifting stage

- Only **1 sift area** is offered — not the usual 5-area choice.
- **Small tooltips** walk through how sifting works: crouch in, click and drag rocks aside, click to inspect.
- The area is stocked almost entirely with **near-perfect skipping rocks**, with a few weaker ones mixed in for contrast. The contrast is what teaches the stat bars — seeing a great rock and a mediocre one side by side teaches a new player to read the difference themselves, no explanation needed.
- Filling the bucket here is also where the bucket mechanic (capacity 3, single-use) is first encountered.

### Skipping stage

Three guided throws, using the near-perfect rocks just gathered — so rock quality is never the variable. Every miss reads as a **player skill issue**, isolating the aiming/throwing skill check from rock quality.

1. **Throw 1 — full guided walkthrough.** The directed sequence from `03-throwing.md`: pose, arc, attack angle, all narrated.
2. **Throw 2 — assisted.** Lighter touch. The player drives more; prompts step back.
3. **Throw 3 — solo, easy goal.** A generously attainable target, so the tutorial ends on an earned win, not a stumble.

### The implicit lesson

The tutorial rocks are never seen again. The player carries the felt memory of what a great skipping rock plays like, and the unspoken understanding that it may be a long time before they hold one again. This teaches **ephemerality and scarcity without a tooltip explaining it** — the mechanic teaches itself, consistent with the barebones-UI rule.

## Onboarding — decided

**The tutorial above IS the onboarding.** No separate tutorial system beyond the tuned practice-world pass described above.

### First-session sequence

1. Sign in, pick a username
2. Tutorial — one sift area, near-perfect rocks, three guided throws (above)
3. Free practice — full practice world, all 5 areas, no guidance
4. The daily, once the player is ready

**There is no unlock ladder.** Full throw complexity is live from the first throw onward — see `03-throwing.md`. The daily is the addiction loop, and it has to be the same skill test on day 1 as on day 100. Onboarding is carried entirely by the tutorial plus unlimited, stakes-free practice — not by staging which axes are available.

## Anti-cheat — MVP: plausibility checks only

**Server-side sim replay is deferred.** It's a large lift for an MVP with no player base, and it requires Level 2 (bit-exact) determinism.

**MVP approach: plausibility checks.** Reject impossible or absurd scores server-side without full replay. Cheap, and it covers the blatant cases.

**Post-MVP: server re-runs the sim.** Client submits inputs; server replays deterministically and confirms. Revisit when there's a player base worth cheating against, or when rooms are built — rooms need the same determinism anyway.

> Note: **Level 1 determinism (fixed timestep + seeded RNG) is still required for the MVP** — not for anti-cheat, but so that physics doesn't vary with the player's framerate. See `04-physics.md`.

Deferred implementation notes:

- Client submits: throw inputs + rock properties + seed — payload `TBD`
- Float divergence tolerance — `TBD`
- Rejection behaviour — `TBD`

## Platform

**Desktop only for the MVP.**

## OPEN

- Profanity filter approach — wordlist, third-party service, or manual review queue?
- Are usernames changeable?
- Google option shown first, or proprietary?
- Is there any preview of the pond before/behind the sign-in?
- Can a player skip straight to the daily, bypassing tutorial/practice?
- Can the tutorial be replayed on request?
- Submitted payload shape, float tolerance, rejection behaviour
- Accessibility — the throw uses two devices simultaneously; no plan yet
