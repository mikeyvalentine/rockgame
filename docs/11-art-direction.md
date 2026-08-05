# 11 · Art Direction

## Target

**Semi-realistic, stylized as a mid-2000s Wii-era look.**

Rendering artifacts of that era — **aliasing and similar — are kept deliberately and contribute to the look.** They are not defects to be corrected.

## ⭐ The art direction pays for itself

The chosen aesthetic and the floor spec (2020 Intel MacBook, Iris Plus G7) point the same direction. Exploit this everywhere.

| Wii-era choice | Performance effect |
| --- | --- |
| Aliasing kept as style | **No MSAA / TAA needed** — one of the biggest costs simply removed |
| Period-correct softness | **Lower render resolution is stylistically defensible**, not a compromise |
| Simple shading models | Cheap fragment work |
| Baked / simple lighting | No expensive dynamic global illumination |
| Strong silhouettes over dense geometry | Lower poly counts, better readability at 200m |
| Simple specular water | Avoids screen-space reflections, the most expensive water technique |

**Rule:** when a rendering shortcut is available, check whether it's period-correct before treating it as a compromise. Usually it is.

## Water — decided

**Semi-realistic, Wii-era stylized.** Not photoreal, not painterly, not flat-shaded toon.

Water is most of the screen and most of the GPU budget. Avoid:

- Screen-space reflections
- High-resolution normal/displacement passes
- Full refraction

Prefer simple specular, low-cost normals, and a readable surface at 200m.

## Palette — decided

**Cool greens and blues.** Classic temperate pond — green trees, blue-green water, grey stones.

Guard against generic: let the rock and the score number be the only strongly saturated things on screen.

- Water — `TBD`
- Sky / horizon — `TBD`
- Trees / foliage — `TBD`
- Sand — `TBD`
- Stone — `TBD`
- UI foreground — `TBD`
- UI background — `TBD`
- Accent — `TBD`

## Hero look — early morning

The time of day designed first, and used for marketing and the share card.

**Low sun, mist on the water, glassy surface.**

Two reasons this is the right hero:

1. **It matches the real sport** — record skips happen on dead-calm mornings
2. **Glassy water is the cheapest water to render** — less displacement, simpler normals. The hero shot is also the cheapest frame

Day/night is real-time synced, so all times must work, but early morning is the reference.

## Typography

- **Stefan Bubble** — scores only. Childlike, friendly, satisfying on the count-up.
- Body typeface — `TBD`

## DECIDE IN ENGINE

**Stylization layer — cel shading, pastel grade, or neither.** Deliberately deferred: this needs to be seen running before it can be judged. Do not pick one on paper.

Context for when it's evaluated: a cel/toon shader fights the semi-realistic Wii target, while a soft pastel colour grade is compatible with it and costs almost nothing.

## OPEN

- All palette hex values
- Body typeface
- Tree treatment — how stylized, and how they read when swaying for wind
- Mist rendering approach (cheap on the floor machine?)
- How the moonlit night state relates to the cool-greens-and-blues palette
- Sand look, given it's a particle sim (see `09-sand-sim.md`)

## Anti-goals

- Nothing photoreal
- No urgency or pressure cues
- No competitive-esports UI language
- Don't "fix" aliasing — it's part of the look
