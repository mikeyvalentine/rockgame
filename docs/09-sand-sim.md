# 09 · Sand Particle Sim

Adapt [SNOWFLOW](https://snowflow-lilac.vercel.app/) — a WebGPU snow particle study — restyled as **sand** instead of powdery snow.

**Status:** decided in principle, implementation open.

## Rendering target — decided

**WebGPU, with a WebGL fallback path** at reduced fidelity (simpler sand, fewer particles).

### Why a fallback is needed

SNOWFLOW requires WebGPU ("Chrome 113+ on a desktop GPU"). Support as of 2026:

| Browser | Support |
| --- | --- |
| Chrome / Edge | 113+ on Windows, macOS, ChromeOS |
| Chrome Android | 121+, Android 12+, Qualcomm/ARM GPUs only |
| Firefox | 141+ Windows; 145+ macOS **ARM64 only** |
| Safari | 26, on macOS Tahoe 26 / iOS 26+ |
| Linux | Incomplete across all browsers |

Without a fallback this breaks the *"runs on most computers"* pillar. Note also that "desktop GPU" implies integrated GPUs may struggle regardless of API support.

## Three uses

### 1. Rock field LOD — the strongest use

At standing distance, rock fields are **simple simulated particles.** Crouch into a small area and they become **full physics objects** you can click, drag and sift.

**The crouch is the LOD swap point.** It already exists in the design as a camera move, so the transition is hidden inside a motion the player already performs. This is what makes a physics-driven sifting minigame affordable at all — full rigid bodies across a whole shoreline is not viable.

**Risk:** the particle representation must resemble the rocks you then dig through. A visible pop at the swap would undercut it.

### 2. Movement trails

First person. Walk the shore and turn around to see your trails in the sand.

Low-stakes tactile pleasure, world feels responsive, no gameplay cost. Strong fit for the calm nature-sim mood.

### 3. Leaderboard drawn in the sand

Names raked into a **dedicated stretch of shore** you walk over to read. A place you visit.

Fits the clean-view HUD and the principle of UI living in the world rather than on top of it. Only one patch needs the effect.

**OPEN:** displacement shader vs. full particle sim. A displacement/height map with text stamped in and normal-mapped for lighting gets ~95% of the effect far cheaper, and — importantly for a leaderboard — **stays readable.** Particle-drawn text is hard to keep legible.

## Movement — REVISES the earlier no-WASD rule

**Free movement within a limited zone.**

- The walkable area is **one small coastal stretch — at most 1/8 of the pond's shoreline.**
- Travel between distinct areas still uses HUD / click navigation.
- Free walking exists inside the beach zone.

### Why the zone is bounded

If the whole shore were walkable and you can throw from anywhere, the degenerate strategy is to walk to whichever point is closest to today's cairn. **A bounded zone removes that** — position within the beach is a real choice, but you can never shortcut the distance.

It also bounds how much shoreline must be built to a walkable standard.

## Throwing position — REVISES the fixed throwing spot

**Throw from anywhere on the walkable shore.** The single fixed throwing spot is cut.

Position becomes a **macro layer of aim**:

| Scale | Control |
| --- | --- |
| Macro | Where you stand |
| Meso | The pose |
| Micro | The release point |

Where you stand changes your angle to the cairn and your line relative to wind and chop.

**Daily fairness is preserved** — everyone has the same walkable zone and the same options, so choosing a spot is a skill and knowledge decision, not a random advantage. Same principle as everyone having the same rocks available.

**Anti-cheat note:** throw origin becomes an input the server must validate.

## ⚠️ Performance: don't rely on "never simultaneous"

The assumption that the water sim and sand sim never run at once doesn't hold — they'll frequently be **in frame** together (standing on sand looking at water; throwing; sifting with water in view).

**But being in frame is not the same as simulating.**

> **Rely on the sand sim being pausable, not on co-occurrence.**

Sand only needs to *step* while the player is disturbing it. While aiming and throwing the player is stationary — freeze the sand state, keep rendering it, and give the GPU budget to the water.

## ⚠️ This makes the performance budget urgent

There is still no target framerate or floor spec. With two GPU-heavy systems in play, the budget must exist **before either sim is finalised.**

## 📝 Licensing

SNOWFLOW is someone else's project. **Check its licence or obtain permission before copying it.** Resolve this early, not after it's woven through the renderer.

## OPEN

- [ ] Leaderboard sand: displacement shader vs. particle sim
- [ ] How much fidelity the WebGL fallback keeps
- [ ] Exact walkable zone size and shape
- [ ] Does the leaderboard stretch sit inside the walkable zone?
- [ ] Particle → physics transition handling at the crouch
- [ ] SNOWFLOW licensing
