// The shape model: a rock is a radius function r(direction) on the unit sphere.
//
// Why radial rather than a general mesh
// -------------------------------------
// Constraining every rock to be star-shaped about its centre costs nothing for
// pebbles — a beach stone with a genuine overhang is a rarity — and buys three
// things at once. The surface is exactly one scalar per direction, so a whole
// rock compresses to one row of a texture. Any two rocks that share a sphere
// tessellation share a topology, so the entire field is one draw call. And a
// star-shaped solid's convex hull is a good approximation of it, so physics can
// reuse a handful of shared hulls.
//
// Why it does not look like a blob
// --------------------------------
// The generator this replaces displaced an icosphere by fbm, which is a recipe
// for a potato: fbm has no straight lines and no discontinuities, and a real
// stone is defined by both. Four things are layered here instead, roughly in
// the order geology applies them:
//
//   1. a *superellipsoid*, not an ellipsoid — one exponent takes the base from
//      octahedral through spherical to nearly cubic, which is most of the
//      difference between shale, a river cobble and a chunk of granite;
//   2. *fracture planes* — half-space cuts, smooth-min'd so the edges round off
//      rather than knife. This is the single biggest anti-blob measure: real
//      stones are bounded by flats that meet at edges;
//   3. *bedding* — banding along one axis, showing only on surfaces parallel to
//      it, which is what makes slate read as slate;
//   4. *lumps and pits* — low-frequency fbm asymmetry and Worley dimples, kept
//      deliberately small. Anything more and you are back to the potato.
//
// Then `wear` runs the tumbling process over the top: it rounds the fracture
// edges, damps the fine detail and pushes the base exponent toward a rounded
// box. wear=0 is freshly broken; wear=1 is a stone that has been in the surf
// for ten thousand years.
//
// Everything here is analytic and resolution-independent. Evaluating the same
// shape on a 162-vertex sphere and a 10,242-vertex one gives the same rock, so
// the low-poly instance in the field and the high-poly one in your hand agree.

import { hash32, mulberry32, clamp, clamp01, lerp, smoothstep } from "./rng.js";
import { makeNoise3D, fbm, makeSphereWorley } from "./noise.js";

/** Quadratic smooth minimum. `k` is the blend width in radius units. */
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Quadratic smooth maximum — the union side of the same blend. */
function smax(a, b, k) {
  if (k <= 0) return Math.max(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/**
 * Far intersection of the ray from the origin along unit `d` with the sphere
 * centred at `c` of radius `R`. Returns 0 if the ray misses.
 */
function sphereReach(dx, dy, dz, cx, cy, cz, R) {
  const b = dx * cx + dy * cy + dz * cz;
  const disc = R * R - (cx * cx + cy * cy + cz * cz) + b * b;
  if (disc <= 0) return 0;
  const t = b + Math.sqrt(disc);
  return t > 0 ? t : 0;
}

/**
 * *Near* intersection — where the ray first enters the sphere.
 *
 * This is what carves a conchoidal fracture. Glass and flint do not break along
 * planes: they break in shell-shaped concave scoops, which is why an obsidian
 * flake has curved faces meeting at edges thinner and sharper than anything a
 * flat cut produces. Subtracting a large sphere whose centre sits *outside* the
 * stone leaves exactly that surface, and in radial form the new surface is
 * simply where the ray enters the subtracted sphere.
 */
function sphereEnter(dx, dy, dz, cx, cy, cz, R) {
  const b = dx * cx + dy * cy + dz * cz;
  const disc = R * R - (cx * cx + cy * cy + cz * cz) + b * b;
  if (disc <= 0) return 0;
  const t = b - Math.sqrt(disc);
  return t > 0 ? t : 0;
}

/**
 * Build the radius function for one rock.
 *
 * @param {object} p  archetype parameters (see archetypes.js)
 * @param {number} seed integer; the same seed and params always give the same rock
 * @returns {{ radiusAt: (x:number,y:number,z:number)=>number, params: object }}
 */
export function makeShape(p, seed) {
  const rng = mulberry32(hash32(seed ^ 0x9e3779b9));
  const noise = makeNoise3D(mulberry32(hash32(seed + 1013)));
  const jitter = (v, amt) => v * (1 - amt + rng() * amt * 2);

  const wear = clamp01(p.wear + (rng() - 0.5) * (p.wearJitter ?? 0.15));

  // --- base solid -------------------------------------------------------
  // Axes are sorted long/medium/short and applied to x/z/y, so y is always the
  // thin axis. Downstream code (bedding, physics, the skip rating) can then
  // assume a stone lies flat when it is y-up.
  const spread = p.axisJitter ?? 0.12;
  let axes = [1, jitter(p.axes[1], spread), jitter(p.axes[2], spread)].map((v) => clamp(v, 0.08, 1));
  const ax = 1, ay = Math.min(axes[1], axes[2]), az = Math.max(axes[1], axes[2]);

  // Wear pulls the exponent toward 2.05 — an ellipsoid.
  //
  // This used to pull toward 3.0, on the reasoning that a worn stone is "a
  // rounded box". That is simply wrong: a superellipsoid at exponent 3 *is* a
  // squircle, and tumbling drives stones toward ellipsoids, not cuboids. With
  // wear between 0.68 and 0.93 the old term dragged every family into the
  // 2.75-3.5 band, so a field of six lithologies came out as one field of
  // rounded rectangles — and the archetypes' own exponents, which are the main
  // thing distinguishing them, were being averaged away.
  //
  // The pull is also weaker now (0.35 rather than 0.55) so a family keeps its
  // identity even when heavily worn.
  const expo = lerp(jitter(p.exponent, 0.18), 2.05, wear * 0.35);

  // --- fracture planes --------------------------------------------------
  // Normals are drawn on the sphere but pulled toward the *thin* axis by
  // `beddingBias`: rocks that split along a plane break into slabs, so their
  // cut faces face up and down, not sideways. With bias 0 the cuts are
  // isotropic, which is what you want for a chunk of granite.
  const bias = p.beddingBias ?? 0;
  const nFacets = Math.round(jitter(p.facets, 0.3));
  // Side cuts: normals lying in the horizontal plane, so they chop chords out
  // of the *outline* rather than off the faces.
  //
  // Without these, a strongly bedded stone had every cut normal pulled to +/-Y,
  // which flattens the top and bottom and leaves the plan view as the bare
  // superellipsoid cross-section — a rounded rectangle, on every single stone.
  // Measured, eight slate outlines all sat between 0.69 and 1.00 of their own
  // maximum radius with no straight edge anywhere. Real cleaved slate breaks to
  // an irregular polygon: a few straight edges at unrelated angles, which is
  // most of what makes one fragment distinguishable from another.
  const nSide = Math.round(lerp(p.sideFacets?.[0] ?? 0, p.sideFacets?.[1] ?? 0, rng()));
  const planes = [];

  for (let i = 0; i < nFacets + nSide; i++) {
    const isSide = i >= nFacets;
    let nx, ny, nz;
    if (isSide) {
      // Random azimuth, near-horizontal normal. The small Y component lets a
      // side face lean, so fragments are not all prisms.
      const az = rng() * Math.PI * 2;
      nx = Math.cos(az); nz = Math.sin(az);
      ny = (rng() - 0.5) * (p.sideTilt ?? 0.35);
    } else {
      nx = rng() * 2 - 1; ny = rng() * 2 - 1; nz = rng() * 2 - 1;
    }
    let l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (!isSide) {
      // Blend toward +/-Y, keeping the sign so both faces of a slab get cut.
      const s = ny >= 0 ? 1 : -1;
      nx = lerp(nx, 0, bias); ny = lerp(ny, s, bias); nz = lerp(nz, 0, bias);
    }
    l = Math.hypot(nx, ny, nz) || 1;

    // Offset: how deep the cut bites. Measured against the base solid's radius
    // in that direction so the bite is the same fraction whatever the axes are.
    const baseR = superR(nx / l, ny / l, nz / l, ax, ay, az, expo);
    // Side cuts bite shallower by default: a chord taken as deep as a bedding
    // cut would leave a sliver rather than a stone.
    const biteRange = isSide ? (p.sideBite ?? [0.70, 0.97]) : p.facetBite;
    const bite = lerp(biteRange[0], biteRange[1], rng());
    // Each plane carries its own noise offset so its face can undulate. A
    // mathematically flat cut is the other half of why these read as machined:
    // proc-rock displaces its cutting geometry by noise before the boolean, for
    // exactly this reason ("ideal for forming shapes where it looks like the
    // rock has brittled"). Same idea, done analytically.
    planes.push({
      nx: nx / l, ny: ny / l, nz: nz / l, h: baseR * bite,
      ox: rng() * 100, oy: rng() * 100, oz: rng() * 100,
    });
  }
  const planeWobble = (p.facetWobble ?? 0.10) * (1 - wear * 0.4);
  const planeFreq = p.facetWobbleFreq ?? 2.2;

  // --- lobes ------------------------------------------------------------
  // A few off-centre spheres, smooth-union'd onto the base solid.
  //
  // This is proc-rock's skin-surface generator translated into radial form. Its
  // "liquid" method unions ~100 weighted spheres via CGAL to get shapes that no
  // parametric family produces; the same trick with a handful of spheres is one
  // line of ray-sphere maths here, and it is the single biggest source of
  // asymmetry available. A superellipsoid is inescapably symmetric about three
  // planes — no amount of noise on top hides that, which is why the field read
  // as uniform however the other knobs were set. An off-centre lobe breaks all
  // three symmetries at once.
  const lobes = [];
  const nLobes = Math.round(lerp(p.lobes?.[0] ?? 0, p.lobes?.[1] ?? 0, rng()));
  for (let i = 0; i < nLobes; i++) {
    let lx = rng() * 2 - 1, ly = rng() * 2 - 1, lz = rng() * 2 - 1;
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx /= ll; ly /= ll; lz /= ll;

    // Both offset and radius are fractions of the base solid's radius *in that
    // direction*. Sizing them in absolute units instead is how the first
    // attempt failed silently: the body reaches 1.0 along its long axis but
    // only ~0.2 along a flat stone's thin one, so a fixed-size sphere sat
    // entirely inside the body in some directions and swamped it in others.
    // Scaling by the local radius also makes a flat stone grow flat lobes
    // rather than sprouting a ball off its face.
    //
    // A lobe sticks out only where offset + radius > 1, so the ranges below
    // straddle that deliberately: some lobes bulge, some merely fatten the body.
    const bR = superR(lx, ly, lz, ax, ay, az, expo);
    const dist = lerp(p.lobeOffset[0], p.lobeOffset[1], rng()) * bR;
    const rad = lerp(p.lobeRadius[0], p.lobeRadius[1], rng()) * bR;
    lobes.push({ cx: lx * dist, cy: ly * dist, cz: lz * dist, r: rad });
  }
  // How softly a lobe merges into the body. This is the parameter that decides
  // how much *concavity* the shape has: a narrow blend leaves a sharp saddle
  // where the lobe meets the body, and a convex physics hull bridges every one
  // of those saddles. Widening it costs a little of the lobe's silhouette and
  // buys back most of the hull error. Worn stones blend more, as they should.
  const lobeBlend = lerp(p.lobeBlend?.[0] ?? 0.05, p.lobeBlend?.[1] ?? 0.30, wear);

  // --- conchoidal scoops -------------------------------------------------
  //
  // Glass and flint do not break along planes. They break in shell-shaped
  // concave scoops, which is why an obsidian flake has curved faces meeting at
  // edges far thinner and sharper than any flat cut produces. Subtracting a
  // large sphere whose centre sits outside the stone leaves exactly that
  // surface — see sphereEnter.
  const scoops = [];
  const nScoops = Math.round(lerp(p.scoops?.[0] ?? 0, p.scoops?.[1] ?? 0, rng()));
  for (let i = 0; i < nScoops; i++) {
    let sx = rng() * 2 - 1, sy = rng() * 2 - 1, sz = rng() * 2 - 1;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const bR = superR(sx, sy, sz, ax, ay, az, expo);
    // Parameterised by what *survives*, not by the sphere's radius.
    //
    // Setting the radius directly is unusable: it interacts with the centre
    // distance, and the combination that looks right on one axis cuts straight
    // through the stone on another. Measured, radius 1.3 at offset 1.02 put the
    // sphere's near surface behind the origin and removed half the flake — a
    // 29% volume error against the physics hull. `keep` is the fraction of the
    // local radius left standing, so the depth of the bite is bounded by
    // construction however the other numbers fall.
    const dist = lerp(p.scoopOffset?.[0] ?? 1.15, p.scoopOffset?.[1] ?? 1.9, rng()) * bR;
    const keep = lerp(p.scoopKeep?.[0] ?? 0.70, p.scoopKeep?.[1] ?? 0.90, rng()) * bR;
    scoops.push({ cx: sx * dist, cy: sy * dist, cz: sz * dist, r: dist - keep });
  }
  // A fresh flake keeps its scoop edges knife-sharp; wear rounds them.
  const scoopBlend = lerp(p.scoopBlend?.[0] ?? 0.015, p.scoopBlend?.[1] ?? 0.09, wear);

  // Edge rounding, in radius units. This is the parameter that reads as age.
  const round = lerp(p.facetRound[0], p.facetRound[1], wear);

  // --- surface detail ---------------------------------------------------
  const damp = 1 - wear * 0.7;
  const lumpAmp = p.lumpAmp * damp * (0.7 + rng() * 0.6);
  const lumpFreq = jitter(p.lumpFreq, 0.25);
  const lumpOct = p.lumpOctaves ?? 3;

  const pitAmp = (p.pitAmp ?? 0) * damp;
  const pitCount = Math.max(4, Math.round(p.pitCount ?? 40));
  const worley = pitAmp > 0 || (p.crackAmp ?? 0) > 0
    ? makeSphereWorley(mulberry32(hash32(seed + 7717)), pitCount)
    : null;
  const pitRadius = 1.6 / Math.sqrt(pitCount);
  const crackAmp = (p.crackAmp ?? 0) * damp;

  const beddingAmp = (p.beddingAmp ?? 0) * (1 - wear * 0.35);
  const beddingFreq = jitter(p.beddingFreq ?? 6, 0.2);

  // Noise domain offset — without it every rock made from the same archetype
  // gets the same lumps in the same places, which is instantly readable as
  // repetition once there are more than about twenty on screen.
  const ox = rng() * 100, oy = rng() * 100, oz = rng() * 100;

  function radiusAt(dx, dy, dz) {
    let r = superR(dx, dy, dz, ax, ay, az, expo);

    for (let i = 0; i < lobes.length; i++) {
      const lo = lobes[i];
      const t = sphereReach(dx, dy, dz, lo.cx, lo.cy, lo.cz, lo.r);
      if (t > 0) r = smax(r, t, lobeBlend);
    }

    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i];
      const d = dx * pl.nx + dy * pl.ny + dz * pl.nz;
      // Only directions pointing into the half-space can be clipped by it, and
      // the 1/d blows up as d -> 0. Below the cutoff the plane is effectively
      // parallel to the ray and cannot be the nearest surface anyway.
      if (d > 0.08) {
        const h = pl.h * (1 + planeWobble *
          noise(dx * planeFreq + pl.ox, dy * planeFreq + pl.oy, dz * planeFreq + pl.oz));
        r = smin(r, h / d, round);
      }
    }

    for (let i = 0; i < scoops.length; i++) {
      const sc = scoops[i];
      const t = sphereEnter(dx, dy, dz, sc.cx, sc.cy, sc.cz, sc.r);
      if (t > 0) r = smin(r, t, scoopBlend);
    }

    if (lumpAmp > 0) {
      r *= 1 + lumpAmp * fbm(noise, dx * lumpFreq + ox, dy * lumpFreq + oy, dz * lumpFreq + oz, lumpOct);
    }

    if (beddingAmp > 0) {
      // Bands run perpendicular to y. They are hidden on the flat faces (where
      // |dy| is large) and strongest around the rim, which is exactly where you
      // see the layers on a piece of shale.
      const band = noise(dy * beddingFreq + ox, oy * 0.1, oz * 0.1);
      r *= 1 + beddingAmp * band * (1 - Math.abs(dy)) ** 1.5;
    }

    if (worley) {
      const w = worley(dx, dy, dz);
      if (pitAmp > 0) {
        // 1 at a site centre, 0 beyond pitRadius: dimples, not craters.
        r -= pitAmp * (1 - smoothstep(0, pitRadius, w.f1));
      }
      if (crackAmp > 0) {
        // f2 - f1 vanishes on the boundary between two cells — the crack lines.
        r -= crackAmp * (1 - smoothstep(0, pitRadius * 0.35, w.f2 - w.f1));
      }
    }

    return r;
  }

  return {
    radiusAt,
    params: { ax, ay, az, expo, wear, facets: planes.length, round },
  };
}

/** Radius of the superellipsoid |x/ax|^e + |y/ay|^e + |z/az|^e = 1 along `d`. */
function superR(dx, dy, dz, ax, ay, az, e) {
  const s =
    Math.pow(Math.abs(dx) / ax, e) +
    Math.pow(Math.abs(dy) / ay, e) +
    Math.pow(Math.abs(dz) / az, e);
  return Math.pow(s, -1 / e);
}

/**
 * Sample a shape onto a sphere tessellation.
 *
 * Radii come back normalised so the longest axis of the *bounding box* is
 * exactly `size`. Normalising on the bounding box rather than on max radius
 * matters: cuts and pits move the extreme point off the long axis, and scaling
 * by max radius leaves flat stones systematically undersized.
 *
 * `fixedScale` overrides that normalisation, and callers who are re-sampling an
 * *already baked* shape must pass it. The bounding box a sampling finds depends
 * on how many directions it looked in — 42 points miss the extremes that 642
 * find — so re-deriving the scale at a different resolution silently rescales
 * the rock by a percent or two. That is invisible on the rendered mesh and very
 * visible in physics, where it means the collision hull is not the size of the
 * thing you can see.
 *
 * @returns {{ radii: Float32Array, span: [number,number,number], scale: number }}
 */
export function sampleShape(shape, dirs, vertexCount, size, fixedScale = null) {
  const radii = new Float32Array(vertexCount);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < vertexCount; i++) {
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    const r = Math.max(1e-4, shape.radiusAt(dx, dy, dz));
    radii[i] = r;
    const x = dx * r, y = dy * r, z = dz * r;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }

  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const k = fixedScale !== null ? fixedScale : size / Math.max(span[0], span[1], span[2]);
  for (let i = 0; i < vertexCount; i++) radii[i] *= k;

  return { radii, span: [span[0] * k, span[1] * k, span[2] * k], scale: k };
}
