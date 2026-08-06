# Paused work — findings, 2026-08-05

Written so the investigation does not have to be repeated. Each section is something
that was started or scoped and then stopped, with what was learned and where the next
person should put their hands.

Everything here is measured or read out of the code, not assumed.

---

## 1. The forge material port — done, in sand-sim

**Goal:** make the sift bed shade its stones the way `rock-forge` does, so it looks
like the lab instead of like flat grey pebbles.

**Status:** ✅ built, for sand-sim's beds. `rock-forge/src/babylon/rockMaterial.js`
gained a **real-geometry mode** (`realGeometry: true`) and sand-sim's
`scene/rockMaterials.js` uses it; `sand-sim/tools/rock-material-check.mjs` covers it.
The analysis below was right about the problem and half right about the fix — the
resolution is at the end of this section.

`rock-sift`'s own lab still uses its plain per-stone `PBRMaterial`. Nothing forces it
to; the mode is there whenever that becomes worth doing.

### Why it does not just wire up

`rock-forge`'s vertex shader is built around the forge's *memory scheme*: one shared
unit sphere whose per-vertex radius is read from a "shape texture". So:

- vertices arrive as **unit directions**, and the shader does
  `positionUpdated = positionUpdated * rockShape.w`
  (`rock-forge/src/babylon/rockMaterial.js`, `CUSTOM_VERTEX_UPDATE_POSITION`).
- `rock-sift` has genuine per-stone meshes — Havok needs them, and so does the skip
  solver — so multiplying its real positions by a texture radius mangles them.

**`bypassShapeTexture` is not the escape hatch it looks like.** It is a debug bisect:
it substitutes `vec4(normalize(positionUpdated), 0.42)`, i.e. draws a plain sphere at
a fixed radius, to tell a bad texture fetch from a mesh that never drew. Turning it on
would make every rock a ball.

### The three attributes

`rockMaterial.js:126` — `getAttributes` pushes `vertIndex`, `rockInst`, `rockVar`.

`vRockTint = rockInst.yzw;` runs **unconditionally**, outside any bypass branch. If the
attribute is not supplied Babylon feeds zeros, so the tint is black and every stone
renders black. Any real-geometry path must still provide `rockInst`.

### The cloning dead end

Per-stone colour was attempted by cloning the family material and setting
`albedoColor`. `PBRMaterial.clone()` calls `_clonePlugins`, which reaches for `window`:

```
ReferenceError: window is not defined
  at InstantiationTools.Instantiate (.../instantiationTools.js:22)
  at Material._ParsePlugins (.../material.js:1486)
  at PBRMaterial.clone (.../pbrMaterial.js:375)
```

That took all 5 of rock-sift's headless tests from passing to failing at once. Cloning
is not available to any code path that has to run under `NullEngine`.

### What the work actually is

1. Add a **real-geometry mode** to `createRockMaterials` — a third branch in
   `CUSTOM_VERTEX_UPDATE_POSITION` that leaves `positionUpdated` and `normalUpdated`
   alone and sets `vRockNrm` from the authored normal. Everything downstream (albedo,
   triplanar photo surfaces, grain, mottle/vein, displacement, polish) is unaffected.
2. Feed `rockInst` (and `rockVar`) per instance in rock-sift. Babylon's
   `mesh.registerInstancedBuffer("rockInst", 4)` is the mechanism; `InstancedMesh`
   copies the source mesh's value at creation, so setting it on the archetype mesh
   before instancing should propagate.
3. Carry per-stone tint through `rockInst.yzw` — **not** through a material clone.

### How it was actually resolved

Step 1 above was right and is what shipped: `realGeometry: true` skips the vertex half
entirely rather than adding a third branch to it, since with real geometry there is
nothing for that half to do. `vRockObj` comes from the mesh's own position (already in
metres), `vRockNrm` from its own normal.

Steps 2 and 3 were the wrong shape, and the reason is worth keeping. `rockInst` exists
to carry a per-*instance* tint through a shared unit sphere; a real-geometry mesh is
already per-stone, so the tint has a much simpler home — **vertex colours**. PBR folds
`vColor.rgb` into `surfaceAlbedo` before the plugin's fragment hook runs, so the
photograph multiplies it with exactly the arithmetic the instanced branch does. No
instanced buffer to register, no attribute that silently reads zero, and no material
clone: **one material per lithology**, seven programs rather than forty.

Two things the original analysis did not reach, both discovered building it:

- **WGSL is not optional.** `MaterialPluginManager` *throws* when a plugin is added to
  a material whose shader language it does not claim, and `PBRMaterial` picks WGSL by
  itself the moment the engine is WebGPU. A GLSL-only plugin does not degrade there —
  it takes the scene down at construction. Real-geometry mode therefore emits both
  dialects. (`forceGLSL` works too, and costs a CDN fetch of glslang at first compile.)
- **The stones were black for a second reason as well.** sand-sim's WebGPU scene had
  no lights at all, correctly — terrain, sky, water and spray all light themselves in
  WGSL. A PBR mesh in a scene with no lights is black whatever its material says. Both
  causes had to go.

---

## 2. sand-sim × rock-sift integration — built

**Goal:** rock piles visible in the sand sim, walkable in first person, click to crouch
into sifting.

**Status:** all three slices built, tested and seen running.

### The DeformationField is the wrong tool

`sand-sim/src/terrain/deformation.js` looks like the obvious home and is not:

- `COVERAGE = 80` metres, a window **centred on the player**, toroidally addressed.
- `MAX_BRUSHES = 96` per frame.
- It **relaxes** (`RELAX_STEP`, `_relaxOwed`). It is built for footprints, surf wake
  and spells — transient marks that should fade.

Rock piles are permanent terrain. Written here they would smooth away, and vanish
entirely once the player walked off the window.

### The right insertion point, and why it is only one place

`sand-sim/src/terrain/heightfield.js` bakes `heightTex` once from the beach params
(WGSL). Critically, line 11:

> `heightCPU  Float32Array mirror of heightTex, read back once.`

`heightCPU` is a **readback** (`heightfield.js:164`), not an independent computation.
So adding mound terms to the WGSL height bake gives you *both*:

- the terrain **renders** the piles, and
- `terrain.heightAt()` returns pile height — so the player **walks up them for free**.

`character/controller.js:89-92` already damps `position.y` toward
`terrain.heightAt(x, z)` and reads `normalAt` every frame. No character-controller work
is required at all. `terrain.js:403` is a straight pass-through to the heightfield.

The codebase already has the discipline for this:

> "The beach profile, from the shared params module — the WGSL bake and the JS twin
> (`shoreProfileJS`) must describe the same shore."

Piles follow the same twin pattern.

### Slices

1. **Pile field.** ✅ Built, then deliberately flattened. `shared/pileField.js` became
   `shared/siftPad.js`: the mound is gone and only the levelling survives. See
   docs/09 · "The sift pad".
2. **Rock instances.** ✅ Built. `sand-sim/src/scene/siftingBeds.js` — 2480 stones
   across four spots, drawn and culled, no physics, shaded by the forge material.
3. **Crouch transition.** ✅ Built. Stand at a spot, press E, sift; E or Escape comes
   back. The walker freezes; everything the stones touch keeps running.

**Everything below this line describes the mound**, which no longer exists. It is kept
because the reasoning about *where* a spot belongs in the pipeline — the height bake,
not the deformation field — is unchanged and was the expensive part to work out.

### Slice 1, as built

`shared/pileField.js` is the single source of truth: four spots along the shingle
band, a C1 radial falloff, and `pileCoverage/pileHeightJS/pileMaskJS/spotAt`.
`sand-sim/tools/pile-field-check.mjs` covers it (30 assertions, in `npm test`).

Three things the plan above did not anticipate, all of them found by writing the
test rather than by reasoning:

**The crown has to be flat, and flat is a correctness requirement.** rock-sift
pours its bed on flat ground (`config.js`: "the ground is flat and the pile is
allowed to find its own angle of repose"). A baked bed restored onto a dome has
stones floating on the high side and buried on the low one. So the falloff
saturates over an inner `CROWN_RADIUS` (0.9 m, clear of rock-sift's 0.42 m
`BED_RADIUS`) instead of peaking at a point, **and the mound damps micro relief
under itself in the same proportion as it rises** — otherwise the crown carries
the beach's own ±0.09 m of noise.

*Corrected while building slice 2:* flattening the noise was only half of it.
The beach itself rises at `FORESHORE_SLOPE`, which across a 1.4 m bed is **48 mm
of tilt** — and rock-sift's stones are 40 to 100 mm across, so the seaward edge
of a bed poured flat floats by half a stone. The pile now cancels the ramp under
itself (`pileLift`), making the crown a true horizontal plateau: the drawn
surface measures **0.000 mm** across the bed footprint. The grounding mirror
still reads 23 mm because its 0.5 m B-spline drags the bank face inward, which
is the character's business and well inside the micro relief it walks on
anyway — the two are now checked separately, because conflating them is exactly
how the ramp survived the first pass.

Levelling also keeps the crouch honest: rock-sift simulates the bed on flat
ground under vertical gravity, so a level crown is the one that will not pop at
the handoff.

**A pile the size of the bed is invisible to the terrain.** The bake is 0.25
m/texel and the CPU mirror the walker grounds on is 0.5 m/texel, then bicubic
B-spline reconstructed. A 0.42 m mound would be filtered away and the player
would walk through a bank they can see. `PILE_RADIUS` is 2.4 m — the mound is
the *shingle bank*, and the sift bed occupies its crown. The test asserts this
against a faithful stand-in for `_readback` + `heightAt`, not against the
analytic profile, because analytic flatness proves nothing about what the
character actually stands on.

**The pile belongs in the aux bake too.** `auxBake`'s B channel — the pebble
band, deliberately zeroed since the open beach is all sand — already drives a
voronoi cobble shading path. Writing the pile mask there makes the bank *shade*
as shingle from standing distance for free, which is the direct answer to
docs/09's stated risk that the crouch pops between a smooth sand lump and a bed
of stones.

**No uniforms.** The WGSL is generated from the JS constants
(`pileFieldWGSL()`), registered as the `snowPiles` include, and unrolled to one
`max` per spot. So there is no uniform array to bind, no runtime indexing of a
const array, and the twin problem the beach profile lives with — WGSL and JS
kept in structural agreement by hand — does not exist here at all. Both
renderers read the same four numbers.

Pile height sits **outside** `macroHeightScale`: the piles are where the player
sifts, so their geometry is level design rather than an art-direction tunable.

### Verified in a browser, and what it turned up

Driven headlessly through the app's own `SANDSIM` hook on `?webgl=1`. The live
`terrain.heightAt` around the eastern spot:

| | |
|---|---|
| crown | 0.594 m |
| crown edge, 0.8 m | 0.622 m (the foreshore's own ramp, not a dome) |
| mid-face, 1.65 m | 0.419 m |
| rim, 2.4 m | 0.2445 m |
| open beach, 9 m | 0.2445 m |

Rim and open beach agree to four decimals — the mound closes exactly where it
should. The walker climbs it with no controller work, as predicted: `player
11.50 0.59 -8.40` on the crown against `player 2.50 0.26 -8.40` at the same z
on open sand.

**The WGSL bake is still not compile-verified.** WebGPU cannot run in a
container: SwiftShader's Vulkan refuses the bake's 4 MB allocations
(`createBuffer failed, size (4194304) is too large for the implementation`) and
the adapter drops out. The generated include does parse clean as WGSL under
`wgsl_reflect`, which rules out syntax but not Babylon's preprocessor or Dawn.
First run on real hardware is still the real check.

**The piles are WebGPU-only, by decision.** The WebGL beach is a single 256²
grid over 512 m, so a 2.4 m mound gets **4 vertices** (nearest 0.64 m from the
crown, measured off the live mesh) and the bank is not meaningfully drawn —
while grounding stays exact, so the fallback walks you up a step that isn't
there. Fixing it needs local dense patches *and* a GLSL port of the pebble
shading, since the fallback has neither an aux texture nor the voronoi cobble
path. Deliberately not done. See docs/09.

### Slice 3, as built

`rock-sift/src/main.js` gave up everything below the engine to a new
`world.js`, so the lab page and sand-sim build the *same* sift mode instead of
two of them. sand-sim's `scene/siftSession.js` opens it as a second scene and
stops the beach dead — no render, no character, no deformation, no input —
which is the pausable-sand-sim arrangement docs/10 asks for and what makes a
full Havok bed affordable.

A handoff rather than a merge, because the two worlds do not share a scale: 512
m of terrain in metres against 80 cm of stones modelled at 4x.

**Escape was being swallowed.** `shore.leave()` returns early while a tween is
running, so a press during the crouch transition did nothing and the player had
to notice and press again. It is not a narrow window — the transition is 1.1 s
of tween time and `world.js` clamps dt to 50 ms, so at 5 fps it stretches past
four seconds. The intent is remembered now and acted on when the camera settles.
Found by instrumenting the live scene, not by reading it.

Verified in the browser: crouch and stand at two different spots, scene count
1 → 2 → 1 each time, so the sift scene really is disposed.

### Slice 2, as built

`siftingBeds.js` draws each spot's baked bed on its crown. The plan said "spawn
each bed's stones — `spawnBed`'s `asleep: true`". That turned out to be the
wrong route, for a reason the plan could not have known: `spawnBed` lives in
rock-sift and would drag Babylon 8.56 into a Babylon 9.18 page. So the boundary
was redrawn at things that carry no engine —

- geometry from `rock-forge/src/forge/*`, pure JS, plain position/index arrays;
- the bed file through `shared/bedFormat.js`, DataView and nothing else
  (`rock-sift/src/bed.js` is now a shim over it, like `rocks.js` over
  `shared/rockRating.js` — rock-sift's five Havok tests still pass);

— and sand-sim builds meshes with its own Babylon. The cast matches because the
forge is deterministic: same seed, same count, same RNG draw order. The bed's
stored *names* are the proof, and `tools/bed-load-check.mjs` resolves all forty.

**Three failures worth writing down, because all three are silent.**

*Thin instances are an augmentation module.* `thinInstanceSetBuffer` is not on
`Mesh` in the tree-shaken ES6 build — `@babylonjs/core/Meshes/thinInstanceMesh.js`
has to be imported for its side effect, exactly like the `engine.dynamicTexture.js`
imports already in both app modules. Without it every call is a no-op on
`undefined`, nothing throws, and the beach just has no stones on it. There is now
a post-condition that counts uploaded instances and says so.

*Thin-instance buffers live on the Geometry, not the Mesh.* So `mesh.clone()`,
which shares geometry, gives four spots one buffer and the last write wins. The
symptom is vicious: every mesh reports the right instance count and the right
bounding box, passes culling exactly where its stones should be, and draws some
other spot's stones off screen. Three of the four beds were invisible with
nothing anywhere reporting a problem. Each (archetype, spot) now gets its own
geometry — 160 copies of a 320-triangle pebble, under a megabyte.

*A frozen material cannot compile the instanced variant.* `material.freeze()`
pins whatever effect was compiled first. Not frozen now; the world matrices are,
which is where the per-frame cost was.

**And one measurement that changed the design.** Built the obvious way — one
mesh per archetype, rock-sift's own icosphere level 3 — the beds submitted
**2,764,800 triangles from anywhere on the beach**, against a 131k beach mesh,
because a thin-instanced mesh is culled by the bounds of all its instances and
those spanned 55 m of shore. Split per spot and dropped to icosphere level 2
(indistinguishable at standing distance, four times cheaper): **172,800
triangles with a bed in view, 0 with none.** Measured both ways in the browser,
not estimated.

### The Babylon version gap — resolved

`rock-sift` was on `@babylonjs/core` **8.56**, `sand-sim` on **9.18**, and the
crouch puts both in one page. It upgraded cleanly: all five Havok tests pass on
9.18 with no source changes at all. sand-sim's vite config now dedupes
`@babylonjs/core`, since rock-sift's bare import otherwise resolves to a second
copy of the same version — two ShaderStores, two Engine classes, and an
`instanceof` that quietly answers false.

Unrelated good news for that slice: `rock-sift/src/main.js:61` constructs a
plain `Engine`, i.e. **WebGL2**. The sifting minigame never used WebGPU, so
Havok, the bed, examine and bucket are renderer-agnostic and work everywhere.
The fallback question only ever touches the approach to a spot, never the
sifting itself.

---

## 3. Missing texture assets

The repo's `.gitignore` excludes most rock textures. Only seven tileable materials are
tracked (`rock_027`, `rough_rock_012`, `marble_col_001`, `rough_rock_015`,
`quarry_wall_02`, `granite_002`, `pebble_scan`) plus `manifest.json`. The `scan/` and
`displacement/` directories are excluded entirely.

Consequence, observed live in the forge lab:

```
rock textures: [flint: "granite_002" has no normal map — falling back to procedural
grain, chert: "pebble_scan" has no normal map — falling back ...]
```

plus a 404. `loadRockTextures` degrades rather than failing, so this is survivable —
but the material port (§1) inherits these gaps, and some families will shade with
procedural grain rather than photo surfaces until the assets are tracked or replaced.

---

## 4. Known defects confirmed, not introduced

### bed-test fails by design

`rock-sift/tools/bed-test.mjs` fails and its own header asks that it not be "fixed":
a dense pile of convex hulls that Havok never sleeps micro-creeps indefinitely, and
the live build always did. It is deliberately kept out of `npm test`.

Measured before and after the move to generated stones:

| | max drift across variants |
|---|---|
| scanned stones (before) | 43–64 mm |
| generated stones (after) | 96–150 mm |

The creep roughly **doubled**, because the forge produces near-equant cobbles the five
scans never contained and a rounder stone on a flat floor has less reason to stop.
The **static** restore the game actually uses is still 0.00 mm, so it is not
player-facing. The real fix is the wake mechanism parked in `tools/physics-bench.mjs`.

### Settling time is cast-dependent

`FINAL_STEPS` was raised 400 → 1000. Measured on the 540-stone bed: 400 leaves 4
stones drifting, 700 leaves 3, 1000 leaves none. Cost ~3.4 s, paid at **bake time
only** — the browser restores a baked bed and never pours.

### Beds read domed

Observed in the render: the beds sit as domes rather than the shallow spread
`config.js` describes ("a real bank of pebbles is a shallow spread on flat ground").
Not investigated. Worth a look against `POOL_RADIUS` and the pour layering.

---

## 5. Physics gaps still open

### The attitude walk (largest known gap)

`documentary` runs still end with the stone rolled onto its side and most of its energy
intact. `env.balanceRetention` closes this for the *game* profiles by correcting the
walk once per contact, and lands on the independent velocity-limited ceiling (86 skips
measured against ~85 predicted). `documentary` is deliberately untouched, so
PHYSICS-NOTES §11.4 still describes it accurately.

### Skip counts are not numerically converged with Balance on

Substep sweep, game profile:

| `balanceRetention` | `cleanHops` spread |
|---|---|
| 0.00 | 4 (25%) |
| 0.50 | 12 (62%) |
| 1.00 | 9 (49%) |

`runDistance` is unaffected and stays converged at every value (≤1.9 m). Determinism is
**not** affected — checksums are identical at 240/144/60/30 Hz — so the daily stays
fair. What is unstable is the number's meaning *across solver changes*.
`docs/05-scoring.md` currently ranks on skips; this is an argument for at least storing
distance alongside every score. Flagged, not changed.

### Solver hot-loop de-allocation

Unchanged from the audit (item 15): the panel integral allocates ~40k throwaway objects
per impact frame, on exactly the frames that must hold 60 fps. Mechanical fix, most
sensitive maths in the project; wants the checksum suite as its safety net.

---

## 6. Access and environment

- **The GitHub App is not installed** on the account, so this session cannot push:
  `git push` → 403, and the API says `403 Resource not accessible by integration`.
  Reads work because the repo is public and served anonymously. Fix is
  github.com/apps/claude → Install → grant `rockgame`. It is a browser permission
  grant, not a download.
- Three commits exist only outside GitHub — the forge→solver bridge, the procedural
  rock swap, and the resolution/bed-staleness fixes. They were delivered as a zip.
- `node_modules` for `rock-sift` and `rock-forge` were installed in the session
  container, which is what allowed the real Havok headless tests and the browser
  screenshots. That dies with the container; a fresh session needs `npm install`
  (~5 s each).
