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

### The pile field — decided, built

A sifting spot is **terrain, not a prop**: a shingle mound baked into the height field.

`shared/pileField.js` holds the spots and the mound shape; `sand-sim/tools/pile-field-check.mjs` tests them. Four spots along the shingle band, one per baked bed variant in `public/assets/beds/shore.json`.

| | |
| --- | --- |
| Mound radius | 2.4 m — the shingle bank |
| Flat crown | 0.9 m — where the sift bed lands |
| Height | 0.30 m, an ~11° walkable face |

Three consequences worth knowing before touching it:

- **The height bake is the only insertion point, and it buys both halves.** `heightfield.heightCPU` is a readback of the bake rather than a second computation, so a mound term gives the rendered pile *and* `terrain.heightAt()` — the walker climbs the bank with no character-controller work. The deformation field is the wrong home: it is player-centred, toroidal and relaxing, built for footprints that should fade.
- **The crown must stay flat**, and it is flat by construction rather than by luck — the mound suppresses micro relief under itself. rock-sift pours its bed on flat ground, so a domed crown floats stones on one side and buries them on the other.
- **The mask goes in the aux bake's B channel**, the old pebble band, which already drives voronoi cobble shading. That is what keeps the bank reading as stone from standing distance — the direct answer to the pop risk above.

**The piles are visible on WebGPU only — decided.** Measured in the browser: the WebGL beach is one 256² grid over 512 m, so a 2.4 m mound gets **4 vertices** and the bank is effectively not drawn. Grounding is exact on both paths (it reads `shoreProfileJS` directly), so on the fallback the walker steps up onto a bank that isn't really there. Making it visible would mean local dense patches *and* a GLSL port of the pebble shading — the fallback has no aux texture and no cobble path — and that is not worth doing before the throw is proven fun. Note the cost honestly: docs/10 records that on the floor spec WebGL is the Safari and Firefox path, so this is most browsers on that machine, not an edge case.

The broader "how much fidelity the fallback keeps" question stays open; this settles the piles only.

### The stones — built

`sand-sim/src/scene/siftingBeds.js` draws rock-sift's baked beds on the crowns: 2160 stones across four spots, one bed variant each, no physics. `tools/bed-load-check.mjs` covers it.

Nothing crosses the Babylon boundary. rock-sift is on `@babylonjs/core` 8.56 and sand-sim on 9.18, so sand-sim regenerates the cast from `rock-forge` (pure JS) and decodes the bed with `shared/bedFormat.js` (DataView only), then builds meshes with its own Babylon. The forge is deterministic, so same seed and count gives the same forty stones — and the bed's stored *names* are what proves it, resolved stone by stone in the check.

Two costs that had to be measured rather than assumed:

- **Scenery LOD.** rock-sift draws at icosphere level 3 (1280 tris) because the player is crouched over the bed. At standing distance level 2 is indistinguishable and four times cheaper. This is the rock-field LOD above, in its cheapest form — the detailed bed is what the crouch swaps in.
- **One mesh per (archetype, spot).** Babylon frustum-tests a thin-instanced mesh by the bounds of *all* its instances, so merging the four spots per archetype means nothing ever culls. Measured: 2,764,800 triangles submitted from anywhere on the beach, against a 131k beach. Split per spot and dropped to scenery LOD: **172,800 with a bed in view, 0 with none.**

Still open at the swap: the crouch handoff itself.

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
