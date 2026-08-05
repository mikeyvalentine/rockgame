# Rocky Shore

A small Babylon.js demo: a field of ~540 scanned river stones spread over a flat
sand beach, all real rigid bodies.
Drag to sweep your hand through them, click one to pick it up and turn it over,
and see whether it would make a decent skipping stone.

```bash
npm install
npm run dev
```

## Controls

| Input | Action |
| --- | --- |
| Click a ring | Crouch down and sift at that spot |
| `Esc` | Stand back up |
| Drag | Part the stones with a fingertip-sized collider |
| Scroll | Dig depth (1 – 12 cm above the sand) |
| Click a stone | Lift it out and examine it |
| Drag from a stone | Carry that stone; let go to throw it |
| Drag a stone over the bucket | It lifts to clear the rim — let go to drop it in |
| Drag while holding | Tumble the stone; scroll zooms |
| Click / `Esc` | Put it back |
| `R` | Swap this spot for a different baked bed |
| `O` | Toggle SSAO |
| `H` | Show the hand collider (debug) |

## How it fits together

`src/main.js` is the composition root and nothing else — it starts the engine,
builds the pieces below, wires them together and runs.

| File | Role |
| --- | --- |
| `src/config.js` | World constants, DOM-free so the physics can run headlessly |
| `src/main.js` | Composition root |
| `src/field.js` | Pouring and settling the bed; scattering gravel |
| `src/bed.js` | The baked-bed format: encode, decode, restore |
| `src/shore.js` | The three sifting spots, the markers, and the crouch transition |
| `src/bucket.js` | The bucket at each spot — collider built from primitives, so its contents settle |
| `src/rocks.js` | The skip rating. Mirrored by rock-forge's `metrics.js` — keep the two identical |
| `src/assetRocks.js` | Loads and normalises rock meshes out of a grouped GLB |
| `src/hand.js` | The sifting hand — kinematic collider, park/sweep/release |
| `src/interaction.js` | Pointer and keyboard: sweep, carry, pick up, put back, dig depth |
| `src/carry.js` | Dragging one stone around — force-driven, so it cannot bulldoze |
| `src/environment.js` | Sky/IBL, sun, sand, water, ground collider |
| `src/examine.js` | The "hold it up and look at it" stage and camera |
| `src/look.js` | Tone mapping and ambient occlusion — **all** the brightness knobs |
| `src/ui.js` | The HUD. Pure DOM |
| `src/textures.js` | Procedural ripple normal map for the water |
| `src/noise.js` | Seeded PRNG + Perlin/fbm |
| `tools/bake-bed.mjs` | Pours beds offline and writes them to `public/assets/beds` — `npm run bake` |
| `tools/bed-test.mjs` | Checks the shipped beds restore and hold still. **Currently fails on purpose — read its header** |
| `tools/bake-bench.mjs` | What baking a bed saves versus pouring one |
| `tools/test.mjs` | The suite — `npm test` |
| `tools/settle-test.mjs` | Headless physics check of the bed at rest — see below |
| `tools/sift-test.mjs` | Headless physics check of the sift itself — see below |
| `tools/carry-test.mjs` | Checks lifting a stone nudges its neighbours rather than firing them |
| `tools/bucket-test.mjs` | Checks stones dropped in the bucket stay in it |
| `tools/margin-test.mjs` | Measures the gap Havok leaves between touching bodies |
| `tools/physics-bench.mjs` | How Havok's cost scales with stone count. Read its header before optimising |
| `tools/winding-check.mjs` | Checks imported rocks face the same way as Babylon's own geometry |

If the scene looks too dark, everything responsible is in `src/look.js`, in the
order it applies, with notes on which knob costs the most. Press `O` first — that
toggles ambient occlusion, which is usually the largest single term.

## Testing the physics without a browser

```bash
npm test
```

Babylon's `NullEngine` and Havok's WASM both run under Node, so the pour can be
verified with no rendering at all. It builds the same ground collider and the
same bed, runs the settle, and reports how many stones ended up under the
terrain, how far the bank spread, and how many are still moving. Exits
non-zero if any tunnelled or the bed never came to rest.

This exists because the bed had a physics bug that was very hard to read off a
screenshot: dropping all the stones at once builds a column about a metre tall,
and stones arriving at 4 m/s travel further per step than their own thickness,
so they tunnel clean through the terrain mesh. On screen that looks like "most
of the rocks are stuck in the sand". The test reports it as a number.

A bed that settles quietly says nothing about what happens once you sweep a hand
through it, which is where this scene actually came apart, so:

```bash
node tools/sift-test.mjs [fps] [stoneCount]
```

drives `src/hand.js` through four strokes at different dig depths and reports
peak stone speed and spin, how many stones ended up airborne, ejected from the
bank, or under the sand. It runs a fake render loop in Babylon's own order —
physics substeps, then `onBeforeRender`, then `onAfterRender` — because several
of the bugs it caught only exist in that ordering and vanish if you step the
physics engine directly.

The `fps` argument matters: stepping physics at the frame delta makes the
simulation's behaviour depend on how fast the machine draws, so the bed has to
hold together at 20 fps as well as at 60.

### Ground

The sand is flat under the bed and for two bed radii beyond it, with only the
faintest swell after that — 2 cm over a couple of metres, enough that the far
sand does not read as a table. Nothing holds the stones in; they settle into a
field about 10 cm deep with a 25 cm median radius.

The stones rain down one even *sheet over the whole field* at a time, not a
fixed-size batch at a time. The layout is a shelf-pack that fills the disc from
one corner, so a batch only ever covers the first couple of rows — batch pouring
tips every stone into the same strip of ground and builds a cone. Pouring by
layer is what makes a field.

Its collider is a **box**, not a mesh following the sand. A convex hull resting
across a grid of triangles catches on the internal edges between them and gets
kicked, and on flat ground there is nothing to damp that out: with the old
200×200 trimesh, 50 of 180 stones were still moving after 30 seconds and the
pile crept outward indefinitely. A box has no internal edges, is exact for flat
ground, and poured the same bed 7× faster.

### Baked beds

The bed is not poured at runtime. Settling 540 stones costs ~3.4 s and scales
superlinearly — 1080 stones took 12 s — for a result that never varies, so it is
poured once by

```bash
npm run bake
```

which writes four variants to `public/assets/beds` (8.2 KB each) plus a manifest.
The game picks one, so not every player gets the same beach; pass a value derived
from the save to `fetchBakedBed` and a given save keeps its own. Restoring one
costs ~30 ms against 3400 ms to pour it. If no bed is found the game falls back
to pouring, slowly, and says so in the console.

The format stores archetype **names**, not indices, so a bed baked against a
different version of `river_rocks.glb` fails loudly instead of silently mapping
every stone to the wrong shape. The manifest also records the world constants it
was baked under, and `bed-test` refuses beds that no longer match.

Re-bake whenever anything that shapes the bed changes: the source model, the
stone count, the bed or pool radius, gravity, or the settle constants.

### The bucket

Its collider is a cylinder for the floor plus a ring of boxes for the wall — not
the bucket mesh. A convex hull of a bucket is a solid lump with no inside, and a
triangle mesh of one gives the stones an inside they can never rest in: a convex
hull sitting across a grid of triangles catches on the internal edges between
them and gets kicked. Measured, five stones dropped in and left for four seconds:

    triangle mesh      175.5 mm/s still moving
    cylinder + boxes     0.0 mm/s

This is the same failure the ground had, fixed the same way. `tools/bucket-test.mjs`
now asserts both that the stones stay in and that they stop moving, because the
first is true in the broken case too.

### Scale

One world unit is 1/4 metre — modelling the beach at 4× real size keeps 5 cm
stones comfortably clear of Havok's collision margins. Gravity is scaled by the
same factor (`-9.81 × 4`), so motion still plays back at real-world speed. Every
size in the source is written in real metres and multiplied by `U`.

### Rocks

One source: the 8 scanned stones in `public/assets/river_rocks.glb`, split into
their individual named rocks, world transforms baked in, recentred and rescaled
to plausible real-world sizes. `src/assetRocks.js` produces `{ mesh, shape,
vertexData, material, metrics }` per rock.

There used to be a second, procedural source — noise-displaced icospheres,
optionally carved by half-spaces. It has been removed: the generated stones did
not read as real rock beside the scans, and mixing the two made the scanned ones
look worse rather than the generated ones look better.

Each archetype gets one shared `PhysicsShapeConvexHull`; the field instances the
mesh, so per-rock scaling stays at 1 and the collider always matches the
silhouette. Mass comes from the mesh's actual signed-tetrahedron volume at
2650 kg/m³, so a 7 cm slab really does weigh ~200 g.

### Picking a stone up

The stone does not cut to the examine view. `enter()` converts the stone's real
world *pose* into the camera's own space and starts the held mesh there, at true
size, then eases it in to the framing distance over 0.75 s — so it leaves the bed
from exactly where it was lying and grows as it comes towards you. Putting it
back reverses the tween, slerping the orientation back to the one it was resting
in however far you tumbled it, and only hands the stone to the solver once it has
landed.

Converting the *rotation*, not just the position, is the part that is easy to get
wrong. The mesh is a child of the camera, so assigning the world quaternion
straight to it leaves the camera's own rotation multiplied in on top and the
stone visibly flicks to a different orientation as you pick it up. Babylon
composes `world = local x parent`, so the local pose is `world x inverse(parent)`
— done on the full matrix, which gets position and rotation together and cannot
get the order wrong.

There is no dimming backdrop. A black alpha plane fading in behind the held stone
reads as a silhouette dropped over the scene rather than as depth of field.

### Skip rating

From the stone's own geometry: flatness (`c/a`), roundness (`b/a`) and mass, each
scored against the range that actually skips, weighted 0.45 / 0.28 / 0.27. See
`skipRating` in `src/rocks.js`.

## Adding your own rocks

Drop a GLB in `public/assets/` and add a call in `main.js`:

```js
archetypes.push(...await loadRockArchetypes(scene, "/assets/my_rocks.glb", {
  unitScale: U,
  include: /^Rock_/,   // optional name filter
}));
```

Re-run `npm test` afterwards. Bigger stones spread further and pile higher, so
`ROCK_COUNT` and `POOL_RADIUS` in `src/config.js` may need adjusting — the settle
test reports the spread it ends up with.

Each mesh in the file becomes one archetype. Give it a size hint in
`SIZE_HINTS` (`src/assetRocks.js`) if the default 5.5 cm is wrong.

## Assets

- `public/assets/river_rocks.glb` — 8 low-poly textured river rocks.
- `public/assets/sky/autumn_field_puresky_4k.hdr` — Poly Haven, CC0. Drives both
  the visible sky and all image-based lighting, and `SUN_DIR` is matched to the
  sun in it: a key light that disagrees with the environment map gives every
  stone two sets of highlights. `puresky_1k.hdr` sits alongside it if the 17 MB
  download becomes annoying — Babylon resamples either one to a 512 cube.
- `public/assets/ground/coast_sand_01_*` — Poly Haven, CC0. Diffuse, OpenGL
  normal, and a standalone greyscale roughness map. There is no ARM/ORM map in
  this set, so the roughness goes into `metallicTexture` with
  `useRoughnessFromMetallicTextureAlpha` off, `...Green` on, and both the
  metalness-from-blue and AO-from-red flags off — otherwise Babylon reads the
  roughness value as metalness and the damp sand turns to chrome.
