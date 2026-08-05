// Gradient and cellular noise, both 3D and sampled on the unit sphere.
//
// Perlin gives the smooth mass asymmetry that stops a stone looking turned on a
// lathe. Worley is what gives it *grain* — the pitting, vesicles and grit that
// separate a rock from a potato. The old generator in rock-sift used fbm alone,
// which is exactly why the results read as blobs.

import { mulberry32 } from "./rng.js";

const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a, b, t) => a + (b - a) * t;

/** Classic Perlin with a permutation table shuffled by `rng`. Roughly [-1, 1]. */
export function makeNoise3D(rng) {
  const perm = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = base[i]; base[i] = base[j]; base[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];

  const grad = (h, x, y, z) => {
    const g = GRAD[h % 12];
    return g[0] * x + g[1] * y + g[2] * z;
  };

  return function noise(x, y, z) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);

    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;

    return mix(
      mix(
        mix(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u),
        mix(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
      mix(
        mix(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u),
        mix(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  };
}

/** Fractal sum of `octaves` layers. Returns roughly [-1, 1]. */
export function fbm(noise, x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Billowed fbm — |noise| folded and inverted. The creases this produces run in
 * ridges rather than rolling hills, which is what a weathered, jointed surface
 * actually looks like. Returns [0, 1].
 */
export function ridged(noise, x, y, z, octaves = 4) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (1 - Math.abs(noise(x * freq, y * freq, z * freq)));
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Billow: fbm built from |noise| rather than noise.
 *
 * proc-rock reaches for this everywhere its textures need *grain* — it is the
 * base of all three of its igneous textures and both halves of its vein system.
 * Folding the negative lobe upward turns rolling hills into packed rounded
 * blobs, which is what a mineral aggregate looks like and what plain fbm never
 * gives you. Returns [0, 1].
 */
export function billow(noise, x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * Math.abs(noise(x * freq, y * freq, z * freq));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Worley / cellular noise from an explicit point set rather than a hash grid.
 *
 * The point set lives on (and just inside) the unit sphere, because every rock
 * surface here is described in spherical terms — scattering cells in a 3D grid
 * and slicing the sphere out of it gives cells whose size varies with how the
 * sphere happens to cut the grid. An explicit set of `count` points is both
 * cheaper for the few hundred samples we need and gives direct control over
 * grain size: `count` *is* the number of visible pits.
 *
 * Returns { f1, f2, id } — f1 the distance to the nearest site (0 at a site
 * centre), f2 to the second, and id the index of the nearest. f2 - f1 is small
 * exactly on the ridges between cells, which is how you draw crack lines.
 */
export function makeSphereWorley(rng, count) {
  const px = new Float32Array(count), py = new Float32Array(count), pz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Marsaglia: uniform on the sphere. A naive [-1,1]^3 normalise clumps at the
    // cube corners' directions and the pitting comes out visibly patterned.
    let x, y, s;
    do { x = rng() * 2 - 1; y = rng() * 2 - 1; s = x * x + y * y; } while (s >= 1);
    const k = 2 * Math.sqrt(1 - s);
    px[i] = x * k; py[i] = y * k; pz[i] = 1 - 2 * s;
  }
  const out = { f1: 0, f2: 0, id: 0 };
  return function worley(dx, dy, dz) {
    let f1 = Infinity, f2 = Infinity, id = 0;
    for (let i = 0; i < count; i++) {
      const ax = dx - px[i], ay = dy - py[i], az = dz - pz[i];
      const d = ax * ax + ay * ay + az * az;
      if (d < f1) { f2 = f1; f1 = d; id = i; }
      else if (d < f2) { f2 = d; }
    }
    out.f1 = Math.sqrt(f1);
    out.f2 = Math.sqrt(f2);
    out.id = id;
    return out;
  };
}

export { mulberry32 };
