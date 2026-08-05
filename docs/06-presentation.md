# 06 · UI, Audio & Share Card

## UI — decided

### HUD density: clean view

**Nothing on screen while standing and looking around.** Information appears only when the player is doing something.

The default state of the game is a person looking at a pond, not a person reading an interface.

### Conditions readout

**Small numeric readout plus visual indicators.**

- Wind — flag/windsock, trees swaying, surface streaks, drifting particles
- Chop — simple wave-peak line

The number is the truth; the indicator is the glance. This is what makes environment cosmetics fairness-safe: conditions are read as data, not inferred from visuals.

### Score count-up

**Overlaid on the skip camera.** Large Stefan Bubble number on top of the live footage, climbing as the rock skips.

Score and spectacle in one frame. The number stops when the daylight between splashes closes, so the count-up has a built-in ending.

### Typography

- **Stefan Bubble** — scores only. Childlike, friendly.
- Body typeface — `TBD`

### Screens to design

None designed yet.

Standing / free look · Sift field (crouched) · Rock inspection · Bucket / selection · Pose modal side · Pose modal top · Arc + release with sweet spot · Attack angle control · Skip camera + score overlay · Result / share · Leaderboard · Account / username · Practice entry

## Audio — decided

Sound design is a core pillar, not a polish pass. It carries the calm nature-sim mood.

### Music: sparse, at moments

Silence most of the time. Music enters at specific beats rather than running continuously.

### The skip sound — the signature

**Realistic water contact, overlaid with a melodic bell chime.** The chime **rises in pitch as the skip count climbs.**

Two layers per skip: the honest physical plip, and a musical event on top.

This makes the run *audibly* legible — a long run sounds like it's ascending, and the ear tracks the count without watching. The pitty-pat death has a natural sound as the chimes crowd together and the pitch stalls. Pairs directly with the on-screen count-up.

**The chimes must stop when the daylight rule stops the count.** Audio and scoring must agree.

### Reactive audio: time of day only

The soundscape changes with time of day. **Wind and chop do not change it.**

Since day/night is real-time synced, a 3am player hears a genuinely different pond.

### Still to define

Water ambience · wind in trees · rock handling (sifting, picking up, dropping in bucket) · the throw itself · splash on landing · big splash for heavy rocks · cairn hit · UI clicks ("satisfying buttons" is a requirement) · result moment

## Share card — decided

### Image

**The player's customised forearm, palm up, holding the rock that won the day.**

- Zero new art — the arm exists for the pose modals, the rock is procedurally generated
- A natural trophy pose, universally readable
- The rock appears **skinned** (skins apply from throw onward)

> ⚠️ **Unresolved conflict with the universal daily rock (`05-scoring.md`):** this section was written when each player threw their own sifted rock, so "every card is unique because rocks are procedurally generated" was true by construction. Now every player throws the *same* seeded rock on a given day — same shape, same silhouette, for everyone. Uniqueness would have to come entirely from cosmetics (skin colour/material, arm customization), not the rock itself. Does that hold as the story, or does the rock need some per-player cosmetic shape variance to keep cards distinct? Flagging, not deciding.

**Without multiplayer, this is the only place anyone else sees your cosmetics** — which makes it the store's entire discovery channel.

### Text line

Images don't paste into a group chat as text, and text is what makes daily results spread.

**Ship both.** Example text form:

```
ROCK 148 — 23 skips ×2 → 46 · 31.4m
```

### Production notes

- Render client-side from the actual rock geometry — must show *the* rock
- Fixed lighting rig and framing so cards are consistent as a set
- Stats legible at phone size; the skip number is the largest element

## OPEN

- Body typeface
- Exact units for wind and chop
- Where the conditions readout sits, and how it's summoned given the clean view
- Is the flag diegetic or a HUD element?
- Score number position and behaviour within the frame; how the ×2 appears
- Does the pitch reset each throw? What happens at very high counts — cap, octave-wrap, keep climbing?
- Chime timbre — bell, glass, chime bar
- Time-of-day audio states and whether transitions crossfade
- Share card backdrop — pond or neutral?
- Does the card show the daily number and date?
