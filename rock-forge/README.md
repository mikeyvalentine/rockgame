# rock-forge

Procedural rock geometry for a coastline you can sift through by hand.

The problem this solves: scanned rocks from Sketchfab are 5k–400k triangles
each, every one is its own mesh with its own UVs and its own textures, and a
field of them cannot be instanced because no two share a topology. Eight of
them is fine. Five thousand is not.

## The idea in one paragraph

Every rock is a radius function on the unit sphere, `r(direction)`. That single
constraint — the rock must be star-shaped about its centre, which any pebble is
— means all rocks can share one sphere tessellation, so a rock *is* one row of
per-vertex radii and normals. Those rows live in a texture. The vertex shader
reads one texel and moves the shared sphere's vertex onto that rock's surface.
Everything finer than a triangle is a shared triplanar normal map. The whole
field is a handful of thin-instanced draw calls, and a rock costs 5 KB of shape
data that it shares with every other instance of itself, plus 80 bytes for its
own transform.

```
src/forge/     engine-agnostic. Runs under node; tools/shape-test.mjs exercises it.
  icosphere.js   the one shared topology, built so LOD N is a vertex prefix of LOD N+1
  shape.js       r(direction) — superellipsoid + fracture planes + bedding + grain
  archetypes.js  slate / granite / flint / sandstone / basalt / quartz
  bake.js        seeds -> shared mesh + RGBA16F shape texture, and the escape hatches
  metrics.js     volume, extents, mass, skip rating (matches rock-sift's)

src/babylon/   the renderer binding
  rockMaterial.js  PBRMaterial plugin: vertex displacement + triplanar grain
  rockField.js     thin instances, LOD bucketing
  detailTextures.js the shared grain/cavity map
```

## Running it

```bash
npm install && npm run dev
```

Then <http://localhost:5184>. `npm test` runs the headless geometry checks.

The lab has two modes. **field** scatters N rocks and reports triangles, draw
calls, LOD split and memory; the benchmark button ramps the count until the
frame rate gives out and tells you where that was. **inspect** shows one stone
with a LOD selector, a wireframe toggle and an optional 20,480-triangle CPU
reference of the same rock beside it — the only honest way to judge whether
1,280 triangles plus a normal map is enough.

Useful things to try: set **shapes** to 8 and look for repetition; set **grain**
to 0 to see the bare silhouette; turn on **colour by lod** and walk the camera
back.

## Why it does not look like a blob

The generator this replaces (removed from rock-sift's `src/rocks.js`, with a
comment saying the results "read as blobs") displaced an icosphere with fbm.
That is a recipe for a potato: fbm has no straight lines and no discontinuities,
and a stone is defined by both. `shape.js` layers four things instead:

1. a **superellipsoid** base — one exponent moves it from octahedral through
   spherical to nearly cubic, which is most of the difference between shale, a
   river cobble and a lump of granite;
2. **fracture planes** — half-space cuts combined with a smooth minimum, so the
   flats meet at rounded edges. This is the single biggest anti-blob measure;
3. **bedding** — banding along one axis, visible only on surfaces parallel to
   it, which is what makes slate read as slate;
4. **lumps and pits** — low-frequency fbm asymmetry and Worley dimples, kept
   small.

`wear` then runs the tumbling process over the top: it rounds the fracture
edges, damps the fine detail and pulls the exponent toward a rounded box. 0 is
freshly broken flint; 1 is a stone that has been in the surf a very long time.

Everything is analytic and resolution-independent, so the 80-triangle version in
the distance, the 1,280-triangle version at your feet and the 20,480-triangle
version in your hand are all the same rock.

## What it costs

Measured by `npm test`, for a 96-shape library at LOD0 = 642 vertices:

| | |
|---|---|
| shape texture | 481 KB (5.0 KB per distinct shape) |
| shared base meshes, all 3 LODs | 27 KB |
| per rock in the world | 80 bytes (a matrix + 4 floats) |
| the same 96 shapes as ordinary meshes | 2,646 KB, and 96 draw calls |

The table understates it. The real number is that adding the 5,000th rock costs
80 bytes and no draw call, where a conventional pipeline pays for another mesh
or accepts visible repetition. Getting to a five-figure rock count with scanned
assets means either a few archetypes repeated until the eye catches it, or a
memory budget you do not have.

## The three escape hatches

A scheme this aggressive only works if it knows when to stop:

- **The rock in your hand.** `buildDetailMesh(shape, params, 5, size)` rebuilds
  one rock on the CPU at 20,480 triangles from its seed. The field never needs
  real geometry, so you can afford full detail for the one stone the player is
  actually looking at.
- **Physics.** `buildHullPoints(shape, params, size)` gives a point cloud for a
  convex hull. Hulls are shared per (shape, size bucket) — quantise size into
  three or four buckets per shape and a 5,000-rock field needs a few hundred
  hulls, not 5,000. How closely that matches what you can see is measured
  below, because it is the first thing anyone asks.
- **Hero rocks.** Nothing stops a handful of scanned meshes sitting in the same
  scene. The forge is for the field, not for the one boulder with a story.

## Does the collision match what you can see?

The displacement happens on the GPU, so it is fair to ask whether physics is
getting the real rock or a stand-in. It gets the real rock: `r(direction)` is an
ordinary analytic function, the vertex shader is just *one sampling* of it, and
`buildHullPoints` is another sampling of the same function. Nothing is faked.

But "same function" is not "same shape", and there are two ways to get it wrong.
`tools/collision-test.mjs` measures both against an exact convex hull:

**Scale.** Sampling at a different resolution finds a different bounding box, so
re-deriving the normalisation gives a hull a few percent off the rendered rock —
invisible on screen, and exactly the kind of thing that makes a bed of stones
settle wrong for no apparent reason. Shapes now carry the scale they were baked
with and every re-sampling reuses it.

**Sampling.** This one was worse than expected. An icosphere spreads directions
evenly, but on a 7 cm slate disc the radius falls from 37 mm to 20 mm within 15°
of the equator, so an even spread puts almost nothing on the rim. The first
version put the collision surface **16 mm inside** the drawn one and lost 37% of
the volume. The fix is to union three direction sets: isotropic points to anchor
the flat faces, points warped by the stone's own axis ratios to crowd the rim,
and the six directions where the baked shape reaches its bounding box.

Measured over 24 stones per family at 7 cm, against the surface actually drawn:

| | mean | worst outward | worst inward | volume |
|---|---|---|---|---|
| default (210 points, ~280 faces) | 0.19–0.27 mm | 0.90 mm | 4.28 mm | −1.9% to +7.2% |
| `level: 3` (690 points, ~790 faces) | 0.09–0.14 mm | 0.94 mm | 1.76 mm | +0.8% to +11.0% |

This test earned its keep by catching a *shape* bug rather than a physics one.
Sandstone's outward error sat at 4 mm and — unlike every other family — refused
to improve when sample density tripled. Outward error that does not converge is
not sampling, it is concavity: the hull was bridging a dish. The cause was
`facetRound`, the smooth-min blend width, which at high `wear` had grown to
0.44 against a radius of 0.5. A blend that wide stops rounding edges and starts
scooping the faces, so the most weathered stones were coming out dished — wrong
for the look as much as for the physics. Rescaling it fixed both.

Three things make that good enough. A hull's *vertices* are sample points and
every sample point is exactly on the drawn surface — and contact between two
stones happens at whichever point is extreme along the contact normal, which is
a hull vertex. So the places stones actually touch are the places the hull is
exact; the error lives in the spans between vertices, which are by construction
not the first thing to touch. The worst-case numbers are single directions out
of 642 on the sharpest corners of the flattest stones, against a typical
deviation a third of a millimetre. And the volume gap is convexification filling
the dished faces of the flat stones — it never reaches displayed mass or the
skip rating, both of which come from the drawn mesh via `instanceMetrics()`.

What remains genuinely lost is concavity: a deeply fractured flint collides as
slightly fuller than it looks. That is the same trade rock-sift already makes,
since it feeds its scanned meshes to `PhysicsShapeConvexHull` too.

## Integrating into rock-sift

`src/forge/` has no Babylon dependency and `metrics.js:skipRating` is identical
to rock-sift's, so the two are already compatible. The swap is:

1. Copy `src/forge/` and `src/babylon/` across.
2. Replace `loadRockArchetypes()` in `src/assetRocks.js` with `bakeLibrary()`.
   An archetype there is `{ mesh, shape, vertexData, material, metrics }`; here
   a shape is a texture row, so `field.js:addRock` changes from
   `arch.mesh.createInstance()` to pushing an instance record into `RockField`.
3. Physics bodies attach to `TransformNode`s rather than meshes, since the mesh
   no longer exists per rock. `PhysicsShapeConvexHull` takes the point cloud
   from `buildHullPoints`. Havok's shape sharing already works the way
   `field.js` uses it.
4. `examine.js` swaps its held mesh for `buildDetailMesh(..., 5, size)`.

The one genuine complication is that a physics body's transform has to be
written back into the thin-instance matrix buffer every frame for every moving
rock. That is a `Matrix.ComposeToRef` plus 16 float writes per rock — cheaper
than the scene-graph update it replaces, but it is a real change in how the
field is driven.

## Known limits

- **WebGL 2 only.** The shape texture is a half-float sampled in the vertex
  shader; WebGL 1 does not guarantee vertex texture units at all.
- **Star-shaped only.** No overhangs, no holes, no arches. Fine for pebbles.
- **Shadows need the wrapper.** A shadow map is drawn with its own depth shader,
  which knows nothing about the displacement — without `ShadowDepthWrapper`
  every rock casts the shadow of an undisplaced sphere. `scene.js:createShadows`
  wires it up and reports failures rather than taking the scene down with it.
- **Picking.** The GPU is the only thing that knows where the surface is, so
  ray-picking against the visual mesh is out. Pick against the physics hulls.
- **The sky HDR** (`public/assets/sky/puresky_1k.hdr`) is copied from rock-sift
  so the lighting matches the game it feeds.
