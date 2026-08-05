// Procedurally generated textures. What is left here is the water's ripple normal
// map; the sky used to be generated here too and is now a captured HDR, see
// environment.js.

import { RawTexture, Texture } from "@babylonjs/core";
import { makeNoise3D, mulberry32, fbm } from "./noise.js";

/**
 * Tiling normal map derived from fbm height. `roughScale` controls grain size.
 * Returns a RawTexture in RGBA8 (tangent-space normal, +Z up).
 */
export function makeNoiseNormalTexture(scene, { size = 256, freq = 6, octaves = 5, strength = 2.2, seed = 7 } = {}) {
  const noise = makeNoise3D(mulberry32(seed));

  // Sample height on a torus so the result tiles seamlessly in U and V.
  const height = new Float32Array(size * size);
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * TAU;
      const v = (y / size) * TAU;
      const nx = Math.cos(u) * freq * 0.16;
      const ny = Math.sin(u) * freq * 0.16;
      const nz = Math.cos(v) * freq * 0.16;
      const nw = Math.sin(v) * freq * 0.16;
      // 4D-ish: fold the second circle into two extra noise lookups and blend.
      const a = fbm(noise, nx, ny, nz, octaves);
      const b = fbm(noise, nz + 31.7, nw + 12.3, nx - 5.1, octaves);
      height[y * size + x] = (a + b) * 0.5;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normal of the height field: (-dx, -dy, 1) normalised.
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }

  const tex = RawTexture.CreateRGBATexture(data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.name = "proc-normal";
  return tex;
}

/* ---------------------------------------------------------------------- */
