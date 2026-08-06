# Paused work — findings, 2026-08-05

Written so the investigation does not have to be repeated. Each section is something
that was started or scoped and then stopped, with what was learned and where the next
person should put their hands.

Everything here is measured or read out of the code, not assumed.

---

## 1. The forge material port — attempted, reverted

**Goal:** make `rock-sift` shade its stones the way `rock-forge` does, so the sift bed
looks like the lab instead of like flat grey pebbles.

**Status:** reverted. It is not a port. It needs a shader change in `rock-forge`.

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

Needs a browser in the loop to verify. It is a focused change to the forge's shader,
not a wiring job.

### What is in place meanwhile

`rock-sift/src/forgeRocks.js` builds a plain `PBRMaterial` per stone from the
archetype's own `colour` and `roughness`. Honest per-lithology shading, no textures.
That is why the sift screenshots read pale and flat next to the forge lab.

---

## 2. sand-sim × rock-sift integration — scoped, not started

**Goal:** rock piles visible in the sand sim, walkable in first person, click to crouch
into sifting.

**Status:** slice 1 built and tested. Slices 2 and 3 still want a live scene.

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

1. **Pile field.** ✅ Built. `shared/pileField.js` + the mound term in the height bake.
2. **Rock instances.** Spawn each bed's stones at its pile, statically — `spawnBed`'s
   `asleep: true`, which `bed-test.mjs` measures at 0.00 mm drift. Visual only; no
   Havok bed until the player crouches.
3. **Crouch transition.** Proximity prompt → camera move → hand off to rock-sift's
   sift mode, which is where the physics bed wakes.

Slices 2 and 3 need a live scene to judge.

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
the beach's own ±0.09 m of noise. Measured through the real resampling, the
crown is flat to 3 mm.

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

### Before slice 3: the Babylon versions do not match

`rock-sift` is on `@babylonjs/core` **8.56**; `sand-sim` is on **9.18**. The
crouch handoff eventually puts both in one page. Worth resolving before the
handoff is designed rather than during it.

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
