// The shared detail map — one texture for every rock in the world.
//
// This is where the "displacement mapping" instinct actually pays off, but as a
// *normal* map rather than a displacement: the geometry only has to carry the
// silhouette, and everything finer than a triangle is a lighting trick. At a
// LOD0 triangle edge of roughly 3 mm on a 7 cm stone, that means the grain, the
// grit, the pitting and the micro-cavities are all free.
//
// It is tiled triplanar in the rock's own object space, so it costs three
// samples and no UVs — which matters, because a shared topology cannot carry a
// per-rock UV layout, and unwrapping every rock would defeat the whole scheme.
//
// RGB is a tangent-space normal, A is a cavity/occlusion term. Packing cavity
// into the spare channel is free and does more for the sense of relief than the
// normal alone: crevices need to be *dark*, not just differently lit.

import { RawTexture, Texture } from "@babylonjs/core";
import { makeNoise3D, fbm, ridged, billow } from "../forge/noise.js";
import { mulberry32, hash32, clamp01 } from "../forge/rng.js";

/**
 * Tiling 2D cellular noise on a wrapped integer grid. Gives the grit: a dense
 * field of small facets, which is what stone looks like up close and fbm never
 * produces on its own.
 */
function makeTilingCellular(seed, cells) {
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const pv = new Float32Array(cells * cells);   // per-cell value, for spots
  const rng = mulberry32(hash32(seed));
  for (let i = 0; i < cells * cells; i++) { px[i] = rng(); py[i] = rng(); pv[i] = rng(); }

  return function cell(u, v) {
    const fx = u * cells, fy = v * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let f1 = 8, f2 = 8, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ((ix + ox) % cells + cells) % cells;
        const cy = ((iy + oy) % cells + cells) % cells;
        const k = cy * cells + cx;
        const dx = (ix + ox + px[k]) - fx;
        const dy = (iy + oy + py[k]) - fy;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; id = k; } else if (d < f2) f2 = d;
      }
    }
    return { f1: Math.sqrt(f1), f2: Math.sqrt(f2), value: pv[id] };
  };
}

/**
 * @param {object} opts
 * @param {number} opts.size      texture edge, px
 * @param {number} opts.grit      cellular cells across the tile — grain size
 * @param {number} opts.strength  height-to-normal gain
 */
export function makeGrainTexture(scene, { size = 512, grit = 64, strength = 1.25, seed = 11 } = {}) {
  const noise = makeNoise3D(mulberry32(hash32(seed)));
  const cell = makeTilingCellular(seed + 991, grit);
  const TAU = Math.PI * 2;

  // Height is sampled on a torus embedded in 3D so it tiles seamlessly in both
  // directions — the standard trick, and the only one that avoids a visible
  // repeat seam running across every stone in the field.
  // What this must NOT do is put a dome on every cell. `f1` rises from 0 at a
  // cell's centre to its edge, so using it as height builds a hemisphere per
  // cell — which is exactly how you generate a golf ball, and exactly what a
  // wet river pebble does not look like. A tumbled stone is smooth: its surface
  // is fine, near-isotropic micro-relief with the odd crease and mineral joint,
  // and nothing on it reads as a repeating cell.
  //
  // So the cellular noise is used only for the thin dark *joints* between
  // grains, at low amplitude, and the bulk of the height is fine multi-octave
  // fbm. Frequencies are high and amplitudes small: at the scale this is tiled
  // to, one cell is under a millimetre on a 7 cm stone.
  const height = new Float32Array(size * size);
  const F = 5.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * TAU, v = (y / size) * TAU;
      const a = Math.cos(u) * F, b = Math.sin(u) * F;
      const c = Math.cos(v) * F, d = Math.sin(v) * F;

      // Two independent 3D lookups blended: a genuine 4D noise would be tidier
      // but this is indistinguishable at grain scale and a third of the cost.
      const rough = 0.5 * (fbm(noise, a, b, c, 6) + fbm(noise, c + 31.7, d + 12.3, a - 5.1, 6));
      // A little ridged fbm for creases; plain fbm alone reads as suede.
      const creases = ridged(noise, a * 2.3, b * 2.3, c * 2.3, 4) - 0.5;

      const w = cell(x / size, y / size);
      // f2 - f1 vanishes only on the boundary between two cells, so this is a
      // thin line, not a dome. Squared to keep it tight.
      const joint = (1 - clamp01((w.f2 - w.f1) * grit * 1.6)) ** 2;

      height[y * size + x] = rough * 0.62 + creases * 0.22 - joint * 0.16;
    }
  }

  const at = (x, y) => height[((y % size) + size) % size * size + (((x % size) + size) % size)];
  const data = new Uint8Array(size * size * 4);

  // Cavity: how far below its local neighbourhood a texel sits. A wide box blur
  // is enough — this only has to darken crevices, not be a correct AO solve.
  const R = Math.max(2, Math.round(size / 96));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;

      let avg = 0;
      for (let k = -R; k <= R; k++) avg += at(x + k, y) + at(x, y + k);
      avg /= (2 * R + 1) * 2;
      const cavity = clamp01(0.5 + (at(x, y) - avg) * 1.6);

      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      // Narrow range: this only has to hint at crevices. Wide range plus a
      // cellular pattern is what made the stones look quilted.
      data[i + 3] = (0.72 + cavity * 0.28) * 255;
    }
  }

  const tex = RawTexture.CreateRGBATexture(
    data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE
  );
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  tex.name = "rock-grain";
  return tex;
}

/* ---------------------------------------------------------------------- */

/**
 * Per-stone colour variation: the three "texture adder" ideas from proc-rock,
 * packed into one shared tiling map and sampled with a per-instance offset so
 * no two stones get the same markings.
 *
 *   R  variance — low-frequency mottling. proc-rock adds this to everything and
 *      says why plainly: it "makes it look less uniform". A photographed albedo
 *      tiled over a thousand stones is the same photograph a thousand times,
 *      and this is the cheapest thing that breaks that up.
 *   G  veins — mineral filling in old cracks. Built the way the thesis does it,
 *      as the *minimum of two billow noises* at different frequencies: a billow
 *      noise is near zero along a crease, so taking the min of two gives a
 *      network of thin intersecting lines rather than blobs. On a real shingle
 *      beach the white-veined stones are the ones you pick up.
 *   B  spots — Voronoi cells with a random value each. This is proc-rock's own
 *      fix for granite: its abstracted pipeline lacked "distinguished white
 *      quartz" and "the not fully correct shapes of the pink/orange potassium
 *      feldspar", and a Voronoi-driven spot adder is what closed the gap.
 *   A  bands — a 1D-ish profile for bedding, read along the stone's short axis.
 *
 * Kept to one texture and one set of three triplanar samples: the whole point
 * is that this costs the same whether a stone is veined, spotted or plain.
 */
export function makeVariationTexture(scene, { size = 512, seed = 4711 } = {}) {
  const noise = makeNoise3D(mulberry32(hash32(seed)));
  const fine = makeNoise3D(mulberry32(hash32(seed + 313)));
  const cell = makeTilingCellular(seed + 77, 9);
  const TAU = Math.PI * 2;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * TAU, v = (y / size) * TAU;
      const torus = (f) => [Math.cos(u) * f, Math.sin(u) * f, Math.cos(v) * f, Math.sin(v) * f];

      // Variance: broad, soft, low contrast. Anything sharper reads as dirt.
      const [a1, b1, c1, d1] = torus(1.7);
      const mottle = clamp01(0.5 + 0.5 * 0.5 * (fbm(noise, a1, b1, c1, 3) + fbm(noise, c1 + 19.3, d1 - 7.1, a1 + 3.3, 3)));

      // Veins: min of two billow noises, one coarse and one fine, then a narrow
      // band near zero. Squared to keep the lines thin rather than smeared.
      const [a2, b2, c2, d2] = torus(3.1);
      const bigVein = billow(noise, a2, b2, c2, 3);
      const smallVein = billow(fine, c2 * 2.6 + 11.7, d2 * 2.6 - 4.2, a2 * 2.6 + 8.1, 3);
      const vein = (1 - clamp01(Math.min(bigVein, smallVein) * 9)) ** 2;

      // Spots: flat value per cell, so they read as discrete mineral grains
      // rather than as another cloud of noise.
      const w = cell(x / size, y / size);
      const spot = w.value;

      // Bands: fine layering profile, irregular so bedding is not a sine wave.
      //
      // All FOUR torus coordinates, deliberately. The first version used only
      // the u pair (cos u, sin u), which made the channel constant down every
      // column — and the shader picks a band profile by sampling a row at
      // `vRockVar.y`, so with identical rows that per-stone offset selected
      // nothing and every banded stone (agate, malachite, slate's bedding)
      // wore the same profile, merely shifted sideways. Mixing the v circle in
      // keeps the texture seamless both ways while giving each row its own
      // profile, which is what makes two agates band differently.
      const [a3, b3, c3, d3] = torus(6.5);
      const band = clamp01(0.5 + 0.25 * (
        fbm(noise, a3 * 0.35 + 41.0, b3 * 0.35 - 13.0, c3 * 0.35, 4) +
        fbm(noise, c3 * 0.35 + 7.7, d3 * 0.35 + 3.1, a3 * 0.35 - 9.2, 4)));

      const i = (y * size + x) * 4;
      data[i] = mottle * 255;
      data[i + 1] = vein * 255;
      data[i + 2] = spot * 255;
      data[i + 3] = band * 255;
    }
  }

  const tex = RawTexture.CreateRGBATexture(
    data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE
  );
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 4;
  tex.name = "rock-variation";
  return tex;
}
