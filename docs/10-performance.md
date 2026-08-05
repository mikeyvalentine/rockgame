# 10 · Performance Budget

## Floor spec — 2020 Intel MacBook

Reference machine: **2020 MacBook Air (Intel) / MacBook Pro 13" (Intel)** — Ice Lake, **Intel Iris Plus Graphics G7** integrated, roughly 1.0–1.1 TFLOPS.

### ⚠️ WebGPU on this machine is effectively Chrome-only

| Browser | WebGPU on a 2020 Intel Mac |
| --- | --- |
| Chrome / Edge | **Yes** — 113+, via Metal |
| Safari | **Only** if the machine runs macOS Tahoe 26 — and Tahoe dropped most 2020 Intel Macs. The 2020 MacBook Air is **not** supported; the 13" MacBook Pro is supported **only** in the 4-Thunderbolt-port variant |
| Firefox | **No** — macOS WebGPU is ARM64 only |

**Consequence: the WebGL fallback is not optional.** On the exact machine named as the floor, it is the Safari and Firefox path. Budget for it as a first-class renderer, not a courtesy.

## Framerate targets

**60fps is a hard floor during the throw.** No compromise — it's the timing-critical moment.

### Budget by activity, not globally

The game's moments have very different needs, and conveniently the most demanding one is also the cheapest to render.

| Activity | Target | Why |
| --- | --- | --- |
| Standing / looking | 30–60 | A person looking at a pond |
| Free movement (sand sim active) | 30–60 | The expensive state — sand is stepping |
| Sifting | 60 | Direct manipulation of physics objects |
| Pose modals | 30 | Essentially static 2D |
| **Arc drag / release / drift** | **60 hard** | Precision timing with continuous correction on two devices |
| Skip camera | 30–60 | Bullet time means less motion per frame, so a lower rate is less visible |

**The throw is the cheapest moment by design:** the sand sim is frozen, the pose modals are 2D. That's what makes a hard 60 on integrated graphics plausible.

## Why framerate is a fairness question here

Physics runs on a fixed timestep decoupled from rendering (required for determinism and server validation). So **a 30fps player gets identical physics to a 144fps player.**

What differs is **input resolution**, and that matters in exactly two places: hitting the release sweet spot, and correcting the attack-angle drift.

- If the sweet-spot window is 100ms wide, a 30fps player has 3 frames to hit it; a 60fps player has 6
- Drift correction bandwidth must sit comfortably under the floor framerate, or low-end players genuinely cannot fight the drift

**Therefore:** either derive the framerate floor from the sweet-spot window width, or size the window so the floor stays fair. These two numbers must be set together.

## Millisecond budget

60fps = **16.6ms**. Example allocation during the throw, to be replaced with measured values:

| System | Budget |
| --- | --- |
| Sand sim | **0ms — frozen** |
| Water sim | `TBD` |
| Scene render (trees, terrain, rock LOD) | `TBD` |
| Rock physics | `TBD` |
| UI / post | `TBD` |
| Headroom | `TBD` |

During free movement (sand active) at 30fps = 33.3ms, the sand sim gets its own allocation.

A millisecond budget is enforceable in a way that "should run well" is not. *"The water sim gets 4ms"* governs decisions; a vague target doesn't.

## The sand sim must be pausable

Do not rely on the water and sand sims never co-occurring — they are frequently in frame together. Rely instead on the sand sim only *stepping* while the player disturbs it. Freeze and render otherwise.

This is what buys the throw its budget.

## Resolution is the biggest lever

On integrated graphics, **render resolution dominates everything else.** Rendering at native Retina on an Iris Plus G7 would be brutal.

Render at 1x or 1.5x and upscale. This is a fixed choice, not adaptive quality.

## ⚠️ Fixed quality caps the ceiling

**Decided: fixed quality, no runtime adaptive scaling.**

Consequence to accept consciously: **the floor machine determines the ceiling.** If the sand sim must hit 60fps on an Iris Plus G7, that particle budget applies to everyone — including players with high-end GPUs.

### Alternative worth considering

**Startup tier detection** — not dynamic scaling. Detect the machine once at launch and select a quality tier that stays fixed for the session.

This preserves what makes fixed quality desirable (runs are reproducible, nothing shifts mid-session, no rubber-banding) while removing the floor-caps-ceiling problem. It's a different thing from adaptive quality and it may be worth revisiting.

## The concrete next action

**Measure the existing water sim on the floor machine, in milliseconds per frame.**

Everything else is speculation until that number exists — it determines how much budget remains for sand, trees, rocks and UI.

## OPEN

- [ ] Measure the water sim on the floor machine
- [ ] Set the ms budget from that measurement
- [ ] Decide sweet-spot window width alongside the framerate floor
- [ ] Render resolution / upscale factor
- [ ] Reconsider startup tier detection vs. strictly fixed quality
- [ ] How much fidelity the WebGL fallback keeps
- [ ] Is a 2020 MacBook Air (Intel) acceptable as floor given it can't run Safari WebGPU at all?

## Sources

- [macOS Tahoe 26 compatibility list — EveryMac](https://everymac.com/mac-answers/macos-26-tahoe-faq/macos-tahoe-macos-26-compatbility-list-system-requirements.html)
- [WebGPU is now supported in major browsers — web.dev](https://web.dev/blog/webgpu-supported-major-browsers)
