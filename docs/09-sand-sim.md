# 09 · Sand Particle Sim

Adapt [SNOWFLOW](https://snowflow-lilac.vercel.app/) — a WebGPU snow particle study — restyled as **sand** instead of powdery snow.

**Status:** rendering and movement decided; the rock-field LOD is built (pads, beds, crouch, sifting). The particle sim and the sand leaderboard remain open.

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

### The sift pad — decided, built

A sifting spot is **terrain, not a prop** — but it is not a *mound* either.

There was a shingle mound here: a 2.4 m bank, 30 cm tall, with the bed on its
flat crown. It is gone, by decision. A bank you climb reads as level design, and
the stones are meant to be part of the beach rather than a heap placed on it.

What survives is the part that was never about height. `shared/siftPad.js` holds
the spots and a **level pad**: it cancels the foreshore ramp under itself and
damps micro relief in proportion to its coverage, and adds no height at all.
`sand-sim/tools/sift-pad-check.mjs` tests it. Four spots along the shingle band,
one per baked bed variant in `public/assets/beds/shore.json`.

| | |
| --- | --- |
| Flat region | 1.35 x 0.90 m half-extents — where the bed lands |
| Feather | 1.30 m of blend out to the beach's own ramp |
| Height added | none |

Three consequences worth knowing before touching it:

- **The pad is rectangular**, half-extents rather than a radius, because the
  stones are meant to spread along the beach later. A strip is then a bigger
  `PAD_HALF_X`, not a new concept — and the ramp correction depends only on z,
  so widening along the shore costs nothing.
- **Levelling is a correctness requirement, not styling.** rock-sift pours its
  bed on flat ground under vertical gravity and the crouch simulates it on a
  flat static box. The beach rises at 2°, which across the bed is 39 mm of tilt
  against stones 40 to 100 mm across — a bed poured flat and laid on that ramp
  floats its seaward edge by half a stone.
- **The height bake is the only insertion point, and it buys both halves.**
  `heightfield.heightCPU` is a readback of the bake rather than a second
  computation, so the pad term gives the rendered surface *and*
  `terrain.heightAt()`. The deformation field is the wrong home: it is
  player-centred, toroidal and relaxing, built for footprints that should fade.

**Nothing shades as shingle.** The beach is sand everywhere, by decision — the
aux bake's B channel is zero and the voronoi cobble path is unused. The old
arrangement painted a stone texture under each spot so a distant mound read as
stone; with no mound, and the stones themselves drawn on the pad, that was a
rocky patch of beach with rocks on it.

Because the pad has no height, **the WebGL fallback no longer loses anything
here.** The old note recorded that a 2.4 m mound got 4 vertices on the fallback's
256² grid and was effectively not drawn, so the walker climbed a bank that was
not there. A level pad is a couple of centimetres of correction over more than a
metre; both renderers now agree to within their own smoothing.

### The stones — built

`sand-sim/src/scene/siftingBeds.js` draws rock-sift's baked beds on the pads: 2480 stones across four spots, one bed variant each, no physics. `tools/bed-load-check.mjs` covers it.

**One layer, not a heap — decided.** The bed used to be 540 stones poured into a 0.38 m disc, about four deep, and it read as a mound to excavate. It is now 620 stones over a 2.0 x 1.1 m rectangle: a single tightly packed sheet, stones touching and slightly overlapping, each pressing its own dent into the sand. Median stone centre sits 24 mm above the sand against a mean stone radius near 30 mm, which is one layer by arithmetic rather than by eye; `bed-load-check` asserts it so the bed cannot drift back into a heap unnoticed.

**The stones are drawn by the forge's own material.** `sand-sim/src/scene/rockMaterials.js` builds rock-forge's `createRockMaterials` in a new **real-geometry mode**: the mesh already is the rock, so the shape-texture vertex half is skipped and the whole fragment surfacing scheme — triplanar photographed albedo, normal and AO from `public/assets/rock`, the procedural grain and variation maps, cavity darkening and the mottle/vein/spot/band adders — is kept. The per-stone tint travels as vertex colours instead of as an instance attribute. One material per lithology, not per stone. `tools/rock-material-check.mjs` covers both dialects.

Nothing crosses the Babylon boundary: sand-sim regenerates the cast from `rock-forge` (pure JS) and decodes the bed with `shared/bedFormat.js` (DataView only), then builds meshes with its own Babylon. That was forced at the time — rock-sift was on `@babylonjs/core` 8.56 against sand-sim's 9.18 — and it is worth keeping now the two are both on 9.18, because it means the beach carries no physics engine to draw scenery. The forge is deterministic, so same seed and count gives the same forty stones — and the bed's stored *names* are what proves it, resolved stone by stone in the check.

Two costs that had to be measured rather than assumed:

- **Scenery LOD.** rock-sift draws at icosphere level 3 (1280 tris) because the player is crouched over the bed. At standing distance level 2 is indistinguishable and four times cheaper. This is the rock-field LOD above, in its cheapest form — the detailed bed is what the crouch swaps in.
- **One mesh per (archetype, spot).** Babylon frustum-tests a thin-instanced mesh by the bounds of *all* its instances, so merging the four spots per archetype means nothing ever culls. Measured: 2,764,800 triangles submitted from anywhere on the beach, against a 131k beach. Split per spot and dropped to scenery LOD: **172,800 with a bed in view, 0 with none.**

### The crouch — built

Stand at a spot, press E, and the camera kneels to the stones while that spot's bed wakes into physics behind the move. Press E again — or Escape — to stand back up. **One scene throughout** — there is nothing to build, nothing to fetch, and no scene to swap.

**The cursor is the tool, so the crouch gives it back.** Walking is mouse-look under pointer lock; sifting is not. rock-sift drives sweeping, dragging and examining from `scene.pointerX/Y`, which under pointer lock never moves — so a crouch that kept the lock left the camera turning and the bed inert, which read as the sifting being broken. Crouching therefore releases pointer lock (and suppresses the canvas click handler that would grab it straight back), pins the view at **65° down**, and allows ±22° of yaw and ±14° of pitch so the far edge of the bed is reachable by leaning rather than by standing up. Standing up takes the lock again, on the way up rather than at the start of the rise, so the last click on a stone is not swallowed.

That last point is the whole design. Because it is the beach's own scene:

- the bed rests on the beach's terrain, not on a lab floor;
- the sand under it is the sand the player walked over;
- anything a stone does can reach the deformation field, so a stone thrown aside can dent the sand the way a footstep does.

**1:1 metres works — measured.** rock-sift models at 4x to stay clear of Havok's collision margins, so this had to be tested rather than assumed. Running its own suite at `U = 1`: sweeping, carrying, bucket and winding all pass; only settling a *poured* bed regresses (6 stones creeping against ~0). The game never pours — it restores baked beds, and pouring is `npm run bake`, offline, still at 4x. So the 4x world is a bake-time convenience, not a runtime requirement.

**Why there is no loading.** Havok's wasm and the forty convex hulls are built during the beach's own load — measured at ~650 ms, once. Crouching then costs only the swap: **~130 ms for 620 bodies**, against a transition of 1.1 s. `rock-sift/src/shore.js` reached the same conclusion about its own swap: "comfortably inside one frame of a transition that lasts about a second, so there is nothing to hide behind a loading screen."

**"Pausing the sim" means freezing the walker, not the world.** Input, locomotion and footfall contact stop, because the player is knelt down. Everything the stones touch keeps running — which is the entire reason for being in this scene. The performance note asks for a sand sim that only steps while the player disturbs it; while crouched, the disturbance is the bed rather than the boots.

The ground collider is a single static box with its top face exactly at the sand, and *exact* is the word: the pad makes that patch of beach a true horizontal plane. It is sized to the pad rather than generously, because level is only true inside the pad — a wider box would be a flat shelf under sloping sand. rock-sift's note on why a trimesh is wrong here still applies: convex hulls catch on the internal edges between triangles and the bed never rests.

**Sweeping is rock-sift's, not a second copy.** `hand.js`, `examine.js` and `interaction.js` are constructed against sand-sim's camera and the woken bed at `unitScale: 1` — reusable because their scale turned out to be a parameter in all but name (every constant is authored in metres and multiplied by `U` at the point of use). rock-sift's own five Havok tests pass unchanged at the default, which is what says the change was safe.

That needed the awake bed to be pickable: the sweep works by picking the stone under the pointer, and thin instances cannot be picked individually. So the awake spot swaps its scenery for `createInstance` nodes carrying `metadata.rock` — rock-sift's own arrangement — while the other three spots stay on thin instances and cost nothing.

Verified in a browser: picking at screen centre returns a real stone, and a pointer drag across the bed displaces stones by up to 364 mm.

Files: `scene/crouch.js` (the transition), `scene/siftPhysics.js` (the two bed states and the swap), `scene/siftInteraction.js` (the sweep, wired), tested by `tools/sift-physics-check.mjs`. Both renderers carry it.

Not wired yet: the bucket and a sift HUD. Sweeping, carrying and examining are what make a bed a bed; keeping what you find is the economy, and that wants docs/02 read properly first.

**Divots persist, and they are drawn — built.** Two requirements that wanted two mechanisms, which is what an earlier version got wrong by treating "it must persist" as ruling the deformation field out and letting that quietly forfeit *visibility* as well:

- `shared/spotImprint.js` **remembers**, and does not draw. A small fixed grid per spot, world-anchored, that never relaxes and never scrolls — 256² over 4 m is 1.6 cm texels and 256 KB a spot. The terrain is wrapped rather than patched, so everything that grounds sees the dug surface.
- The `DeformationField` **draws**, and forgets. Its own header settles it: everything that touches the sand writes through `brush()`. A stone is just another thing that touches the sand.

So a dent is written to both, and re-stamped into the field when the player comes back — on crouching, and on a slow tick while walking within 14 m, because the field relaxes and a bed you are walking towards would otherwise be flat sand until you knelt.

The bed's own imprint falls out of the same layer: every stone's resting position is in the bed file, so the sand it has been sitting in is *derived* rather than authored, and deterministic for a given bed. Measured on `shore-0`: **608 of 620 stones** touch the sand, pressing it 16.4 mm at the deepest over 13.7% of the layer. Nearly all of them, because the bed is one layer — the old four-deep heap pressed 308 of 540. Presses combine with `max` and not `+=`, so two stones in one dip make one dip and the bake is order-independent.

**One thing designed for but not yet built:**

- **Spots are no longer circular, and the rest should follow.** The pad, the imprint layer and the pour are all rectangular now, so spreading stones along the beach is a matter of widening `PAD_HALF_X` and `POOL_HALF_X` rather than replacing a concept. Nothing new should compute `distance < radius` inline.

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
