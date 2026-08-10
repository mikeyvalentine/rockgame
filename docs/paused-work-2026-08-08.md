# Paused work — where things stand, 2026-08-08

Written so the next session does not have to re-derive two days of work.
Everything here is measured or verified in a browser, not assumed. The state
described is `main` as pushed (WebGL path — see the renderer note at the end).

The one-sentence version: **sand-sim now plays inside the authored glb world**
— its terrain is the ground, its camera is the spawn, its trees are the walls,
the lab's water fills its pond, and a quarter-million inspectable stones sit on
its beach.

---

## 1. The glb IS the world now

`public/assets/pond.0.glb` stopped being scenery and became the authority.
Everything below re-derives on a re-export — that is the point of the design:

- **Ground.** `buildWorldEnv` bakes the `Landscape` mesh into a height grid
  (`shared/glbHeightfield.js`, 300 m / 512² around the pond centre) and returns
  it as `.terrain`. The beach mesh is displaced from it and the walker grounds
  on it — one `heightAt`, so what is drawn is what you stand on. The
  procedural `shoreProfileJS` survives only as the `?env=0` fallback.
  `npm run test:glbterrain` gates a re-exported terrain (green = safe to ship).
- **Spawn.** The export's `RS Camera` node: its world translation and heading
  become where the player starts and which way they face. No camera in the
  glb → the placeholder `SPAWN`.
- **The clearing.** worldEnv collects every instanced prop's world (x, z),
  spatial-hashes them (`TREE_CLEAR` 1.4 m), and flood-fills the sand reachable
  from the spawn (above water, clear of trees, within `REACH_RADIUS` 35 m).
  That one region (`worldEnv.clearing`) is the walk bound (a step out is
  rejected — the flood is what makes a gap between two trunks NOT a corridor
  into the forest) and the rock mask.
- **Trees.** Left exactly as authored in plan; only their feet are re-seated
  onto the baked terrain. An earlier version deleted 217 of them to clear a
  placeholder beach arc — that arc and every other "70 m strip" rule is gone.

Two traps for whoever touches the glb pipeline next:

- The draco-decoded glb **interleaves position/normal/uv at byteStride 32**.
  A hand parser that assumes tight packing reads garbage — this misdiagnosed
  the terrain twice ("island", "±80 m spikes") before it was caught. Honour
  `bufferView.byteStride`, or read vertices through Babylon.
- **Only `git ls-files public/assets` ships to the deployed site**
  (`tools/build-site.mjs`). Anything else under `public/` works in `vite dev`
  and 404s in production as a text/html SPA fallback — this shipped one broken
  deploy (the draco decoder) before it was understood. Verify prod changes
  against `npx serve dist`, not the dev server.

## 2. Water

The lab's ambient surface, imported for real: `shared/ambientWaterShader.js`
EMITS both GLSL and WGSL from the one octave table in `shared/ambientWater.js`
— the water the world renders, the lab tunes, and the solver planes on cannot
drift apart (`sand-sim/tools/water-shader-check.mjs` guards it).

- Reflection is a planar `MirrorTexture` (sky + shore + tree line; the rocks
  are deliberately not in the render list). 0.75× with a gaussian blur.
  Gotcha: bound into a custom ShaderMaterial it must be pushed into
  `scene.customRenderTargets` or it renders black.
- The shore edge samples the baked terrain height per pixel, so the waterline
  is the authored (irregular — radius 75..101 m) shore, not a circle.
- **Foam is CUT.** The scene-depth foam mis-reconstructed the gap and washed a
  huge band over the shore, and the depth pre-pass it needed re-rendered the
  whole scene every frame. Both removed; the check asserts foam stays out
  until there is a **verified** depth source to hang it on.
- The wet-sand band (`sandDeformPlugin.js`) darkens by height above the
  waterline, so it follows the real shore contour too.

## 3. The stones

The premise (docs/02): more stones than the player could ever inspect, all of
them touchable. They need **no physics** — pickup will be an animation; the
only collision is at placement, which the scatter guarantees (no overlaps, by
construction). Drawing collapsed to two layers after the ring system tanked
the frame rate:

- **CARPET** — every stone, always: ONE frozen mesh, a 4-triangle
  vertex-coloured dome per stone tinted from its archetype's real colours.
  One draw call, never rebuilt, never pops. This is also what finally makes
  the shingle READ at eye level.
- **DETAIL** — real forge geometry (level 1) as thin instances per
  (archetype, tile), enabled within `MID_DISTANCE` 8 m. A stone only ever
  changes shape with distance, never existence.

Field: ~260k stones across the clearing, density by height above the
waterline (thin at the water — the waves keep the wet edge clear — full from
`FULL_RISE` 1 m up to the trees). Budget dials if the floor machine drops
frames: `?density=` (or the Density slider), `MID_DISTANCE`
(sand-sim/src/scene/shoreRocks.js), `PEAK_DENSITY` (shared/shoreScatter.js,
currently 60 — 160 ballooned the field to 350k and 7M triangles).

## 4. Crouch and inspect

- **Crouch**: hold ctrl or C — eye sinks 1.62 → 0.92 m (damped), movement
  drops to a half-pace shuffle that overrides sprint.
- **Inspect** (`scene/inspect.js`): E or click pulls the stone under the
  centre of the screen up to the camera (no crosshair — centre of view IS the
  pointer). The field is ray-picked directly (`rocks.pickAlongRay`, closest
  approach over the tiles the ray crosses — no physics engine). The held
  stone is a lazy level-3 (1280-tri) archetype build; the view freezes and
  the mouse turns the stone; E / Escape / click puts it back; world tools are
  off while holding. The stats panel is REAL: `shared/rockRating.skipRating`
  fed from measured spans + signed-volume mass — bars, rarity tier, and the
  verdict naming the worst stat.
- **v1 inspects a COPY** — the ground stone stays in the carpet/tiles.
  Lifting the actual instance out (edit its tile buffer + carpet verts) is
  the pickup animation's job.

## 5. Leaves

The atlases were black-backed with alpha flattened; `tools/key-atlas-alpha.mjs`
keys the mask back AND colour-dilates the background (leaf-on-leaf fringes, no
dark outline). The fine-leaf atlases — birch + everything on the shared
conifer `BranchMat` — additionally run ALPHATESTANDBLEND to feather the
sub-pixel needle shimmer under motion. Broad-leaf trees stay pure alpha-test.
Whether the crawl is fully gone needs eyes on real hardware. Tree `COLOR_0`
is NOT colour (it is C4D wind-rig data) — kept in the geometry, never shaded.

## 6. Where the next hands go

1. **Per-stone sand imprints** (asked for, queued): stones sink
   (`SINK_FRACTION` 0.22) but do not yet dent the deformation buffer. The
   beds' `Imprints` system already solved budgeted re-pressing into the
   transient, player-following deform window — adapt it to read the field
   from `shoreRocks` byTile.
2. **Pickup animation** + actually lifting the inspected stone out of the
   field (and the bucket, docs/02).
3. **WebGPU parity** — deliberately deferred (WebGL2 is the DEFAULT renderer;
   `?webgpu=1` is opt-in and unverifiable in this dev environment). The
   WebGPU path still grounds on the procedural beach, has no clearing, no
   rocks, no glb spawn; the note at its terrain build lists the wiring.
4. **WGSL water** — written and structurally checked, never compiled on a
   real GPU (mirror V-flip is the suspect part).
5. **Foam**, if wanted back: needs a verified scene-depth source first.
6. **Far-field ground** — the 512 m ground mesh runs flat and pale past the
   glb's ±125 m; invisible at eye level, ugly from above. Clamp or skirt it
   if aerial shots ever matter.
7. **Throw/skip coupling** into this world — the aiming/throwing feature is
   being built separately (feature/aiming-throwing worktree + throw-lab).

## 7. How this was verified (and how to re-verify)

Headless Playwright against `npm --prefix sand-sim run dev` (port 5185):
`globalThis.SANDSIM` exposes everything; `SANDSIM.input.locked = true` stands
in for pointer lock, then `SANDSIM.inspect.toggle()` etc. Headless renders
the WebGL path only, and screenshots stall at large viewports on heavy scenes
— use ~960×540 and retry. FPS numbers from headless are meaningless; frame
rate judgements happen on real hardware. Deploys: push to main → Cloudflare
Pages auto-builds → `rockgame.pages.dev/sand-sim/`.
