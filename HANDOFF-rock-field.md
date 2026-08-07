# Handoff — shore rock field (branch `claude/rock-sifting-integration-2y6gac`)

Written for the next code agent. Everything here is on the sand-sim lab
(`sand-sim/`) unless noted. Read `docs/09-sand-sim.md` and `docs/10-performance.md`
first; this file assumes them.

## TL;DR of where we are

The beach now scatters ~355,000 rocks across the whole 70×25 m shore, drawn at
three levels of detail. Two user-reported bugs are fixed (a bare ring where the
near LOD circle met the tile edge; square-edged holes in the distance from a
draw-distance cutoff). **The look is right** (dense nestled shingle, no pop, no
squares — verified in screenshots). **The open problem is performance:** the
field is 5.7–7.6M triangles, which will not hit the floor-spec machine (2020
Intel Iris Plus). That is the decision waiting for the user; see "OPEN" below.

## Git state — READ THIS FIRST

- Branch: `claude/rock-sifting-integration-2y6gac`, based on `main`.
- **The last committed commit is `2dcdf6c` ("Fix the bare ring…").** It sits on
  top of merged `main` (`9d7f136`). PR #23 was already merged; per repo rules a
  merged PR is finished, so `2dcdf6c` was rebased onto latest main and is a
  *new* change awaiting a *new* PR (never reopen #23).
- **There is UNCOMMITTED work in the tree** — this is the "3× rocks" change and
  is the thing this doc is mostly about. Three files:
  - `shared/shoreScatter.js`   (density up, overlap packing)
  - `sand-sim/src/scene/shoreRocks.js`  (no cutoff, size-graded far)
  - `sand-sim/tools/shore-scatter-check.mjs`  (checks updated for overlap)
- All 264 headless checks pass (`cd sand-sim && npm test`).
- The 3× change is **not committed and not pushed** because the perf tradeoff
  needs the user's call. Do not commit it as the default without confirming they
  accept the triangle cost or want it dialled back.

## How to run / test

- Dev server: `cd sand-sim && npm run dev` → http://localhost:5185/ (strict port
  5185, WebGL2 by default; `?webgpu=1` opts into WebGPU which does NOT run in the
  headless container — SwiftShader refuses `mappedAtCreation` buffers).
- The container has only a software rasteriser, so you can screenshot and count
  triangles but **cannot measure fps.** Real fps needs the user's machine or a
  deploy. Deploy = merge to `main`; Cloudflare Pages builds `main` on push. CI
  (`ci.yml`) does not gate the deploy.
- Headless screenshot harness pattern (Playwright is at
  `/opt/node22/lib/node_modules/playwright`, chromium at
  `/opt/pw-browsers/chromium`, launch args
  `["--use-gl=swiftshader","--enable-unsafe-swiftshader"]`). Boot takes ~60–110 s
  under SwiftShader; wait before evaluating. `globalThis.SANDSIM` exposes
  `{ scene, engine, rig, character, rocks, terrain, deform, ... }`. Reposition
  with `SANDSIM.character.position` + `SANDSIM.rig.yaw/pitch`, then call
  `SANDSIM.rocks.update(x,z)` to force a rebuild before screenshotting.
  Scratch scripts from this session live in the session scratchpad
  (`big.mjs`, `big2.mjs`, `gap.mjs`, `lod.mjs`) — copy their structure.
- Triangle counting: iterate `scene.getActiveMeshes()`, filter
  `name.startsWith("rock")`, sum `(getTotalIndices()/3) * max(1,thinInstanceCount)`,
  bucket by name prefix `rockNear` / `rockMid` / `rockFar`.

## The architecture (what each file does)

### `shared/worldBounds.js`
The world. Round pond, radius 100 (`POND_RADIUS`), near rim on the waterline.
The walkable + rock-bearing strip is 70 m of shoreline (`SHORE_WIDTH`, so
`SHORE_HALF_ARC = 35`) by 25 m deep (`SHORE_DEPTH`). **The strip is a rectangle
in (arc, depth), a banana in world x/z.** Two coordinate functions carry the
curve and EVERYTHING downstream uses them:
- `shoreDistance(x,z)` — metres out from the water, negative in the pond.
- `shoreArc(x,z)` — metres along the shore, signed like x.
- `shorePoint(arc,depth,out)` — inverse, (arc,depth) → world.
- `clampToShore(v)` — pull a point back into the strip (used by walk clamp,
  aliased as `clampToPlayRect` in beachParams for back-compat).
The height profile is `shoreDistance(x,z) * FORESHORE_SLOPE` (one slope raises
beach, digs basin, lifts far bank). Twinned in WGSL in
`sand-sim/src/shaders/heightBake.fragment.wgsl` (circle SDF) — keep the two in
sync; `tools/beach-profile-check.mjs` guards it.

### `shared/shoreScatter.js`  — WHERE the stones are (pure, deterministic, no Babylon)
`scatterShore({seed,density,heightAt,cast})` → array of
`{x,z,y,yaw,tilt,arc,depth,archetype,radius}`. Dart-throwing over a jittered
(arc,depth) grid; `ATTEMPTS` candidates per cell; determinism = rule 4 (same
seed same stones, regenerated per client, never shipped). Key constants (current
values are the 3× config):
- `PEAK_DENSITY = 560` — asked-for stones/m² at the back of the strip.
- `PACK = 0.5` — **overlap allowance.** `need = (r1+r2)*PACK + MIN_GAP`. 1.0 was
  edge-to-edge (jammed at ~55% coverage, the flat-disc RSA ceiling ≈ 276k
  stones). 0.5 lets silhouettes nestle past tangent → ~355k stones (3×). This is
  the ONLY way past the packing wall; 3× flat non-overlapping is physically
  impossible (would be 70% coverage). User explicitly OK with overlap
  ("some rocks could still be touching"). Screenshot confirms it reads as dense
  shingle, not "melting."
- `ATTEMPTS = 8` — darts per cell. Node gen time ~1.8 s (browser JIT faster).
  Was 10 → ~382k but 8 s gen (too slow a load).
- `densityAt(depth)` — 0 within `ROCK_FREE_MARGIN` (5 m of the water), then
  quadratic ramp to `PEAK_DENSITY` at `SHORE_DEPTH`. Takes DEPTH not z (curve).
- `SINK_FRACTION = 0.22` — stones sit into the sand by this × radius.
Prior densities for reference: default was 24k (`PEAK 54`), then 117k
(`PEAK 160`, `ATTEMPTS 6`, no PACK).

### `sand-sim/src/scene/shoreRocks.js`  — HOW the stones are drawn (Babylon)
`buildShoreRocks(scene, terrain, {seed,density,lod,renderingGroupId,forgeMaterial})`.
Uses the SAME 40 forge archetypes as the sift beds (`createBedArchetypes` from
`siftingBeds.js`), built at three icosphere levels (`LOD_LEVELS = [2,1,0]` =
320/80/20 tris). Thin-instanced, split per (archetype, tile) because Babylon
frustum-culls a thin-instanced mesh by the bounds of ALL its instances (one mesh
per archetype = nothing ever culls; the beds hit this, 2.7M tris with nothing in
sight). `TILE = 6` m.

Three rings, returned object has `update(x,z)` (call once/frame with walker pos),
`setEnabled`, `dispose`, `stones`, `farStones`, `meshes`, `tiles`, `nearCap`:
- **NEAR** — level 2, dynamic circle `NEAR_RADIUS = 1.5` m around the walker,
  rebuilt every `REBUILD_STEP = 0.75` m of movement. Built from the player not
  the grid (a per-tile L2 would be far too many tris at this density). One mesh
  per archetype, buffer sized to `nearCap` and refilled in place (only per-frame
  allocation avoided). CANNOT be frustum-culled (`alwaysSelectAsActiveMesh`), so
  its cost is the WHOLE circle incl. behind you — ~1.4M tris at 1.5 m. `nearCap`
  is deliberately generous (600/m² budget) because a near stone that overflows
  the cap now VANISHES (it's punched out of mid — see below).
- **MID** — level 1, per tile, out to `MID_DISTANCE = 4` m. Buffers NOT static.
  **Key mechanism (the bare-ring fix, `2dcdf6c`):** when the near circle covers
  part of a tile, exactly those stones are punched OUT of the tile's mid buffer
  (`setMidRemainder`, recomputed each rebuild since the circle slides), so near
  draws them at L2 and mid draws the rest at L1 — no stone twice, no hole.
  Restored by `setMidFull` when the near set leaves. This is the largest tri
  cost (3.6–5.2M) — see OPEN.
- **FAR** — level 0, per tile, the WHOLE rest of the strip (`DRAW_DISTANCE =
  Infinity` — no cutoff; that removed the square-edged holes). Carries only the
  biggest stones: `FAR_FRACTION = 0.22` keeps the largest ~22% of stones BY
  SIZE (whole archetypes above a size threshold, `farKept` set), not a random
  stride. Small pebbles genuinely vanish by ~15 m, so this reads as detail
  shedding with distance, no density step. ~84k far stones × 20 = ~1.6M tris,
  always on (whole strip).

`update(x,z)` logic: distance from tile centre → "off" (never, DRAW_DISTANCE=∞) /
"far" / "mid". Occupied tiles are within 2 m so always fall to "mid".

### Wiring
Both apps call it: `sand-sim/src/app/webglApp.js` (default) and `webgpuApp.js`.
Density from `?density=` URL (`numberFromURL`) overriding `S.rockDensity` setting
(slider max is 4 in `settings.js`), because the field builds once behind the
loading screen and a slider can't move it live. `?lod=N` forces all three rings
to one level (for judging ringed vs flat). Both call
`rocks.update(character.position.x, character.position.z)` each frame.

The four Havok **sifting beds are UNWIRED, not deleted** (`buildSiftingBeds`,
`siftPhysics`, `Imprints`, crouch all still build + pass checks; nothing calls
them). They're the only thing that can put a stone in your hand (a thin instance
can't be picked). Re-wiring "inspect any stone" = wake nearby thin instances
into real pickable instances, the way the crouch wakes a bed. That's the next
gameplay pass.

### Checks
`sand-sim/tools/shore-scatter-check.mjs` — determinism, clear band (measured as
`shoreDistance`, not z), nothing outside the strip, **no pair closer than PACK
allows** (updated from the old no-overlap rule), density ramp measured off the
field. `beach-profile-check.mjs` — pond closure + curve. Run all: `cd sand-sim
&& npm test` (264 ok). NOTE: several checks were written to catch exactly the
"straight waterline" assumption when the pond became round — if you change world
shape again, expect them to fire and fix them to sample along the shore.

## OPEN — the decision the user needs to make (perf)

3× rocks + whole beach visible + individual meshes = **5.7–7.6M triangles**
(measured; MID ring is 3.6–5.2M of it, NEAR ~1.4M, FAR ~1.6M). That will not run
at 60 fps on the floor spec, and is borderline even at 30. The look is correct;
the cost is the issue. Options, roughly in order of effort:

1. **Dial back the count.** ~2× (≈230k) with these rings is ~3–4M tris,
   borderline-30fps. Lower `PEAK_DENSITY` / raise `PACK` toward 0.62.
2. **Tighten rings further** (smaller NEAR_RADIUS/MID_DISTANCE, lower
   FAR_FRACTION). Diminishing — MID at 4 m is already tight and still dominates.
3. **Bake the far/mid field into the sand** (albedo + normal map on the terrain
   material) beyond a few metres. Zero geometry for the distant field — the
   correct long-term answer for ground detail at this density. Big change:
   generate a pebble texture from the deterministic field, blend into the
   terrain material past a radius. This is what actually makes 3× floor-spec
   viable. NOTE impostor/billboard quads do NOT work here — the player looks
   DOWN at the beach, so camera-facing quads would be seen edge-on.
4. **Accept 30 fps on the beach** (docs/10 allows 30–60 off the throw; only the
   throw is a 60 hard floor). Even so, 7.6M is too much for 30 on Iris Plus.

My recommendation to relay: the look is a keeper; commit the 3× scatter, but
before it can be the shipped default either (3) lands or the count drops. Ask the
user which. If they just want to SEE it on real hardware to judge the look, the
fastest path is to commit + open a PR + merge to deploy, accepting it'll be slow
until the far-field is baked.

## Immediate next steps for you
1. Relay the perf reality + options above; get the user's call on count vs bake.
2. If they accept the look and want it committed: `git add -A`, commit the three
   modified files (message: 3× rocks via overlap packing + no-cutoff + size-graded
   far; include the tri measurements and the packing-wall reasoning), then open a
   NEW PR to `main` (not #23). Attribution footer on any GitHub comment.
3. If they want it cheaper first: implement option 1 (retune) or 3 (bake) before
   committing.

## Gotchas that already bit this session
- Nested backticks inside a GLSL/WGSL template literal close the string →
  SyntaxError that passes text-based checks but breaks boot. `import-check.mjs`
  now runs `node --check` per module; still, avoid backticks in generated-shader
  comments.
- WebGPU can't run in this container. Verify on WebGL only here.
- `ProceduralTexture` uniforms must be registered before the effect compiles or
  they silently no-op on WebGL (`deform-uniform-check.mjs` guards it) — unrelated
  to rocks but same repo, easy to trip.
