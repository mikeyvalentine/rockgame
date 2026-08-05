// Baking: turn N seeds into one shared topology plus one texture.
//
// The output of this file is the whole memory argument. Every rock in the
// library is stored as `vertexCount` texels of RGBA16F — normal in xyz, radius
// in w — on a single row of one texture. At the default LOD0 of 642 vertices
// that is 5.1 KB per *distinct rock shape*, and a rock drawn in the world costs
// nothing beyond its 64-byte instance matrix and a few bytes of per-instance
// attributes, because it reuses one of those rows.
//
// For comparison, an indexed 1,280-triangle mesh with position + normal + uv is
// about 30 KB of vertex data plus 7.7 KB of indices per rock, and it cannot be
// instanced with any other rock because its topology is its own.
//
// Everything the shape is scaled to happens per instance: shapes are baked at
// unit size (longest bounding-box axis = 1) and the real size in metres goes
// into the instance matrix. One baked row therefore serves every size of that
// rock, which is why a 96-shape library does not look like 96 rocks.

import { mulberry32, hash32, lerp } from "./rng.js";
import { buildIcosphere, computeRadialNormals } from "./icosphere.js";
import { makeShape, sampleShape } from "./shape.js";
import { ARCHETYPES, pickArchetype } from "./archetypes.js";
import { meshVolume, meshSpan, boundingRadius, skipRating } from "./metrics.js";

/** IEEE 754 binary32 -> binary16, via a scratch view. */
const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);
export function toHalf(val) {
  _f32[0] = val;
  const x = _i32[0];
  let bits = (x >> 16) & 0x8000;            // sign
  let m = (x >> 12) & 0x07ff;               // mantissa, with rounding bit
  const e = (x >> 23) & 0xff;               // exponent

  if (e < 103) return bits;                 // underflows to zero
  if (e > 142) return bits | 0x7c00;        // overflows to inf
  if (e < 113) {                            // subnormal half
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;                            // round to nearest even
  return bits;
}

/**
 * @param {object} opts
 * @param {number} opts.count       number of distinct shapes to bake
 * @param {number} opts.seed        base seed
 * @param {number} opts.lod0Level   icosphere subdivision the texture is sized for
 * @param {string|null} opts.only   restrict the library to one archetype
 * @returns library object
 */
/**
 * The tessellation warp for an archetype: its axis ratios, raised to an
 * exponent measured to minimise rim sawtooth. See buildIcosphere.
 */
export function archetypeWarp(a) {
  const ay = Math.min(a.axes[1], a.axes[2]);
  const az = Math.max(a.axes[1], a.axes[2]);
  return [1, Math.pow(ay, WARP_EXPONENT), Math.pow(az, WARP_EXPONENT)];
}
const WARP_EXPONENT = 1.25;

export function bakeLibrary({ count = 96, seed = 1, lod0Level = 3, only = null } = {}) {
  const t0 = now();
  const ico = buildIcosphere(lod0Level);
  const lod0 = ico.levels[lod0Level];
  const width = lod0.vertexCount;

  // Each archetype gets its own direction set, warped to suit how flat that
  // family of stones is. Indices are shared, so this costs one extra 642-vertex
  // direction array per archetype and nothing at all at draw time — but the
  // mesh a shape is drawn with must use the same directions it was baked with,
  // which is why RockField groups its meshes by archetype.
  const dirsByArchetype = {};
  for (const [name, a] of Object.entries(ARCHETYPES)) {
    dirsByArchetype[name] = buildIcosphere(lod0Level, archetypeWarp(a)).dirs;
  }

  const rng = mulberry32(hash32(seed ^ 0x5bf03635));
  const shapes = [];
  const texel = new Uint16Array(width * count * 4);
  const scratchN = new Float32Array(width * 3);

  for (let s = 0; s < count; s++) {
    const name = only || pickArchetype(rng);
    const a = ARCHETYPES[name];
    const rockSeed = hash32(seed * 2654435761 + s * 40503);
    const srng = mulberry32(rockSeed ^ 0x2545f491);

    const dirs = dirsByArchetype[name];
    const shape = makeShape(a, rockSeed);
    const { radii, scale: unitScale } = sampleShape(shape, dirs, width, 1);
    const normals = computeRadialNormals(dirs, radii, lod0.indices, width, scratchN);

    const row = s * width * 4;
    for (let i = 0; i < width; i++) {
      const o = row + i * 4;
      texel[o] = toHalf(normals[i * 3]);
      texel[o + 1] = toHalf(normals[i * 3 + 1]);
      texel[o + 2] = toHalf(normals[i * 3 + 2]);
      texel[o + 3] = toHalf(radii[i]);
    }

    // Unit-size measurements; the instance's own size scales them.
    const unitVolume = meshVolume(dirs, radii, lod0.indices);
    const unitSpan = meshSpan(dirs, radii, width);
    const unitRadius = boundingRadius(radii, width);

    shapes.push({
      index: s,
      archetype: name,
      label: a.label,
      seed: rockSeed,
      params: shape.params,
      lod0Level,
      // The normalisation this shape was baked with. Every later re-sampling of
      // it — the detail mesh, the physics hull — must reuse this exact number
      // or it will come out a different size from the rock on screen.
      unitScale,
      radii: radii.slice(),
      unitVolume,
      unitSpan,
      unitRadius,
      density: a.density,
      sizeRange: a.sizeRange,
      grain: a.grain,
      colour: pickColour(a, srng),
      roughness: a.roughness ? lerp(a.roughness[0], a.roughness[1], srng()) : 0.5,
    });
  }

  const bytes = texel.byteLength;
  return {
    ico,
    dirsByArchetype,
    lod0Level,
    width,
    count,
    shapes,
    texel,
    stats: {
      bakeMs: now() - t0,
      shapeTextureBytes: bytes,
      bytesPerShape: bytes / count,
      indexBytes: ico.levels.reduce((n, l) => n + l.indices.byteLength, 0),
      baseVertexBytes: Object.values(dirsByArchetype).reduce((n, d) => n + d.byteLength, 0),
    },
  };
}

/**
 * Concrete geometry for one instance: what a rock actually measures once the
 * library's unit shape is scaled to a real size in metres.
 */
export function instanceMetrics(shape, sizeMetres) {
  const span = shape.unitSpan.map((v) => v * sizeMetres);
  const volume = shape.unitVolume * sizeMetres ** 3;
  const massGrams = volume * shape.density * 1000;
  const sortedCm = span.map((v) => v * 100).sort((a, b) => b - a);
  return {
    span, volume, massGrams, sortedCm,
    massKg: volume * shape.density,
    radius: shape.unitRadius * sizeMetres,
    rating: skipRating({ sortedCm, massGrams }),
  };
}

/**
 * Full-resolution CPU geometry for a single rock — the one in the player's hand.
 *
 * This is the escape hatch that makes the whole low-memory scheme acceptable:
 * the field never needs real geometry, so when the player lifts a stone to eye
 * level you can afford to rebuild that *one* rock at 20,000 triangles from its
 * seed. It is the same analytic shape function, so it is the same rock — just
 * resolved properly.
 */
export function buildDetailMesh(shape, archetypeParams, level, sizeMetres) {
  const ico = buildIcosphere(level, archetypeWarp(archetypeParams));
  const lvl = ico.levels[level];
  const n = lvl.vertexCount;
  const s = makeShape(archetypeParams, shape.seed);
  const { radii } = sampleShape(s, ico.dirs, n, sizeMetres, shape.unitScale * sizeMetres);
  const normals = computeRadialNormals(ico.dirs, radii, lvl.indices, n);

  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = ico.dirs[i * 3] * radii[i];
    positions[i * 3 + 1] = ico.dirs[i * 3 + 1] * radii[i];
    positions[i * 3 + 2] = ico.dirs[i * 3 + 2] * radii[i];
  }
  return { positions, normals, indices: lvl.indices, vertexCount: n, radii, dirs: ico.dirs };
}

/**
 * Point cloud for a convex-hull physics shape.
 *
 * Where the sample directions go matters far more than how many there are, and
 * getting it wrong is not subtle. An icosphere spreads directions evenly over
 * the sphere, but a rock's radius does not vary evenly: on a 7 cm slate disc it
 * falls from 37 mm to 20 mm within 15 degrees of the equator. Evenly-spread
 * directions therefore spend dozens of points on the two flat faces, which need
 * three each, and almost nothing on the rim, where the entire silhouette lives.
 * Measured, that put the collision surface 16 mm inside the drawn one and lost
 * 37% of the volume — a stone that visibly floats above its neighbours.
 *
 * So three sets are unioned:
 *
 *   - the isotropic level-1 icosphere, which anchors the flat faces and the
 *     poles. Warped directions alone abandon them and turn a disc into a
 *     bicone;
 *   - the icosphere at `level`, warped by the stone's own axis ratios, which
 *     compresses directions toward the equator in proportion to how flat the
 *     stone is. A no-op for an equant cobble;
 *   - the six directions where the *baked* shape reaches its bounding box,
 *     which pins the hull to the same overall size as the rock on screen. Left
 *     out, the extents drift by up to 7%.
 *
 * What is left after that is the convex hull's own irreducible error: it cuts
 * the corner between sample points, and it fills in concavities. Both are
 * measured per archetype by tools/collision-test.mjs — at the default level the
 * mean deviation is about a third of a millimetre on a 7 cm stone and the worst
 * inward case is 2.6 mm.
 *
 * The default rose from level 2 to level 3 when lobes were added to the shape
 * model. Lumpier stones need denser sampling: at level 2 the inward error was
 * 5.9 mm, and level 3 more than halves it. The *outward* error, 2-4.7 mm, does
 * not improve with density because it is not a sampling error — it is the hull
 * bridging the concave saddle where a lobe meets the body. That is the price of
 * having shapes that are not ellipsoids, and it is the same trade rock-sift
 * already makes by feeding its scanned meshes to PhysicsShapeConvexHull.
 */
export function buildHullPoints(shape, archetypeParams, sizeMetres, level = 3) {
  const s = makeShape(archetypeParams, shape.seed);
  const k = shape.unitScale * sizeMetres;
  const { ax, ay, az } = shape.params;

  const iso = buildIcosphere(1);
  const isoN = iso.levels[1].vertexCount;
  const warp = buildIcosphere(level);
  const warpN = warp.levels[level].vertexCount;

  const dirs = new Float32Array((isoN + warpN + 6) * 3);
  dirs.set(iso.dirs.subarray(0, isoN * 3), 0);

  let o = isoN * 3;
  for (let i = 0; i < warpN; i++) {
    let dx = warp.dirs[i * 3] * ax, dy = warp.dirs[i * 3 + 1] * ay, dz = warp.dirs[i * 3 + 2] * az;
    const l = Math.hypot(dx, dy, dz) || 1;
    dirs[o++] = dx / l; dirs[o++] = dy / l; dirs[o++] = dz / l;
  }

  // The extremes are read off the baked radii rather than assumed to lie on the
  // axes: a fracture cut moves a stone's widest point off its long axis.
  const lod = buildIcosphere(shape.lod0Level, archetypeWarp(archetypeParams));
  const lodN = lod.levels[shape.lod0Level].vertexCount;
  for (let c = 0; c < 3; c++) {
    let hi = -Infinity, lo = Infinity, ih = 0, il = 0;
    for (let i = 0; i < lodN; i++) {
      const v = lod.dirs[i * 3 + c] * shape.radii[i];
      if (v > hi) { hi = v; ih = i; }
      if (v < lo) { lo = v; il = i; }
    }
    for (const idx of [ih, il]) {
      dirs[o++] = lod.dirs[idx * 3];
      dirs[o++] = lod.dirs[idx * 3 + 1];
      dirs[o++] = lod.dirs[idx * 3 + 2];
    }
  }

  const count = dirs.length / 3;
  const pts = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    const r = Math.max(1e-4, s.radiusAt(dx, dy, dz)) * k;
    pts[i * 3] = dx * r; pts[i * 3 + 1] = dy * r; pts[i * 3 + 2] = dz * r;
  }
  return pts;
}

/**
 * Per-shape colour.
 *
 * A rock family blends between two ends of its own range. A treasure with a
 * `palette` instead picks one entry outright — sea glass does not come in a
 * gradient from seafoam to cobalt, it comes in discrete bottle colours, and
 * interpolating between them would invent glass that has never existed.
 */
function pickColour(a, srng) {
  const pal = a.gem?.palette;
  if (pal) return pal[Math.min(pal.length - 1, Math.floor(srng() * pal.length))].slice();
  return mixColour(a.colour ?? a.gem?.colours ?? [[1, 1, 1], [1, 1, 1]], srng());
}

function mixColour([lo, hi], t) {
  return [lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t), lerp(lo[2], hi[2], t)];
}

const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();
